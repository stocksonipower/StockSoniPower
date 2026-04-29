import os
import io
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any

import bcrypt
import jwt
import pandas as pd
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, Query, Response, Header
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pydantic import BaseModel, Field, EmailStr, ConfigDict

from storage import init_storage, put_object, get_object, build_path

# Shared infrastructure (db, auth deps, helpers) — extracted for modularity (zero logic change)
from deps import (
    ROOT_DIR,
    db,
    client,
    JWT_SECRET, JWT_ALGORITHM, bearer_scheme,
    logger,
    APP_MODULES,
    hash_password, verify_password, create_access_token,
    get_current_user, require_admin, _module_dep,
    now_iso,
    NOTIFICATION_AUDIENCES, _notify,
    _resolve_assignee, _enforce_assignee,
)

# All Pydantic models live in models.py (extracted; zero logic change)
from models import *  # noqa: F401,F403


# -------------------- APP SETUP --------------------
app = FastAPI(title="Stock Management API")
api_router = APIRouter(prefix="/api")

# Auth, Users, Notifications routes extracted to /routes (zero logic changes)
from routes import auth as _auth_routes
from routes import users as _users_routes
from routes import notifications as _notifications_routes
api_router.include_router(_auth_routes.router)
api_router.include_router(_users_routes.router)
api_router.include_router(_notifications_routes.router)
from routes import dashboard as _dashboard_routes
from routes import item_details as _item_details_routes
api_router.include_router(_dashboard_routes.router)
api_router.include_router(_item_details_routes.router)
from routes import uploads as _uploads_routes
api_router.include_router(_uploads_routes.router)
from routes import locations as _locations_routes
api_router.include_router(_locations_routes.router)
from routes import stock_master as _stock_master_routes
api_router.include_router(_stock_master_routes.router)


# -------------------- STOCK IN/OUT --------------------
async def _validate_txn(p):
    item = await db.stock_master.find_one({"part_no": p.part_no, "make": p.make}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=400, detail="No matching item in Stock Master")
    godown = await db.godowns.find_one({"id": p.godown_id})
    rack = await db.racks.find_one({"id": p.rack_id})
    box = await db.boxes.find_one({"id": p.box_id})
    if not godown or not rack or not box:
        raise HTTPException(status_code=400, detail="Invalid location")
    if p.quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")
    return item, godown, rack, box


class StockInLookupEntry(BaseModel):
    part_no: str
    make: Optional[str] = None


class StockInLookupRequest(BaseModel):
    # Accept either explicit entries (part_no + optional make) or just part_nos for backward compat
    entries: Optional[List[StockInLookupEntry]] = None
    part_nos: Optional[List[str]] = None


@api_router.post("/stock-in/lookup")
async def stock_in_lookup(req: StockInLookupRequest, user=Depends(get_current_user)):
    """Given entries of (part_no, make?), return stock master details + current locations with qty.
    One entry per (part_no, make). Items with <=1 location first, multi-location items last."""
    # Normalize input
    lookups = []  # list of (part_no, make_or_None)
    if req.entries:
        for e in req.entries:
            pn = (e.part_no or "").strip()
            mk = (e.make or "").strip() or None
            if pn:
                lookups.append((pn, mk))
    elif req.part_nos:
        for pn in req.part_nos:
            pn = (pn or "").strip()
            if pn:
                lookups.append((pn, None))

    results = []
    seen_keys = set()
    for part_no, make_filter in lookups:
        query = {"part_no": part_no}
        if make_filter:
            query["make"] = make_filter
        items = await db.stock_master.find(query, {"_id": 0}).to_list(100)
        if not items:
            key = f"{part_no}|{make_filter or ''}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            results.append({"part_no": part_no, "make": make_filter or "", "not_found": True, "locations": []})
            continue
        for item in items:
            key = f"{part_no}|{item.get('make','')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            pipeline = [
                {"$match": {"part_no": part_no, "make": item.get("make", "")}},
                {"$group": {
                    "_id": {
                        "godown_id": "$godown_id", "godown_name": "$godown_name",
                        "rack_id": "$rack_id", "rack_no": "$rack_no",
                        "box_id": "$box_id", "box_no": "$box_no",
                    },
                    "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
                }},
                {"$match": {"quantity": {"$gt": 0}}},
                {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
            ]
            raw_locs = await db.transactions.aggregate(pipeline).to_list(1000)
            locations = [{**r["_id"], "quantity": r["quantity"]} for r in raw_locs]
            results.append({
                "not_found": False,
                "part_no": part_no,
                "make": item.get("make", ""),
                "model": item.get("model", ""),
                "old_part_no": item.get("old_part_no", ""),
                "make_part_no": item.get("make_part_no", ""),
                "oem": item.get("oem", ""),
                "description_1": item.get("description_1", ""),
                "description_2": item.get("description_2", ""),
                "remarks_oem": item.get("remarks_oem", ""),
                "remarks_others": item.get("remarks_others", ""),
                "item_category": item.get("item_category", ""),
                "image": item.get("image", ""),
                "locations": locations,
            })
    results.sort(key=lambda r: (1 if len(r.get("locations", [])) > 1 else 0, len(r.get("locations", []))))
    return results


@api_router.post("/stock-in")
async def stock_in(payload: StockInCreate, user=Depends(get_current_user)):
    item, godown, rack, box = await _validate_txn(payload)
    doc = {
        "id": str(uuid.uuid4()),
        "type": "IN",
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


@api_router.post("/stock-out")
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


async def _get_balance(part_no, make, godown_id, rack_id, box_id) -> int:
    pipeline = [
        {"$match": {"part_no": part_no, "make": make, "godown_id": godown_id, "rack_id": rack_id, "box_id": box_id}},
        {"$group": {"_id": None, "qty": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}}
    ]
    result = await db.transactions.aggregate(pipeline).to_list(1)
    return result[0]["qty"] if result else 0


@api_router.get("/transactions")
async def list_transactions(
    response: Response,
    limit: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(10000, ge=1, le=10000),
    type: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if type:
        query["type"] = type.upper()
    total = await db.transactions.count_documents(query)
    # Backward compat: if `limit` query param is provided, return first `limit` rows (no pagination headers consumer needed)
    if limit is not None and limit > 0:
        rows = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
        await _enrich_items(rows)
        response.headers["X-Total-Count"] = str(total)
        response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
        return rows
    skip = (page - 1) * page_size
    rows = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


# -------------------- RECEIPT NOTES (Stock In) --------------------
def current_fy_label(d: datetime) -> str:
    """Indian financial year label, e.g. 2026-04-15 -> '26-27'."""
    if d.month >= 4:
        start, end = d.year, d.year + 1
    else:
        start, end = d.year - 1, d.year
    return f"{start % 100:02d}-{end % 100:02d}"


@api_router.get("/receipt-notes/next-no")
async def next_receipt_note_no(user=Depends(get_current_user)):
    """Preview the next receipt-note number for the current FY (max existing serial + 1)."""
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.receipt_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_rn_no": f"RN/{fy}/{next_serial:03d}",
        "rn_date": today.date().isoformat(),
    }


@api_router.post("/receipt-notes", response_model=ReceiptNote)
async def create_receipt_note(payload: ReceiptNoteCreate, user=Depends(get_current_user)):
    """Create a Receipt Note. Always lands as DRAFT — Final Save happens via the
    /finalize endpoint after received_qty is filled for every row."""
    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")

    # Date validation
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")

    # Per-row validation (DRAFT-level — received_qty optional, invoice_qty required)
    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.invoice_qty is None or it.invoice_qty <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Invoice Qty must be greater than 0")
        if it.received_qty is not None and it.received_qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("rn", fy)
        rn_no = f"RN/{fy}/{serial:03d}"
        items_out = []
        for it in payload.items:
            rec = it.received_qty if it.received_qty is not None else None
            # Legacy `quantity` mirror — equals received_qty when set, else invoice_qty.
            qty_legacy = float(rec) if rec is not None else float(it.invoice_qty)
            items_out.append({
                "part_no": it.part_no.strip(),
                "make": it.make.strip(),
                "invoice_qty": float(it.invoice_qty),
                "received_qty": float(rec) if rec is not None else None,
                "quantity": qty_legacy,
            })

        doc = {
            "id": str(uuid.uuid4()),
            "rn_no": rn_no,
            "rn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "stock_in_type": payload.stock_in_type,
            "invoice_no": (payload.invoice_no or "").strip(),
            "invoice_date": (payload.invoice_date or "").strip(),
            "goods_received_date": (payload.goods_received_date or "").strip(),
            "items": items_out,
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.receipt_notes.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="receipt_note.created", module="stock_in",
                title=f"Receipt Note {rn_no} (Draft)",
                message=f"{user.get('email')} created draft {rn_no} with {len(doc['items'])} item(s).",
                audience="module", ref_collection="receipt_notes", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="receipt_note.assigned", module="stock_in",
                    title=f"Assigned to you: {rn_no}",
                    message=f"{user.get('email')} assigned Receipt Note {rn_no} to you.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="receipt_notes", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"Could not allocate receipt-note number: {last_err}")

@api_router.get("/receipt-notes")
async def list_receipt_notes(
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
            {"rn_no": {"$regex": s, "$options": "i"}},
            {"invoice_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
    # Allow comma-separated lists for both filters
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.receipt_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.receipt_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    # Annotate `has_racking_note`: any RKN (DRAFT or RECORDED) referencing the RN blocks edit/delete.
    if rows:
        ids_with_rkn = await db.racking_notes.distinct("receipt_note_id", {"receipt_note_id": {"$in": [r["id"] for r in rows]}})
        id_set = set(ids_with_rkn or [])
        for r in rows:
            r["has_racking_note"] = r["id"] in id_set
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/receipt-notes/{rn_id}")
async def get_receipt_note(rn_id: str, user=Depends(get_current_user)):
    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    await _enrich_note_items([doc])
    doc["has_racking_note"] = bool(await db.racking_notes.find_one({"receipt_note_id": rn_id}, {"_id": 1}))
    return doc


@api_router.put("/receipt-notes/{rn_id}", response_model=ReceiptNote)
async def update_receipt_note(rn_id: str, payload: ReceiptNoteCreate, user=Depends(get_current_user)):
    """Edit a Receipt Note.
       - Editable regardless of status AS LONG AS no Racking Note exists against it.
       - Once ANY Racking Note (DRAFT or RECORDED) exists, edits are locked.
       - Assignee enforcement still applies on non-DRAFT RNs so non-owners cannot
         hijack someone else's finalized note.
       - Re-finalization logic (SRN/ERN auto-create) remains unchanged on next finalize."""
    existing = await db.receipt_notes.find_one({"id": rn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")

    is_draft = existing.get("status") == "DRAFT"

    # Assignee enforcement: skip for DRAFT (anyone with module access can edit drafts).
    if not is_draft:
        _enforce_assignee(existing, user, "edit this receipt note")

    # Single gate: ANY racking note against this RN locks further edits.
    if await db.racking_notes.find_one({"receipt_note_id": rn_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — racking notes exist for this receipt note. Delete those first.")

    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")

    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.invoice_qty is None or it.invoice_qty <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Invoice Qty must be greater than 0")
        if it.received_qty is not None and it.received_qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    items_out = []
    for it in payload.items:
        rec = it.received_qty if it.received_qty is not None else None
        qty_legacy = float(rec) if rec is not None else float(it.invoice_qty)
        items_out.append({
            "part_no": it.part_no.strip(),
            "make": it.make.strip(),
            "invoice_qty": float(it.invoice_qty),
            "received_qty": float(rec) if rec is not None else None,
            "quantity": qty_legacy,
        })

    update = {
        "stock_in_type": payload.stock_in_type,
        "invoice_no": (payload.invoice_no or "").strip(),
        "invoice_date": (payload.invoice_date or "").strip(),
        "goods_received_date": (payload.goods_received_date or "").strip(),
        "items": items_out,
        "updated_at": now_iso(),
        **assignee,
    }
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})

    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="receipt_note.assigned", module="stock_in",
            title=f"Assigned to you: {existing.get('rn_no', '')}",
            message=f"{user.get('email')} assigned Receipt Note {existing.get('rn_no', '')} to you.",
            audience="user", target_user_id=new_aid,
            ref_collection="receipt_notes", ref_id=rn_id,
        )

    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    return doc

@api_router.post("/receipt-notes/{rn_id}/finalize", response_model=ReceiptNote)
async def finalize_receipt_note(rn_id: str, response: Response, user=Depends(get_current_user)):
    """Promote a DRAFT receipt note to RACKING_NOTE_DRAFT.

    Requires: received_qty is a non-negative number for every row (0 is allowed
    and means "nothing received against this row yet"). invoice_date and
    goods_received_date are optional; only a future-date check is applied
    when they are provided.

    Side effects: if any row has received_qty < invoice_qty, a Short Received Note
    is auto-created in DRAFT for the shortfall. If any row has received_qty >
    invoice_qty, an Extra Received Note is auto-created in DRAFT for the overage.
    Both can occur on the same RN (one SRN + one ERN, both linked).
    """
    rn = await db.receipt_notes.find_one({"id": rn_id})
    if not rn:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    if rn.get("status") != "DRAFT":
        raise HTTPException(status_code=409, detail=f"Only DRAFT receipt notes can be finalized (current status: {rn.get('status')})")

    # Header validation — invoice_no/invoice_date/goods_received_date are OPTIONAL.
    # Only future-date sanity check if supplied.
    _no_future_date(rn.get("invoice_date"), "Invoice Date")
    _no_future_date(rn.get("goods_received_date"), "Goods Received Date")
    stock_in_type = (rn.get("stock_in_type") or "INVOICE").upper()

    items = rn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    # Received Qty may be 0 (or null -> treated as 0). Only negative values are rejected.
    for idx, it in enumerate(items, start=1):
        rq = it.get("received_qty")
        if rq is None or rq == "":
            continue
        try:
            if float(rq) < 0:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty must be a number")

    # Update status + sync legacy `quantity` field with received_qty for racking compat
    items_out = []
    short_rows, extra_rows = [], []
    for it in items:
        inv = float(it.get("invoice_qty") or 0)
        rec = float(it.get("received_qty") or 0)
        out = {**it, "quantity": rec, "invoice_qty": inv, "received_qty": rec}
        items_out.append(out)
        diff = rec - inv
        if diff < 0:
            short_rows.append({**out, "short_qty": abs(diff)})
        elif diff > 0:
            extra_rows.append({**out, "extra_qty": diff})

    now = now_iso()
    await db.receipt_notes.update_one(
        {"id": rn_id},
        {"$set": {"items": items_out, "status": "RACKING_NOTE_DRAFT", "finalized_at": now}},
    )

    await _recompute_rn_status(rn_id)
    
    # Auto-create child notes (these land as PENDING — user finalizes them later).
    # GENERAL stock-in never produces SRN/ERN (invoice_qty == received_qty -> qty_diff = 0).
    srn_no, ern_no = None, None
    if stock_in_type != "GENERAL":
        if short_rows:
            srn_no = await _auto_create_srn_for_rn(rn, short_rows, user)
        if extra_rows:
            ern_no = await _auto_create_ern_for_rn(rn, extra_rows, user)

    msg = f"{user.get('email')} finalized {rn['rn_no']} with {len(items_out)} item(s)."
    if srn_no:
        msg += f" Auto-created {srn_no} for shortfall."
    if ern_no:
        msg += f" Auto-created {ern_no} for overage."

    # Rule 1: auto-create DRAFT RKN for the received qty against the parent RN.
    rkn_no = await _auto_create_rkn_for_source("RN", rn_id, user, auto_source="rn-finalize")
    if rkn_no:
        msg += f" Auto-created {rkn_no} for racking."
    await _notify(
        actor=user, type="receipt_note.finalized", module="stock_in",
        title=f"Receipt Note finalized — {rn['rn_no']}",
        message=msg, audience="module",
        ref_collection="receipt_notes", ref_id=rn_id,
    )

    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if rkn_no:
        # Surface auto-RKN to frontend so it can show a toast
        response.headers["X-Auto-RKN-No"] = rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return doc

@api_router.delete("/receipt-notes/{rn_id}")
async def delete_receipt_note(rn_id: str, user=Depends(get_current_user)):
    existing = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    _enforce_assignee(existing, user, "delete this receipt note")
    # Block delete if any racking note (DRAFT or RECORDED) references it
    if await db.racking_notes.find_one({"receipt_note_id": rn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this receipt note. Delete them first.")
    await db.receipt_notes.delete_one({"id": rn_id})
    return {"ok": True}


# -------------------- RACKING NOTES --------------------
@api_router.get("/racking-notes/next-no")
async def next_racking_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.racking_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_rkn_no": f"RKN/{fy}/{next_serial:03d}",
        "rkn_date": today.date().isoformat(),
    }


def _no_future_date(value: str, field_label: str):
    """Raise 400 if the ISO date string is after today. Empty/None passes.

    The server clock is UTC, but users enter dates in their local timezone (e.g. IST
    is UTC+5:30 — a user typing today's local date right after midnight is "tomorrow"
    in UTC). To accept any valid local-today entry without admitting truly future
    dates, we allow up to +1 day past UTC today (covers all timezones up to UTC+24).
    """
    if not value:
        return
    try:
        d = datetime.fromisoformat(value).date()
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_label}: invalid date format")
    max_allowed = datetime.now(timezone.utc).date() + timedelta(days=1)
    if d > max_allowed:
        raise HTTPException(status_code=400, detail=f"{field_label} cannot be in the future")


def _qty_diff(it: dict) -> float:
    """received_qty - invoice_qty. Positive = extra, negative = short, 0 = exact."""
    inv = float(it.get("invoice_qty") or 0)
    rec = float(it.get("received_qty") or 0)
    return rec - inv


def _rn_items_have_all_received(items: list) -> bool:
    """True iff every row has a numeric, > 0 received_qty."""
    if not items:
        return False
    for it in items:
        rq = it.get("received_qty")
        if rq is None or rq == "":
            return False
        try:
            if float(rq) <= 0:
                return False
        except Exception:
            return False
    return True


async def _alloc_serial(series: str, fy: str) -> int:
    """Atomically allocate the next serial number for a given series + FY.

    Uses a `counters` collection where each (series, fy) pair has a single
    document. `find_one_and_update` with $inc and upsert=True is atomic at the
    document level — concurrent callers get distinct, monotonically increasing
    serials with no retry loop and no race window.

    `series` is one of: rn, rkn, srn, ern, in, pn, str, stn
    """
    key = f"{series}:{fy}"
    res = await db.counters.find_one_and_update(
        {"_id": key},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(res["value"])
    


def _validate_racking_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.godown_id or "").strip() or not (it.rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown and Rack are required")
        # box_id is required only when the rack actually has boxes


async def _box_id_required_for_rack(rack_id: str) -> bool:
    """A box must be picked only if the selected rack has at least one box defined."""
    return await db.boxes.count_documents({"rack_id": rack_id}) > 0


def _key(p, m):
    return f"{(p or '').strip()}||{(m or '').strip()}"


# ----------- Live-join helper for consistent master / location data -----------
_MASTER_FIELDS = (
    "model", "old_part_no", "new_part_no", "make_part_no",
    "description_1", "description_2",
    "remarks_oem", "remarks_others",
    "item_category", "unit", "image", "reorder_level",
)


async def _enrich_items(items: list):
    """In-place: overwrite snapshotted master & location fields on each dict
    with the LATEST values from stock_master / godowns / racks / boxes.
    Items that don't have a corresponding live master are left untouched.
    Accepts a list of dicts that have part_no/make and/or godown_id/rack_id/box_id.
    """
    if not items:
        return
    # 1. Build pair sets to query
    sm_pairs = list({(it.get("part_no", ""), it.get("make", "")) for it in items if it.get("part_no")})
    g_ids = list({it.get("godown_id") for it in items if it.get("godown_id")})
    r_ids = list({it.get("rack_id") for it in items if it.get("rack_id")})
    b_ids = list({it.get("box_id") for it in items if it.get("box_id")})
    sm_map, g_map, r_map, b_map = {}, {}, {}, {}
    if sm_pairs:
        or_q = [{"part_no": p, "make": m} for p, m in sm_pairs]
        async for sm in db.stock_master.find({"$or": or_q}, {"_id": 0}):
            sm_map[(sm.get("part_no"), sm.get("make"))] = sm
    if g_ids:
        async for g in db.godowns.find({"id": {"$in": g_ids}}, {"_id": 0}):
            g_map[g["id"]] = g
    if r_ids:
        async for r in db.racks.find({"id": {"$in": r_ids}}, {"_id": 0}):
            r_map[r["id"]] = r
    if b_ids:
        async for b in db.boxes.find({"id": {"$in": b_ids}}, {"_id": 0}):
            b_map[b["id"]] = b
    # 2. Overwrite each item's snapshot fields with live values where available
    for it in items:
        sm = sm_map.get((it.get("part_no"), it.get("make")))
        if sm:
            for f in _MASTER_FIELDS:
                if f in sm:
                    it[f] = sm.get(f) or ("" if f != "reorder_level" else 0)
        g = g_map.get(it.get("godown_id"))
        if g and g.get("godown_name") is not None:
            it["godown_name"] = g["godown_name"]
        rk = r_map.get(it.get("rack_id"))
        if rk and rk.get("rack_no") is not None:
            it["rack_no"] = rk["rack_no"]
        bx = b_map.get(it.get("box_id"))
        if bx:
            if bx.get("box_no") is not None:
                it["box_no"] = bx["box_no"]
            it["box_category"] = bx.get("box_category", it.get("box_category", ""))


async def _enrich_note_items(notes: list):
    """For documents that contain nested `items[]`, enrich each item."""
    flat = []
    for n in notes:
        for it in (n.get("items") or []):
            flat.append(it)
    await _enrich_items(flat)
    return notes


async def _enrich_with_parent_assignee(rows: list, parent_collection: str, parent_id_field: str):
    """Add parent_assigned_to_user_id / _name / _email onto each row by joining against a parent collection."""
    if not rows:
        return rows
    parent_ids = list({r.get(parent_id_field) for r in rows if r.get(parent_id_field)})
    if not parent_ids:
        return rows
    coll = getattr(db, parent_collection)
    pmap = {}
    async for p in coll.find(
        {"id": {"$in": parent_ids}},
        {"_id": 0, "id": 1, "assigned_to_user_id": 1, "assigned_to_name": 1, "assigned_to_email": 1},
    ):
        pmap[p["id"]] = p
    for r in rows:
        p = pmap.get(r.get(parent_id_field), {})
        r["parent_assigned_to_user_id"] = p.get("assigned_to_user_id")
        r["parent_assigned_to_name"] = p.get("assigned_to_name", "") or ""
        r["parent_assigned_to_email"] = p.get("assigned_to_email", "") or ""
    return rows


async def _aggregate_other_rkn_qty(rn_id: str, exclude_rkn_id: Optional[str] = None) -> dict:
    """Sum the qty per (part_no, make) across all OTHER racking notes for an RN."""
    q = {"receipt_note_id": rn_id}
    if exclude_rkn_id:
        q["id"] = {"$ne": exclude_rkn_id}
    sums = {}
    async for rkn in db.racking_notes.find(q, {"_id": 0, "items": 1}):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _validate_cumulative_qty(rn_id: str, items, exclude_rkn_id: Optional[str] = None):
    """Cumulative racked qty per (part_no, make) across all RKNs for this RN must not exceed received qty.
    `items` is the new-payload list (Pydantic models)."""
    rn = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not rn:
        raise HTTPException(status_code=400, detail="Receipt note not found")
    received = {}
    for it in rn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        received[k] = received.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _aggregate_other_rkn_qty(rn_id, exclude_rkn_id)
    new_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        if k not in received:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked receipt note")
    for k, new_q in new_sums.items():
        recv = received.get(k, 0)
        used = other_sums.get(k, 0)
        total = used + new_q
        if total > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Quantity exceeds receipt note for {part} / {make}: "
                    f"received {recv}, already racked elsewhere {used}, this note {new_q} "
                    f"(total {total} > {recv})"
                ),
            )


async def _recompute_rn_status(rn_id: str):
    """Recompute racking-progress status. DRAFT receipts stay at DRAFT.

    Status precedence (highest to lowest), active 4-status set only:
      DRAFT                : manual; never auto-promoted
      RACKING_NOTE_DRAFT   : finalized RN with at most DRAFT racking notes (or none yet —
                             SRN/ERN tree may still emit auto-RKNs later)
      FULLY_RACKED         : all rackable qty (RN.received + SRN.fulfilled + ERN.accepted
                             across descendants) is covered by RECORDED racking notes
                             AND every descendant SRN/ERN is COMPLETE
      PARTIALLY_RACKED     : some RECORDED racking exists but not yet fully covered
                             OR a descendant SRN/ERN is still non-COMPLETE
    """
    rn = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not rn:
        return
    cur = rn.get("status")
    # Drafts never get auto-promoted.
    if cur == "DRAFT":
        return

    # Walk SRN + ERN descendant tree starting from this RN.
    srn_ids: list = []
    ern_ids: list = []
    # Direct SRNs / ERNs under the RN
    seed_srns = await db.short_received_notes.find({"parent_rn_id": rn_id}, {"_id": 0, "id": 1}).to_list(None)
    seed_erns = await db.extra_received_notes.find({"parent_rn_id": rn_id}, {"_id": 0, "id": 1}).to_list(None)
    pending_srn = [s["id"] for s in seed_srns]
    pending_ern = [e["id"] for e in seed_erns]
    while pending_srn:
        sid = pending_srn.pop()
        if sid in srn_ids:
            continue
        srn_ids.append(sid)
        children = await db.short_received_notes.find({"parent_srn_id": sid}, {"_id": 0, "id": 1}).to_list(None)
        for c in children:
            if c["id"] not in srn_ids:
                pending_srn.append(c["id"])
    while pending_ern:
        eid = pending_ern.pop()
        if eid in ern_ids:
            continue
        ern_ids.append(eid)
        children = await db.extra_received_notes.find({"parent_ern_id": eid}, {"_id": 0, "id": 1}).to_list(None)
        for c in children:
            if c["id"] not in ern_ids:
                pending_ern.append(c["id"])

    # Build the set of (source_type, source_id) pairs that count toward this RN's racking.
    source_pairs = [("RN", rn_id)] + [("SRN", sid) for sid in srn_ids] + [("ERN", eid) for eid in ern_ids]
    or_clauses = [{"source_type": st, "source_id": sid} for (st, sid) in source_pairs]

    # First check: any RECORDED RKN exists? If yes -> PARTIALLY_RACKED / FULLY_RACKED.
    # Once any qty is recorded, status NEVER goes back to RACKING_NOTE_DRAFT
    # (even if a later draft RKN is added on top).
    has_recorded_rkn = await db.racking_notes.find_one(
        {"status": "RECORDED", "$or": or_clauses}, {"_id": 0, "id": 1}
    )

    if not has_recorded_rkn:
        # No recorded RKNs yet — RN sits in RACKING_NOTE_DRAFT (covers both
        # "draft RKN exists" and "no RKN at all" cases — the SRN/ERN tree may
        # still produce RKNs later via the auto-creation workflow).
        new_status = "RACKING_NOTE_DRAFT"
        update: dict = {"status": new_status}
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
        await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})
        return

    # Total rackable qty = RN.received + each SRN.fulfilled + each ERN.accepted
    rackable: dict = {}
    for it in rn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        q = it.get("received_qty")
        if q is None:
            q = it.get("quantity") or 0
        rackable[k] = rackable.get(k, 0) + (q or 0)
    if srn_ids:
        async for srn in db.short_received_notes.find({"id": {"$in": srn_ids}}, {"_id": 0, "items": 1}):
            for it in srn.get("items") or []:
                k = _key(it.get("part_no"), it.get("make"))
                children = it.get("children") or []
                if children:
                    rackable[k] = rackable.get(k, 0) + sum(
                        float(c.get("received_qty") or 0) for c in children
                    )
                else:
                    rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    if ern_ids:
        async for ern in db.extra_received_notes.find({"id": {"$in": ern_ids}}, {"_id": 0, "items": 1}):
            for it in ern.get("items") or []:
                k = _key(it.get("part_no"), it.get("make"))
                children = it.get("children") or []
                if children:
                    rackable[k] = rackable.get(k, 0) + sum(
                        float(c.get("accepted_qty") or 0) for c in children
                    )
                else:
                    rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)

    # Total racked qty across RECORDED RKNs against any of these sources.
    racked: dict = {}
    async for rkn in db.racking_notes.find(
        {"status": "RECORDED", "$or": or_clauses}, {"_id": 0, "items": 1}
    ):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            racked[k] = racked.get(k, 0) + (it.get("quantity") or 0)

    # New spec rule: RN cannot be FULLY_RACKED while ANY descendant SRN/ERN is
    # still in a non-terminal state (PENDING / PARTIALLY_*). Even if all current
    # rackable qty is racked, the user may still fulfill the shortfall later.
    has_open_descendant = False
    if srn_ids:
        async for srn in db.short_received_notes.find(
            {"id": {"$in": srn_ids}}, {"_id": 0, "status": 1}
        ):
            if (srn.get("status") or "PENDING").upper() != "COMPLETE":
                has_open_descendant = True
                break
    if not has_open_descendant and ern_ids:
        async for ern in db.extra_received_notes.find(
            {"id": {"$in": ern_ids}}, {"_id": 0, "status": 1}
        ):
            if (ern.get("status") or "PENDING").upper() != "COMPLETE":
                has_open_descendant = True
                break

    # We already confirmed at least one RECORDED RKN exists, so status is
    # PARTIALLY_RACKED unless every rackable qty is fully covered AND no SRN/ERN
    # descendant is still pending.
    if not rackable or sum(rackable.values()) == 0:
        new_status = "PARTIALLY_RACKED"
    else:
        all_full = all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)
        if all_full and not has_open_descendant:
            new_status = "FULLY_RACKED"
        else:
            new_status = "PARTIALLY_RACKED"

    update = {"status": new_status}
    if new_status == "FULLY_RACKED":
        update["racked_at"] = rn.get("racked_at") or now_iso()
    else:
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})

# --- SRN / ERN auto-creation -------------------------------------------------

async def _build_master_snapshot(part_no: str, make: str) -> dict:
    """Pull denormalized master fields for an SRN/ERN item row."""
    sm = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
    return {
        "model": sm.get("model", ""),
        "old_part_no": sm.get("old_part_no", ""),
        "make_part_no": sm.get("make_part_no", ""),
        "description_1": sm.get("description_1", ""),
        "description_2": sm.get("description_2", ""),
        "remarks_oem": sm.get("remarks_oem", ""),
        "remarks_others": sm.get("remarks_others", ""),
        "item_category": sm.get("item_category", ""),
    }


async def _auto_create_srn_for_rn(rn: dict, short_rows: list, actor: dict, parent_srn: dict = None) -> str:
    """Create a PENDING Short Received Note for the given short rows.

    If `parent_srn` is provided, this is a CHILD SRN auto-created from the residual
    shortfall of an ancestor SRN whose user-entered fulfilled_qty was less than its
    short_qty. The chain links back to the original parent RN through parent_rn_id.

    Items consolidate duplicates by (part_no, make) so racking sees one row per pair.
    """
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    for _ in range(5):
        serial = await _alloc_serial("srn", fy)
        srn_no = f"SRN/{fy}/{serial:03d}"
        # Consolidate duplicates — sum short_qty for the same (part_no, make).
        merged = {}
        for r in short_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            sh_q  = float(r.get("short_qty") or 0)
            if key in merged:
                merged[key]["short_qty"]  += sh_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "short_qty": sh_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"])
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "short_qty": m["short_qty"],
                "fulfilled_qty": None,
                "quantity": None,
                **snap,
            })
        if parent_srn:
            chain = f"Auto-generated from {parent_srn['srn_no']} — residual shortfall on {len(items)} item(s)."
            parent_srn_id = parent_srn["id"]
            parent_srn_no = parent_srn["srn_no"]
        else:
            chain = f"Auto-generated from {rn['rn_no']} — short on {len(items)} item(s)."
            parent_srn_id = None
            parent_srn_no = ""
        doc = {
            "id": str(uuid.uuid4()),
            "srn_no": srn_no, "srn_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_srn_id": parent_srn_id,
            "parent_srn_no": parent_srn_no,
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "fulfillment_date": "",
            "items": items,
            "status": "PENDING",
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.short_received_notes.insert_one(doc)
            # Track child SRN reference on each parent item that contributed residual.
            if parent_srn:
                child_keys = {(it["part_no"], it["make"]): float(it.get("short_qty") or 0) for it in items}
                new_parent_items = []
                for p_it in parent_srn.get("items", []):
                    new_p = dict(p_it)
                    k = (p_it.get("part_no"), p_it.get("make"))
                    if k in child_keys:
                        children = list(new_p.get("children") or [])
                        children.append({
                            "child_srn_id": doc["id"],
                            "child_srn_no": srn_no,
                            "short_qty": child_keys[k],
                            "created_at": doc["created_at"],
                        })
                        new_p["children"] = children
                    new_parent_items.append(new_p)
                await db.short_received_notes.update_one(
                    {"id": parent_srn["id"]}, {"$set": {"items": new_parent_items}}
                )
            return srn_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate SRN number after 5 attempts")
    return ""


async def _auto_create_ern_for_rn(rn: dict, extra_rows: list, actor: dict, parent_ern: dict = None) -> str:
    """Create a PENDING Extra Received Note for the given overage rows.

    If `parent_ern` is provided, this is a CHILD ERN auto-created from the
    residual undecided extra of an ancestor ERN (where accepted+rejected < extra).
    Items consolidate duplicates by (part_no, make).
    """
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    for _ in range(5):
        serial = await _alloc_serial("ern", fy)
        ern_no = f"ERN/{fy}/{serial:03d}"
        merged = {}
        for r in extra_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            ex_q  = float(r.get("extra_qty") or 0)
            if key in merged:
                merged[key]["extra_qty"]   += ex_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "extra_qty": ex_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"])
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "extra_qty": m["extra_qty"],
                "accepted_qty": None,
                "rejected_qty": None,
                "quantity": None,
                **snap,
            })
        if parent_ern:
            chain = f"Auto-generated from {parent_ern['ern_no']} — residual extra on {len(items)} item(s)."
            parent_ern_id = parent_ern["id"]
            parent_ern_no = parent_ern["ern_no"]
        else:
            chain = f"Auto-generated from {rn['rn_no']} — extra on {len(items)} item(s)."
            parent_ern_id = None
            parent_ern_no = ""
        doc = {
            "id": str(uuid.uuid4()),
            "ern_no": ern_no, "ern_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_ern_id": parent_ern_id,
            "parent_ern_no": parent_ern_no,
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "goods_received_date": rn.get("goods_received_date", ""),
            "items": items,
            "status": "PENDING",
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.extra_received_notes.insert_one(doc)
            # Track child ERN reference on each parent item that contributed residual.
            if parent_ern:
                child_keys = {(it["part_no"], it["make"]): float(it.get("extra_qty") or 0) for it in items}
                new_parent_items = []
                for p_it in parent_ern.get("items", []):
                    new_p = dict(p_it)
                    k = (p_it.get("part_no"), p_it.get("make"))
                    if k in child_keys:
                        children = list(new_p.get("children") or [])
                        children.append({
                            "child_ern_id": doc["id"],
                            "child_ern_no": ern_no,
                            "extra_qty": child_keys[k],
                            "created_at": doc["created_at"],
                        })
                        new_p["children"] = children
                    new_parent_items.append(new_p)
                await db.extra_received_notes.update_one(
                    {"id": parent_ern["id"]}, {"$set": {"items": new_parent_items}}
                )
            return ern_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate ERN number after 5 attempts")
    return ""


# --- Auto-create RKN against any source (RN | SRN | ERN) --------------------
async def _auto_create_rkn_for_source(
    source_type: str,
    source_id: str,
    actor: dict,
    *,
    auto_source: str,
) -> Optional[str]:
    """Auto-create a DRAFT Racking Note for whatever rackable qty is still pending
    against (source_type, source_id). Returns the new rkn_no, or None when there's
    nothing to rack (avoids creating empty RKNs).

    Reuses the same prepare-rackable logic so qty + locations exactly match what the
    user would have seen in /racking-notes/prepare-source. Inherits assignee from the
    source's parent doc so the workflow keeps the same owner.

    `auto_source` is a free-form tag persisted on the doc:
        "rn-finalize" | "rkn-record-balance" | "srn-child-save" | "ern-child-save"
    """
    source_type = (source_type or "").upper()
    if source_type not in ("RN", "SRN", "ERN"):
        return None

    # Resolve the parent doc + ultimate RN (re-uses existing helper, avoids drift)
    try:
        _, _, parent_doc, ultimate_rn = await _resolve_racking_source(
            {"source_type": source_type, "source_id": source_id}
        )
    except HTTPException:
        return None

    # Use the existing prepare logic to compute pending qty + prefilled locations.
    # Pass user=actor; prepare_racking_for_source ignores user (it's only there for
    # the FastAPI dependency contract).
    try:
        prepared = await prepare_racking_for_source(
            source_type=source_type,
            source_id=source_id,
            exclude_rkn_id=None,
            user=actor,
        )
    except HTTPException as e:
        # 409 if source is already FULLY_RACKED — nothing to do
        if e.status_code == 409:
            return None
        raise
    items = prepared.get("items") or []
    if not items:
        return None

    # Strip helper-only fields the model doesn't accept
    rkn_items = []
    for it in items:
        rkn_items.append({
            "part_no": it.get("part_no", ""),
            "make":    it.get("make", ""),
            "quantity": float(it.get("pending_qty") or 0),
            "model":          it.get("model", ""),
            "old_part_no":    it.get("old_part_no", ""),
            "make_part_no":   it.get("make_part_no", ""),
            "description_1":  it.get("description_1", ""),
            "description_2":  it.get("description_2", ""),
            "remarks_oem":    it.get("remarks_oem", ""),
            "remarks_others": it.get("remarks_others", ""),
            "item_category":  it.get("item_category", ""),
            "godown_id":   it.get("godown_id", ""),
            "godown_name": it.get("godown_name", ""),
            "rack_id":     it.get("rack_id", ""),
            "rack_no":     it.get("rack_no", ""),
            "box_id":      it.get("box_id", ""),
            "box_no":      it.get("box_no", ""),
            "box_category":it.get("box_category", ""),
        })
    rkn_items = [it for it in rkn_items if it["quantity"] > 0]
    if not rkn_items:
        return None

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    # Display strings for the source
    if source_type == "RN":
        source_no = parent_doc.get("rn_no", "")
        source_date = parent_doc.get("rn_date", "")
    elif source_type == "SRN":
        source_no = parent_doc.get("srn_no", "")
        source_date = parent_doc.get("srn_date", "")
    else:  # ERN
        source_no = parent_doc.get("ern_no", "")
        source_date = parent_doc.get("ern_date", "")

    ult_rn_id = (ultimate_rn or {}).get("id", "")
    ult_rn_no = (ultimate_rn or {}).get("rn_no", "")
    ult_rn_date = (ultimate_rn or {}).get("rn_date", "")

    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("rkn", fy)
        rkn_no = f"RKN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rkn_no": rkn_no,
            "rkn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "source_type": source_type,
            "source_id": source_id,
            "source_no": source_no,
            "source_date": source_date,
            "receipt_note_id": ult_rn_id,
            "receipt_note_no": ult_rn_no,
            "receipt_note_date": ult_rn_date,
            "items": rkn_items,
            "status": "DRAFT",
            "auto_created": True,
            "auto_source": auto_source,
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
        }
        try:
            await db.racking_notes.insert_one(doc)
            await _recompute_source_status_after_rkn(source_type, source_id, ult_rn_id)
            return rkn_no
        except DuplicateKeyError as e:
            last_err = e
            continue
    logger.warning(f"Could not allocate auto-RKN number after 5 attempts: {last_err}")
    return None


# ===================== RACKING NOTES — polymorphic source (Phase 2) =====================

async def _resolve_racking_source(payload_or_existing: dict) -> tuple:
    """Given a payload dict or existing rkn doc, normalise (source_type, source_id) and
    fetch the parent doc + ultimate parent RN. Returns (source_type, source_id, parent_doc, ultimate_rn)."""
    source_type = (payload_or_existing.get("source_type") or "").upper()
    source_id = payload_or_existing.get("source_id") or ""
    if not source_type and not source_id:
        # Legacy clients send only receipt_note_id.
        rni = payload_or_existing.get("receipt_note_id")
        if rni:
            source_type = "RN"
            source_id = rni
    if source_type not in ("RN", "SRN", "ERN"):
        raise HTTPException(status_code=400, detail="source_type must be RN, SRN, or ERN")
    if not source_id:
        raise HTTPException(status_code=400, detail="source_id is required")

    if source_type == "RN":
        rn = await db.receipt_notes.find_one({"id": source_id}, {"_id": 0})
        if not rn:
            raise HTTPException(status_code=400, detail="Receipt note not found")
        return "RN", source_id, rn, rn
    if source_type == "SRN":
        srn = await db.short_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not srn:
            raise HTTPException(status_code=400, detail="Short Received Note not found")
        rn = await db.receipt_notes.find_one({"id": srn.get("parent_rn_id")}, {"_id": 0}) or {}
        return "SRN", source_id, srn, rn
    # ERN
    ern = await db.extra_received_notes.find_one({"id": source_id}, {"_id": 0})
    if not ern:
        raise HTTPException(status_code=400, detail="Extra Received Note not found")
    rn = await db.receipt_notes.find_one({"id": ern.get("parent_rn_id")}, {"_id": 0}) or {}
    return "ERN", source_id, ern, rn


async def _validate_cumulative_qty_polymorphic(source_type: str, source_id: str, parent_doc: dict, items, exclude_rkn_id: Optional[str] = None):
    """Cumulative racked qty per (part_no, make) across all RKNs for this source must
    not exceed the rackable qty (received_qty for RN, fulfilled_qty for SRN, accepted_qty for ERN)."""
    rackable = {}
    if source_type == "RN":
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            q = it.get("received_qty")
            if q is None:
                q = it.get("quantity") or 0
            rackable[k] = rackable.get(k, 0) + (q or 0)
    elif source_type == "SRN":
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("received_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    else:  # ERN
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("accepted_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)

    other_sums = await _aggregate_other_rkn_qty_by_source(source_type, source_id, exclude_rkn_id)
    new_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        if k not in rackable:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked source")
    for k, new_q in new_sums.items():
        avail = rackable.get(k, 0)
        used = other_sums.get(k, 0)
        total = used + new_q
        if total > avail + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Quantity exceeds rackable for {part} / {make}: "
                    f"rackable {avail}, already racked elsewhere {used}, this note {new_q} "
                    f"(total {total} > {avail})"
                ),
            )


async def _recompute_source_status_after_rkn(source_type: str, source_id: str, ultimate_rn_id: Optional[str]):
    """After a racking note is created/edited/deleted, recompute the source's racking status,
    and always recompute the ultimate parent RN's status (it now considers SRN/ERN qty)."""
    if source_type == "RN":
        if source_id:
            await _recompute_rn_status(source_id)
    elif source_type == "SRN":
        await _recompute_srn_racking_status(source_id)
    elif source_type == "ERN":
        await _recompute_ern_racking_status(source_id)
    # The RN's FULLY_RACKED state depends on rackable qty across all SRN/ERN descendants,
    # so always re-run RN status recompute when the ultimate RN is known.
    if ultimate_rn_id and source_type != "RN":
        await _recompute_rn_status(ultimate_rn_id)


# Legacy /racking-notes/prepare/{rn_id} kept for back-compat — delegates to the polymorphic version.
@api_router.get("/racking-notes/prepare/{rn_id}")
async def prepare_racking_note(rn_id: str, exclude_rkn_id: Optional[str] = None, user=Depends(_module_dep("stock_in"))):
    """LEGACY: prepare for racking against an RN. Modern clients should use /racking-notes/prepare-source."""
    res = await prepare_racking_for_source(source_type="RN", source_id=rn_id, exclude_rkn_id=exclude_rkn_id, user=user)
    # Reshape header to the legacy contract for old frontend code paths
    src = res["source"]
    return {
        "receipt_note": {
            "id": src["id"], "rn_no": src["no"], "rn_date": src["date"],
            "invoice_no": src.get("invoice_no", ""), "invoice_date": src.get("invoice_date", ""),
            "status": src.get("status"),
        },
        "items": res["items"],
    }


@api_router.post("/racking-notes", response_model=RackingNote)
async def create_racking_note(payload: RackingNoteCreate, user=Depends(_module_dep("stock_in"))):
    src_type, src_id, parent_doc, ultimate_rn = await _resolve_racking_source(payload.model_dump())
    _enforce_assignee(parent_doc, user, "create a racking note for this source")
    # Disallow if source is fully racked
    if src_type == "RN" and parent_doc.get("status") == "FULLY_RACKED":
        raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
    if src_type == "SRN" and await _is_source_fully_racked("SRN", parent_doc):
        raise HTTPException(status_code=409, detail="This Short Received Note is already fully racked")
    if src_type == "ERN" and await _is_source_fully_racked("ERN", parent_doc):
        raise HTTPException(status_code=409, detail="This Extra Received Note is already fully racked")

    _validate_racking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, payload.items, exclude_rkn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None

    # Resolve display strings for the source
    if src_type == "RN":
        source_no = parent_doc.get("rn_no", "")
        source_date = parent_doc.get("rn_date", "")
    elif src_type == "SRN":
        source_no = parent_doc.get("srn_no", "")
        source_date = parent_doc.get("srn_date", "")
    else:
        source_no = parent_doc.get("ern_no", "")
        source_date = parent_doc.get("ern_date", "")

    ult_rn_id = (ultimate_rn or {}).get("id", "")
    ult_rn_no = (ultimate_rn or {}).get("rn_no", "")
    ult_rn_date = (ultimate_rn or {}).get("rn_date", "")

    for _ in range(5):
        serial = await _alloc_serial("rkn", fy)
        rkn_no = f"RKN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rkn_no": rkn_no,
            "rkn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            # Polymorphic
            "source_type": src_type,
            "source_id": src_id,
            "source_no": source_no,
            "source_date": source_date,
            # Legacy fields — receipt_note_* always points to the ULTIMATE parent RN.
            "receipt_note_id": ult_rn_id,
            "receipt_note_no": ult_rn_no,
            "receipt_note_date": ult_rn_date,
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.racking_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_source_status_after_rkn(src_type, src_id, ult_rn_id)
            return doc
        except DuplicateKeyError as e:
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"Could not allocate racking-note number: {last_err}")


@api_router.get("/racking-notes")
async def list_racking_notes(
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
    total = await db.racking_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.racking_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "receipt_notes", "receipt_note_id")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/racking-notes/sources")
async def list_racking_sources(user=Depends(_module_dep("stock_in"))):
    """Return all rackable sources (RN + SRN-with-fulfilled + ERN-with-accepted),
    grouped by their ultimate parent RN."""
    # 1. RNs eligible: any non-DRAFT, non-FULLY_RACKED status.
    rn_rows = await db.receipt_notes.find(
        {"status": {"$in": ["RACKING_NOTE_DRAFT", "PARTIALLY_RACKED"]}},
        {"_id": 0, "id": 1, "rn_no": 1, "rn_date": 1, "stock_in_type": 1,
         "invoice_no": 1, "invoice_date": 1, "status": 1,
         "assigned_to_user_id": 1, "assigned_to_name": 1, "assigned_to_email": 1},
    ).sort("created_at", -1).to_list(5000)

    # 2. SRNs eligible: any with sum(received_qty) > 0 AND not yet fully racked.
    srn_rows = await db.short_received_notes.find({}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    eligible_srns = []
    for s in srn_rows:
        # Inline-child model: rackable = sum(children.received_qty); fall back to fulfilled_qty
        total_rcv = 0.0
        for it in s.get("items") or []:
            children = it.get("children") or []
            if children:
                total_rcv += sum(float(c.get("received_qty") or 0) for c in children)
            else:
                total_rcv += float(it.get("fulfilled_qty") or 0)
        if total_rcv > 0 and not await _is_source_fully_racked("SRN", s):
            eligible_srns.append(s)

    # 3. ERNs eligible: any with sum(accepted_qty) > 0 AND not yet fully racked.
    ern_rows = await db.extra_received_notes.find({}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    eligible_erns = []
    for e in ern_rows:
        total_acc = 0.0
        for it in e.get("items") or []:
            children = it.get("children") or []
            if children:
                total_acc += sum(float(c.get("accepted_qty") or 0) for c in children)
            else:
                total_acc += float(it.get("accepted_qty") or 0)
        if total_acc > 0 and not await _is_source_fully_racked("ERN", e):
            eligible_erns.append(e)

    # Group everything by parent_rn_id.
    groups = {}
    for rn in rn_rows:
        groups[rn["id"]] = {
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "stock_in_type": rn.get("stock_in_type", "INVOICE"),
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "sources": [{
                "source_type": "RN",
                "source_id": rn["id"],
                "source_no": rn.get("rn_no", ""),
                "source_date": rn.get("rn_date", ""),
                "status": rn.get("status", ""),
                "assigned_to_user_id": rn.get("assigned_to_user_id"),
                "assigned_to_name": rn.get("assigned_to_name", ""),
                "assigned_to_email": rn.get("assigned_to_email", ""),
            }],
        }
    for s in eligible_srns:
        prn_id = s.get("parent_rn_id")
        if prn_id not in groups:
            # Parent RN already fully racked; create a stub group so the SRN/ERN are still selectable.
            groups[prn_id] = {
                "parent_rn_id": prn_id,
                "parent_rn_no": s.get("parent_rn_no", ""),
                "parent_rn_date": s.get("parent_rn_date", ""),
                "stock_in_type": "INVOICE",
                "invoice_no": s.get("invoice_no", ""),
                "invoice_date": s.get("invoice_date", ""),
                "sources": [],
            }
        groups[prn_id]["sources"].append({
            "source_type": "SRN",
            "source_id": s["id"],
            "source_no": s.get("srn_no", ""),
            "source_date": s.get("srn_date", ""),
            "status": s.get("status", ""),
            "assigned_to_user_id": s.get("assigned_to_user_id"),
            "assigned_to_name": s.get("assigned_to_name", ""),
            "assigned_to_email": s.get("assigned_to_email", ""),
        })
    for e in eligible_erns:
        prn_id = e.get("parent_rn_id")
        if prn_id not in groups:
            groups[prn_id] = {
                "parent_rn_id": prn_id,
                "parent_rn_no": e.get("parent_rn_no", ""),
                "parent_rn_date": e.get("parent_rn_date", ""),
                "stock_in_type": "INVOICE",
                "invoice_no": e.get("invoice_no", ""),
                "invoice_date": e.get("invoice_date", ""),
                "sources": [],
            }
        groups[prn_id]["sources"].append({
            "source_type": "ERN",
            "source_id": e["id"],
            "source_no": e.get("ern_no", ""),
            "source_date": e.get("ern_date", ""),
            "status": e.get("status", ""),
            "assigned_to_user_id": e.get("assigned_to_user_id"),
            "assigned_to_name": e.get("assigned_to_name", ""),
            "assigned_to_email": e.get("assigned_to_email", ""),
        })

    # Filter out empty groups (parent RN fully racked AND no eligible SRN/ERN under it).
    return [g for g in groups.values() if g.get("sources")]



@api_router.get("/racking-notes/prepare-source")
async def prepare_racking_for_source(
    source_type: str,
    source_id: str,
    exclude_rkn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    """Polymorphic prepare for racking: builds the items list from RN, SRN, or ERN."""
    source_type = (source_type or "").upper()
    if source_type not in ("RN", "SRN", "ERN"):
        raise HTTPException(status_code=400, detail="source_type must be RN, SRN, or ERN")

    if source_type == "RN":
        rn = await db.receipt_notes.find_one({"id": source_id}, {"_id": 0})
        if not rn:
            raise HTTPException(status_code=404, detail="Receipt note not found")
        if rn.get("status") == "FULLY_RACKED" and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
        # The qty available per (part,make) is received_qty.
        rackable = []
        for it in rn.get("items", []):
            rec = it.get("received_qty")
            if rec is None:
                rec = it.get("quantity") or 0
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": float(rec or 0),
            })
        header = {
            "id": rn["id"], "no": rn["rn_no"], "date": rn["rn_date"],
            "type": "RN",
            "parent_rn_id": rn["id"], "parent_rn_no": rn["rn_no"], "parent_rn_date": rn["rn_date"],
            "invoice_no": rn.get("invoice_no", ""), "invoice_date": rn.get("invoice_date", ""),
            "status": rn.get("status"),
        }

    elif source_type == "SRN":
        srn = await db.short_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not srn:
            raise HTTPException(status_code=404, detail="Short Received Note not found")
        if await _is_source_fully_racked("SRN", srn) and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This SRN is already fully racked")
        rackable = []
        for it in srn.get("items", []):
            children = it.get("children") or []
            if children:
                rqty = sum(float(c.get("received_qty") or 0) for c in children)
            else:
                rqty = float(it.get("fulfilled_qty") or 0)
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": rqty,
            })
        header = {
            "id": srn["id"], "no": srn["srn_no"], "date": srn["srn_date"],
            "type": "SRN",
            "parent_rn_id": srn.get("parent_rn_id"),
            "parent_rn_no": srn.get("parent_rn_no", ""),
            "parent_rn_date": srn.get("parent_rn_date", ""),
            "invoice_no": srn.get("invoice_no", ""), "invoice_date": srn.get("invoice_date", ""),
            "status": srn.get("status"),
        }

    else:  # ERN
        ern = await db.extra_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not ern:
            raise HTTPException(status_code=404, detail="Extra Received Note not found")
        if await _is_source_fully_racked("ERN", ern) and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This ERN is already fully racked")
        rackable = []
        for it in ern.get("items", []):
            children = it.get("children") or []
            if children:
                rqty = sum(float(c.get("accepted_qty") or 0) for c in children)
            else:
                rqty = float(it.get("accepted_qty") or 0)
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": rqty,
            })
        header = {
            "id": ern["id"], "no": ern["ern_no"], "date": ern["ern_date"],
            "type": "ERN",
            "parent_rn_id": ern.get("parent_rn_id"),
            "parent_rn_no": ern.get("parent_rn_no", ""),
            "parent_rn_date": ern.get("parent_rn_date", ""),
            "invoice_no": ern.get("invoice_no", ""), "invoice_date": ern.get("invoice_date", ""),
            "status": ern.get("status"),
        }

    # How much has already been racked from this same source?
    other_sums = await _aggregate_other_rkn_qty_by_source(source_type, source_id, exclude_rkn_id)

    items_out = []
    for r in rackable:
        part_no = r["part_no"]
        make = r["make"]
        avail = r["rackable_qty"]
        if avail <= 0:
            continue
        already = other_sums.get(_key(part_no, make), 0)
        pending = avail - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        # Existing locations
        pipeline = [
            {"$match": {"part_no": part_no, "make": make}},
            {"$group": {
                "_id": {
                    "godown_id": "$godown_id", "godown_name": "$godown_name",
                    "rack_id": "$rack_id", "rack_no": "$rack_no",
                    "box_id": "$box_id", "box_no": "$box_no", "box_category": "$box_category",
                },
                "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
            }},
            {"$match": {"quantity": {"$gt": 0}}},
            {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
        ]
        raw_locs = await db.transactions.aggregate(pipeline).to_list(1000)
        existing_locations = [{**rr["_id"], "current_qty": rr["quantity"]} for rr in raw_locs]
        prefill = existing_locations[0] if len(existing_locations) == 1 else None
        items_out.append({
            "part_no": part_no, "make": make,
            "rackable_qty": avail,
            "already_racked_qty": already,
            "pending_qty": pending,
            "quantity": pending,
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
            "existing_locations": existing_locations,
        })

    return {"source": header, "items": items_out}


@api_router.get("/racking-notes/{rkn_id}")
async def get_racking_note(rkn_id: str, user=Depends(get_current_user)):
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Racking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "receipt_notes", "receipt_note_id")
    return doc


@api_router.put("/racking-notes/{rkn_id}", response_model=RackingNote)
async def update_racking_note(rkn_id: str, payload: RackingNoteCreate, user=Depends(_module_dep("stock_in"))):
    existing = await db.racking_notes.find_one({"id": rkn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — this racking note has already been recorded as Stock In")

    # Use the existing rkn's source as the source of truth for editing.
    src_type = existing.get("source_type") or "RN"
    src_id = existing.get("source_id") or existing.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "edit this racking note")

    _validate_racking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, payload.items, exclude_rkn_id=rkn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.racking_notes.update_one({"id": rkn_id}, {"$set": update})
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    return doc


@api_router.delete("/racking-notes/{rkn_id}")
async def delete_racking_note(rkn_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock In")
    src_type = existing.get("source_type") or "RN"
    src_id = existing.get("source_id") or existing.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "delete this racking note")
    await db.racking_notes.delete_one({"id": rkn_id})
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    return {"ok": True}


@api_router.post("/racking-notes/{rkn_id}/record")
async def record_racking_note(rkn_id: str, response: Response, user=Depends(_module_dep("stock_in"))):
    rkn = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not rkn:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if rkn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    src_type = rkn.get("source_type") or "RN"
    src_id = rkn.get("source_id") or rkn.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "record this racking note")
    items = rkn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    for idx, it in enumerate(items, start=1):
        if not it.get("godown_id") or not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown/Rack missing — edit racking note before recording")
        if not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing — edit racking note before recording")
        if (it.get("quantity") or 0) <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: quantity must be > 0")

    now = now_iso()
    tx_docs = []
    for it in items:
        master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
        tx_docs.append({
            "id": str(uuid.uuid4()),
            "type": "IN",
            "part_no": it["part_no"],
            "make": it["make"],
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
            "godown_id": it["godown_id"],
            "godown_name": it.get("godown_name", ""),
            "rack_id": it["rack_id"],
            "rack_no": it.get("rack_no", ""),
            "box_id": it["box_id"],
            "box_no": it.get("box_no", ""),
            "box_category": it.get("box_category", ""),
            "racking_note_id": rkn["id"],
            "racking_note_no": rkn["rkn_no"],
            "source_type": src_type,
            "source_id": src_id,
            "source_no": rkn.get("source_no", ""),
            "receipt_note_id": rkn.get("receipt_note_id", ""),
            "receipt_note_no": rkn.get("receipt_note_no", ""),
            "created_at": now,
            "created_by": user.get("email"),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.racking_notes.update_one(
        {"id": rkn_id},
        {"$set": {"status": "RECORDED", "recorded_at": now}},
    )
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))

    # Rule 2: if the same source still has unracked qty, auto-create a balance RKN.
    balance_rkn_no = await _auto_create_rkn_for_source(
        src_type, src_id, user, auto_source="rkn-record-balance"
    )

    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    extra_msg = f" Auto-created {balance_rkn_no} for remaining qty." if balance_rkn_no else ""
    await _notify(
        actor=user, type="stock_in.recorded", module="stock_in",
        title=f"Stock In recorded ({rkn['rkn_no']})",
        message=f"{user.get('email')} recorded {len(tx_docs)} item(s), total qty {total_qty} into stock from {rkn.get('source_no') or rkn.get('receipt_note_no') or 'source'}.{extra_msg}",
        audience="module", ref_collection="racking_notes", ref_id=rkn_id,
    )
    if balance_rkn_no:
        response.headers["X-Auto-RKN-No"] = balance_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return {"ok": True, "transactions_created": len(tx_docs), "auto_rkn_no": balance_rkn_no}

# ===================== SHORT RECEIVED NOTES — read-only endpoints (Phase 1) =====================

# ===================== SRN / ERN STATUS HELPERS (Phase 2) =====================

def _compute_srn_status(srn: dict) -> str:
    """Inline-child model status:
       sum(short_qty) == 0                                   -> PENDING
       no children                                            -> PENDING
       sum(received + not_receivable) < sum(short_qty)        -> PARTIALLY_RECEIVED
       sum(received + not_receivable) >= sum(short_qty)       -> COMPLETE
    """
    items = srn.get("items") or []
    total_short = 0.0
    total_decided = 0.0
    has_children = False
    for it in items:
        total_short += float(it.get("short_qty") or 0)
        for c in (it.get("children") or []):
            has_children = True
            total_decided += float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
    if total_short <= 0:
        return "PENDING"
    if not has_children or total_decided <= 0:
        return "PENDING"
    if total_decided + 1e-6 >= total_short:
        return "COMPLETE"
    return "PARTIALLY_RECEIVED"


def _compute_ern_status(ern: dict) -> str:
    """Inline-child model status:
       Each child entry has accepted_qty + rejected_qty.

         total_decided = sum(accepted+rejected) across all children
         no children                            -> PENDING
         total_decided >= sum(extra_qty)        -> COMPLETE
         any decided activity but not complete  -> PARTIALLY_ACCEPTED
                                                   (legacy PARTIALLY_REJECTED collapsed
                                                    into PARTIALLY_ACCEPTED in iter-30)
    """
    items = ern.get("items") or []
    total_extra = 0.0
    total_acc = 0.0
    total_rej = 0.0
    has_children = False
    for it in items:
        total_extra += float(it.get("extra_qty") or 0)
        for c in (it.get("children") or []):
            has_children = True
            total_acc += float(c.get("accepted_qty") or 0)
            total_rej += float(c.get("rejected_qty") or 0)
    if total_extra <= 0:
        return "PENDING"
    decided = total_acc + total_rej
    if not has_children or decided <= 0:
        return "PENDING"
    if decided + 1e-6 >= total_extra:
        return "COMPLETE"
    if total_acc > 0:
        return "PARTIALLY_ACCEPTED"
    # Only rejections so far → still partially-accepted (zero accepted)
    # so the user knows fulfillment is in progress.
    if total_rej > 0:
        return "PARTIALLY_ACCEPTED"
    return "PENDING"


async def _aggregate_other_rkn_qty_by_source(source_type: str, source_id: str, exclude_rkn_id: Optional[str] = None) -> dict:
    """Sum qty per (part_no, make) across all OTHER racking notes for a given (source_type, source_id)."""
    q = {"source_type": source_type, "source_id": source_id}
    if exclude_rkn_id:
        q["id"] = {"$ne": exclude_rkn_id}
    sums = {}
    async for rkn in db.racking_notes.find(q, {"_id": 0, "items": 1}):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _is_source_fully_racked(source_type: str, source_doc: dict) -> bool:
    """True iff every rackable (part, make) on the source is fully covered by RECORDED RKNs.
    Used in place of the legacy `racking_status == FULLY_RACKED` check on SRN/ERN."""
    rackable = {}
    if source_type == "SRN":
        for it in source_doc.get("items") or []:
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("received_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    elif source_type == "ERN":
        for it in source_doc.get("items") or []:
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("accepted_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)
    else:
        return False
    if not rackable or sum(rackable.values()) == 0:
        return False
    racked = {}
    async for rkn in db.racking_notes.find(
        {"status": "RECORDED", "source_type": source_type, "source_id": source_doc.get("id")},
        {"_id": 0, "items": 1},
    ):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            racked[k] = racked.get(k, 0) + float(it.get("quantity") or 0)
    return all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)


async def _recompute_srn_racking_status(srn_id: str):
    """Legacy field cleanup. The "is fully racked" semantics are now derived at
    runtime via _is_source_fully_racked(). This helper is kept as a no-op-ish
    cleanup so callers keep working; it just drops the legacy racking_status /
    racked_at fields if they exist on old docs."""
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$unset": {"racking_status": "", "racked_at": ""}},
    )


async def _recompute_ern_racking_status(ern_id: str):
    """Legacy field cleanup — see _recompute_srn_racking_status."""
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$unset": {"racking_status": "", "racked_at": ""}},
    )


# ===================== SHORT RECEIVED NOTES — full CRUD =====================

class ShortReceivedNoteUpdate(BaseModel):
    """Used for editing fulfilled_qty + fulfillment_date on an SRN that is still PENDING/PARTIALLY_RECEIVED."""
    fulfillment_date: Optional[str] = ""
    items: List[dict] = []   # accept dicts so frontend can send {part_no, make, fulfilled_qty}


@api_router.get("/short-received-notes/next-no")
async def next_srn_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.short_received_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_srn_no": f"SRN/{fy}/{next_serial:03d}",
        "srn_date": today.date().isoformat(),
    }


@api_router.get("/short-received-notes")
async def list_short_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.short_received_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.short_received_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/short-received-notes/{srn_id}")
async def get_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/short-received-notes/{srn_id}", response_model=ShortReceivedNote)
async def update_short_received_note(srn_id: str, payload: ShortReceivedNoteUpdate, user=Depends(_module_dep("stock_in"))):
    """Edit fulfilled_qty / fulfillment_date on an SRN that hasn't been fully received yet.
    Also recompute status. Cannot edit if SRN is COMPLETE already."""
    existing = await db.short_received_notes.find_one({"id": srn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(existing, user, "edit this Short Received Note")
    if existing.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="Cannot edit — this SRN is already fully received")

    _no_future_date(payload.fulfillment_date, "Fulfillment Date")

    # Build a lookup from payload by (part_no, make)
    payload_map = {}
    for r in (payload.items or []):
        if not r.get("part_no") or not r.get("make"):
            continue
        key = (r["part_no"], r["make"])
        payload_map[key] = r

    items_out = []
    for it in existing.get("items", []):
        new_it = dict(it)
        key = (it.get("part_no"), it.get("make"))
        if key in payload_map:
            ful = payload_map[key].get("fulfilled_qty")
            if ful is None or ful == "":
                new_it["fulfilled_qty"] = None
                new_it["quantity"] = None
            else:
                try:
                    f = float(ful)
                except Exception:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty must be a number")
                if f < 0:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty cannot be negative")
                short_q = float(it.get("short_qty") or 0)
                if f > short_q + 1e-6:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty ({f}) cannot exceed short_qty ({short_q})")
                new_it["fulfilled_qty"] = f
                new_it["quantity"] = f   # legacy mirror for racking
        items_out.append(new_it)

    update = {
        "items": items_out,
        "fulfillment_date": (payload.fulfillment_date or "").strip(),
        "updated_at": now_iso(),
    }
    new_status = _compute_srn_status({"items": items_out})
    update["status"] = new_status
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": update})
    await _recompute_srn_racking_status(srn_id)
    # Bubble up to the ultimate RN: its FULLY_RACKED check considers SRN fulfilled qty.
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


@api_router.post("/short-received-notes/{srn_id}/finalize", response_model=ShortReceivedNote)
async def finalize_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    """Finalize an SRN. If fulfilled_qty < short_qty for any item, a CHILD SRN is auto-created
    for the residual shortfall, linked back to the same parent_rn_id."""
    srn = await db.short_received_notes.find_one({"id": srn_id})
    if not srn:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(srn, user, "finalize this Short Received Note")
    if srn.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This SRN is already fully received")

    items = srn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="SRN has no items")

    # All items must have fulfilled_qty filled (>= 0). 0 is allowed -> the item rolls fully into the child SRN.
    residual_rows = []
    for it in items:
        f = it.get("fulfilled_qty")
        if f is None:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: enter Fulfilled Qty before Final Save")
        try:
            f = float(f)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty must be a number")
        short_q = float(it.get("short_qty") or 0)
        residual = short_q - f
        if residual > 1e-6:
            residual_rows.append({
                "part_no": it.get("part_no"), "make": it.get("make"),
                "invoice_qty": float(it.get("invoice_qty") or 0),
                "received_qty": float(it.get("received_qty") or 0),
                "short_qty": residual,
            })

    now = now_iso()
    new_status = _compute_srn_status({"items": items})
    update = {
        "status": new_status,
        "finalized_at": now,
    }
    if not srn.get("fulfillment_date") and any((it.get("fulfilled_qty") or 0) > 0 for it in items):
        update["fulfillment_date"] = datetime.now(timezone.utc).date().isoformat()
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": update})
    await _recompute_srn_racking_status(srn_id)
    # Bubble up to the ultimate RN: its FULLY_RACKED check considers SRN fulfilled qty.
    if srn.get("parent_rn_id"):
        await _recompute_rn_status(srn["parent_rn_id"])

    # Create child SRN for the residual.
    child_srn_no = None
    if residual_rows:
        rn = await db.receipt_notes.find_one({"id": srn.get("parent_rn_id")}, {"_id": 0}) or {}
        child_srn_no = await _auto_create_srn_for_rn(rn, residual_rows, user, parent_srn=srn)

    msg = f"{user.get('email')} finalized {srn['srn_no']} ({new_status})."
    if child_srn_no:
        msg += f" Auto-created child {child_srn_no} for residual shortfall."
    await _notify(
        actor=user, type="srn.finalized", module="stock_in",
        title=f"SRN finalized — {srn['srn_no']}",
        message=msg, audience="module",
        ref_collection="short_received_notes", ref_id=srn_id,
    )

    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


# ===================== SRN slice (per-batch fulfillment) — DEPRECATED =====================
# The slice-as-separate-doc endpoints below have been REMOVED in favour of the
# inline-child model defined further down. Helpers + body class kept for legacy
# imports.

class SrnFulfillSliceBody(BaseModel):
    part_no: str
    make: str
    fulfilled_qty: float
    fulfillment_date: str          # ISO YYYY-MM-DD


# ===================== SRN child rows (inline batches per item) =====================
#
# In the inline-child model, each parent SRN.items[i].children[] entry is a
# fulfillment record (NOT a separate SRN document). Each entry has:
#   {child_srn_no, received_qty, not_receivable_qty, created_at, status}
# where `child_srn_no` is the parent SRN no suffixed with an alphabetical letter
# (e.g. "SRN/26-27/001-A"). Racking happens against the parent SRN; the rackable
# qty per item is sum(children.received_qty).

class SrnChildBody(BaseModel):
    part_no: str
    make: str
    received_qty: float = 0
    not_receivable_qty: float = 0


def _next_letter_suffix(used: set[str]) -> str:
    """Return the next alphabetical suffix not in `used` (A..Z, AA..AZ, BA.. ZZ)."""
    import string
    letters = string.ascii_uppercase
    for ch in letters:
        if ch not in used:
            return ch
    for a in letters:
        for b in letters:
            cand = a + b
            if cand not in used:
                return cand
    raise HTTPException(status_code=409, detail="Cannot allocate child suffix — too many children")


@api_router.post("/short-received-notes/{srn_id}/children", response_model=ShortReceivedNote)
async def add_srn_child_row(srn_id: str, body: SrnChildBody, response: Response,
                            user=Depends(_module_dep("stock_in"))):
    """Append a new fulfillment row to the matching parent SRN item. Auto-allocates
    a letter-suffixed child_srn_no (PARENT-A, PARENT-B, ...). Recomputes status."""
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(parent, user, "add a fulfillment row on this Short Received Note")

    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found on this SRN")

    p_item = parent["items"][item_idx]
    short_qty = float(p_item.get("short_qty") or 0)
    children = list(p_item.get("children") or [])
    used_total = sum(float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
                     for c in children)
    if used_total + rcv + nrcv > short_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Pending Qty ({short_qty - used_total:.2f})")

    parent_no = parent.get("srn_no", "")
    used_suffixes = {(c.get("child_srn_no") or "").rsplit("-", 1)[-1] for c in children}
    suffix = _next_letter_suffix(used_suffixes)
    child = {
        "child_srn_no": f"{parent_no}-{suffix}",
        "received_qty": rcv,
        "not_receivable_qty": nrcv,
        "created_at": now_iso(),
        "status": "RECEIVED" if rcv > 0 else "NOT_RECEIVABLE",
    }
    children.append(child)

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = children
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])

    # Rule 3: if the new child added rackable qty, auto-create a DRAFT RKN
    # against this SRN (covers only the newly-pending qty thanks to
    # prepare_racking_for_source's already_racked subtraction).
    auto_rkn_no = None
    if rcv > 0:
        auto_rkn_no = await _auto_create_rkn_for_source(
            "SRN", srn_id, user, auto_source="srn-child-save"
        )
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})


@api_router.put("/short-received-notes/{srn_id}/children/{child_srn_no:path}", response_model=ShortReceivedNote)
async def edit_srn_child_row(srn_id: str, child_srn_no: str, body: SrnChildBody, response: Response,
                             user=Depends(_module_dep("stock_in"))):
    """Edit a child row (received_qty / not_receivable_qty). Allowed only if the
    parent SRN's racking_status isn't FULLY_RACKED AND the new totals don't drop
    below the qty already racked against the parent SRN."""
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent SRN not found")
    _enforce_assignee(parent, user, "edit a row on this Short Received Note")

    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found")
    p_item = parent["items"][item_idx]
    short_qty = float(p_item.get("short_qty") or 0)
    children = list(p_item.get("children") or [])
    others_total = sum(
        float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
        for c in children if c.get("child_srn_no") != child_srn_no
    )
    if others_total + rcv + nrcv > short_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Short Qty ({short_qty - others_total:.2f})")

    # If the parent's items[].children received qty already racked > new total received,
    # block (would create negative racking inventory).
    racked = await _aggregate_other_rkn_qty_by_source("SRN", srn_id, exclude_rkn_id=None)
    racked_for_item = float(racked.get(_key(body.part_no, body.make), 0))
    new_total_rcv = sum(
        float(c.get("received_qty") or 0)
        for c in children if c.get("child_srn_no") != child_srn_no
    ) + rcv
    if racked_for_item > new_total_rcv + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot reduce — {racked_for_item:.2f} already racked")

    found = False
    new_children = []
    for c in children:
        if c.get("child_srn_no") == child_srn_no:
            new_children.append({
                **c, "received_qty": rcv, "not_receivable_qty": nrcv,
                "status": "RECEIVED" if rcv > 0 else "NOT_RECEIVABLE",
            })
            found = True
        else:
            new_children.append(c)
    if not found:
        raise HTTPException(status_code=404, detail="Child row not found")

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = new_children
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    # Rule 3: edit may have raised received_qty → auto-create RKN if newly pending.
    auto_rkn_no = None
    if rcv > 0:
        auto_rkn_no = await _auto_create_rkn_for_source(
            "SRN", srn_id, user, auto_source="srn-child-save"
        )
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})


@api_router.delete("/short-received-notes/{srn_id}/children/{child_srn_no:path}")
async def delete_srn_child_row(srn_id: str, child_srn_no: str,
                               user=Depends(_module_dep("stock_in"))):
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent SRN not found")
    _enforce_assignee(parent, user, "delete a row on this Short Received Note")

    target = None
    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        for c in (it.get("children") or []):
            if c.get("child_srn_no") == child_srn_no:
                target = c
                item_idx = i
                break
        if target:
            break
    if not target:
        raise HTTPException(status_code=404, detail="Child row not found")

    # Block deletion if dropping qty would go below already-racked.
    racked = await _aggregate_other_rkn_qty_by_source("SRN", srn_id, exclude_rkn_id=None)
    p_item = parent["items"][item_idx]
    racked_for_item = float(racked.get(_key(p_item.get("part_no"), p_item.get("make")), 0))
    remaining_rcv = sum(
        float(c.get("received_qty") or 0)
        for c in (p_item.get("children") or [])
        if c.get("child_srn_no") != child_srn_no
    )
    if racked_for_item > remaining_rcv + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot delete — {racked_for_item:.2f} already racked")

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = [c for c in (new_it.get("children") or [])
                                  if c.get("child_srn_no") != child_srn_no]
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return {"ok": True}


# Legacy slice endpoints (kept for back-compat; route to the new model).
@api_router.delete("/short-received-notes/{srn_id}")
async def delete_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(existing, user, "delete this Short Received Note")
    if await db.racking_notes.find_one({"source_type": "SRN", "source_id": srn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this SRN. Delete them first.")
    if await db.short_received_notes.find_one({"parent_srn_id": srn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — a child SRN was generated from this SRN. Delete the child first.")
    await db.short_received_notes.delete_one({"id": srn_id})
    return {"ok": True}


# ===================== EXTRA RECEIVED NOTES — full CRUD =====================

class ExtraReceivedNoteUpdate(BaseModel):
    """Used for editing accepted_qty / rejected_qty per item."""
    items: List[dict] = []


@api_router.get("/extra-received-notes/next-no")
async def next_ern_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.extra_received_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_ern_no": f"ERN/{fy}/{next_serial:03d}",
        "ern_date": today.date().isoformat(),
    }


@api_router.get("/extra-received-notes")
async def list_extra_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.extra_received_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.extra_received_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/extra-received-notes/{ern_id}")
async def get_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/extra-received-notes/{ern_id}", response_model=ExtraReceivedNote)
async def update_extra_received_note(ern_id: str, payload: ExtraReceivedNoteUpdate, user=Depends(_module_dep("stock_in"))):
    existing = await db.extra_received_notes.find_one({"id": ern_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(existing, user, "edit this Extra Received Note")
    if existing.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="Cannot edit — this ERN is already complete")

    payload_map = {}
    for r in (payload.items or []):
        if not r.get("part_no") or not r.get("make"):
            continue
        key = (r["part_no"], r["make"])
        payload_map[key] = r

    items_out = []
    for it in existing.get("items", []):
        new_it = dict(it)
        key = (it.get("part_no"), it.get("make"))
        if key in payload_map:
            extra_q = float(it.get("extra_qty") or 0)
            for fld in ("accepted_qty", "rejected_qty"):
                v = payload_map[key].get(fld)
                if v is None or v == "":
                    new_it[fld] = None
                else:
                    try:
                        f = float(v)
                    except Exception:
                        raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: {fld} must be a number")
                    if f < 0:
                        raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: {fld} cannot be negative")
                    new_it[fld] = f
            acc = float(new_it.get("accepted_qty") or 0)
            rej = float(new_it.get("rejected_qty") or 0)
            if acc + rej > extra_q + 1e-6:
                raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted+rejected ({acc + rej}) cannot exceed extra_qty ({extra_q})")
            new_it["quantity"] = acc   # legacy mirror — racking only sees accepted
        items_out.append(new_it)

    update = {
        "items": items_out,
        "updated_at": now_iso(),
        "status": _compute_ern_status({"items": items_out}),
    }
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": update})
    await _recompute_ern_racking_status(ern_id)
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    return doc


@api_router.post("/extra-received-notes/{ern_id}/finalize", response_model=ExtraReceivedNote)
async def finalize_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    """Finalize an ERN. accepted_qty + rejected_qty must be present (per row).
    accepted_qty is mandatory (>= 0); rejected_qty is optional (defaults to 0).
    If accepted+rejected < extra_qty, a CHILD ERN is auto-created for the residual."""
    ern = await db.extra_received_notes.find_one({"id": ern_id})
    if not ern:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(ern, user, "finalize this Extra Received Note")
    if ern.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This ERN is already complete")

    items = ern.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="ERN has no items")

    residual_rows = []
    for it in items:
        acc = it.get("accepted_qty")
        if acc is None:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: enter Accepted Qty before Final Save")
        try:
            acc = float(acc)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted_qty must be a number")
        rej = it.get("rejected_qty")
        rej = float(rej or 0)
        extra_q = float(it.get("extra_qty") or 0)
        if acc + rej > extra_q + 1e-6:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted+rejected ({acc + rej}) cannot exceed extra_qty ({extra_q})")
        residual = extra_q - acc - rej
        if residual > 1e-6:
            residual_rows.append({
                "part_no": it.get("part_no"), "make": it.get("make"),
                "invoice_qty": float(it.get("invoice_qty") or 0),
                "received_qty": float(it.get("received_qty") or 0),
                "extra_qty": residual,
            })

    now = now_iso()
    new_status = _compute_ern_status({"items": items})
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": {
        "status": new_status,
        "finalized_at": now,
    }})
    await _recompute_ern_racking_status(ern_id)
    if ern.get("parent_rn_id"):
        await _recompute_rn_status(ern["parent_rn_id"])

    child_ern_no = None
    if residual_rows:
        rn = await db.receipt_notes.find_one({"id": ern.get("parent_rn_id")}, {"_id": 0}) or {}
        child_ern_no = await _auto_create_ern_for_rn(rn, residual_rows, user, parent_ern=ern)

    msg = f"{user.get('email')} finalized {ern['ern_no']} ({new_status})."
    if child_ern_no:
        msg += f" Auto-created child {child_ern_no} for residual extra."
    await _notify(
        actor=user, type="ern.finalized", module="stock_in",
        title=f"ERN finalized — {ern['ern_no']}",
        message=msg, audience="module",
        ref_collection="extra_received_notes", ref_id=ern_id,
    )

    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    return doc



# ===================== ERN child rows (inline batches per item) =====================
# Same model as SRN: each parent ERN.items[i].children[] entry is a decision
# record with {child_ern_no, accepted_qty, rejected_qty, created_at, status}.
# child_ern_no is "PARENT-LETTER" (e.g. "ERN/26-27/001-A"). Racking pulls from
# sum(children.accepted_qty); rejected qty is NOT rackable.

class ErnChildBody(BaseModel):
    part_no: str
    make: str
    accepted_qty: float = 0
    rejected_qty: float = 0


@api_router.post("/extra-received-notes/{ern_id}/children", response_model=ExtraReceivedNote)
async def add_ern_child_row(ern_id: str, body: ErnChildBody, response: Response,
                            user=Depends(_module_dep("stock_in"))):
    """Append a decision row (accepted + rejected) to a parent ERN item.
    Auto-allocates a letter-suffixed child_ern_no (PARENT-A, PARENT-B, ...)."""
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(parent, user, "add a row on this Extra Received Note")
    acc = float(body.accepted_qty or 0)
    rej = float(body.rejected_qty or 0)
    if acc < 0 or rej < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if acc == 0 and rej == 0:
        raise HTTPException(status_code=400, detail="At least one of Accepted Qty or Rejected Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found on this ERN")
    p_item = parent["items"][item_idx]
    extra_qty = float(p_item.get("extra_qty") or 0)
    children = list(p_item.get("children") or [])
    used = sum(float(c.get("accepted_qty") or 0) + float(c.get("rejected_qty") or 0)
               for c in children)
    if used + acc + rej > extra_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Pending Qty ({extra_qty - used:.2f})")

    parent_no = parent.get("ern_no", "")
    used_suffixes = {(c.get("child_ern_no") or "").rsplit("-", 1)[-1] for c in children}
    suffix = _next_letter_suffix(used_suffixes)
    children.append({
        "child_ern_no": f"{parent_no}-{suffix}",
        "accepted_qty": acc,
        "rejected_qty": rej,
        "created_at": now_iso(),
        "status": "COMPLETE",
    })
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = children
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    # Rule 3 (parallel for ERN): if accepted_qty was added, auto-create RKN.
    auto_rkn_no = None
    if acc > 0:
        auto_rkn_no = await _auto_create_rkn_for_source(
            "ERN", ern_id, user, auto_source="ern-child-save"
        )
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@api_router.put("/extra-received-notes/{ern_id}/children/{child_ern_no:path}", response_model=ExtraReceivedNote)
async def edit_ern_child_row(ern_id: str, child_ern_no: str, body: ErnChildBody, response: Response,
                             user=Depends(_module_dep("stock_in"))):
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent ERN not found")
    _enforce_assignee(parent, user, "edit a row on this Extra Received Note")
    acc = float(body.accepted_qty or 0)
    rej = float(body.rejected_qty or 0)
    if acc < 0 or rej < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if acc == 0 and rej == 0:
        raise HTTPException(status_code=400, detail="At least one of Accepted Qty or Rejected Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found")
    p_item = parent["items"][item_idx]
    extra_qty = float(p_item.get("extra_qty") or 0)
    children = list(p_item.get("children") or [])
    others = sum(float(c.get("accepted_qty") or 0) + float(c.get("rejected_qty") or 0)
                 for c in children if c.get("child_ern_no") != child_ern_no)
    if others + acc + rej > extra_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Extra Qty ({extra_qty - others:.2f})")
    racked = await _aggregate_other_rkn_qty_by_source("ERN", ern_id, exclude_rkn_id=None)
    racked_for_item = float(racked.get(_key(body.part_no, body.make), 0))
    new_total_acc = sum(float(c.get("accepted_qty") or 0)
                        for c in children if c.get("child_ern_no") != child_ern_no) + acc
    if racked_for_item > new_total_acc + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot reduce — {racked_for_item:.2f} already racked")
    found = False
    new_children = []
    for c in children:
        if c.get("child_ern_no") == child_ern_no:
            new_children.append({**c, "accepted_qty": acc, "rejected_qty": rej})
            found = True
        else:
            new_children.append(c)
    if not found:
        raise HTTPException(status_code=404, detail="Child row not found")
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = new_children
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    # Rule 3 parallel: edit may have raised accepted_qty → auto-create RKN.
    auto_rkn_no = None
    if acc > 0:
        auto_rkn_no = await _auto_create_rkn_for_source(
            "ERN", ern_id, user, auto_source="ern-child-save"
        )
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@api_router.delete("/extra-received-notes/{ern_id}/children/{child_ern_no:path}")
async def delete_ern_child_row(ern_id: str, child_ern_no: str,
                               user=Depends(_module_dep("stock_in"))):
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent ERN not found")
    _enforce_assignee(parent, user, "delete a row on this Extra Received Note")
    target = None
    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        for c in (it.get("children") or []):
            if c.get("child_ern_no") == child_ern_no:
                target = c
                item_idx = i
                break
        if target:
            break
    if not target:
        raise HTTPException(status_code=404, detail="Child row not found")
    racked = await _aggregate_other_rkn_qty_by_source("ERN", ern_id, exclude_rkn_id=None)
    p_item = parent["items"][item_idx]
    racked_for_item = float(racked.get(_key(p_item.get("part_no"), p_item.get("make")), 0))
    remaining_acc = sum(
        float(c.get("accepted_qty") or 0)
        for c in (p_item.get("children") or [])
        if c.get("child_ern_no") != child_ern_no
    )
    if racked_for_item > remaining_acc + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot delete — {racked_for_item:.2f} already racked")
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = [c for c in (new_it.get("children") or [])
                                  if c.get("child_ern_no") != child_ern_no]
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return {"ok": True}


@api_router.delete("/extra-received-notes/{ern_id}")
async def delete_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(existing, user, "delete this Extra Received Note")
    if await db.racking_notes.find_one({"source_type": "ERN", "source_id": ern_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this ERN. Delete them first.")
    if await db.extra_received_notes.find_one({"parent_ern_id": ern_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — a child ERN was generated from this ERN. Delete the child first.")
    await db.extra_received_notes.delete_one({"id": ern_id})
    return {"ok": True}


# ===================== RACKING SOURCES (polymorphic) =====================

# ===================== ISSUE NOTES (Stock Out) =====================
async def _stock_total_for(part_no: str, make: str) -> float:
    """Total available qty for a part/make across all locations (sum of IN - OUT)."""
    rows = await db.transactions.aggregate([
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
    ]).to_list(1)
    return rows[0]["q"] if rows else 0


@api_router.get("/issue-notes/lookup/{part_no}")
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


@api_router.get("/issue-notes/next-no")
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


def _validate_issue_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")


async def _validate_issue_qty_against_stock(items, exclude_in_id: Optional[str] = None):
    """Block requesting more than current stock total for any (part_no, make)."""
    # Sum requested qty in this payload per (part_no, make)
    req = {}
    for it in items:
        k = _key(it.part_no, it.make)
        req[k] = req.get(k, 0) + (it.quantity or 0)
    for k, q in req.items():
        part_no, make = k.split("||", 1)
        avail = await _stock_total_for(part_no, make)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot issue {q} — only {avail} in stock",
            )


@api_router.post("/issue-notes", response_model=IssueNote)
async def create_issue_note(payload: IssueNoteCreate, user=Depends(get_current_user)):
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
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


@api_router.get("/issue-notes")
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


@api_router.get("/issue-notes/{in_id}")
async def get_issue_note(in_id: str, user=Depends(get_current_user)):
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Issue note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/issue-notes/{in_id}", response_model=IssueNote)
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


@api_router.delete("/issue-notes/{in_id}")
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
async def _pick_aggregate_other(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Sum picking-note qty per (part,make,box_id) across other PNs for an Issue Note (DRAFT + RECORDED)."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1}):
        for it in pn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _pick_aggregate_other_by_loc(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Per-location sum across other PNs (DRAFT + RECORDED). Key = part||make||box_id."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1, "status": 1}):
        # Only DRAFT picks reserve at the location level (RECORDED already debited the balance).
        if pn.get("status") != "DRAFT":
            continue
        for it in pn.get("items", []):
            loc_key = f"{it.get('part_no','')}||{it.get('make','')}||{it.get('box_id','')}"
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


async def _recompute_in_status(in_id: str):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        return
    requested = {}
    for it in inn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    picked = await _pick_aggregate_other(in_id)
    if not requested:
        new_status = "PICKING_PENDING"
    elif sum(picked.values()) == 0:
        new_status = "PICKING_PENDING"
    else:
        all_full = all(picked.get(k, 0) + 1e-6 >= q for k, q in requested.items())
        new_status = "FULLY_PICKED" if all_full else "PARTIALLY_PICKED"
    update = {"status": new_status}
    if new_status == "FULLY_PICKED":
        update["picked_at"] = inn.get("picked_at") or now_iso()
    else:
        if inn.get("picked_at"):
            await db.issue_notes.update_one({"id": in_id}, {"$unset": {"picked_at": ""}})
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})


@api_router.get("/picking-notes/next-no")
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


async def _stock_locations_for(part_no: str, make: str) -> List[dict]:
    """Aggregate current balance per location (positive only) for a part/make."""
    pipeline = [
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {
            "_id": {
                "godown_id": "$godown_id", "godown_name": "$godown_name",
                "rack_id": "$rack_id", "rack_no": "$rack_no",
                "box_id": "$box_id", "box_no": "$box_no", "box_category": "$box_category",
            },
            "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"quantity": {"$gt": 0}}},
        {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
    ]
    rows = await db.transactions.aggregate(pipeline).to_list(1000)
    return [{**r["_id"], "current_qty": r["quantity"]} for r in rows]


@api_router.get("/picking-notes/prepare/{in_id}")
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


def _validate_picking_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.godown_id or "").strip() or not (it.rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown and Rack are required")


async def _validate_picking_constraints(in_id: str, items, exclude_pn_id: Optional[str] = None):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    requested = {}
    for it in inn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _pick_aggregate_other(in_id, exclude_pn_id)
    other_loc_sums = await _pick_aggregate_other_by_loc(in_id, exclude_pn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.box_id or ''}"
        new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked issue note")
    # 1. cumulative qty
    for k, new_q in new_sums.items():
        recv = requested.get(k, 0)
        used = other_sums.get(k, 0)
        if used + new_q > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(status_code=400, detail=(
                f"Quantity exceeds issue note for {part} / {make}: "
                f"requested {recv}, already picked elsewhere {used}, this note {new_q} "
                f"(total {used + new_q} > {recv})"
            ))
    # 2. per-location stock availability (after subtracting other DRAFT picks at same loc)
    # Group by part||make to fetch locations once
    loc_cache = {}
    for k_full, new_q in new_loc_sums.items():
        part_no, make, box_id = k_full.split("||", 2)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        # box_id might be empty for racks with no boxes — match accordingly
        loc = next((L for L in locs if (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen location")
        already_pending_here = other_loc_sums.get(k_full, 0)
        available = (loc.get("current_qty") or 0) - already_pending_here
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to pick {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))


@api_router.post("/picking-notes", response_model=PickingNote)
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
    from pymongo.errors import DuplicateKeyError
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


@api_router.get("/picking-notes")
async def list_picking_notes(
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


@api_router.get("/picking-notes/{pn_id}")
async def get_picking_note(pn_id: str, user=Depends(get_current_user)):
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Picking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "issue_notes", "issue_note_id")
    return doc


@api_router.put("/picking-notes/{pn_id}", response_model=PickingNote)
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


@api_router.delete("/picking-notes/{pn_id}")
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


@api_router.post("/picking-notes/{pn_id}/record")
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


# ===================== STOCK TRANSFER (Request + Note) =====================
async def _transfer_other_qty(str_id: str, exclude_stn_id: Optional[str] = None) -> dict:
    """Sum qty per (part,make) across other STNs (DRAFT + RECORDED) for a given STR."""
    q = {"transfer_request_id": str_id}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _transfer_other_src_loc_qty(exclude_stn_id: Optional[str] = None) -> dict:
    """Per-source-location sum across DRAFT STNs (used to reserve source qty so two drafts can't double-book)."""
    q = {"status": "DRAFT"}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            loc_key = f"{it.get('part_no','')}||{it.get('make','')}||{it.get('src_box_id','') or ''}"
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


async def _recompute_str_status(str_id: str):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        return
    requested = {}
    for it in s.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    transferred = await _transfer_other_qty(str_id)
    if not requested or sum(transferred.values()) == 0:
        new_status = "PENDING"
    else:
        all_full = all(transferred.get(k, 0) + 1e-6 >= q for k, q in requested.items())
        new_status = "FULLY_TRANSFERRED" if all_full else "PARTIALLY_TRANSFERRED"
    update = {"status": new_status}
    if new_status == "FULLY_TRANSFERRED":
        update["transferred_at"] = s.get("transferred_at") or now_iso()
    else:
        if s.get("transferred_at"):
            await db.transfer_requests.update_one({"id": str_id}, {"$unset": {"transferred_at": ""}})
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})


def _validate_transfer_request_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")


async def _validate_transfer_request_qty(items, exclude_str_id: Optional[str] = None):
    """Block requesting more than current stock total for any (part,make)."""
    req = {}
    for it in items:
        k = _key(it.part_no, it.make)
        req[k] = req.get(k, 0) + (it.quantity or 0)
    for k, q in req.items():
        part_no, make = k.split("||", 1)
        avail = await _stock_total_for(part_no, make)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot transfer {q} — only {avail} in stock",
            )


# ---------- Transfer Request ----------
@api_router.get("/transfer-requests/lookup/{part_no}")
async def transfer_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """Reuse the issue-note lookup: makes with positive stock for this part_no."""
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    return {"makes": [{"make": p["_id"]["make"], "available_qty": p["q"]} for p in pairs]}


@api_router.get("/transfer-requests/next-no")
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


@api_router.post("/transfer-requests", response_model=TransferRequest)
async def create_transfer_request(payload: TransferRequestCreate, user=Depends(get_current_user)):
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
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


@api_router.get("/transfer-requests")
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
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/transfer-requests/{str_id}")
async def get_transfer_request(str_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/transfer-requests/{str_id}", response_model=TransferRequest)
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


@api_router.delete("/transfer-requests/{str_id}")
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
@api_router.get("/transfer-notes/next-no")
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


@api_router.get("/transfer-notes/prepare/{str_id}")
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


def _validate_transfer_note_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.src_godown_id or "").strip() or not (it.src_rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown and Rack are required")
        if not (it.dest_godown_id or "").strip() or not (it.dest_rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown and Rack are required")
        # Disallow source == destination
        if (
            it.src_godown_id == it.dest_godown_id
            and it.src_rack_id == it.dest_rack_id
            and (it.src_box_id or "") == (it.dest_box_id or "")
        ):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source and destination locations must differ")


async def _validate_transfer_note_constraints(str_id: str, items, exclude_stn_id: Optional[str] = None):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    requested = {}
    for it in s.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.src_box_id or ''}"
        new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked transfer request")

    # Cumulative qty cap vs request
    for k, new_q in new_sums.items():
        recv = requested.get(k, 0)
        used = other_sums.get(k, 0)
        if used + new_q > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(status_code=400, detail=(
                f"Quantity exceeds transfer request for {part} / {make}: "
                f"requested {recv}, already transferred elsewhere {used}, this note {new_q} "
                f"(total {used + new_q} > {recv})"
            ))

    # Per-source-location stock check
    loc_cache = {}
    for k_full, new_q in new_loc_sums.items():
        part_no, make, box_id = k_full.split("||", 2)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        loc = next((L for L in locs if (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen source location")
        already_pending_here = other_loc_sums.get(k_full, 0)
        available = (loc.get("current_qty") or 0) - already_pending_here
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to transfer {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))


@api_router.post("/transfer-notes", response_model=TransferNote)
async def create_transfer_note(payload: TransferNoteCreate, user=Depends(get_current_user)):
    s = await db.transfer_requests.find_one({"id": payload.transfer_request_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    _enforce_assignee(s, user, "create a transfer note for this request")
    if s.get("status") == "FULLY_TRANSFERRED":
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    await _validate_transfer_note_constraints(s["id"], payload.items, exclude_stn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
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


@api_router.get("/transfer-notes")
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


@api_router.get("/transfer-notes/{stn_id}")
async def get_transfer_note(stn_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "transfer_requests", "transfer_request_id")
    return doc


@api_router.put("/transfer-notes/{stn_id}", response_model=TransferNote)
async def update_transfer_note(stn_id: str, payload: TransferNoteCreate, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "edit this transfer note")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    await _validate_transfer_note_constraints(existing.get("transfer_request_id"), payload.items, exclude_stn_id=stn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": update})
    await _recompute_str_status(existing.get("transfer_request_id"))
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    return doc


@api_router.delete("/transfer-notes/{stn_id}")
async def delete_transfer_note(stn_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "delete this transfer note")
    await db.transfer_notes.delete_one({"id": stn_id})
    if existing.get("transfer_request_id"):
        await _recompute_str_status(existing["transfer_request_id"])
    return {"ok": True}


@api_router.post("/transfer-notes/{stn_id}/record")
async def record_transfer_note(stn_id: str, user=Depends(get_current_user)):
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
    # Final source-balance check (real balance, not DRAFT-aware)
    for idx, it in enumerate(items, start=1):
        bal = await db.transactions.aggregate([
            {"$match": {"part_no": it["part_no"], "make": it["make"], "box_id": it.get("src_box_id", "")}},
            {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        ]).to_list(1)
        avail = (bal[0]["q"] if bal else 0)
        if avail < it["quantity"] - 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at source "
                f"{it.get('src_godown_name')}/{it.get('src_rack_no')}/{it.get('src_box_no') or '—'}: have {avail}, need {it['quantity']}"
            ))

    now = now_iso()
    tx_docs = []
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
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "OUT",
            "godown_id": it["src_godown_id"], "godown_name": it.get("src_godown_name", ""),
            "rack_id": it["src_rack_id"], "rack_no": it.get("src_rack_no", ""),
            "box_id": it.get("src_box_id", ""), "box_no": it.get("src_box_no", ""), "box_category": it.get("src_box_category", ""),
        })
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "IN",
            "godown_id": it["dest_godown_id"], "godown_name": it.get("dest_godown_name", ""),
            "rack_id": it["dest_rack_id"], "rack_no": it.get("dest_rack_no", ""),
            "box_id": it.get("dest_box_id", ""), "box_no": it.get("dest_box_no", ""), "box_category": it.get("dest_box_category", ""),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": {"status": "RECORDED", "recorded_at": now}})
    if stn.get("transfer_request_id"):
        await _recompute_str_status(stn["transfer_request_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_transfer.recorded", module="stock_transfer",
        title=f"Stock Transfer recorded ({stn['stn_no']})",
        message=f"{user.get('email')} transferred {len(items)} item(s), total qty {total_qty}, from {stn.get('transfer_request_no') or 'STR'}.",
        audience="module", ref_collection="transfer_notes", ref_id=stn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs)}




# -------------------- STARTUP --------------------
@app.on_event("startup")
async def startup():
    # Initialise object storage (best-effort — log only, do not fail boot)
    try:
        init_storage()
    except Exception as e:
        logger.error(f"Object storage init failed: {e}")
    await db.users.create_index("email", unique=True)
    await db.stock_master.create_index([("part_no", 1), ("make", 1)], unique=True)
    await db.stock_master.create_index("id", unique=True)
    await db.godowns.create_index("id", unique=True)
    await db.racks.create_index("id", unique=True)
    await db.boxes.create_index("id", unique=True)
    await db.transactions.create_index("id", unique=True)
    await db.transactions.create_index([("part_no", 1), ("make", 1)])
    await db.receipt_notes.create_index("id", unique=True)
    await db.receipt_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.receipt_notes.create_index("created_at")
    await db.receipt_notes.create_index("status")
    await db.racking_notes.create_index("id", unique=True)
    await db.racking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.racking_notes.create_index("created_at")
    await db.racking_notes.create_index("status")
    await db.racking_notes.create_index("receipt_note_id")
    await db.issue_notes.create_index("id", unique=True)
    await db.issue_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.issue_notes.create_index("created_at")
    await db.issue_notes.create_index("status")
    await db.picking_notes.create_index("id", unique=True)
    await db.picking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.picking_notes.create_index("created_at")
    await db.picking_notes.create_index("status")
    await db.picking_notes.create_index("issue_note_id")
    await db.transfer_requests.create_index("id", unique=True)
    await db.transfer_requests.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_requests.create_index("created_at")
    await db.transfer_requests.create_index("status")
    await db.transfer_notes.create_index("id", unique=True)
    await db.transfer_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_notes.create_index("created_at")
    await db.transfer_notes.create_index("status")
    await db.transfer_notes.create_index("transfer_request_id")
   # ---- Receipt-note status migration ----
    # Default missing status to RACKING_NOTE_DRAFT (the new equivalent of legacy FINAL/RACKING_PENDING).
    await db.receipt_notes.update_many({"status": {"$exists": False}}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})
    # Legacy values -> new names
    await db.receipt_notes.update_many({"status": "RACKED"}, {"$set": {"status": "FULLY_RACKED"}})
    await db.receipt_notes.update_many({"status": "RACKING_PENDING"}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})
    await db.receipt_notes.update_many({"status": "FINAL"}, {"$set": {"status": "RACKING_NOTE_DRAFT"}})

    # ---- Receipt-note item-shape migration (Phase 1) ----
    # Older items had a single `quantity`. New items split it into invoice_qty + received_qty.
    # Migration policy: invoice_qty = received_qty = legacy quantity (no implied shortfall).
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1, "items": 1}):
        items = rn.get("items") or []
        if not items:
            continue
        changed = False
        new_items = []
        for it in items:
            new_it = dict(it)
            if "invoice_qty" not in new_it or new_it.get("invoice_qty") is None:
                q = float(new_it.get("quantity") or 0)
                new_it["invoice_qty"] = q
                changed = True
            if "received_qty" not in new_it:
                # Legacy rows had no draft concept — treat as fully received.
                new_it["received_qty"] = float(new_it.get("quantity") or 0)
                changed = True
            # Ensure legacy `quantity` mirrors received_qty so racking still works.
            if new_it.get("quantity") in (None, 0) and new_it.get("received_qty") is not None:
                new_it["quantity"] = float(new_it["received_qty"])
                changed = True
            new_items.append(new_it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # Recompute every RN's status off saved racking notes (idempotent — skips DRAFT)
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1}):
        try:
            await _recompute_rn_status(rn["id"])
        except Exception:
            pass

    # ---- SRN / ERN collection indexes (Phase 1 + Phase 2) ----
    await db.short_received_notes.create_index("id", unique=True)
    await db.short_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.short_received_notes.create_index("created_at")
    await db.short_received_notes.create_index("status")
    await db.short_received_notes.create_index("parent_rn_id")
    await db.short_received_notes.create_index("parent_srn_id")
    await db.extra_received_notes.create_index("id", unique=True)
    await db.extra_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.extra_received_notes.create_index("created_at")
    await db.extra_received_notes.create_index("status")
    await db.extra_received_notes.create_index("parent_rn_id")
    await db.extra_received_notes.create_index("parent_ern_id")

    # ---- Stock Master column settings (admin-editable order/widths) ----
    await db.column_settings.create_index("page", unique=True)

    # ---- Phase 2: counters self-heal ----
    # `_alloc_serial` reads/writes `db.counters` keyed by "{series}:{fy}". On first deploy after
    # the switch from `_next_serial`, scan each FY-numbered collection for max(serial) per fy
    # and seed the counter to that value (so subsequent allocations don't collide with existing
    # serials). Idempotent and safe to run on every startup.
    # Note: db.counters uses _id as the key — MongoDB auto-creates a unique index on _id.
    SERIES_TO_COLL = {
        "rn":  db.receipt_notes,
        "rkn": db.racking_notes,
        "srn": db.short_received_notes,
        "ern": db.extra_received_notes,
        "in":  db.issue_notes,
        "pn":  db.picking_notes,
        "str": db.transfer_requests,
        "stn": db.transfer_notes,
    }
    for series, coll in SERIES_TO_COLL.items():
        async for row in coll.aggregate([
            {"$group": {"_id": "$fy", "max_serial": {"$max": "$serial"}}},
        ]):
            fy = row["_id"]
            if not fy:
                continue
            max_serial = int(row.get("max_serial") or 0)
            counter_id = f"{series}:{fy}"
            existing = await db.counters.find_one({"_id": counter_id})
            if existing is None:
                await db.counters.insert_one({"_id": counter_id, "value": max_serial})
            elif int(existing.get("value", 0)) < max_serial:
                await db.counters.update_one({"_id": counter_id}, {"$set": {"value": max_serial}})

    # ---- Phase 2: RN stock_in_type backfill ----
    # Older receipt notes have no stock_in_type field. Default existing rows to "INVOICE"
    # (the prior behaviour was always invoice-based).
    await db.receipt_notes.update_many({"stock_in_type": {"$exists": False}}, {"$set": {"stock_in_type": "INVOICE"}})

    # ---- Phase 2: RN item.description_1 backfill (denormalize from stock_master) ----
    # New items carry description_1 inline (read-only display). Backfill from stock_master
    # for any item that doesn't already have it.
    async for rn in db.receipt_notes.find(
        {"items.description_1": {"$exists": False}},
        {"_id": 0, "id": 1, "items": 1},
    ):
        items = rn.get("items") or []
        new_items = []
        changed = False
        for it in items:
            if it.get("description_1") is None or "description_1" not in it:
                sm = await db.stock_master.find_one(
                    {"part_no": it.get("part_no"), "make": it.get("make")},
                    {"_id": 0, "description_1": 1},
                )
                it = dict(it)
                it["description_1"] = (sm or {}).get("description_1", "") or ""
                changed = True
            new_items.append(it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # ---- Phase 2: racking_notes polymorphic source backfill ----
    # Existing racking_notes rows have only receipt_note_id. Set source_type="RN" + source_id=receipt_note_id
    # so the new polymorphic endpoints work uniformly.
    async for rkn in db.racking_notes.find({"source_type": {"$exists": False}}, {"_id": 0, "id": 1, "receipt_note_id": 1, "receipt_note_no": 1, "receipt_note_date": 1}):
        await db.racking_notes.update_one(
            {"id": rkn["id"]},
            {"$set": {
                "source_type": "RN",
                "source_id": rkn.get("receipt_note_id", ""),
                "source_no": rkn.get("receipt_note_no", ""),
                "source_date": rkn.get("receipt_note_date", ""),
            }},
        )
    await db.racking_notes.create_index([("source_type", 1), ("source_id", 1)])

    # ---- Drop legacy racking_status indexes (now derived) ----
    for coll in (db.short_received_notes, db.extra_received_notes):
        try:
            await coll.drop_index("racking_status_1")
        except Exception:
            pass

    # ---- SRN/ERN status migration to active 12-status set ----
    # New active values:
    #   SRN: PENDING / PARTIALLY_RECEIVED / COMPLETE
    #   ERN: PENDING / PARTIALLY_ACCEPTED / COMPLETE
    # Drop legacy racking_status entirely (now derived at runtime).
    await db.short_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"status": "FULLY_RECEIVED"}, {"$set": {"status": "COMPLETE"}})
    await db.short_received_notes.update_many({}, {"$unset": {"racking_status": "", "racked_at": ""}})
    await db.extra_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"status": "PARTIALLY_REJECTED"}, {"$set": {"status": "PARTIALLY_ACCEPTED"}})
    await db.extra_received_notes.update_many({}, {"$unset": {"racking_status": "", "racked_at": ""}})

    # Recompute SRN/ERN derived statuses on startup so any data loaded with old shapes is consistent.
    async for srn in db.short_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_srn_status(srn)
            if srn.get("status") != new_status:
                await db.short_received_notes.update_one({"id": srn["id"]}, {"$set": {"status": new_status}})
        except Exception:
            pass
    async for ern in db.extra_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_ern_status(ern)
            if ern.get("status") != new_status:
                await db.extra_received_notes.update_one({"id": ern["id"]}, {"$set": {"status": new_status}})
        except Exception:
            pass
    # Migrate Stock Master schema: oem→remarks_oem, remarks→remarks_others
    cursor = db.stock_master.find({"$or": [{"oem": {"$exists": True}}, {"remarks": {"$exists": True}}]})
    migrated = 0
    async for doc in cursor:
        upd, unset = {}, {}
        if "oem" in doc:
            if not doc.get("remarks_oem"):
                upd["remarks_oem"] = doc.get("oem", "") or ""
            unset["oem"] = ""
        if "remarks" in doc:
            if not doc.get("remarks_others"):
                upd["remarks_others"] = doc.get("remarks", "") or ""
            unset["remarks"] = ""
        if upd or unset:
            op = {}
            if upd: op["$set"] = upd
            if unset: op["$unset"] = unset
            await db.stock_master.update_one({"_id": doc["_id"]}, op)
            migrated += 1
    if migrated:
        logger.info(f"Migrated {migrated} stock_master docs to new schema")

    # Seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@stockmgmt.com").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "name": "Admin",
            "password_hash": hash_password(admin_password),
            "role": "admin",
            "is_active": True,
            "module_access": {m: True for m in APP_MODULES},
            "force_password_reset": False,
            "failed_login_attempts": 0,
            "created_at": now_iso(),
        })
        logger.info(f"Seeded admin user: {admin_email}")
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password)}})
    # Backfill new fields on every user doc
    await db.users.update_many({"is_active": {"$exists": False}}, {"$set": {"is_active": True}})
    await db.users.update_many({"role": "user"}, {"$set": {"role": "staff"}})
    await db.users.update_many({"module_access": {"$exists": False}}, {"$set": {"module_access": {m: True for m in APP_MODULES}}})
    # Backfill any newly-added module key onto existing user docs (default-allow)
    for _m in APP_MODULES:
        await db.users.update_many(
            {f"module_access.{_m}": {"$exists": False}},
            {"$set": {f"module_access.{_m}": True}},
        )
    await db.users.update_many({"force_password_reset": {"$exists": False}}, {"$set": {"force_password_reset": False}})
    await db.users.update_many({"failed_login_attempts": {"$exists": False}}, {"$set": {"failed_login_attempts": 0}})
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email", unique=True)


@app.on_event("shutdown")
async def shutdown():
    client.close()

# -------------------- SECURITY & MIDDLEWARE --------------------

# The Rulebook: Maps URL prefixes to module permissions
PATH_TO_MODULE = [
    ("/api/stock-master", "stock_master"),
    ("/api/godowns", "locations"),
    ("/api/racks", "locations"),
    ("/api/boxes", "locations"),
    ("/api/stock-in", "stock_in"),
    ("/api/receipt-notes", "stock_in"),
    ("/api/racking-notes", "stock_in"),
    ("/api/stock-out", "stock_out"),
    ("/api/issue-notes", "stock_out"),
    ("/api/picking-notes", "stock_out"),
    ("/api/transfer-requests", "stock_transfer"),
    ("/api/transfer-notes", "stock_transfer"),
    ("/api/stock-balance", "stock_summary"),
    ("/api/low-stock", "low_stock"),
    ("/api/item-details", "item_details"),
    ("/api/transactions", "transactions"),
    ("/api/short-received-notes", "stock_in"),
    ("/api/extra-received-notes", "stock_in"),
]

@app.middleware("http")
async def module_access_middleware(request, call_next):
    path = request.url.path
    matched = next((m for prefix, m in PATH_TO_MODULE if path.startswith(prefix)), None)
    if matched:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                payload = jwt.decode(auth.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALGORITHM])
                u = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0, "role": 1, "module_access": 1, "is_active": 1})
                if u and u.get("is_active") is not False and u.get("role") != "admin":
                    access = u.get("module_access") or {}
                    if access.get(matched, True) is False:
                        from starlette.responses import JSONResponse as _JSON
                        return _JSON(status_code=403, content={"detail": f"Access denied: '{matched}' module is disabled for your account"})
            except Exception:
                pass
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# CRITICAL: This MUST be the very last line of the file
app.include_router(api_router)