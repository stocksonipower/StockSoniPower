from fastapi import APIRouter, Depends, HTTPException, Query, Response
from datetime import datetime, timezone
from typing import Optional
import uuid
from pymongo.errors import DuplicateKeyError

from deps import db, get_current_user, now_iso, _notify, _resolve_assignee, _enforce_assignee
from models import *
from helpers.stock_helpers import _enrich_items, _enrich_note_items, _stock_locations_for, _get_balance
from helpers.stock_helpers import _enrich_with_parent_assignee
from helpers.note_helpers import current_fy_label, note_date_key, _next_serial, _key
from helpers.status_helpers import _recompute_str_status, _transfer_other_qty, _transfer_other_src_loc_qty
from helpers.validation import _validate_transfer_request_items, _validate_transfer_request_qty, _validate_transfer_note_items, _validate_transfer_note_constraints, _box_id_required_for_rack
from services.unit_of_work import unit_of_work
from services.locking import location_locks
from helpers.audit import _write_audit_log

router = APIRouter()


async def _audit_transfer(action: str, user: dict, ref_collection: str, ref_id: str, old=None, new=None):
    await _write_audit_log(module="stock_transfer", action=action, actor=user,
                            ref_collection=ref_collection, ref_id=ref_id, old=old, new=new)


def _transfer_src_lock_key(it: dict) -> str:
    """Same key format as stock_out.py's `_stock_out_lock_key`, over the SOURCE location.
    Sharing the `stock_out_locks` collection (not just the format) means a Transfer Note
    completion and a Picking Note completion drawing from the same physical location can
    never both pass their balance check at once — closing the cross-module race that
    could otherwise drive a location's stock negative."""
    return "||".join([
        it.get("part_no", ""),
        it.get("make", ""),
        it.get("src_godown_id", ""),
        it.get("src_rack_id", ""),
        it.get("src_box_id", ""),
    ])


def _sum_transfer_like_items(items: list[dict]) -> dict:
    sums = {}
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        # transferred + rejected both resolve the requested qty — neither needs re-transfer.
        sums[k] = sums.get(k, 0) + float(it.get("quantity") or 0) + float(it.get("rejected_qty") or 0)
    return sums


def _remaining_assigned_items(assigned_items: list[dict], transferred_items: list[dict]) -> list[dict]:
    """What still needs transferring, line by line, driven by the ACTUAL moved quantity.

    The moved quantity is a single pool per (part, make) — the operator records what came
    off which shelf, not which of several identical request lines it was for. So the pool
    is CONSUMED line by line in order: 15 moved against lines of 15 and 5 leaves the
    second line's 5 outstanding, instead of both lines seeing the full 15 and the
    remainder silently vanishing with no follow-up note.
    """
    pool = _sum_transfer_like_items(transferred_items)
    remaining = []
    for it in assigned_items or []:
        row = dict(it)
        k = _key(row.get("part_no"), row.get("make"))
        assigned_qty = float(row.get("quantity") or 0)
        used = min(pool.get(k, 0), assigned_qty)
        pool[k] = pool.get(k, 0) - used
        rem = assigned_qty - used
        if rem > 1e-6:
            row["quantity"] = rem
            remaining.append(row)
    return remaining


async def _next_transfer_note_doc(base: dict, user: dict, assigned_items: list[dict], parent_transfer_note_id=None, execution_attempt=1):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _next_serial("transfer_notes")
        stn_no = f"STN/{note_date_key(today)}/{serial:02d}"
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
    makes = [p["_id"]["make"] for p in pairs]
    sm_by_make = {}
    if makes:
        async for sm in db.stock_master.find(
            {"part_no": part_no, "make": {"$in": makes}},
            {"_id": 0, "make": 1, "model": 1},
        ):
            sm_by_make[sm.get("make")] = sm
    return {"makes": [
        {
            "make": p["_id"]["make"], "available_qty": p["q"],
            "model": sm_by_make.get(p["_id"]["make"], {}).get("model", "") or "",
        }
        for p in pairs
    ]}


@router.get("/transfer-requests/lookup-locations/{part_no}/{make}")
async def transfer_lookup_locations(part_no: str, make: str, user=Depends(get_current_user)):
    """Locations currently holding stock for this part/make, so the requester's
    optional Source dropdown can be capped per-location instead of by the grand total."""
    return {"locations": await _stock_locations_for(part_no, make)}


@router.get("/transfer-requests/next-no")
async def next_transfer_request_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    last = await db.transfer_requests.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_str_no": f"STR/{note_date_key(today)}/{next_serial:02d}",
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
        serial = await _next_serial("transfer_requests")
        str_no = f"STR/{note_date_key(today)}/{serial:02d}"
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
    search: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if search:
        s = search.strip()
        query["$or"] = [
            {"str_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
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
        rejected = 0
        async for stn in db.transfer_notes.find({"transfer_request_id": row["id"], "status": {"$in": ["COMPLETED", "RECORDED"]}}, {"_id": 0, "items": 1}):
            moved += sum(float(it.get("quantity") or 0) for it in stn.get("items", []))
            rejected += sum(float(it.get("rejected_qty") or 0) for it in stn.get("items", []))
        row["requested_qty_total"] = requested
        row["transferred_qty_total"] = moved
        row["rejected_qty_total"] = rejected
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
    rejected = 0
    async for stn in db.transfer_notes.find({"transfer_request_id": doc["id"], "status": {"$in": ["COMPLETED", "RECORDED"]}}, {"_id": 0, "items": 1}):
        moved += sum(float(it.get("quantity") or 0) for it in stn.get("items", []))
        rejected += sum(float(it.get("rejected_qty") or 0) for it in stn.get("items", []))
    doc["requested_qty_total"] = requested
    doc["transferred_qty_total"] = moved
    doc["rejected_qty_total"] = rejected
    return doc


@router.put("/transfer-requests/{str_id}", response_model=TransferRequest)
async def update_transfer_request(str_id: str, payload: TransferRequestCreate, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "edit this transfer request")
    # Editable until the first quantity is actually transferred — a Transfer Note is
    # always auto-created immediately (PENDING/DRAFT), so its mere existence must not
    # block editing; only a COMPLETED (processed) note does.
    if await db.transfer_notes.find_one({"transfer_request_id": str_id, "status": {"$in": ["RECORDED", "COMPLETED"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="Cannot edit — transfer has already started on this request")
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items, exclude_str_id=str_id)
    new_items = [it.model_dump() for it in payload.items]
    # Only cascade-reset in-progress Transfer Note drafts if the requested qty actually
    # changed — a no-op re-save (e.g. only reassigning) must not discard an operator's
    # already-entered (but not yet recorded) allocation.
    items_changed = _sum_transfer_like_items(existing.get("items", [])) != _sum_transfer_like_items(new_items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    update = {
        "purpose": (payload.purpose or "").strip(),
        "items": new_items,
        "updated_at": now_iso(),
        **assignee,
    }
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})
    if items_changed:
        # Propagate the edited request into every not-yet-processed Transfer Note so
        # allocation/availability/preview never show a stale requested quantity — but
        # KEEP what the operator has already entered. A quantity typed against a physical
        # shelf is their own observation of what was actually moved/staged; the office
        # revising the request must not silently erase it. The draft stays fully editable
        # until it is completed.
        valid_keys = {_key(it.get("part_no"), it.get("make")) for it in update["items"]}
        async for stn in db.transfer_notes.find(
            {"transfer_request_id": str_id, "status": {"$nin": ["RECORDED", "COMPLETED"]}},
            {"_id": 0, "id": 1, "items": 1},
        ):
            # Only rows for items the request no longer asks for are dropped — they would
            # otherwise fail the "not on the linked transfer request" check on next save.
            kept = [
                it for it in (stn.get("items") or [])
                if _key(it.get("part_no"), it.get("make")) in valid_keys
            ]
            await db.transfer_notes.update_one(
                {"id": stn["id"]},
                {"$set": {"assigned_items": update["items"], "items": kept, "updated_at": now_iso()}},
            )
    await _audit_transfer("request.edited", user, "transfer_requests", str_id,
                           {"items": existing.get("items", [])}, {"items": update["items"]})
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="transfer_request.assigned", module="stock_transfer",
            title=f"Assigned to you: {existing.get('str_no', '')}",
            message=f"{user.get('email')} assigned Transfer Request {existing.get('str_no', '')} to you.",
            audience="user", target_user_id=new_aid,
            ref_collection="transfer_requests", ref_id=str_id,
        )
    await _recompute_str_status(str_id)
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    return doc


@router.delete("/transfer-requests/{str_id}")
async def delete_transfer_request(str_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "delete this transfer request")
    if await db.transfer_notes.find_one({"transfer_request_id": str_id, "status": {"$in": ["RECORDED", "COMPLETED"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="Cannot delete — transfer has already started on this request")
    await db.transfer_notes.delete_many({"transfer_request_id": str_id})
    await db.transfer_requests.delete_one({"id": str_id})
    return {"ok": True}


# ---------- Transfer Note ----------
@router.get("/transfer-notes/next-no")
async def next_transfer_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    last = await db.transfer_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_stn_no": f"STN/{note_date_key(today)}/{next_serial:02d}",
        "stn_date": today.date().isoformat(),
    }


@router.get("/transfer-notes/prepare/{str_id}")
async def prepare_transfer_note(str_id: str, exclude_stn_id: Optional[str] = None, user=Depends(get_current_user)):
    """Prepare Transfer Note rows for a Transfer Request.

    Source resolution (never left blank when inventory location is known):
      - If the request fully specified a source (down to box), use exactly that
        location — the request's decision is authoritative.
      - If the request specified only part of the source (godown, or godown+rack) or
        nothing at all, auto-resolve the rest against current inventory, narrowed by
        whatever *was* specified. When more than one location still qualifies, the
        pending quantity is greedily split across all of them (one row per location —
        "Multiple Source Locations" — never merged), same order/logic as
        `_allocate_locations_for`.

    Both source AND destination remain freely editable in the Transfer Note form —
    this only decides what's pre-filled, never locks the operator's choice (unlike
    Picking's authorized-location restriction).
    """
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    if s.get("status") == "COMPLETE" and not exclude_stn_id:
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")

    stn_scope = None
    if exclude_stn_id:
        stn_scope = await db.transfer_notes.find_one({"id": exclude_stn_id}, {"_id": 0})
    other_sums = {} if stn_scope else await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    def _avail(part_no, make, L):
        reserved = other_loc_sums.get(
            f"{part_no}||{make}||{L.get('godown_id', '') or ''}||{L.get('rack_id', '') or ''}||{L.get('box_id', '') or ''}", 0,
        )
        return max(0, L["current_qty"] - reserved)

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
            L["available_qty"] = _avail(part_no, make, L)

        common = {
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
            # Destination from request — pre-filled but freely editable in the form.
            "dest_godown_id": it.get("dest_godown_id", "") or "",
            "dest_godown_name": it.get("dest_godown_name", "") or "",
            "dest_rack_id": it.get("dest_rack_id", "") or "",
            "dest_rack_no": it.get("dest_rack_no", "") or "",
            "dest_box_id": it.get("dest_box_id", "") or "",
            "dest_box_no": it.get("dest_box_no", "") or "",
            "dest_box_category": it.get("dest_box_category", "") or "",
            "available_locations": locs,
        }

        req_src_godown = (it.get("src_godown_id") or "").strip()
        req_src_rack = (it.get("src_rack_id") or "").strip()
        req_src_box = (it.get("src_box_id") or "").strip()

        if req_src_box:
            # Case 1: request fully specified the source — authoritative, use as-is.
            match = next((L for L in locs if L.get("box_id") == req_src_box), None)
            avail = match["available_qty"] if match else 0
            items_out.append({
                **common, "quantity": min(pending, avail),
                "src_godown_id": it.get("src_godown_id", ""), "src_godown_name": it.get("src_godown_name", ""),
                "src_rack_id": it.get("src_rack_id", ""), "src_rack_no": it.get("src_rack_no", ""),
                "src_box_id": it.get("src_box_id", ""), "src_box_no": it.get("src_box_no", ""),
                "src_box_category": it.get("src_box_category", ""),
            })
            continue

        # Case 2: source blank or only partially specified — auto-resolve against
        # current inventory, narrowed by whatever was given, split across every
        # qualifying location until the pending qty is covered.
        candidates = locs
        if req_src_godown:
            candidates = [L for L in candidates if L.get("godown_id") == req_src_godown]
        if req_src_rack:
            candidates = [L for L in candidates if L.get("rack_id") == req_src_rack]
        remaining = pending
        allocated_any = False
        for L in candidates:
            if remaining <= 1e-9:
                break
            take = min(remaining, L["available_qty"])
            if take <= 1e-9:
                continue
            allocated_any = True
            items_out.append({
                **common, "quantity": take,
                "src_godown_id": L.get("godown_id", ""), "src_godown_name": L.get("godown_name", ""),
                "src_rack_id": L.get("rack_id", ""), "src_rack_no": L.get("rack_no", ""),
                "src_box_id": L.get("box_id", ""), "src_box_no": L.get("box_no", ""),
                "src_box_category": L.get("box_category", ""),
            })
            remaining -= take
        if not allocated_any:
            # Nothing currently available that qualifies — still surface one row (with
            # whatever source specificity the request gave) so the line isn't silently
            # dropped; the operator resolves it manually.
            items_out.append({
                **common, "quantity": 0,
                "src_godown_id": it.get("src_godown_id", ""), "src_godown_name": it.get("src_godown_name", ""),
                "src_rack_id": it.get("src_rack_id", ""), "src_rack_no": it.get("src_rack_no", ""),
                "src_box_id": "", "src_box_no": "", "src_box_category": "",
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
    if s.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")

    # Atomic guard: without this, two concurrent create-requests for the same
    # Transfer Request (double-click, two operators, or a client retry) could both
    # pass the "no active note exists" check below before either inserts, producing
    # two active Transfer Notes for one request.
    note_lock_key = f"str_note_slot::{s['id']}"
    try:
        await db.stock_out_locks.insert_one({"_id": note_lock_key, "transfer_request_id": s["id"], "created_at": now_iso()})
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Another request is already creating a Transfer Note for this request — please retry")
    try:
        if await db.transfer_notes.find_one({"transfer_request_id": s["id"], "status": {"$in": ["PENDING", "DRAFT", "PROCESSING"]}}, {"_id": 0, "id": 1}):
            raise HTTPException(status_code=409, detail="An active Transfer Note already exists for this request")
        await _validate_transfer_note_items(payload.items)
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
            serial = await _next_serial("transfer_notes")
            stn_no = f"STN/{note_date_key(today)}/{serial:02d}"
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
    finally:
        await db.stock_out_locks.delete_one({"_id": note_lock_key})


@router.get("/transfer-notes")
async def list_transfer_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    transfer_request_id: Optional[str] = None,
    search: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if transfer_request_id:
        query["transfer_request_id"] = transfer_request_id
    if search:
        s = search.strip()
        query["$or"] = [
            {"stn_no": {"$regex": s, "$options": "i"}},
            {"transfer_request_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    # No implicit status filter: a completed Transfer Note is the record of stock that
    # physically moved and must stay visible in the list. It used to disappear the moment
    # it was completed — and because completion also creates a follow-up note for any
    # remainder, the row appeared to "reset" to 1 item / 0 transferred when it was really
    # a different note. Callers that want only open work pass status explicitly.
    total = await db.transfer_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "transfer_requests", "transfer_request_id")
    for row in rows:
        row["assigned_qty_total"] = sum(float(it.get("quantity") or 0) for it in (row.get("assigned_items") or []))
        row["transferred_qty_total"] = sum(float(it.get("quantity") or 0) for it in (row.get("items") or []))
        row["rejected_qty_total"] = sum(float(it.get("rejected_qty") or 0) for it in (row.get("items") or []))
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
    doc["rejected_qty_total"] = sum(float(it.get("rejected_qty") or 0) for it in (doc.get("items") or []))
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
    await _validate_transfer_note_items(payload.items)
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
    await _validate_transfer_note_items(item_models)  # final re-check on top of the draft-time check
    await _validate_transfer_note_constraints(stn.get("transfer_request_id"), item_models, exclude_stn_id=stn_id, assigned_items=assigned_items)
    remaining_items = _remaining_assigned_items(assigned_items, items)
    now = now_iso()

    # Optimistic claim on the note itself — same primitive Stock In's Racking Note
    # recording uses (repositories/inventory_repo.py: transition_status). Done as a
    # standalone write (not inside the transaction below) so a concurrent double-submit
    # of the SAME note gets exactly this 409, before any location lock is attempted.
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

    # Per-source-location lock: without this, two concurrent completions drawing from
    # the same physical (part, make, godown, rack, box) — whether another Transfer Note
    # or a Picking Note's Stock Out — could both pass the balance check below before
    # either writes its transaction, over-drawing the location into negative stock.
    lock_keys = sorted({_transfer_src_lock_key(it) for it in items})
    tx_docs = []
    try:
        # Lock held across the whole transaction, released only after commit (see
        # services/locking.py) — otherwise a concurrent request could pass its own
        # balance check against not-yet-committed writes the instant the lock frees.
        async with location_locks(
            lock_keys, owner_field="transfer_note_id", owner_value=stn_id,
            conflict_message="Stock at one selected source location is being recorded by another user",
        ):
            async with unit_of_work() as uow:
                # Final source-balance check (real balance, not DRAFT-aware). Fully-
                # rejected rows (quantity == 0, resolved entirely via rejected_qty)
                # move no stock and need no balance check.
                for idx, it in enumerate(items, start=1):
                    if (it.get("quantity") or 0) <= 0:
                        continue
                    bal = await uow.transactions.aggregate([
                        {"$match": {
                            "part_no": it["part_no"], "make": it["make"],
                            "godown_id": it.get("src_godown_id", ""),
                            "rack_id": it.get("src_rack_id", ""),
                            "box_id": it.get("src_box_id", ""),
                        }},
                        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
                    ])
                    avail = (bal[0]["q"] if bal else 0)
                    if avail < it["quantity"] - 1e-6:
                        raise HTTPException(status_code=400, detail=(
                            f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at source "
                            f"{it.get('src_godown_name')}/{it.get('src_rack_no')}/{it.get('src_box_no') or '—'}: have {avail}, need {it['quantity']}"
                        ))
                for it in items:
                    if (it.get("quantity") or 0) <= 0:
                        continue  # fully-rejected row — nothing physically transferred
                    master = await uow.db.stock_master.find_one(
                        {"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}, session=uow.session
                    ) or {}
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
                    await uow.transactions.insert_many(tx_docs)
                finalized = await uow.transfer_notes.transition_status(
                    stn_id, from_status="PROCESSING", to_status="COMPLETED",
                    set_fields={"recorded_at": now}, unset_fields=["processing_started_at"],
                )
                if not finalized:
                    raise HTTPException(status_code=409, detail="Transfer Note recording state changed; transfer was not finalized")

                # Planned-vs-actual audit: the Transfer Request's original source/destination
                # preference (if any) compared against what was actually recorded for each
                # line. "What was planned" must never be lost once the actual location
                # supersedes it everywhere else in the app (previews, reports, inventory).
                planned_by_key = {}
                for pit in (parent.get("items") or []):
                    planned_by_key[_key(pit.get("part_no"), pit.get("make"))] = pit

                def _loc(d, prefix):
                    return {
                        "godown_id": d.get(f"{prefix}_godown_id", "") or "", "godown_name": d.get(f"{prefix}_godown_name", "") or "",
                        "rack_id": d.get(f"{prefix}_rack_id", "") or "", "rack_no": d.get(f"{prefix}_rack_no", "") or "",
                        "box_id": d.get(f"{prefix}_box_id", "") or "", "box_no": d.get(f"{prefix}_box_no", "") or "",
                    }

                location_changes = []
                for it in items:
                    if (it.get("quantity") or 0) <= 0:
                        continue
                    planned = planned_by_key.get(_key(it.get("part_no"), it.get("make"))) or {}
                    planned_src, actual_src = _loc(planned, "src"), _loc(it, "src")
                    planned_dest, actual_dest = _loc(planned, "dest"), _loc(it, "dest")
                    if planned_src != actual_src or planned_dest != actual_dest:
                        location_changes.append({
                            "part_no": it.get("part_no"), "make": it.get("make"),
                            "planned_source": planned_src, "actual_source": actual_src,
                            "planned_destination": planned_dest, "actual_destination": actual_dest,
                        })

                await uow.audit.record(
                    action="transfer_note.completed", actor=user,
                    ref_collection="transfer_notes", ref_id=stn_id,
                    old={"status": "DRAFT"},
                    new={"status": "COMPLETED", "items": items},
                    reason="Actual source/destination differs from the transfer request's plan" if location_changes else "",
                    module="stock_transfer",
                    links={"transfer_request_id": stn.get("transfer_request_id", ""), "location_changes": location_changes},
                )
            # transaction committed here, still holding the location locks
        # location locks released here
    except Exception:
        # Everything inside unit_of_work() above already rolled back automatically on
        # abort (tx_docs, the COMPLETED flip, the audit entry never became durable).
        # Only this note's initial non-transactional claim needs a manual revert.
        await db.transfer_notes.update_one({"id": stn_id, "status": "PROCESSING"}, {"$set": {"status": "DRAFT"}, "$unset": {"processing_started_at": ""}})
        raise

    child_stn = None
    if remaining_items:
        child_stn = await _create_followup_transfer_note(stn, remaining_items, user)
    if stn.get("transfer_request_id"):
        await _recompute_str_status(stn["transfer_request_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    total_rejected = sum(int(it.get("rejected_qty") or 0) for it in items)
    rejected_note = f", rejected {total_rejected}" if total_rejected else ""
    await _notify(actor=user, type="stock_transfer.recorded", module="stock_transfer", title=f"Stock Transfer completed ({stn['stn_no']})", message=f"{user.get('email')} transferred {len(tx_docs) // 2} item(s), total qty {total_qty}{rejected_note}, from {stn.get('transfer_request_no') or 'STR'}.", audience="module", ref_collection="transfer_notes", ref_id=stn_id)
    return {"ok": True, "transactions_created": len(tx_docs), "remaining_transfer_note": child_stn}
