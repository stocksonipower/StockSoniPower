from fastapi import APIRouter, Depends, HTTPException, Query, Response
from datetime import datetime, timezone
from typing import Optional
import uuid
from pymongo.errors import DuplicateKeyError

from deps import db, get_current_user, now_iso, _notify, _resolve_assignee, _enforce_assignee
from deps import _module_dep
from models import *
from helpers.stock_helpers import _enrich_items, _enrich_note_items, _stock_total_for, _stock_locations_for, _get_balance
from helpers.note_helpers import current_fy_label, _alloc_serial, _key
from helpers.status_helpers import _recompute_in_status, _pick_aggregate_other, _pick_aggregate_other_by_loc
from helpers.validation import _validate_txn, _validate_issue_items, _validate_issue_qty_against_stock, _validate_picking_items, _validate_picking_constraints, _box_id_required_for_rack

router = APIRouter()


@router.post("/stock-out")
async def stock_out(payload: StockOutCreate, user=Depends(get_current_user)):
    item, godown, rack, box = await _validate_txn(payload)
    # Check available balance
    balance = await _get_balance(payload.part_no, payload.make, payload.godown_id, payload.rack_id, payload.box_id)
    if balance < payload.quantity:
        raise HTTPException(status_code=400, detail=f"Insufficient stock. Available: {balance}")
    doc = {
        "id": str(uuid.uuid4()),
        "type": "OUT",
        "part_no": payload.part_no,
        "make": payload.make,
        "model": item.get("model", ""),
        "old_part_no": item.get("old_part_no", ""),
        "make_part_no": item.get("make_part_no", ""),
        "description_1": item.get("description_1", ""),
        "description_2": item.get("description_2", ""),
        "remarks_oem": item.get("remarks_oem", ""),
        "remarks_others": item.get("remarks_others", ""),
        "item_category": item.get("item_category", ""),
        "image": item.get("image", ""),
        "quantity": payload.quantity,
        "godown_id": payload.godown_id,
        "godown_name": godown["godown_name"],
        "rack_id": payload.rack_id,
        "rack_no": rack["rack_no"],
        "box_id": payload.box_id,
        "box_no": box["box_no"],
        "box_category": box.get("box_category", ""),
        "created_at": now_iso(),
        "created_by": user.get("email"),
    }
    await db.transactions.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/issue-notes/lookup/{part_no}")
async def issue_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """For Issue Note flow: list makes that have positive stock for this part_no, with available qty."""
    # Pull every (part_no, make) combination that has transactions, then filter to those with positive total
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    return {"makes": [{"make": p["_id"]["make"], "available_qty": p["q"]} for p in pairs]}


@router.get("/issue-notes/next-no")
async def next_issue_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.issue_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_in_no": f"IN/{fy}/{next_serial:03d}",
        "in_date": today.date().isoformat(),
    }


@router.post("/issue-notes", response_model=IssueNote)
async def create_issue_note(payload: IssueNoteCreate, user=Depends(get_current_user)):
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("in", fy)
        in_no = f"IN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "in_no": in_no,
            "in_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issued_to": (payload.issued_to or "").strip(),
            "items": [it.model_dump() for it in payload.items],
            "status": "PICKING_PENDING",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.issue_notes.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="issue_note.created", module="stock_out",
                title=f"Issue Note {in_no}",
                message=f"{user.get('email')} created {in_no} for '{doc['issued_to'] or '—'}' with {len(doc['items'])} item(s) — picking pending.",
                audience="module", ref_collection="issue_notes", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="issue_note.assigned", module="stock_out",
                    title=f"Assigned to you: {in_no}",
                    message=f"{user.get('email')} assigned Issue Note {in_no} to you for picking.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="issue_notes", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate issue-note number: {last_err}")


@router.get("/issue-notes")
async def list_issue_notes(
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
    total = await db.issue_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.issue_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/issue-notes/{in_id}")
async def get_issue_note(in_id: str, user=Depends(get_current_user)):
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Issue note not found")
    await _enrich_note_items([doc])
    return doc


@router.put("/issue-notes/{in_id}", response_model=IssueNote)
async def update_issue_note(in_id: str, payload: IssueNoteCreate, user=Depends(get_current_user)):
    existing = await db.issue_notes.find_one({"id": in_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue note not found")
    _enforce_assignee(existing, user, "edit this issue note")
    if await db.picking_notes.find_one({"issue_note_id": in_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — picking notes have been created. Delete those first.")
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items, exclude_in_id=in_id)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    update = {
        "issued_to": (payload.issued_to or "").strip(),
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
        **assignee,
    }
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="issue_note.assigned", module="stock_out",
            title=f"Assigned to you: {existing.get('in_no', '')}",
            message=f"{user.get('email')} assigned Issue Note {existing.get('in_no', '')} to you for picking.",
            audience="user", target_user_id=new_aid,
            ref_collection="issue_notes", ref_id=in_id,
        )
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    return doc


@router.delete("/issue-notes/{in_id}")
async def delete_issue_note(in_id: str, user=Depends(get_current_user)):
    existing = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue note not found")
    _enforce_assignee(existing, user, "delete this issue note")
    if await db.picking_notes.find_one({"issue_note_id": in_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — picking notes exist for this issue note. Delete them first.")
    await db.issue_notes.delete_one({"id": in_id})
    return {"ok": True}


# -------------------- PICKING NOTES --------------------

@router.get("/picking-notes/next-no")
async def next_picking_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.picking_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_pn_no": f"PN/{fy}/{next_serial:03d}",
        "pn_date": today.date().isoformat(),
    }


@router.get("/picking-notes/prepare/{in_id}")
async def prepare_picking_note(in_id: str, exclude_pn_id: Optional[str] = None, user=Depends(get_current_user)):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=404, detail="Issue note not found")
    if inn.get("status") == "FULLY_PICKED" and not exclude_pn_id:
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    other_sums = await _pick_aggregate_other(in_id, exclude_pn_id)
    other_loc_sums = await _pick_aggregate_other_by_loc(in_id, exclude_pn_id)

    items_out = []
    for it in inn.get("items", []):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        requested_qty = it.get("quantity", 0) or 0
        already = other_sums.get(_key(part_no, make), 0)
        pending = requested_qty - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        locs = await _stock_locations_for(part_no, make)
        # subtract pending DRAFT picks per location to produce "available_for_pick"
        for L in locs:
            reserved = other_loc_sums.get(f"{part_no}||{make}||{L['box_id']}", 0)
            L["available_qty"] = max(0, L["current_qty"] - reserved)
        # Pre-pick if exactly 1 location has enough
        pickable = [L for L in locs if L["available_qty"] > 0]
        prefill = pickable[0] if len(pickable) == 1 and pickable[0]["available_qty"] >= pending else None

        items_out.append({
            "part_no": part_no, "make": make,
            "requested_qty": requested_qty,
            "already_picked_qty": already,
            "pending_qty": pending,
            "quantity": prefill["available_qty"] if prefill else min(pending, pickable[0]["available_qty"]) if pickable else 0,
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            "godown_id": prefill["godown_id"] if prefill else "",
            "godown_name": prefill["godown_name"] if prefill else "",
            "rack_id": prefill["rack_id"] if prefill else "",
            "rack_no": prefill["rack_no"] if prefill else "",
            "box_id": prefill["box_id"] if prefill else "",
            "box_no": prefill["box_no"] if prefill else "",
            "box_category": prefill.get("box_category", "") if prefill else "",
            "available_locations": locs,
        })

    return {
        "issue_note": {
            "id": inn["id"], "in_no": inn["in_no"], "in_date": inn["in_date"],
            "issued_to": inn.get("issued_to", ""), "status": inn.get("status"),
        },
        "items": items_out,
    }


@router.post("/picking-notes", response_model=PickingNote)
async def create_picking_note(payload: PickingNoteCreate, user=Depends(get_current_user)):
    inn = await db.issue_notes.find_one({"id": payload.issue_note_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    _enforce_assignee(inn, user, "create a picking note for this issue")
    if inn.get("status") == "FULLY_PICKED":
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_picking_constraints(inn["id"], payload.items, exclude_pn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("pn", fy)
        pn_no = f"PN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "pn_no": pn_no,
            "pn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issue_note_id": inn["id"],
            "issue_note_no": inn["in_no"],
            "issue_note_date": inn["in_date"],
            "issued_to": inn.get("issued_to", ""),
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.picking_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_in_status(inn["id"])
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate picking-note number: {last_err}")


@router.get("/picking-notes")
async def list_picking_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    from helpers.stock_helpers import _enrich_with_parent_assignee
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.picking_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.picking_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "issue_notes", "issue_note_id")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/picking-notes/{pn_id}")
async def get_picking_note(pn_id: str, user=Depends(get_current_user)):
    from helpers.stock_helpers import _enrich_with_parent_assignee
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Picking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "issue_notes", "issue_note_id")
    return doc


@router.put("/picking-notes/{pn_id}", response_model=PickingNote)
async def update_picking_note(pn_id: str, payload: PickingNoteCreate, user=Depends(get_current_user)):
    existing = await db.picking_notes.find_one({"id": pn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Out")
    in_parent = await db.issue_notes.find_one({"id": existing.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "edit this picking note")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_picking_constraints(existing.get("issue_note_id"), payload.items, exclude_pn_id=pn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.picking_notes.update_one({"id": pn_id}, {"$set": update})
    await _recompute_in_status(existing.get("issue_note_id"))
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    return doc


@router.delete("/picking-notes/{pn_id}")
async def delete_picking_note(pn_id: str, user=Depends(get_current_user)):
    existing = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Out")
    in_parent = await db.issue_notes.find_one({"id": existing.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "delete this picking note")
    await db.picking_notes.delete_one({"id": pn_id})
    if existing.get("issue_note_id"):
        await _recompute_in_status(existing["issue_note_id"])
    return {"ok": True}


@router.post("/picking-notes/{pn_id}/record")
async def record_picking_note(pn_id: str, user=Depends(get_current_user)):
    pn = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not pn:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if pn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    in_parent = await db.issue_notes.find_one({"id": pn.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "record this picking note")
    items = pn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    # Final availability check (real balance, not the DRAFT-pending-aware one)
    for idx, it in enumerate(items, start=1):
        if not it.get("godown_id") or not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown/Rack missing")
        if not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing")
        # Real balance at the box (sum of all IN-OUT for this part/make/box)
        bal = await db.transactions.aggregate([
            {"$match": {"part_no": it["part_no"], "make": it["make"], "box_id": it.get("box_id", "")}},
            {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        ]).to_list(1)
        avail = (bal[0]["q"] if bal else 0)
        if avail < it["quantity"] - 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at "
                f"{it.get('godown_name')}/{it.get('rack_no')}/{it.get('box_no') or '—'}: have {avail}, need {it['quantity']}"
            ))

    now = now_iso()
    tx_docs = []
    for it in items:
        master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
        tx_docs.append({
            "id": str(uuid.uuid4()),
            "type": "OUT",
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
            "godown_id": it["godown_id"], "godown_name": it.get("godown_name", ""),
            "rack_id": it["rack_id"], "rack_no": it.get("rack_no", ""),
            "box_id": it["box_id"], "box_no": it.get("box_no", ""), "box_category": it.get("box_category", ""),
            "picking_note_id": pn["id"], "picking_note_no": pn["pn_no"],
            "issue_note_id": pn.get("issue_note_id", ""), "issue_note_no": pn.get("issue_note_no", ""),
            "issued_to": pn.get("issued_to", ""),
            "created_at": now, "created_by": user.get("email"),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.picking_notes.update_one({"id": pn_id}, {"$set": {"status": "RECORDED", "recorded_at": now}})
    if pn.get("issue_note_id"):
        await _recompute_in_status(pn["issue_note_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_out.recorded", module="stock_out",
        title=f"Stock Out recorded ({pn['pn_no']})",
        message=f"{user.get('email')} issued {len(tx_docs)} item(s), total qty {total_qty} to '{pn.get('issued_to') or '—'}' from {pn.get('issue_note_no') or 'IN'}.",
        audience="module", ref_collection="picking_notes", ref_id=pn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs)}
