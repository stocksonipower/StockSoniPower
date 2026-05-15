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
from helpers.validation import (
    _validate_transfer_request_items, _validate_transfer_request_qty,
    _validate_str_type_godowns,
    _validate_transfer_note_items, _validate_transfer_note_items_draft,
    _validate_transfer_note_constraints, _box_id_required_for_rack,
)

router = APIRouter()


# ─────────────────────── helpers ────────────────────────────────────────────

async def _auto_create_stn_for_str(str_id: str, actor: dict, *, pending_only: bool = False) -> Optional[str]:
    """Auto-create a DRAFT Transfer Note for the given STR.

    pending_only=False (on Finalize): uses full requested qty per item.
    pending_only=True  (on partial record): uses remaining pending qty only.
    Returns the new STN number, or None if nothing to create.
    """
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        return None

    other_sums = await _transfer_other_qty(str_id) if pending_only else {}

    items_out = []
    for it in s.get("items", []):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        requested_qty = float(it.get("quantity") or 0)
        if pending_only:
            already = other_sums.get(_key(part_no, make), 0)
            qty = requested_qty - already
            if qty <= 0:
                continue
        else:
            qty = requested_qty

        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        items_out.append({
            "part_no": part_no,
            "make": make,
            "quantity": qty,
            "model": master.get("model", it.get("model", "")),
            "old_part_no": master.get("old_part_no", it.get("old_part_no", "")),
            "make_part_no": master.get("make_part_no", it.get("make_part_no", "")),
            "description_1": master.get("description_1", it.get("description_1", "")),
            "description_2": master.get("description_2", it.get("description_2", "")),
            "remarks_oem": master.get("remarks_oem", it.get("remarks_oem", "")),
            "remarks_others": master.get("remarks_others", it.get("remarks_others", "")),
            "item_category": master.get("item_category", it.get("item_category", "")),
            # Pre-fill source/dest from STR suggestions (may be empty)
            "src_godown_id": it.get("src_godown_id", "") or "",
            "src_godown_name": it.get("src_godown_name", "") or "",
            "src_rack_id": it.get("src_rack_id", "") or "",
            "src_rack_no": it.get("src_rack_no", "") or "",
            "src_box_id": it.get("src_box_id", "") or "",
            "src_box_no": it.get("src_box_no", "") or "",
            "src_box_category": it.get("src_box_category", "") or "",
            "dest_godown_id": it.get("dest_godown_id", "") or "",
            "dest_godown_name": it.get("dest_godown_name", "") or "",
            "dest_rack_id": it.get("dest_rack_id", "") or "",
            "dest_rack_no": it.get("dest_rack_no", "") or "",
            "dest_box_id": it.get("dest_box_id", "") or "",
            "dest_box_no": it.get("dest_box_no", "") or "",
            "dest_box_category": it.get("dest_box_category", "") or "",
        })

    if not items_out:
        return None

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
            "items": items_out,
            "status": "DRAFT",
            "auto_created": True,
            "narration": "",
            "created_at": now_iso(),
            "created_by": actor.get("email", ""),
        }
        try:
            await db.transfer_notes.insert_one(doc)
            return stn_no
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-note number: {last_err}")


# ─────────────────────── Transfer Request ───────────────────────────────────

@router.get("/transfer-requests/lookup/{part_no}")
async def transfer_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """Makes with positive stock, model/description_1 from stock master, and available locations per make."""
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    master = await db.stock_master.find_one({"part_no": part_no}, {"_id": 0, "model": 1, "description_1": 1})
    model = (master or {}).get("model", "") or ""
    description_1 = (master or {}).get("description_1", "") or ""
    makes = []
    for p in pairs:
        make = p["_id"]["make"]
        locations = await _stock_locations_for(part_no, make)
        makes.append({"make": make, "available_qty": p["q"], "available_locations": locations})
    return {"model": model, "description_1": description_1, "makes": makes}


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
    _validate_str_type_godowns(payload.str_type, payload.items)
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
            "str_type": (payload.str_type or "INTRA").upper(),
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.transfer_requests.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="transfer_request.created", module="stock_transfer",
                title=f"Transfer Request {str_no}",
                message=f"{user.get('email')} created {str_no} with {len(doc['items'])} item(s).",
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
    search: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    if search:
        s = search.strip()
        query["$or"] = [
            {"str_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
    total = await db.transfer_requests.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_requests.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
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
    return doc


@router.put("/transfer-requests/{str_id}", response_model=TransferRequest)
async def update_transfer_request(str_id: str, payload: TransferRequestCreate, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "edit this transfer request")
    if existing.get("status", "") != "DRAFT":
        raise HTTPException(status_code=409, detail="Cannot edit — Transfer Request has been finalized. Only DRAFT requests can be edited.")
    _validate_transfer_request_items(payload.items)
    _validate_str_type_godowns(payload.str_type, payload.items)
    await _validate_transfer_request_qty(payload.items, exclude_str_id=str_id)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    update = {
        "purpose": (payload.purpose or "").strip(),
        "str_type": (payload.str_type or "INTRA").upper(),
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
    if existing.get("status", "") != "DRAFT":
        raise HTTPException(status_code=409, detail="Cannot delete — only DRAFT transfer requests can be deleted.")
    await db.transfer_requests.delete_one({"id": str_id})
    return {"ok": True}


@router.post("/transfer-requests/{str_id}/finalize")
async def finalize_transfer_request(str_id: str, user=Depends(get_current_user)):
    """Finalize a DRAFT STR: locks it, auto-creates a DRAFT Transfer Note."""
    existing = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "finalize this transfer request")
    if existing.get("status", "") != "DRAFT":
        raise HTTPException(status_code=409, detail="Only DRAFT transfer requests can be finalized")

    stn_no = await _auto_create_stn_for_str(str_id, user, pending_only=False)

    await db.transfer_requests.update_one({"id": str_id}, {"$set": {"status": "TRANSFER_NOTE_DRAFT", "finalized_at": now_iso()}})

    str_no = existing.get("str_no", "")
    await _notify(
        actor=user, type="transfer_request.finalized", module="stock_transfer",
        title=f"Transfer Request {str_no} finalized",
        message=f"{user.get('email')} finalized {str_no} — Transfer Note {stn_no} auto-created.",
        audience="module", ref_collection="transfer_requests", ref_id=str_id,
    )
    return {"ok": True, "str_no": str_no, "stn_no": stn_no}


# ─────────────────────── Transfer Note ──────────────────────────────────────

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
    if s.get("status") == "FULLY_TRANSFERRED" and not exclude_stn_id:
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")

    other_sums = await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    items_out = []
    for it in s.get("items", []):
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
            reserved = other_loc_sums.get(f"{part_no}||{make}||{L['box_id']}", 0)
            L["available_qty"] = max(0, L["current_qty"] - reserved)

        items_out.append({
            "part_no": part_no, "make": make,
            "requested_qty": requested_qty,
            "already_transferred_qty": already,
            "pending_qty": pending,
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
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
            "str_type": s.get("str_type", "INTER"),
        },
        "items": items_out,
    }


@router.get("/transfer-notes")
async def list_transfer_notes(
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
    total = await db.transfer_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "transfer_requests", "transfer_request_id")
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
    return doc


@router.put("/transfer-notes/{stn_id}", response_model=TransferNote)
async def update_transfer_note(stn_id: str, payload: TransferNoteCreate, user=Depends(get_current_user)):
    """Save as Draft — relaxed validation, locations may be empty."""
    existing = await db.transfer_notes.find_one({"id": stn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "edit this transfer note")
    _validate_transfer_note_items_draft(payload.items)
    await _validate_transfer_note_constraints(existing.get("transfer_request_id"), payload.items, exclude_stn_id=stn_id, strict=False)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "narration": (payload.narration or "").strip(),
        "updated_at": now_iso(),
    }
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": update})
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    return doc


@router.delete("/transfer-notes/{stn_id}")
async def delete_transfer_note(stn_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "delete this transfer note")
    await db.transfer_notes.delete_one({"id": stn_id})
    str_id = existing.get("transfer_request_id")
    if str_id:
        await _recompute_str_status(str_id)
    return {"ok": True}


@router.post("/transfer-notes/{stn_id}/record")
async def record_transfer_note(stn_id: str, user=Depends(get_current_user)):
    """Save Final — validates locations, creates transactions, auto-creates next STN if partial."""
    stn = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not stn:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if stn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    parent = await db.transfer_requests.find_one({"id": stn.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "record this transfer note")
    items = stn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")

    # Strict validation before recording
    for idx, it in enumerate(items, start=1):
        if not (it.get("part_no") or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not (it.get("make") or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if not (it.get("quantity") or 0) > 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.get("src_godown_id") or "").strip() or not (it.get("src_rack_id") or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown and Rack are required")
        if not (it.get("dest_godown_id") or "").strip() or not (it.get("dest_rack_id") or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown and Rack are required")

    # Box required checks
    for idx, it in enumerate(items, start=1):
        if not (it.get("src_box_id") or "").strip() and await _box_id_required_for_rack(it.get("src_rack_id", "")):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if not (it.get("dest_box_id") or "").strip() and await _box_id_required_for_rack(it.get("dest_rack_id", "")):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")

    # Real-time source balance check — aggregate across rows sharing the same source location
    loc_totals: dict = {}
    for it in items:
        src_box = it.get("src_box_id", "") or ""
        same_loc = (
            it.get("src_godown_id") == it.get("dest_godown_id") and
            it.get("src_rack_id") == it.get("dest_rack_id") and
            src_box == (it.get("dest_box_id", "") or "")
        )
        if same_loc:
            continue
        loc_key = (it["part_no"], it["make"], it["src_godown_id"], it["src_rack_id"], src_box)
        if loc_key not in loc_totals:
            loc_totals[loc_key] = {"qty": 0, "meta": it}
        loc_totals[loc_key]["qty"] += it["quantity"]

    for loc_key, entry in loc_totals.items():
        part_no, make, src_godown_id, src_rack_id, src_box = loc_key
        total_needed = entry["qty"]
        it = entry["meta"]
        avail = await _get_balance(part_no, make, src_godown_id, src_rack_id, src_box)
        if avail < total_needed - 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Insufficient stock for {part_no}/{make} at "
                f"{it.get('src_godown_name')}/{it.get('src_rack_no')}/{it.get('src_box_no') or '—'}: "
                f"have {avail}, total needed across rows {total_needed}"
            ))

    now = now_iso()
    tx_docs = []
    for it in items:
        src_box = it.get("src_box_id", "")
        dest_box = it.get("dest_box_id", "")
        same_loc = (
            it.get("src_godown_id") == it.get("dest_godown_id") and
            it.get("src_rack_id") == it.get("dest_rack_id") and
            src_box == dest_box
        )
        if same_loc:
            continue  # no-op: no transactions created for same-location transfer

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
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "OUT",
            "godown_id": it["src_godown_id"], "godown_name": it.get("src_godown_name", ""),
            "rack_id": it["src_rack_id"], "rack_no": it.get("src_rack_no", ""),
            "box_id": src_box, "box_no": it.get("src_box_no", ""), "box_category": it.get("src_box_category", ""),
        })
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "IN",
            "godown_id": it["dest_godown_id"], "godown_name": it.get("dest_godown_name", ""),
            "rack_id": it["dest_rack_id"], "rack_no": it.get("dest_rack_no", ""),
            "box_id": dest_box, "box_no": it.get("dest_box_no", ""), "box_category": it.get("dest_box_category", ""),
        })

    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": {"status": "RECORDED", "recorded_at": now}})

    str_id = stn.get("transfer_request_id")
    if str_id:
        await _recompute_str_status(str_id)

    # Phase 2: auto-create next STN if STR is now PARTIALLY_TRANSFERRED
    auto_stn_no = None
    if str_id:
        updated_str = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0, "status": 1})
        if updated_str and updated_str.get("status") == "PARTIALLY_TRANSFERRED":
            auto_stn_no = await _auto_create_stn_for_str(str_id, user, pending_only=True)

    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_transfer.recorded", module="stock_transfer",
        title=f"Stock Transfer recorded ({stn['stn_no']})",
        message=f"{user.get('email')} transferred {len(items)} item(s), total qty {total_qty}, from {stn.get('transfer_request_no') or 'STR'}.",
        audience="module", ref_collection="transfer_notes", ref_id=stn_id,
    )

    from fastapi.responses import JSONResponse
    result = {"ok": True, "transactions_created": len(tx_docs)}
    if auto_stn_no:
        result["auto_stn_no"] = auto_stn_no
    response = JSONResponse(content=result)
    if auto_stn_no:
        response.headers["X-Auto-Stn-No"] = auto_stn_no
    response.headers["Access-Control-Expose-Headers"] = "X-Auto-Stn-No"
    return response
