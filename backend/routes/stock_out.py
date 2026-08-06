from fastapi import APIRouter, Depends, HTTPException, Query, Response
from datetime import datetime, timezone
from typing import Optional
import re
import uuid
from pymongo.errors import DuplicateKeyError

from deps import db, get_current_user, now_iso, _notify, _resolve_assignee, _enforce_assignee
from deps import _module_dep
from models import *
from helpers.stock_helpers import _enrich_items, _enrich_note_items, _stock_total_for, _get_balance, _allocate_locations_for, _stock_locations_for
from helpers.note_helpers import current_fy_label, note_date_key, _next_serial, _key
from helpers.status_helpers import _recompute_in_status
from helpers.validation import _validate_txn, _validate_issue_items, _validate_issue_qty_against_stock, _validate_picking_items, _validate_picking_constraints, _box_id_required_for_rack
from services.unit_of_work import unit_of_work
from services.locking import location_locks
from helpers.audit import _write_audit_log

router = APIRouter()


DEFAULT_STOCK_OUT_TYPES = ["Sale", "Transfer", "Return"]


async def _register_stock_out_type(name: str, user: dict) -> str:
    """Return the canonical stored spelling of a stock-out type, creating the master
    entry on first use. Matching is case-insensitive so "sale"/"Sale" never split into
    two types — the whole point of keeping this as a master list."""
    clean = (name or "").strip()
    if not clean:
        return ""
    existing = await db.stock_out_types.find_one(
        {"name": {"$regex": f"^{re.escape(clean)}$", "$options": "i"}}, {"_id": 0}
    )
    if existing:
        return existing["name"]
    doc = {
        "id": str(uuid.uuid4()),
        "name": clean,
        "created_at": now_iso(),
        "created_by": user.get("email", ""),
    }
    await db.stock_out_types.insert_one(doc)
    return clean


async def _issue_items_for_storage(items):
    """Normalize Issue Note items for persistence: resolve the optional godown
    preference, and compute a suggested picking-location allocation for each line
    (see `_allocate_locations_for`) — pre-filled onto the Picking Note, not a lock;
    the store user may pick from any other valid location instead (see
    `prepare_picking_note` / `_validate_picking_constraints`). Recomputed on every
    create/edit so it always reflects the current requested quantity and live stock
    disposition.
    """
    out = []
    for idx, it in enumerate(items, start=1):
        row = it.model_dump()
        # Stable per-line identity — two lines of the same part/make must stay distinct
        # all the way through picking (see IssueNoteItem.line_no).
        row["line_no"] = idx
        gid = (row.get("selected_godown_id") or "").strip()
        if gid:
            godown = await db.godowns.find_one({"id": gid}, {"_id": 0})
            row["selected_godown_id"] = gid
            row["selected_godown_name"] = (godown or {}).get("godown_name") or row.get("selected_godown_name") or ""
        else:
            row["selected_godown_id"] = None
            row["selected_godown_name"] = None
        if row.get("quantity") is None:
            # Open line — there is no quantity to pre-allocate; the Picking Note offers
            # every stock location for this part/make instead (see prepare_picking_note).
            row["allocated_locations"] = []
        else:
            row["allocated_locations"] = await _allocate_locations_for(
                row["part_no"], row["make"], row["quantity"], row.get("selected_godown_id")
            )
        out.append(row)
    return out


async def _auto_create_picking_note_for_issue(inn: dict, user: dict) -> Optional[dict]:
    existing = await db.picking_notes.find_one({"issue_note_id": inn["id"], "parent_picking_note_id": {"$in": [None, ""]}}, {"_id": 0})
    if existing:
        return existing
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _next_serial("picking_notes")
        pn_no = f"PN/{note_date_key(today)}/{serial:02d}"
        doc = {
            "id": str(uuid.uuid4()),
            "pn_no": pn_no,
            "pn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issue_note_id": inn["id"],
            "issue_note_no": inn["in_no"],
            "issue_note_date": inn["in_date"],
            "parent_picking_note_id": None,
            "assigned_items": inn.get("items", []),
            "items": [],
            "status": "PENDING",
            "auto_created": True,
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.picking_notes.insert_one(doc)
            doc.pop("_id", None)
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not auto-create picking note: {last_err}")


async def _create_followup_picking_note(parent_pn: dict, assigned_items: list[dict], user: dict) -> Optional[dict]:
    if not assigned_items:
        return None
    existing = await db.picking_notes.find_one({"parent_picking_note_id": parent_pn["id"]}, {"_id": 0})
    if existing:
        return existing
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _next_serial("picking_notes")
        pn_no = f"PN/{note_date_key(today)}/{serial:02d}"
        doc = {
            "id": str(uuid.uuid4()),
            "pn_no": pn_no,
            "pn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issue_note_id": parent_pn["issue_note_id"],
            "issue_note_no": parent_pn.get("issue_note_no", ""),
            "issue_note_date": parent_pn.get("issue_note_date", ""),
            "parent_picking_note_id": parent_pn["id"],
            "assigned_items": assigned_items,
            "items": [],
            "status": "PENDING",
            "auto_created": True,
            "auto_source": "partial-pick-remaining",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.picking_notes.insert_one(doc)
            doc.pop("_id", None)
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not auto-create remaining picking note: {last_err}")


async def _enrich_picking_requested_items(rows: list[dict]) -> None:
    """Expose requested issue quantities for pending auto-created picking notes.

    `picking_notes.items` stores physical rack/box allocations. Pending notes
    have no allocations yet, but the list/detail UI still needs to show the
    issue item count and requested qty.
    """
    issue_ids = sorted({r.get("issue_note_id") for r in rows if r.get("issue_note_id")})
    if not issue_ids:
        return
    issues = await db.issue_notes.find(
        {"id": {"$in": issue_ids}},
        {"_id": 0, "id": 1, "items": 1},
    ).to_list(len(issue_ids))
    by_id = {i["id"]: i for i in issues}
    for row in rows:
        requested_items = row.get("assigned_items") or by_id.get(row.get("issue_note_id"), {}).get("items", []) or []
        row["requested_items"] = requested_items
        row["requested_items_count"] = len(requested_items)
        row["requested_qty_total"] = sum(float(it.get("quantity") or 0) for it in requested_items)
        row["picked_qty_total"] = sum(float(it.get("quantity") or 0) for it in (row.get("items") or []))
        row["rejected_qty_total"] = sum(float(it.get("rejected_qty") or 0) for it in (row.get("items") or []))


def _stock_out_lock_key(it: dict) -> str:
    return "||".join([
        it.get("part_no", ""),
        it.get("make", ""),
        it.get("godown_id", ""),
        it.get("rack_id", ""),
        it.get("box_id", ""),
    ])


def _issue_qty_signature(items: list[dict]) -> dict:
    """Per (part,make) requested-qty map — used to detect whether an Issue Note edit
    actually changed anything that would invalidate an in-progress Picking Note draft.

    An open (blank) quantity is signed as "OPEN" rather than 0, so switching a line
    between open and 0-ish still registers as a change."""
    sig = {}
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        if it.get("quantity") is None:
            sig[k] = "OPEN"
            continue
        prev = sig.get(k)
        sig[k] = ("OPEN" if prev == "OPEN" else (prev or 0) + float(it.get("quantity") or 0))
    return sig


def _sum_issue_like_items(items: list[dict]) -> dict:
    sums = {}
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        # picked + rejected both resolve the requested qty — neither needs re-picking.
        sums[k] = sums.get(k, 0) + float(it.get("quantity") or 0) + float(it.get("rejected_qty") or 0)
    return sums


def _remaining_assigned_items(assigned_items: list[dict], picked_items: list[dict]) -> list[dict]:
    """What still needs picking, line by line.

    The picked quantity is a single pool per (part, make) — the picker records where
    stock came off the shelf, not which of several identical lines it was for. So the
    pool is CONSUMED line by line in order: 15 picked against lines of 15 and 5 leaves
    the second line's 5 outstanding, rather than both lines seeing the full 15 and the
    remainder silently vanishing.
    """
    pool = _sum_issue_like_items(picked_items)
    remaining = []
    for it in assigned_items or []:
        row = dict(it)
        k = _key(row.get("part_no"), row.get("make"))
        if row.get("quantity") is None:
            # Open line: the store incharge's picked quantity IS the quantity, so any
            # pick resolves it. Untouched open lines carry over still open.
            if pool.get(k, 0) <= 1e-6:
                remaining.append(row)
            continue
        assigned_qty = float(row.get("quantity") or 0)
        used = min(pool.get(k, 0), assigned_qty)
        pool[k] = pool.get(k, 0) - used
        rem = assigned_qty - used
        if rem > 1e-6:
            row["quantity"] = rem
            remaining.append(row)
    return remaining


@router.post("/stock-out")
async def stock_out(payload: StockOutCreate, user=Depends(get_current_user)):
    item, godown, rack, box = await _validate_txn(payload)
    # Per-location lock: without this, two concurrent direct stock-out calls (or one
    # racing a Picking Note / Transfer Note completion) against the same physical
    # location could both pass the balance check below before either writes its
    # transaction, over-drawing the location into negative stock. Reusing the same
    # `stock_out_locks` collection/key format as the Picking Note and Transfer Note
    # completion paths means all three mutually exclude each other on the same location.
    lock_key = "||".join([payload.part_no, payload.make, payload.godown_id, payload.rack_id, payload.box_id])
    try:
        await db.stock_out_locks.insert_one({"_id": lock_key, "direct_stock_out": True, "created_at": now_iso()})
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Stock at this location is being recorded by another user")
    try:
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
    finally:
        await db.stock_out_locks.delete_one({"_id": lock_key, "direct_stock_out": True})


@router.get("/stock-out-types")
async def list_stock_out_types(user=Depends(get_current_user)):
    """Master list of Issue Note classifications. Seeded once with the common defaults
    (Sale / Transfer / Return); users add their own from the Issue Note form."""
    rows = await db.stock_out_types.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    if not rows:
        seed = [
            {"id": str(uuid.uuid4()), "name": n, "created_at": now_iso(), "created_by": "system"}
            for n in DEFAULT_STOCK_OUT_TYPES
        ]
        try:
            await db.stock_out_types.insert_many(seed)
        except DuplicateKeyError:
            pass  # another request seeded first — just re-read below
        rows = await db.stock_out_types.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    return rows


@router.post("/stock-out-types", response_model=StockOutType)
async def create_stock_out_type(payload: StockOutTypeCreate, user=Depends(get_current_user)):
    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Type name is required")
    existing = await db.stock_out_types.find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0}
    )
    if existing:
        raise HTTPException(status_code=409, detail=f"'{existing['name']}' already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "created_at": now_iso(),
        "created_by": user.get("email", ""),
    }
    await db.stock_out_types.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.delete("/stock-out-types/{type_id}")
async def delete_stock_out_type(type_id: str, user=Depends(get_current_user)):
    existing = await db.stock_out_types.find_one({"id": type_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Stock out type not found")
    # Deleting a type that notes already reference would leave those notes pointing at
    # a value nobody can pick again — exactly the inconsistency this master list avoids.
    in_use = await db.issue_notes.find_one({"stock_out_type": existing["name"]}, {"_id": 0, "in_no": 1})
    if in_use:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete '{existing['name']}' — it is used by {in_use.get('in_no')} and possibly others",
        )
    await db.stock_out_types.delete_one({"id": type_id})
    return {"ok": True}


@router.get("/issue-notes/lookup/{part_no}")
async def issue_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """For Issue Note flow: list makes that have positive stock for this part_no, with
    available qty and description_1 (Description auto-populates once a make resolves;
    stock_master description is keyed by part_no+make, so it's returned per-make here)."""
    # Pull every (part_no, make) combination that has transactions, then filter to those with positive total
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
            {"_id": 0, "make": 1, "description_1": 1, "model": 1},
        ):
            sm_by_make[sm.get("make")] = sm
    return {"makes": [
        {
            "make": p["_id"]["make"], "available_qty": p["q"],
            "description_1": sm_by_make.get(p["_id"]["make"], {}).get("description_1", "") or "",
            "model": sm_by_make.get(p["_id"]["make"], {}).get("model", "") or "",
        }
        for p in pairs
    ]}


@router.get("/issue-notes/lookup/{part_no}/godowns")
async def issue_lookup_godowns(part_no: str, make: str, user=Depends(get_current_user)):
    """For Issue Note flow: list godowns that currently hold positive stock for part/make."""
    rows = await db.transactions.aggregate([
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {
            "_id": {
                "godown_id": "$godown_id",
                "godown_name": "$godown_name",
            },
            "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"q": {"$gt": 0}, "_id.godown_id": {"$nin": [None, ""]}}},
        {"$sort": {"_id.godown_name": 1}},
    ]).to_list(1000)
    return {
        "godowns": [
            {
                "godown_id": r["_id"].get("godown_id", ""),
                "godown_name": r["_id"].get("godown_name", ""),
                "available_qty": r["q"],
            }
            for r in rows
        ]
    }


@router.get("/issue-notes/next-no")
async def next_issue_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    last = await db.issue_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_in_no": f"IN/{note_date_key(today)}/{next_serial:02d}",
        "in_date": today.date().isoformat(),
    }


@router.post("/issue-notes", response_model=IssueNote)
async def create_issue_note(payload: IssueNoteCreate, user=Depends(get_current_user)):
    """Create an Issue Note. Defaults to the existing behavior (status PENDING, Picking
    Note auto-created immediately) so existing callers are unaffected. Pass
    `save_as_draft: true` to land as DRAFT instead — no Picking Note yet; call
    POST /issue-notes/{id}/finalize when ready to release it for picking."""
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items)
    stored_items = await _issue_items_for_storage(payload.items)
    stock_out_type = await _register_stock_out_type(payload.stock_out_type, user)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    is_draft = bool(payload.save_as_draft)
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _next_serial("issue_notes")
        in_no = f"IN/{note_date_key(today)}/{serial:02d}"
        doc = {
            "id": str(uuid.uuid4()),
            "in_no": in_no,
            "in_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "stock_out_type": stock_out_type,
            "reference_doc_name": (payload.reference_doc_name or "").strip(),
            "reference_doc_date": (payload.reference_doc_date or "").strip(),
            "reference_doc_no": (payload.reference_doc_no or "").strip(),
            "items": stored_items,
            "status": "DRAFT" if is_draft else "PENDING",
            "narration": (payload.narration or "").strip(),
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.issue_notes.insert_one(doc)
            doc.pop("_id", None)
            if is_draft:
                await _notify(
                    actor=user, type="issue_note.created", module="stock_out",
                    title=f"Issue Note {in_no} (Draft)",
                    message=f"{user.get('email')} created draft {in_no} with {len(doc['items'])} item(s).",
                    audience="module", ref_collection="issue_notes", ref_id=doc["id"],
                )
                return doc
            try:
                await _auto_create_picking_note_for_issue(doc, user)
            except Exception:
                await db.issue_notes.delete_one({"id": doc["id"]})
                await db.picking_notes.delete_many({"issue_note_id": doc["id"], "status": "PENDING", "items": []})
                raise
            await _notify(
                actor=user, type="issue_note.created", module="stock_out",
                title=f"Issue Note {in_no}",
                message=f"{user.get('email')} created {in_no} for '{doc.get('assigned_to_name') or '—'}' with {len(doc['items'])} item(s) — picking pending.",
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


@router.post("/issue-notes/{in_id}/finalize", response_model=IssueNote)
async def finalize_issue_note(in_id: str, user=Depends(get_current_user)):
    """Promote a DRAFT issue note to PENDING and auto-create its Picking Note —
    mirrors Receipt Note's DRAFT -> /finalize pattern."""
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=404, detail="Issue note not found")
    if inn.get("status") != "DRAFT":
        raise HTTPException(status_code=409, detail=f"Only DRAFT issue notes can be finalized (current status: {inn.get('status')})")
    _enforce_assignee(inn, user, "finalize this issue note")
    if not inn.get("items"):
        raise HTTPException(status_code=400, detail="At least one item is required")

    await db.issue_notes.update_one({"id": in_id}, {"$set": {"status": "PENDING"}})
    inn["status"] = "PENDING"
    try:
        await _auto_create_picking_note_for_issue(inn, user)
    except Exception:
        await db.issue_notes.update_one({"id": in_id}, {"$set": {"status": "DRAFT"}})
        raise
    await _write_audit_log(
        module="stock_out", action="issue_note.finalized", actor=user,
        ref_collection="issue_notes", ref_id=in_id,
        old={"status": "DRAFT"}, new={"status": "PENDING"},
    )
    await _notify(
        actor=user, type="issue_note.created", module="stock_out",
        title=f"Issue Note {inn['in_no']}",
        message=f"{user.get('email')} finalized {inn['in_no']} for '{inn.get('assigned_to_name') or '—'}' with {len(inn['items'])} item(s) — picking pending.",
        audience="module", ref_collection="issue_notes", ref_id=in_id,
    )
    if inn.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="issue_note.assigned", module="stock_out",
            title=f"Assigned to you: {inn['in_no']}",
            message=f"{user.get('email')} assigned Issue Note {inn['in_no']} to you for picking.",
            audience="user", target_user_id=inn["assigned_to_user_id"],
            ref_collection="issue_notes", ref_id=in_id,
        )
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    return doc


@router.get("/issue-notes")
async def list_issue_notes(
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
            {"in_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
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
    # Editable until the first quantity is actually picked/rejected — a PENDING/DRAFT
    # Picking Note (allocation only, nothing recorded yet) must not block editing;
    # only a COMPLETED (processed) note does.
    if await db.picking_notes.find_one({"issue_note_id": in_id, "status": {"$in": ["RECORDED", "COMPLETED"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="Cannot edit — picking has already started on this issue note")
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items, exclude_in_id=in_id)
    stored_items = await _issue_items_for_storage(payload.items)
    # Only cascade-reset in-progress Picking Note drafts if the requested qty actually
    # changed — a no-op re-save (e.g. only reassigning) must not discard a picker's
    # already-entered (but not yet recorded) allocation.
    items_changed = _issue_qty_signature(existing.get("items", [])) != _issue_qty_signature(stored_items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    update = {
        "stock_out_type": await _register_stock_out_type(payload.stock_out_type, user),
        "reference_doc_name": (payload.reference_doc_name or "").strip(),
        "reference_doc_date": (payload.reference_doc_date or "").strip(),
        "reference_doc_no": (payload.reference_doc_no or "").strip(),
        "items": stored_items,
        "narration": (payload.narration or "").strip(),
        "updated_at": now_iso(),
        **assignee,
    }
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})
    if items_changed:
        # Propagate the edited request into every not-yet-processed Picking Note so
        # allocation/availability/preview never show a stale requested quantity.
        await db.picking_notes.update_many(
            {"issue_note_id": in_id, "status": {"$nin": ["RECORDED", "COMPLETED"]}},
            {"$set": {"items": [], "assigned_items": stored_items, "updated_at": now_iso()}},
        )
    await _write_audit_log(
        module="stock_out", action="issue_note.edited", actor=user,
        ref_collection="issue_notes", ref_id=in_id,
        old={"items": existing.get("items", [])}, new={"items": stored_items},
    )
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="issue_note.assigned", module="stock_out",
            title=f"Assigned to you: {existing.get('in_no', '')}",
            message=f"{user.get('email')} assigned Issue Note {existing.get('in_no', '')} to you for picking.",
            audience="user", target_user_id=new_aid,
            ref_collection="issue_notes", ref_id=in_id,
        )
    await _recompute_in_status(in_id)
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    return doc


@router.delete("/issue-notes/{in_id}")
async def delete_issue_note(in_id: str, user=Depends(get_current_user)):
    existing = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue note not found")
    _enforce_assignee(existing, user, "delete this issue note")
    if await db.picking_notes.find_one({"issue_note_id": in_id, "status": {"$in": ["RECORDED", "COMPLETED"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="Cannot delete — picking has already started on this issue note")
    await db.picking_notes.delete_many({"issue_note_id": in_id})
    await db.issue_notes.delete_one({"id": in_id})
    return {"ok": True}


# -------------------- PICKING NOTES --------------------

@router.get("/picking-notes/next-no")
async def next_picking_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    last = await db.picking_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_pn_no": f"PN/{note_date_key(today)}/{next_serial:02d}",
        "pn_date": today.date().isoformat(),
    }


@router.get("/picking-notes/prepare/{in_id}")
async def prepare_picking_note(in_id: str, exclude_pn_id: Optional[str] = None, user=Depends(get_current_user)):
    """Return one row per SUGGESTED picking location for each still-pending Issue Note
    line — a fresh greedy allocation across current stock (see _allocate_locations_for),
    scoped to whatever is pending for this specific Picking Note (already correctly
    reduced for a follow-up/partial-pick continuation, since `base_items` in that case
    is the frozen remainder, not the original full request).

    The suggestion is pre-filled but never locked: each row also carries
    `available_locations` — every valid stock location currently holding this
    part/make, with its live quantity — so the store user can accept the suggestion,
    pick partially from it, or choose a different valid location entirely. Real
    warehouse stock rarely matches the office user's assumption exactly."""
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=404, detail="Issue note not found")
    if inn.get("status") == "COMPLETE" and not exclude_pn_id:
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    pn_scope = None
    if exclude_pn_id:
        pn_scope = await db.picking_notes.find_one({"id": exclude_pn_id}, {"_id": 0})

    items_out = []
    base_items = (pn_scope or {}).get("assigned_items") or inn.get("items", [])
    for base_idx, it in enumerate(base_items, start=1):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        line_no = it.get("line_no") or base_idx
        is_open = it.get("quantity") is None
        pending = 0 if is_open else (it.get("quantity", 0) or 0)
        selected_godown_id = it.get("selected_godown_id") or ""
        if not is_open and pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        available_locations = await _stock_locations_for(part_no, make)
        # An open line has no quantity to allocate — the picker chooses the location and
        # the amount, bounded only by what is actually on the shelf.
        allocation = [] if is_open else await _allocate_locations_for(part_no, make, pending, selected_godown_id)
        allocated_qty = sum(a["quantity"] for a in allocation)
        common = {
            "part_no": part_no, "make": make,
            "line_no": line_no,
            "open_quantity": is_open,
            "requested_qty": None if is_open else pending,
            "pending_qty": None if is_open else pending,
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            "available_locations": available_locations,
        }
        for a in allocation:
            items_out.append({
                **common,
                "quantity": a["quantity"], "allocated_qty": a["quantity"], "suggested": True,
                "godown_id": a["godown_id"], "godown_name": a["godown_name"],
                "rack_id": a["rack_id"], "rack_no": a["rack_no"],
                "box_id": a["box_id"], "box_no": a["box_no"], "box_category": a.get("box_category", ""),
            })
        if is_open:
            # One blank row, pre-pointed at the godown preference if the office set one
            # (and it still holds stock) — quantity and final location are the picker's.
            preferred = next(
                (L for L in available_locations if selected_godown_id and L.get("godown_id") == selected_godown_id),
                None,
            )
            items_out.append({
                **common, "quantity": "", "allocated_qty": 0, "suggested": False,
                "godown_id": (preferred or {}).get("godown_id", ""), "godown_name": (preferred or {}).get("godown_name", ""),
                "rack_id": (preferred or {}).get("rack_id", ""), "rack_no": (preferred or {}).get("rack_no", ""),
                "box_id": (preferred or {}).get("box_id", ""), "box_no": (preferred or {}).get("box_no", ""),
                "box_category": (preferred or {}).get("box_category", ""),
            })
        elif allocated_qty + 1e-6 < pending:
            # Stock fell short of the greedily-suggested quantity since the Issue Note
            # was created/edited (e.g. concurrent consumption elsewhere) — surface the
            # gap as an unfilled row; the picker can reject it or pick it from another
            # location in `available_locations`.
            items_out.append({
                **common, "quantity": 0, "allocated_qty": 0, "suggested": False, "unallocated_shortfall": pending - allocated_qty,
                "godown_id": "", "godown_name": "", "rack_id": "", "rack_no": "",
                "box_id": "", "box_no": "", "box_category": "",
            })

    return {
        "issue_note": {
            "id": inn["id"], "in_no": inn["in_no"], "in_date": inn["in_date"],
            "status": inn.get("status"),
        },
        "items": items_out,
    }


@router.post("/picking-notes", response_model=PickingNote)
async def create_picking_note(payload: PickingNoteCreate, user=Depends(get_current_user)):
    inn = await db.issue_notes.find_one({"id": payload.issue_note_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    _enforce_assignee(inn, user, "create a picking note for this issue")
    if await db.picking_notes.find_one({"issue_note_id": inn["id"], "status": {"$in": ["PENDING", "DRAFT", "RECORDING"]}}, {"_id": 0, "id": 1}):
        raise HTTPException(status_code=409, detail="A pending Picking Note already exists for this issue note")
    if inn.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        # Only meaningful when a rack was actually chosen — godown-only stock has no rack.
        if (it.rack_id or "").strip() and not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_picking_constraints(inn["id"], payload.items, exclude_pn_id=None, assigned_items=inn.get("items", []))

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None
    for _ in range(5):
        serial = await _next_serial("picking_notes")
        pn_no = f"PN/{note_date_key(today)}/{serial:02d}"
        doc = {
            "id": str(uuid.uuid4()),
            "pn_no": pn_no,
            "pn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issue_note_id": inn["id"],
            "issue_note_no": inn["in_no"],
            "issue_note_date": inn["in_date"],
            "assigned_items": inn.get("items", []),
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
    issue_note_id: Optional[str] = None,
    search: Optional[str] = None,
    user=Depends(get_current_user),
):
    from helpers.stock_helpers import _enrich_with_parent_assignee
    query = {}
    if issue_note_id:
        query["issue_note_id"] = issue_note_id
    if search:
        s = search.strip()
        query["$or"] = [
            {"pn_no": {"$regex": s, "$options": "i"}},
            {"issue_note_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    if not issue_note_id and not status and not not_status and not search:
        query["status"] = {"$in": ["PENDING", "DRAFT", "RECORDING"]}
    total = await db.picking_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.picking_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "issue_notes", "issue_note_id")
    await _enrich_picking_requested_items(rows)
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
    await _enrich_picking_requested_items([doc])
    return doc


@router.put("/picking-notes/{pn_id}", response_model=PickingNote)
async def update_picking_note(pn_id: str, payload: PickingNoteCreate, user=Depends(get_current_user)):
    existing = await db.picking_notes.find_one({"id": pn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if existing.get("status") in ("RECORDED", "COMPLETED"):
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Out")
    in_parent = await db.issue_notes.find_one({"id": existing.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "edit this picking note")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        # Only meaningful when a rack was actually chosen — godown-only stock has no rack.
        if (it.rack_id or "").strip() and not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    assigned_items = existing.get("assigned_items") or in_parent.get("items", [])
    await _validate_picking_constraints(existing.get("issue_note_id"), payload.items, exclude_pn_id=pn_id, assigned_items=assigned_items)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "status": "DRAFT",
        "updated_at": now_iso(),
    }
    await db.picking_notes.update_one({"id": pn_id}, {"$set": update})
    await _recompute_in_status(existing.get("issue_note_id"))
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    return doc


@router.delete("/picking-notes/{pn_id}")
async def delete_picking_note(pn_id: str, user=Depends(get_current_user)):
    # Picking Notes can never be deleted — once a pick begins, its history must
    # never disappear. Only Edit / Preview / Print remain available.
    raise HTTPException(status_code=403, detail="Picking Notes cannot be deleted — edit instead")


@router.post("/picking-notes/{pn_id}/record")
async def record_picking_note(pn_id: str, user=Depends(get_current_user)):
    pn = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not pn:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if pn.get("status") in ("RECORDED", "COMPLETED"):
        raise HTTPException(status_code=409, detail="Already recorded")
    if pn.get("status") != "DRAFT":
        raise HTTPException(status_code=409, detail="Picking note must be saved as Draft before recording")
    in_parent = await db.issue_notes.find_one({"id": pn.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "record this picking note")
    items = pn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    item_models = [PickingNoteItem(**it) for it in items]
    _validate_picking_items(item_models)  # final re-check on top of the draft-time check
    assigned_items = pn.get("assigned_items") or in_parent.get("items", [])
    await _validate_picking_constraints(pn.get("issue_note_id"), item_models, exclude_pn_id=pn_id, assigned_items=assigned_items)
    remaining_items = _remaining_assigned_items(assigned_items, items)
    now = now_iso()

    # Optimistic claim on the note itself — same primitive Stock In's Racking Note
    # recording uses (repositories/inventory_repo.py: transition_status). Done as a
    # standalone write (not inside the transaction below) so a concurrent double-submit
    # of the SAME note gets exactly this 409, before any location lock is attempted.
    locked = await db.picking_notes.update_one(
        {"id": pn_id, "status": "DRAFT"},
        {"$set": {"status": "RECORDING", "recording_started_at": now}},
    )
    if locked.modified_count != 1:
        latest = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0, "status": 1})
        if latest and latest.get("status") in ("RECORDED", "COMPLETED"):
            raise HTTPException(status_code=409, detail="Already recorded")
        raise HTTPException(status_code=409, detail="Picking note is already being recorded")

    lock_keys = sorted({_stock_out_lock_key(it) for it in items})
    tx_docs = []
    try:
        # Lock held across the whole transaction, released only after commit (see
        # services/locking.py) — otherwise a concurrent request could pass its own
        # balance check against not-yet-committed writes the instant the lock frees.
        async with location_locks(
            lock_keys, owner_field="picking_note_id", owner_value=pn_id,
            conflict_message="Stock at one selected location is being recorded by another user",
        ):
            async with unit_of_work() as uow:
                if await uow.transactions.find_one({"picking_note_id": pn_id}):
                    raise HTTPException(status_code=409, detail="Stock Out transactions already exist for this Picking Note")

                # Final availability check (real ledger balance). Fully-rejected rows
                # (quantity == 0, resolved entirely via rejected_qty) move no stock and
                # need no location/balance check.
                for idx, it in enumerate(items, start=1):
                    if (it.get("quantity") or 0) <= 0:
                        continue
                    # Rack/box are not demanded outright — a godown with no racking holds
                    # its stock at rack_id/box_id "", and the balance query below is keyed
                    # on the exact triple, so a wrong location simply finds no stock.
                    if not it.get("godown_id"):
                        raise HTTPException(status_code=400, detail=f"Row {idx}: Godown missing")
                    if it.get("rack_id") and not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
                        raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing")
                    bal = await uow.transactions.aggregate([
                        {"$match": {
                            "part_no": it["part_no"], "make": it["make"],
                            "godown_id": it.get("godown_id", ""),
                            "rack_id": it.get("rack_id", ""),
                            "box_id": it.get("box_id", ""),
                        }},
                        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
                    ])
                    avail = (bal[0]["q"] if bal else 0)
                    if avail < it["quantity"] - 1e-6:
                        raise HTTPException(status_code=400, detail=(
                            f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at "
                            f"{it.get('godown_name')}/{it.get('rack_no')}/{it.get('box_no') or '—'}: have {avail}, need {it['quantity']}"
                        ))

                for it in items:
                    if (it.get("quantity") or 0) <= 0:
                        continue  # fully-rejected row — nothing physically issued
                    master = await uow.db.stock_master.find_one(
                        {"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}, session=uow.session
                    ) or {}
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
                        "created_at": now, "created_by": user.get("email"),
                    })
                if tx_docs:
                    await uow.transactions.insert_many(tx_docs)
                finalized = await uow.picking_notes.transition_status(
                    pn_id, from_status="RECORDING", to_status="COMPLETED",
                    set_fields={"recorded_at": now}, unset_fields=["recording_started_at"],
                )
                if not finalized:
                    raise HTTPException(status_code=409, detail="Picking note recording state changed; stock out was not finalized")

                # Planned-vs-actual audit: the Issue Note's suggested/allocated locations
                # for each part/make, compared against the location the store user actually
                # picked from. "What was suggested" must never be lost once the actual pick
                # supersedes it everywhere else (previews, print, transactions, reports) —
                # mirrors the same pattern used for Transfer Note (record_transfer_note).
                planned_locs_by_key: dict[str, list] = {}
                for pit in (assigned_items or []):
                    k = _key(pit.get("part_no"), pit.get("make"))
                    for loc in pit.get("allocated_locations") or []:
                        planned_locs_by_key.setdefault(k, []).append({
                            "godown_id": loc.get("godown_id", "") or "", "godown_name": loc.get("godown_name", "") or "",
                            "rack_id": loc.get("rack_id", "") or "", "rack_no": loc.get("rack_no", "") or "",
                            "box_id": loc.get("box_id", "") or "", "box_no": loc.get("box_no", "") or "",
                        })

                def _loc(d):
                    return {
                        "godown_id": d.get("godown_id", "") or "", "godown_name": d.get("godown_name", "") or "",
                        "rack_id": d.get("rack_id", "") or "", "rack_no": d.get("rack_no", "") or "",
                        "box_id": d.get("box_id", "") or "", "box_no": d.get("box_no", "") or "",
                    }

                location_changes = []
                for it in items:
                    if (it.get("quantity") or 0) <= 0:
                        continue
                    planned_locs = planned_locs_by_key.get(_key(it.get("part_no"), it.get("make"))) or []
                    actual = _loc(it)
                    if planned_locs and actual not in planned_locs:
                        location_changes.append({
                            "part_no": it.get("part_no"), "make": it.get("make"),
                            "suggested_locations": planned_locs, "actual_location": actual,
                        })

                await uow.audit.record(
                    action="picking_note.completed", actor=user,
                    ref_collection="picking_notes", ref_id=pn_id,
                    old={"status": "RECORDING"},
                    new={"status": "COMPLETED", "items": items, "transactions_created": len(tx_docs)},
                    reason="Actual pick location differs from the issue note's suggested location" if location_changes else "",
                    module="stock_out",
                    links={"issue_note_id": pn.get("issue_note_id", ""), "location_changes": location_changes},
                )
            # transaction committed here, still holding the location locks
        # location locks released here
    except Exception:
        # Everything inside unit_of_work() above already rolled back automatically on
        # abort (tx_docs, the COMPLETED flip, the audit entry never became durable).
        # Only this note's initial non-transactional claim needs a manual revert.
        await db.picking_notes.update_one(
            {"id": pn_id, "status": "RECORDING"},
            {"$set": {"status": "DRAFT"}, "$unset": {"recording_started_at": ""}},
        )
        raise

    child_pn = None
    if remaining_items:
        child_pn = await _create_followup_picking_note(pn, remaining_items, user)
    if pn.get("issue_note_id"):
        await _recompute_in_status(pn["issue_note_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    total_rejected = sum(int(it.get("rejected_qty") or 0) for it in items)
    rejected_note = f", rejected {total_rejected}" if total_rejected else ""
    await _notify(
        actor=user, type="stock_out.recorded", module="stock_out",
        title=f"Stock Out recorded ({pn['pn_no']})",
        message=f"{user.get('email')} issued {len(tx_docs)} item(s), total qty {total_qty}{rejected_note} to '{in_parent.get('assigned_to_name') or '—'}' from {pn.get('issue_note_no') or 'IN'}.",
        audience="module", ref_collection="picking_notes", ref_id=pn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs), "remaining_picking_note": child_pn}
