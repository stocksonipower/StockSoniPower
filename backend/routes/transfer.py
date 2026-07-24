from fastapi import APIRouter, Depends, HTTPException, Query, Response
from datetime import datetime, timezone
from typing import Optional
import uuid
from pymongo.errors import DuplicateKeyError

from deps import db, get_current_user, now_iso, _notify, _resolve_assignee, _enforce_assignee
from models import *
from helpers.stock_helpers import _enrich_items, _enrich_note_items, _stock_locations_for, _get_balance
from helpers.stock_helpers import _enrich_with_parent_assignee
from helpers.note_helpers import current_fy_label, _alloc_serial, _key
from helpers.status_helpers import _recompute_str_status, _transfer_other_qty, _transfer_other_src_loc_qty
from helpers.validation import _validate_transfer_request_items, _validate_transfer_request_qty, _validate_transfer_note_items, _validate_transfer_note_constraints, _box_id_required_for_rack

router = APIRouter()


async def _audit_transfer(action: str, user: dict, ref_collection: str, ref_id: str, old=None, new=None):
    await db.inventory_audit_logs.insert_one({
        "id": str(uuid.uuid4()),
        "module": "stock_transfer",
        "action": action,
        "ref_collection": ref_collection,
        "ref_id": ref_id,
        "old_value": old,
        "new_value": new,
        "created_at": now_iso(),
        "created_by": user.get("email", ""),
    })


def _sum_transfer_like_items(items: list[dict]) -> dict:
    sums = {}
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        sums[k] = sums.get(k, 0) + float(it.get("quantity") or 0)
    return sums


def _remaining_assigned_items(assigned_items: list[dict], transferred_items: list[dict]) -> list[dict]:
    moved = _sum_transfer_like_items(transferred_items)
    remaining = []
    for it in assigned_items or []:
        row = dict(it)
        k = _key(row.get("part_no"), row.get("make"))
        rem = max(0, float(row.get("quantity") or 0) - moved.get(k, 0))
        if rem > 1e-6:
            row["quantity"] = rem
            remaining.append(row)
    return remaining


async def _next_transfer_note_doc(base: dict, user: dict, assigned_items: list[dict], parent_transfer_note_id=None, execution_attempt=1):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("stn", fy)
        stn_no = f"STN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "stn_no": stn_no,
            "stn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "transfer_request_id": base["id"] if "str_no" in base else base["transfer_request_id"],
            "transfer_request_no": base.get("str_no") or base.get("transfer_request_no", ""),
            "transfer_request_date": base.get("str_date") or base.get("transfer_request_date", ""),
            "parent_transfer_note_id": parent_transfer_note_id,
            "execution_attempt": execution_attempt,
            "assigned_items": assigned_items,
            "items": [],
            "status": "PENDING",
            "auto_created": True,
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.transfer_notes.insert_one(doc)
            doc.pop("_id", None)
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-note number: {last_err}")


async def _auto_create_transfer_note_for_request(str_doc: dict, user: dict):
    existing = await db.transfer_notes.find_one({"transfer_request_id": str_doc["id"], "parent_transfer_note_id": {"$in": [None, ""]}}, {"_id": 0})
    if existing:
        return existing
    return await _next_transfer_note_doc(str_doc, user, str_doc.get("items", []), None, 1)


async def _create_followup_transfer_note(parent_stn: dict, assigned_items: list[dict], user: dict):
    if not assigned_items:
        return None
    existing = await db.transfer_notes.find_one({"parent_transfer_note_id": parent_stn["id"]}, {"_id": 0})
    if existing:
        return existing
    return await _next_transfer_note_doc(
        parent_stn,
        user,
        assigned_items,
        parent_stn["id"],
        int(parent_stn.get("execution_attempt") or 1) + 1,
    )


@router.get("/transfer-requests/lookup/{part_no}")
async def transfer_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """Reuse the issue-note lookup: makes with positive stock for this part_no."""
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    return {"makes": [{"make": p["_id"]["make"], "available_qty": p["q"]} for p in pairs]}


@router.get("/transfer-requests/next-no")
async def next_transfer_request_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.transfer_requests.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_str_no": f"STR/{fy}/{next_serial:03d}",
        "str_date": today.date().isoformat(),
    }


@router.post("/transfer-requests", response_model=TransferRequest)
async def create_transfer_request(payload: TransferRequestCreate, user=Depends(get_current_user)):
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("str", fy)
        str_no = f"STR/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "str_no": str_no,
            "str_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "purpose": (payload.purpose or "").strip(),
            "items": [it.model_dump() for it in payload.items],
            "status": "PENDING",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.transfer_requests.insert_one(doc)
            doc.pop("_id", None)
            try:
                stn = await _auto_create_transfer_note_for_request(doc, user)
                await _audit_transfer("request.created", user, "transfer_requests", doc["id"], None, doc)
                await _audit_transfer("transfer_note.generated", user, "transfer_notes", stn["id"], None, stn)
                await _recompute_str_status(doc["id"])
            except Exception:
                await db.transfer_requests.delete_one({"id": doc["id"]})
                await db.transfer_notes.delete_many({"transfer_request_id": doc["id"], "status": "PENDING", "items": []})
                raise
            await _notify(
                actor=user, type="transfer_request.created", module="stock_transfer",
                title=f"Transfer Request {str_no}",
                message=f"{user.get('email')} created {str_no} with {len(doc['items'])} item(s) — transfer pending.",
                audience="module", ref_collection="transfer_requests", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="transfer_request.assigned", module="stock_transfer",
                    title=f"Assigned to you: {str_no}",
                    message=f"{user.get('email')} assigned Transfer Request {str_no} to you.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="transfer_requests", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-request number: {last_err}")


@router.get("/transfer-requests")
async def list_transfer_requests(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.transfer_requests.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_requests.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    for row in rows:
        requested = sum(float(it.get("quantity") or 0) for it in row.get("items", []))
        moved = 0
        async for stn in db.transfer_notes.find({"transfer_request_id": row["id"], "status": {"$in": ["COMPLETED", "RECORDED"]}}, {"_id": 0, "items": 1}):
            moved += sum(float(it.get("quantity") or 0) for it in stn.get("items", []))
        row["requested_qty_total"] = requested
        row["transferred_qty_total"] = moved
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/transfer-requests/{str_id}")
async def get_transfer_request(str_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    await _enrich_note_items([doc])
    requested = sum(float(it.get("quantity") or 0) for it in doc.get("items", []))
    moved = 0
    async for stn in db.transfer_notes.find({"transfer_request_id": doc["id"], "status": {"$in": ["COMPLETED", "RECORDED"]}}, {"_id": 0, "items": 1}):
        moved += sum(float(it.get("quantity") or 0) for it in stn.get("items", []))
    doc["requested_qty_total"] = requested
    doc["transferred_qty_total"] = moved
    return doc


@router.put("/transfer-requests/{str_id}", response_model=TransferRequest)
async def update_transfer_request(str_id: str, payload: TransferRequestCreate, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "edit this transfer request")
    if await db.transfer_notes.find_one({"transfer_request_id": str_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — transfer notes have been created. Delete those first.")
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items, exclude_str_id=str_id)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    update = {
        "purpose": (payload.purpose or "").strip(),
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
        **assignee,
    }
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="transfer_request.assigned", module="stock_transfer",
            title=f"Assigned to you: {existing.get('str_no', '')}",
            message=f"{user.get('email')} assigned Transfer Request {existing.get('str_no', '')} to you.",
            audience="user", target_user_id=new_aid,
            ref_collection="transfer_requests", ref_id=str_id,
        )
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    return doc


@router.delete("/transfer-requests/{str_id}")
async def delete_transfer_request(str_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "delete this transfer request")
    if await db.transfer_notes.find_one({"transfer_request_id": str_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — transfer notes exist. Delete them first.")
    await db.transfer_requests.delete_one({"id": str_id})
    return {"ok": True}


# ---------- Transfer Note ----------
@router.get("/transfer-notes/next-no")
async def next_transfer_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.transfer_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_stn_no": f"STN/{fy}/{next_serial:03d}",
        "stn_date": today.date().isoformat(),
    }


@router.get("/transfer-notes/prepare/{str_id}")
async def prepare_transfer_note(str_id: str, exclude_stn_id: Optional[str] = None, user=Depends(get_current_user)):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    if s.get("status") in ("FULLY_TRANSFERRED", "COMPLETED", "CLOSED") and not exclude_stn_id:
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")

    stn_scope = None
    if exclude_stn_id:
        stn_scope = await db.transfer_notes.find_one({"id": exclude_stn_id}, {"_id": 0})
    other_sums = {} if stn_scope else await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    items_out = []
    for it in ((stn_scope or {}).get("assigned_items") or s.get("items", [])):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        requested_qty = it.get("quantity", 0) or 0
        already = other_sums.get(_key(part_no, make), 0)
        pending = requested_qty - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        locs = await _stock_locations_for(part_no, make)
        for L in locs:
            reserved = other_loc_sums.get(
                f"{part_no}||{make}||{L.get('godown_id', '') or ''}||{L.get('rack_id', '') or ''}||{L.get('box_id', '') or ''}",
                0,
            )
            L["available_qty"] = max(0, L["current_qty"] - reserved)
        pickable = [L for L in locs if L["available_qty"] > 0]
        prefill = pickable[0] if len(pickable) == 1 and pickable[0]["available_qty"] >= pending else None

        items_out.append({
            "part_no": part_no, "make": make,
            "requested_qty": requested_qty,
            "already_transferred_qty": already,
            "pending_qty": pending,
            "quantity": prefill["available_qty"] if prefill else (min(pending, pickable[0]["available_qty"]) if pickable else 0),
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            # Source prefill
            "src_godown_id": prefill["godown_id"] if prefill else "",
            "src_godown_name": prefill["godown_name"] if prefill else "",
            "src_rack_id": prefill["rack_id"] if prefill else "",
            "src_rack_no": prefill["rack_no"] if prefill else "",
            "src_box_id": prefill["box_id"] if prefill else "",
            "src_box_no": prefill["box_no"] if prefill else "",
            "src_box_category": prefill.get("box_category", "") if prefill else "",
            # Destination from request
            "dest_godown_id": it.get("dest_godown_id", "") or "",
            "dest_godown_name": it.get("dest_godown_name", "") or "",
            "dest_rack_id": it.get("dest_rack_id", "") or "",
            "dest_rack_no": it.get("dest_rack_no", "") or "",
            "dest_box_id": it.get("dest_box_id", "") or "",
            "dest_box_no": it.get("dest_box_no", "") or "",
            "dest_box_category": it.get("dest_box_category", "") or "",
            "available_locations": locs,
        })

    return {
        "transfer_request": {
            "id": s["id"], "str_no": s["str_no"], "str_date": s["str_date"],
            "purpose": s.get("purpose", ""), "status": s.get("status"),
        },
        "items": items_out,
    }


@router.post("/transfer-notes", response_model=TransferNote)
async def create_transfer_note(payload: TransferNoteCreate, user=Depends(get_current_user)):
    s = await db.transfer_requests.find_one({"id": payload.transfer_request_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    _enforce_assignee(s, user, "create a transfer note for this request")
    if s.get("status") in ("FULLY_TRANSFERRED", "COMPLETED", "CLOSED"):
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")
    if await db.transfer_notes.find_one({"transfer_request_id": s["id"], "status": {"$in": ["PENDING", "DRAFT", "PROCESSING"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="An active Transfer Note already exists for this request")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if (it.dest_rack_id or "").strip() and not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    await _validate_transfer_note_constraints(s["id"], payload.items, exclude_stn_id=None, assigned_items=s.get("items", []))

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("stn", fy)
        stn_no = f"STN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "stn_no": stn_no,
            "stn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "transfer_request_id": s["id"],
            "transfer_request_no": s["str_no"],
            "transfer_request_date": s["str_date"],
            "parent_transfer_note_id": None,
            "execution_attempt": 1,
            "assigned_items": s.get("items", []),
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.transfer_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_str_status(s["id"])
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-note number: {last_err}")


@router.get("/transfer-notes")
async def list_transfer_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    transfer_request_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if transfer_request_id:
        query["transfer_request_id"] = transfer_request_id
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    if not transfer_request_id and not status and not not_status:
        query["status"] = {"$in": ["PENDING", "DRAFT", "PROCESSING"]}
    total = await db.transfer_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "transfer_requests", "transfer_request_id")
    for row in rows:
        row["assigned_qty_total"] = sum(float(it.get("quantity") or 0) for it in (row.get("assigned_items") or []))
        row["transferred_qty_total"] = sum(float(it.get("quantity") or 0) for it in (row.get("items") or []))
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/transfer-notes/{stn_id}")
async def get_transfer_note(stn_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "transfer_requests", "transfer_request_id")
    doc["assigned_qty_total"] = sum(float(it.get("quantity") or 0) for it in (doc.get("assigned_items") or []))
    doc["transferred_qty_total"] = sum(float(it.get("quantity") or 0) for it in (doc.get("items") or []))
    return doc


@router.put("/transfer-notes/{stn_id}", response_model=TransferNote)
async def update_transfer_note(stn_id: str, payload: TransferNoteCreate, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") in ("RECORDED", "COMPLETED", "PROCESSING"):
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "edit this transfer note")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if (it.dest_rack_id or "").strip() and not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    assigned_items = existing.get("assigned_items") or parent.get("items", [])
    await _validate_transfer_note_constraints(existing.get("transfer_request_id"), payload.items, exclude_stn_id=stn_id, assigned_items=assigned_items)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "status": "DRAFT",
        "updated_at": now_iso(),
    }
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": update})
    await _audit_transfer("transfer_note.draft_saved", user, "transfer_notes", stn_id, {"items": existing.get("items", []), "status": existing.get("status")}, update)
    await _recompute_str_status(existing.get("transfer_request_id"))
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    return doc


@router.delete("/transfer-notes/{stn_id}")
async def delete_transfer_note(stn_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") in ("RECORDED", "COMPLETED", "PROCESSING"):
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "delete this transfer note")
    await db.transfer_notes.delete_one({"id": stn_id})
    if existing.get("transfer_request_id"):
        await _recompute_str_status(existing["transfer_request_id"])
    return {"ok": True}


@router.post("/transfer-notes/{stn_id}/record")
async def record_transfer_note(stn_id: str, user=Depends(get_current_user)):
    stn = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not stn:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if stn.get("status") in ("RECORDED", "COMPLETED"):
        raise HTTPException(status_code=409, detail="Already recorded")
    if stn.get("status") != "DRAFT":
        raise HTTPException(status_code=409, detail="Transfer Note must be saved as Draft before completion")
    parent = await db.transfer_requests.find_one({"id": stn.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "record this transfer note")
    items = stn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    assigned_items = stn.get("assigned_items") or parent.get("items", [])
    item_models = [TransferNoteItem(**it) for it in items]
    await _validate_transfer_note_constraints(stn.get("transfer_request_id"), item_models, exclude_stn_id=stn_id, assigned_items=assigned_items)
    remaining_items = _remaining_assigned_items(assigned_items, items)
    now = now_iso()
    locked = await db.transfer_notes.update_one(
        {"id": stn_id, "status": "DRAFT"},
        {"$set": {"status": "PROCESSING", "processing_started_at": now}},
    )
    if locked.modified_count != 1:
        latest = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0, "status": 1})
        if latest and latest.get("status") in ("COMPLETED", "RECORDED"):
            raise HTTPException(status_code=409, detail="Transfer already completed")
        raise HTTPException(status_code=409, detail="Transfer Note is already being processed")
    if await db.transactions.find_one({"transfer_note_id": stn_id}, {"_id": 0, "id": 1}):
        await db.transfer_notes.update_one({"id": stn_id, "status": "PROCESSING"}, {"$set": {"status": "COMPLETED"}, "$unset": {"processing_started_at": ""}})
        raise HTTPException(status_code=409, detail="Transfer already completed")
    # Final source-balance check (real balance, not DRAFT-aware)
    tx_docs = []
    child_stn = None
    try:
        for idx, it in enumerate(items, start=1):
            bal = await db.transactions.aggregate([
                {"$match": {
                    "part_no": it["part_no"], "make": it["make"],
                    "godown_id": it.get("src_godown_id", ""),
                    "rack_id": it.get("src_rack_id", ""),
                    "box_id": it.get("src_box_id", ""),
                }},
                {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
            ]).to_list(1)
            avail = (bal[0]["q"] if bal else 0)
            if avail < it["quantity"] - 1e-6:
                raise HTTPException(status_code=400, detail=(
                    f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at source "
                    f"{it.get('src_godown_name')}/{it.get('src_rack_no')}/{it.get('src_box_no') or '—'}: have {avail}, need {it['quantity']}"
                ))
        for it in items:
            master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
            common = {
                "part_no": it["part_no"], "make": it["make"],
                "model": master.get("model", it.get("model", "")),
                "old_part_no": master.get("old_part_no", it.get("old_part_no", "")),
                "make_part_no": master.get("make_part_no", it.get("make_part_no", "")),
                "description_1": master.get("description_1", it.get("description_1", "")),
                "description_2": master.get("description_2", it.get("description_2", "")),
                "remarks_oem": master.get("remarks_oem", it.get("remarks_oem", "")),
                "remarks_others": master.get("remarks_others", it.get("remarks_others", "")),
                "item_category": master.get("item_category", it.get("item_category", "")),
                "image": master.get("image", ""),
                "quantity": it["quantity"],
                "transfer_note_id": stn["id"], "transfer_note_no": stn["stn_no"],
                "transfer_request_id": stn.get("transfer_request_id", ""),
                "transfer_request_no": stn.get("transfer_request_no", ""),
                "created_at": now, "created_by": user.get("email"),
            }
            tx_docs.append({**common, "id": str(uuid.uuid4()), "type": "OUT", "godown_id": it["src_godown_id"], "godown_name": it.get("src_godown_name", ""), "rack_id": it["src_rack_id"], "rack_no": it.get("src_rack_no", ""), "box_id": it.get("src_box_id", ""), "box_no": it.get("src_box_no", ""), "box_category": it.get("src_box_category", "")})
            tx_docs.append({**common, "id": str(uuid.uuid4()), "type": "IN", "godown_id": it["dest_godown_id"], "godown_name": it.get("dest_godown_name", ""), "rack_id": it.get("dest_rack_id", ""), "rack_no": it.get("dest_rack_no", ""), "box_id": it.get("dest_box_id", ""), "box_no": it.get("dest_box_no", ""), "box_category": it.get("dest_box_category", "")})
        if tx_docs:
            await db.transactions.insert_many(tx_docs)
        await db.transfer_notes.update_one({"id": stn_id, "status": "PROCESSING"}, {"$set": {"status": "COMPLETED", "recorded_at": now}, "$unset": {"processing_started_at": ""}})
        if remaining_items:
            child_stn = await _create_followup_transfer_note(stn, remaining_items, user)
        if stn.get("transfer_request_id"):
            await _recompute_str_status(stn["transfer_request_id"])
        total_qty = sum(int(it.get("quantity") or 0) for it in items)
        await _audit_transfer("transfer_note.completed", user, "transfer_notes", stn_id, {"status": "DRAFT"}, {"status": "COMPLETED", "items": items})
        await _notify(actor=user, type="stock_transfer.recorded", module="stock_transfer", title=f"Stock Transfer completed ({stn['stn_no']})", message=f"{user.get('email')} transferred {len(items)} item(s), total qty {total_qty}, from {stn.get('transfer_request_no') or 'STR'}.", audience="module", ref_collection="transfer_notes", ref_id=stn_id)
        return {"ok": True, "transactions_created": len(tx_docs), "remaining_transfer_note": child_stn}
    except Exception:
        if tx_docs:
            await db.transactions.delete_many({"id": {"$in": [t["id"] for t in tx_docs]}})
        if child_stn:
            await db.transfer_notes.delete_one({"id": child_stn["id"]})
        await db.transfer_notes.update_one({"id": stn_id, "status": "PROCESSING"}, {"$set": {"status": "DRAFT"}, "$unset": {"processing_started_at": ""}})
        raise
