from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from datetime import datetime, timezone, timedelta
from typing import List, Optional
import uuid
from pymongo.errors import DuplicateKeyError, OperationFailure

from deps import db, get_current_user, now_iso, _notify, logger, _resolve_assignee, _enforce_assignee
from deps import _module_dep
from models import *
from helpers.stock_helpers import _enrich_items, _enrich_note_items, _enrich_with_parent_assignee, _stock_locations_for
from helpers.note_helpers import current_fy_label, note_date_key, note_date_key_from_iso, _next_serial, _linked_note_no, _no_future_date, _key, _next_letter_suffix, _qty_diff, _rn_items_have_all_received, _ern_rackable_qty, _srn_rackable_by_key
from helpers.auto_create import _auto_create_srn_for_rn, _auto_create_ern_for_rn, _auto_create_rkn_for_source
from helpers.status_helpers import _recompute_rn_status, _compute_srn_status, _recompute_srn_racking_status, _recompute_ern_racking_status, _is_source_fully_racked, _aggregate_other_rkn_qty_by_source, _recompute_source_status_after_rkn, _stamp_racked_flag
from helpers.validation import _validate_racking_items, _validate_cumulative_qty, _validate_cumulative_qty_polymorphic, _validate_racking_locations
from services.unit_of_work import unit_of_work
from services import stock_in_service as svc

router = APIRouter()


def _is_write_conflict(exc: Exception) -> bool:
    """True when MongoDB aborted our transaction because another one touched the
    same document first (the loser of a concurrent read-modify-write)."""
    labels = getattr(exc, "_error_labels", None) or getattr(exc, "error_labels", None) or set()
    if "TransientTransactionError" in labels:
        return True
    code = getattr(exc, "code", None)
    if code in (112, 251, 24):  # WriteConflict, NoSuchTransaction, LockTimeout
        return True
    return "WriteConflict" in str(exc) or "write conflict" in str(exc).lower()


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


# -------------------- Local Pydantic models --------------------

class StockInLookupEntry(BaseModel):
    part_no: str
    make: Optional[str] = None


class StockInLookupRequest(BaseModel):
    # Accept either explicit entries (part_no + optional make) or just part_nos for backward compat
    entries: Optional[List[StockInLookupEntry]] = None
    part_nos: Optional[List[str]] = None


# -------------------- Pydantic models used only by SRN/ERN routes --------------------

class ShortReceivedNoteUpdate(BaseModel):
    """Used for editing fulfilled_qty + fulfillment_date on an SRN that is still PENDING/PARTIALLY_RECEIVED."""
    fulfillment_date: Optional[str] = ""
    items: List[dict] = []   # accept dicts so frontend can send {part_no, make, fulfilled_qty}

class NarrationUpdate(BaseModel):
    narration: str = ""


class SrnFulfillSliceBody(BaseModel):
    part_no: str
    make: str
    fulfilled_qty: float
    fulfillment_date: str          # ISO YYYY-MM-DD


class SrnChildBody(BaseModel):
    part_no: str
    make: str
    received_qty: float = 0
    not_receivable_qty: float = 0


class ErnItemDecision(BaseModel):
    """Per-row split of an ERN's extra quantity into approved and rejected parts."""
    part_no: str
    make: str
    approved_qty: float = 0
    rejected_qty: float = 0


class ErnDecisionBody(BaseModel):
    """An ERN approve/reject decision.

    `items` is optional. Omit it for the whole-note decision the endpoint has
    always taken (approve everything / reject everything); supply it to split each
    row, e.g. approve 1 of an extra 2 and reject the other 1.
    """
    reason: Optional[str] = ""
    items: Optional[List[ErnItemDecision]] = None


def _apply_ern_decision(ern: dict, decisions: Optional[List[ErnItemDecision]]) -> tuple:
    """Resolve a decision into (new_items, status).

    Validates the split against the note: quantities cannot be negative, neither
    side may exceed the row's extra_qty, and the two must add up to it exactly —
    every extra unit has to be either accepted into stock or refused.

    Status is APPROVED when anything at all was approved, REJECTED when nothing
    was; a fully-rejected note is terminal and never becomes warehouse work.
    """
    items = ern.get("items") or []
    if decisions is None:
        return ([{**it, "approved_qty": float(it.get("extra_qty") or 0), "rejected_qty": 0.0}
                 for it in items], "APPROVED")

    by_key = {_key(d.part_no, d.make): d for d in decisions}
    unknown = set(by_key) - {_key(it.get("part_no"), it.get("make")) for it in items}
    if unknown:
        parts = ", ".join(k.replace("||", " / ") for k in sorted(unknown))
        raise HTTPException(status_code=400, detail=f"Not on this ERN: {parts}")

    new_items, total_approved = [], 0.0
    for it in items:
        k = _key(it.get("part_no"), it.get("make"))
        extra = float(it.get("extra_qty") or 0)
        d = by_key.get(k)
        if d is None:
            raise HTTPException(
                status_code=400,
                detail=f"Row {it.get('part_no')} / {it.get('make')} is missing an approve/reject decision",
            )
        label = f"{it.get('part_no')} / {it.get('make')}"
        if d.approved_qty < 0 or d.rejected_qty < 0:
            raise HTTPException(status_code=400, detail=f"{label}: quantities cannot be negative")
        if d.approved_qty > extra + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{label}: approved qty {d.approved_qty:g} exceeds the extra qty of {extra:g}")
        if d.rejected_qty > extra + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{label}: rejected qty {d.rejected_qty:g} exceeds the extra qty of {extra:g}")
        if abs((d.approved_qty + d.rejected_qty) - extra) > 1e-6:
            raise HTTPException(
                status_code=400,
                detail=(f"{label}: approved {d.approved_qty:g} + rejected {d.rejected_qty:g} "
                        f"must equal the extra qty of {extra:g}"),
            )
        total_approved += d.approved_qty
        new_items.append({**it, "approved_qty": float(d.approved_qty),
                          "rejected_qty": float(d.rejected_qty)})

    return new_items, ("APPROVED" if total_approved > 1e-6 else "REJECTED")


def _receipt_stock_in_type(payload_or_doc) -> str:
    stock_in_type = ((getattr(payload_or_doc, "stock_in_type", None) if not isinstance(payload_or_doc, dict) else payload_or_doc.get("stock_in_type")) or "INVOICE").upper()
    if stock_in_type not in ("INVOICE", "GENERAL"):
        raise HTTPException(status_code=400, detail="stock_in_type must be INVOICE or GENERAL")
    return stock_in_type


def _normalise_receipt_items(items, stock_in_type: str) -> list:
    """Normalize invoice/general quantity rules into the storage shape used by RN/RKN."""
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")

    items_out = []
    for idx, it in enumerate(items, start=1):
        part_no = (it.part_no or "").strip()
        make = (it.make or "").strip()
        if not part_no:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not make:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")

        rec_raw = it.received_qty
        qty_raw = it.quantity

        if stock_in_type == "GENERAL":
            rec_raw = rec_raw if rec_raw is not None else qty_raw
            if rec_raw is None:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty is required for material without invoice")
            rec = float(rec_raw)
            if rec <= 0:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty must be greater than 0")
            inv = rec
        else:
            inv_raw = it.invoice_qty if it.invoice_qty is not None else qty_raw
            if inv_raw is None or float(inv_raw) <= 0:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Invoice Qty must be greater than 0")
            inv = float(inv_raw)
            rec = float(rec_raw) if rec_raw is not None else None
            if rec is not None and rec < 0:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")

        qty_legacy = float(rec) if rec is not None else float(inv)
        items_out.append({
            "part_no": part_no,
            "make": make,
            "invoice_qty": float(inv),
            "received_qty": float(rec) if rec is not None else None,
            "quantity": qty_legacy,
        })
    return items_out


# ==================== ENDPOINTS ====================

@router.post("/stock-in/lookup")
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


@router.post("/stock-in")
async def stock_in(payload: StockInCreate, user=Depends(get_current_user)):
    raise HTTPException(
        status_code=410,
        detail="Direct Stock In is disabled. Create a Receipt Note and record Stock In through a finalized Racking Note.",
    )


@router.get("/receipt-notes/next-no")
async def next_receipt_note_no(user=Depends(get_current_user)):
    """Preview the next receipt-note number (max existing serial + 1, embedding today's date)."""
    today = datetime.now(timezone.utc)
    last = await db.receipt_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_rn_no": f"RN/{note_date_key(today)}/{next_serial:02d}",
        "rn_date": today.date().isoformat(),
    }


@router.post("/receipt-notes", response_model=ReceiptNote)
async def create_receipt_note(payload: ReceiptNoteCreate, user=Depends(_module_dep("stock_in"))):
    """Create a Receipt Note. Always lands as DRAFT — Final Save happens via the
    /finalize endpoint after received_qty is filled for every row."""
    # Idempotent replay: if the client already sent this exact submit (double-click,
    # retried request after a dropped response), return the existing document instead
    # of creating a duplicate draft.
    if payload.client_token:
        existing = await db.receipt_notes.find_one(
            {"client_token": payload.client_token, "created_by": user.get("email", "")}, {"_id": 0}
        )
        if existing:
            return existing

    stock_in_type = _receipt_stock_in_type(payload)

    # Date validation
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")
    items_out = _normalise_receipt_items(payload.items, stock_in_type)

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    last_err = None
    for _ in range(5):
        serial = await _next_serial("receipt_notes")
        rn_no = f"RN/{note_date_key(today)}/{serial:02d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rn_no": rn_no,
            "rn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "stock_in_type": stock_in_type,
            "supplier_name": (payload.supplier_name or "").strip(),
            "invoice_no": (payload.invoice_no or "").strip(),
            "invoice_date": (payload.invoice_date or "").strip(),
            "goods_received_date": (payload.goods_received_date or "").strip(),
            "items": items_out,
            "status": "DRAFT",
            "version": 0,
            "narration": (payload.narration or "").strip(),
            "client_token": payload.client_token,
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

@router.get("/receipt-notes")
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
    # Annotate `has_racking_note`: mirrors assert_rn_mutable's actual gate — only a
    # RECORDED racking note (stock genuinely moved) blocks edit/delete. A DRAFT
    # racking note holds no stock, so its presence must not lock the parent RN.
    if rows:
        ids_with_recorded_rkn = await db.racking_notes.distinct(
            "receipt_note_id",
            {"receipt_note_id": {"$in": [r["id"] for r in rows]}, "status": "RECORDED"},
        )
        id_set = set(ids_with_recorded_rkn or [])
        for r in rows:
            r["has_racking_note"] = r["id"] in id_set
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/receipt-notes/{rn_id}")
async def get_receipt_note(rn_id: str, user=Depends(get_current_user)):
    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    await _enrich_note_items([doc])
    doc["has_racking_note"] = bool(await db.racking_notes.find_one({"receipt_note_id": rn_id, "status": "RECORDED"}, {"_id": 1}))
    return doc


async def _claim_rn_version(uow, rn_id: str, existing: dict, client_version) -> None:
    """Optimistic lock on the Receipt Note.

    Every edit bumps `version`. A client that submits the version it loaded gets a
    409 if someone else saved in the meantime, instead of silently overwriting
    their work. Clients that send no version (older builds) keep the previous
    last-write-wins behaviour, and the surrounding transaction's own write-conflict
    detection still covers genuinely simultaneous saves.
    """
    current = int(existing.get("version") or 0)
    if client_version is None:
        await uow.receipt_notes.update_one({"id": rn_id}, {"$inc": {"version": 1}})
        return
    if int(client_version) != current:
        raise HTTPException(status_code=409, detail="Receipt modified by another user.")
    # CAS: a doc predating this field has no `version`, so match that shape too.
    flt = {"id": rn_id, "version": current} if current else \
          {"id": rn_id, "$or": [{"version": 0}, {"version": {"$exists": False}}]}
    if not await uow.receipt_notes.update_one(flt, {"$set": {"version": current + 1}}):
        raise HTTPException(status_code=409, detail="Receipt modified by another user.")


def _describe_plan(plan: dict, existing: dict, new_items: list) -> dict:
    """Human-readable old -> new summary of a sync plan, for the pre-save preview."""
    old_by_key = {_key(i.get("part_no"), i.get("make")): i for i in existing.get("items") or []}

    def _qty_rows(rows, qty_field):
        return [{"part_no": r.get("part_no"), "make": r.get("make"),
                 "qty": r.get(qty_field)} for r in rows or []]

    items = []
    for it in new_items:
        k = _key(it.get("part_no"), it.get("make"))
        old = old_by_key.get(k) or {}
        items.append({
            "part_no": it.get("part_no"), "make": it.get("make"),
            "old_invoice_qty": old.get("invoice_qty"), "new_invoice_qty": it.get("invoice_qty"),
            "old_received_qty": old.get("received_qty"), "new_received_qty": it.get("received_qty"),
        })

    return {
        "items": items,
        "blocked": plan.get("blocked") or [],
        "srn": {
            "create": _qty_rows(plan["srn"]["create"], "short_qty"),
            "update": [{"no": s.get("srn_no"), "items": _qty_rows(ni, "short_qty")}
                       for s, ni in plan["srn"]["update"]],
            "delete": [s.get("srn_no") for s in plan["srn"]["delete"]],
        },
        "ern": {
            "create": _qty_rows(plan["ern"]["create"], "extra_qty"),
            "update": [{"no": e.get("ern_no"), "items": _qty_rows(ni, "extra_qty"),
                        "re_approval_required": reset}
                       for e, ni, reset in plan["ern"]["update"]],
            "delete": [e.get("ern_no") for e in plan["ern"]["delete"]],
        },
        "racking": {
            "update": [{"no": r.get("rkn_no"), "items": _qty_rows(ni, "quantity")}
                       for r, ni in plan["rkn"]["update"]],
            "delete": [r.get("rkn_no") for r in plan["rkn"]["delete"]],
            "create": [{"part_no": k.split("||", 1)[0], "make": k.split("||", 1)[1], "qty": v}
                       for k, v in (plan["rkn"]["create_needed"] or {}).items()],
        },
    }


async def _prepare_receipt_edit(rn_id: str, payload: ReceiptNoteCreate, user):
    """Shared front half of edit and edit-preview: load, authorize, validate, normalize."""
    existing = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    is_draft = existing.get("status") == "DRAFT"
    # Assignee enforcement: skip for DRAFT (anyone with module access can edit drafts).
    if not is_draft:
        _enforce_assignee(existing, user, "edit this receipt note")
    stock_in_type = _receipt_stock_in_type(payload)
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")
    items_out = _normalise_receipt_items(payload.items, stock_in_type)
    return existing, is_draft, stock_in_type, items_out


@router.post("/receipt-notes/{rn_id}/edit-preview")
async def preview_receipt_note_edit(rn_id: str, payload: ReceiptNoteCreate,
                                    user=Depends(_module_dep("stock_in"))):
    """Show what an edit would do to the derived documents, without saving.

    Runs the exact plan the save would run, so the preview can never disagree with
    the result. Nothing is written.
    """
    existing, is_draft, stock_in_type, items_out = await _prepare_receipt_edit(rn_id, payload, user)
    if is_draft:
        # A draft has no derived documents yet — nothing to preview beyond the items.
        return {"editable": True, "is_draft": True, "version": int(existing.get("version") or 0),
                "items": [], "blocked": [],
                "srn": {"create": [], "update": [], "delete": []},
                "ern": {"create": [], "update": [], "delete": []},
                "racking": {"create": [], "update": [], "delete": []}}
    async with unit_of_work() as uow:
        await svc.assert_rn_mutable(uow, rn_id, "edit this receipt note")
        plan = await svc.build_rn_sync_plan(uow, existing, items_out, stock_in_type)
        summary = _describe_plan(plan, existing, items_out)
    return {"editable": not summary["blocked"], "is_draft": False,
            "version": int(existing.get("version") or 0), **summary}


@router.put("/receipt-notes/{rn_id}", response_model=ReceiptNote)
async def update_receipt_note(rn_id: str, payload: ReceiptNoteCreate, user=Depends(_module_dep("stock_in"))):
    """Edit a Receipt Note.

    Mutability rule (WMS semantics): the note stays editable for as long as no
    stock has actually moved — that is, until some Racking Note in its source
    graph reaches RECORDED. A DRAFT racking note holds no stock, so its presence
    must not freeze the parent (finalize auto-creates one, which previously locked
    the note immediately).

    Every edit is propagated inside one transaction to the derived documents. The
    Receipt Note is the master: SRN shortfalls, ERN overages and DRAFT racking-note
    quantities are fully **recomputed** from the new figures — created, resized or
    removed as required — never patched by the delta. An audit entry records
    old -> new for each.
    """
    existing, is_draft, stock_in_type, items_out = await _prepare_receipt_edit(rn_id, payload, user)

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    update = {
        "stock_in_type": stock_in_type,
        "supplier_name": (payload.supplier_name or "").strip(),
        "invoice_no": (payload.invoice_no or "").strip(),
        "invoice_date": (payload.invoice_date or "").strip(),
        "goods_received_date": (payload.goods_received_date or "").strip(),
        "items": items_out,
        "narration": (payload.narration or "").strip(),
        "updated_at": now_iso(),
        **assignee,
    }

    synced = {}
    try:
        async with unit_of_work() as uow:
            await svc.assert_rn_mutable(uow, rn_id, "edit this receipt note")
            await _claim_rn_version(uow, rn_id, existing, payload.version)
            await uow.receipt_notes.set_fields(rn_id, update)
            # Keep every derived document in step with the new quantities. The
            # post-edit header is what the new SRN/ERN should carry, so hand the
            # merged doc to the resync rather than the stale one.
            if not is_draft:
                rn_after = {**existing, **update}
                synced = await svc.synchronize_children_after_rn_edit(
                    uow, rn_after, items_out, stock_in_type, user
                )
            await uow.audit.record(
                action="receipt_note.updated", actor=user,
                ref_collection="receipt_notes", ref_id=rn_id,
                old={"items": existing.get("items"), "invoice_no": existing.get("invoice_no"),
                     "narration": existing.get("narration"), "stock_in_type": existing.get("stock_in_type")},
                new={"items": items_out, "invoice_no": update["invoice_no"],
                     "narration": update["narration"], "stock_in_type": stock_in_type},
                reason="Receipt note edited before stock was recorded",
                links={"rn_no": existing.get("rn_no"), "resynced": {
                    k: v for k, v in synced.items() if k in ("srn", "ern", "racking")}},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Receipt modified by another user.",
            )
        raise

    # Growth that no existing DRAFT racking note could absorb (a part that had no
    # row at all) needs a fresh note. Auto-creation prefills locations from live
    # stock, so it has to read committed data — hence after the transaction.
    if synced.get("auto_rkn_needed"):
        await _auto_create_rkn_for_source("RN", rn_id, user, auto_source="rn-edit-resync")

    # Derived-status recomputation is idempotent and runs once the edit is durable.
    if not is_draft:
        await _recompute_rn_status(rn_id)

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

@router.post("/receipt-notes/{rn_id}/finalize", response_model=ReceiptNote)
async def finalize_receipt_note(rn_id: str, response: Response, user=Depends(_module_dep("stock_in"))):
    """Promote a DRAFT receipt note to PENDING (racking-eligible, nothing racked yet).

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
    stock_in_type = _receipt_stock_in_type(rn)

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
        if stock_in_type == "GENERAL":
            if rec <= 0:
                raise HTTPException(status_code=400, detail="Received Qty must be greater than 0 for material without invoice")
            inv = rec
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
        {"$set": {"items": items_out, "status": "PENDING", "finalized_at": now}},
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

    async with unit_of_work() as uow:
        await uow.audit.record(
            action="receipt_note.finalized", actor=user,
            ref_collection="receipt_notes", ref_id=rn_id,
            old={"status": "DRAFT", "items": rn.get("items")},
            new={"status": "PENDING", "items": items_out},
            reason="Receipt note finalized; shortfall/overage and racking derived",
            links={"rn_no": rn.get("rn_no"), "srn_no": srn_no, "ern_no": ern_no},
        )

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

@router.delete("/receipt-notes/{rn_id}")
async def delete_receipt_note(rn_id: str, user=Depends(_module_dep("stock_in"))):
    """Delete a Receipt Note and cascade-remove every pending artifact derived
    from it, so no orphan racking notes / SRNs / ERNs are left behind.

    Permitted only while no stock has been recorded. A child that already carries
    committed quantity (a received SRN delivery, an accepted/rejected ERN
    decision) blocks the delete with an explicit message rather than being
    silently destroyed.
    """
    existing = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    _enforce_assignee(existing, user, "delete this receipt note")

    async with unit_of_work() as uow:
        await svc.assert_rn_mutable(uow, rn_id, "delete this receipt note")
        removed = await svc.cascade_delete_rn(uow, existing, user)

    return {"ok": True, "cascade_removed": removed}


# -------------------- RACKING NOTES --------------------
@router.get("/racking-notes/lookup/{part_no}/locations")
async def racking_note_existing_locations(part_no: str, make: str, user=Depends(get_current_user)):
    """Current existing stock locations (godown/rack/box + qty) for a part/make,
    computed live from the transaction ledger. Used by the Racking Note preview/print
    to show where material already sits — distinct from the destination the operator
    is assigning in the racking note currently being edited/viewed."""
    return {"locations": await _stock_locations_for(part_no, make)}


@router.get("/racking-notes/next-no")
async def next_racking_note_no(
    source_type: Optional[str] = None,
    source_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    """Preview the next racking-note number. Once a source is picked, the RKN
    mirrors its ultimate parent RN's number (e.g. RN/050826/01 -> RKN/050826/01,
    or -B/-C if this RN already has an RKN) — same rule create_racking_note
    applies at save time. Without a source yet, falls back to a generic
    max-existing-serial+1 placeholder just to show something on load."""
    today = datetime.now(timezone.utc)
    if source_type and source_id:
        _, _, _, ultimate_rn = await _resolve_racking_source({"source_type": source_type, "source_id": source_id})
        ult_rn_id = (ultimate_rn or {}).get("id", "")
        ult_rn_date_key = note_date_key_from_iso((ultimate_rn or {}).get("rn_date", ""))
        rkn_no = await _linked_note_no(
            "racking_notes", "rkn_no", "receipt_note_id", ult_rn_id,
            "RKN", ult_rn_date_key, (ultimate_rn or {}).get("serial", 0),
        )
        return {"next_rkn_no": rkn_no, "rkn_date": today.date().isoformat()}
    last = await db.racking_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_rkn_no": f"RKN/{note_date_key(today)}/{next_serial:02d}",
        "rkn_date": today.date().isoformat(),
    }


# Legacy /racking-notes/prepare/{rn_id} kept for back-compat — delegates to the polymorphic version.
@router.get("/racking-notes/prepare/{rn_id}")
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


@router.post("/racking-notes", response_model=RackingNote)
async def create_racking_note(payload: RackingNoteCreate, user=Depends(_module_dep("stock_in"))):
    # Idempotent replay: a retried/duplicated submit returns the existing document.
    if payload.client_token:
        existing = await db.racking_notes.find_one(
            {"client_token": payload.client_token, "created_by": user.get("email", "")}, {"_id": 0}
        )
        if existing:
            return existing

    src_type, src_id, parent_doc, ultimate_rn = await _resolve_racking_source(payload.model_dump())
    _enforce_assignee(parent_doc, user, "create a racking note for this source")
    # Disallow if source is fully racked
    if src_type == "RN" and parent_doc.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
    if src_type == "SRN" and await _is_source_fully_racked("SRN", parent_doc):
        raise HTTPException(status_code=409, detail="This Short Received Note is already fully racked")
    if src_type == "ERN" and await _is_source_fully_racked("ERN", parent_doc):
        raise HTTPException(status_code=409, detail="This Extra Received Note is already fully racked")

    _validate_racking_items(payload.items)
    await _validate_racking_locations(payload.items)
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
    ult_rn_date_key = note_date_key_from_iso(ult_rn_date)
    ult_rn_serial = (ultimate_rn or {}).get("serial", 0)

    for _ in range(5):
        serial = await _next_serial("racking_notes")
        rkn_no = await _linked_note_no(
            "racking_notes", "rkn_no", "receipt_note_id", ult_rn_id,
            "RKN", ult_rn_date_key, ult_rn_serial,
        )
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
            "narration": (payload.narration or "").strip(),
            "client_token": payload.client_token,
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


@router.get("/racking-notes")
async def list_racking_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    search: Optional[str] = None,
    receipt_note_id: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if receipt_note_id:
        query["receipt_note_id"] = receipt_note_id
    if search:
        s = search.strip()
        query["$or"] = [
            {"rkn_no": {"$regex": s, "$options": "i"}},
            {"receipt_note_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
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
        # Attach goods_received_date from parent receipt note
    if rows:
        rn_ids = list({r.get("receipt_note_id") for r in rows if r.get("receipt_note_id")})
        if rn_ids:
            rn_map = {}
            async for rn in db.receipt_notes.find({"id": {"$in": rn_ids}}, {"_id": 0, "id": 1, "goods_received_date": 1}):
                rn_map[rn["id"]] = rn.get("goods_received_date", "")
            for r in rows:
                r["goods_received_date"] = rn_map.get(r.get("receipt_note_id"), "")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/racking-notes/sources")
async def list_racking_sources(user=Depends(_module_dep("stock_in"))):
    """Return all rackable sources (RN + SRN-with-fulfilled + ERN-with-accepted),
    grouped by their ultimate parent RN."""
    # 1. RNs eligible: any non-DRAFT, non-COMPLETE status.
    rn_rows = await db.receipt_notes.find(
        {"status": {"$in": ["PENDING", "IN_PROCESS"]}},
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

    # 3. ERNs eligible: APPROVED (extra qty is rackable) AND not yet fully racked.
    ern_rows = await db.extra_received_notes.find({"status": "APPROVED"}, {"_id": 0}).sort("created_at", -1).to_list(5000)
    eligible_erns = [e for e in ern_rows if not await _is_source_fully_racked("ERN", e)]

    # Group everything by parent_rn_id.
    groups = {}
    for rn in rn_rows:
        groups[rn["id"]] = {
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_stock_in_type": rn.get("stock_in_type", ""),
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


@router.get("/racking-notes/prepare-source")
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
        if rn.get("status") == "COMPLETE" and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
        # The qty available per (part,make) is invoice_qty (capped at invoice to exclude
        # extra qty, which goes to ERN and must be racked separately after ERN acceptance).
        rackable_map = {}
        for it in rn.get("items", []):
            rec = it.get("received_qty")
            if rec is None:
                rec = it.get("quantity") or 0
            rec = float(rec or 0)
            inv = float(it.get("invoice_qty") or 0)
            rq = min(rec, inv) if inv > 0 else rec
            part_no, make = it.get("part_no", ""), it.get("make", "")
            k = _key(part_no, make)
            entry = rackable_map.setdefault(k, {"part_no": part_no, "make": make, "rackable_qty": 0})
            entry["rackable_qty"] += rq
        rackable = list(rackable_map.values())
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
        rackable_map = {}
        for it in srn.get("items", []):
            children = it.get("children") or []
            if children:
                rqty = sum(float(c.get("received_qty") or 0) for c in children)
            else:
                rqty = float(it.get("fulfilled_qty") or 0)
            part_no, make = it.get("part_no", ""), it.get("make", "")
            k = _key(part_no, make)
            entry = rackable_map.setdefault(k, {"part_no": part_no, "make": make, "rackable_qty": 0})
            entry["rackable_qty"] += rqty
        rackable = list(rackable_map.values())
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
        ern_status = (ern.get("status") or "PENDING_APPROVAL").upper()
        if ern_status == "PENDING_APPROVAL":
            raise HTTPException(status_code=409, detail="This ERN is pending approval and is not yet rackable")
        if ern_status == "REJECTED":
            raise HTTPException(status_code=409, detail="This ERN was rejected and cannot be racked")
        if await _is_source_fully_racked("ERN", ern) and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This ERN is already fully racked")
        # Only the approved slice is warehouse work — a partial approval leaves the
        # rejected remainder out of stock entirely.
        rackable_map = {}
        for it in ern.get("items", []):
            part_no, make = it.get("part_no", ""), it.get("make", "")
            k = _key(part_no, make)
            entry = rackable_map.setdefault(k, {"part_no": part_no, "make": make, "rackable_qty": 0})
            entry["rackable_qty"] += _ern_rackable_qty(it)
        rackable = list(rackable_map.values())
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
        # Always prefill the old rack/box when the part has one or more existing
        # locations — pick the one holding the most stock as the primary suggestion.
        # Every location is still returned in `existing_locations` so the user can
        # override with a different one if this pick isn't the right bin.
        prefill = max(existing_locations, key=lambda l: l.get("current_qty") or 0) if existing_locations else None
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


@router.get("/racking-notes/{rkn_id}")
async def get_racking_note(rkn_id: str, user=Depends(get_current_user)):
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Racking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "receipt_notes", "receipt_note_id")
    # Attach goods_received_date from parent receipt note
    if doc.get("receipt_note_id"):
        rn = await db.receipt_notes.find_one({"id": doc["receipt_note_id"]}, {"_id": 0, "goods_received_date": 1})
        doc["goods_received_date"] = rn.get("goods_received_date", "") if rn else ""
    return doc


@router.put("/racking-notes/{rkn_id}", response_model=RackingNote)
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
    await _validate_racking_locations(payload.items)
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, payload.items, exclude_rkn_id=rkn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "narration": (payload.narration or "").strip(),
        "updated_at": now_iso(),
    }
    await db.racking_notes.update_one({"id": rkn_id}, {"$set": update})
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    return doc


@router.delete("/racking-notes/{rkn_id}")
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


@router.post("/racking-notes/{rkn_id}/record")
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
        if not it.get("godown_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown missing — edit racking note before recording")
        if it.get("box_id") and not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Rack required when Box is set — edit racking note before recording")
        if (it.get("quantity") or 0) <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: quantity must be > 0")

    item_models = [RackingNoteItem(**it) for it in items]
    # Defense in depth: a godown/rack/box selected when the note was saved could have
    # been deleted since — re-verify existence right before stock actually moves.
    await _validate_racking_locations(item_models)
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, item_models, exclude_rkn_id=rkn_id)

    now = now_iso()

    # Ledger rows + status flip + audit all commit together, or none of them do.
    # Concurrency is guarded on three levels:
    #   1. an optimistic DRAFT -> RECORDING claim, so a second operator loses the race;
    #   2. the surrounding transaction, which aborts the loser on write conflict;
    #   3. deterministic transaction ids (<rkn_id>:stock-in:<idx>) on a unique index,
    #      so a retry can never double-count stock.
    try:
        async with unit_of_work() as uow:
            existing_tx_count = await uow.transactions.count_for_racking_note(rkn_id)
            tx_docs = await svc.build_stock_in_transactions(uow, rkn, items, src_type, src_id, user, now)

            if existing_tx_count > 0:
                if existing_tx_count == len(tx_docs):
                    await uow.racking_notes.set_fields(
                        rkn_id, {"status": "RECORDED", "recorded_at": rkn.get("recorded_at") or now}
                    )
                    already = True
                else:
                    raise HTTPException(
                        status_code=409,
                        detail="Partial stock transactions already exist for this Racking Note; manual audit required",
                    )
            else:
                already = False
                if not await uow.racking_notes.claim_for_recording(rkn_id, now):
                    latest = await uow.racking_notes.get(rkn_id)
                    if latest and latest.get("status") == "RECORDED":
                        raise HTTPException(status_code=409, detail="Already recorded")
                    raise HTTPException(
                        status_code=409,
                        detail="This Racking Note is already being recorded by another user",
                    )
                await uow.transactions.insert_many(tx_docs)
                await uow.racking_notes.set_fields(rkn_id, {"status": "RECORDED", "recorded_at": now})
                await uow.audit.record(
                    action="racking_note.recorded", actor=user,
                    ref_collection="racking_notes", ref_id=rkn_id,
                    old={"status": "DRAFT"},
                    new={"status": "RECORDED", "items": items,
                         "transactions_created": len(tx_docs)},
                    reason="Stock In recorded against racking note",
                    links={"source_type": src_type, "source_id": src_id,
                           "receipt_note_id": rkn.get("receipt_note_id", ""),
                           "rkn_no": rkn.get("rkn_no")},
                )
    except DuplicateKeyError:
        raise HTTPException(status_code=409, detail="Stock has already been recorded for this Racking Note")

    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    if already:
        return {"ok": True, "transactions_created": 0, "already_recorded": True, "auto_rkn_no": None}

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

# ===================== SHORT RECEIVED NOTES — full CRUD =====================

@router.get("/short-received-notes/next-no")
async def next_srn_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    last = await db.short_received_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_srn_no": f"SRN/{note_date_key(today)}/{next_serial:02d}",
        "srn_date": today.date().isoformat(),
    }


@router.get("/short-received-notes")
async def list_short_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    search: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if search:
        s = search.strip()
        query["$or"] = [
            {"srn_no": {"$regex": s, "$options": "i"}},
            {"parent_rn_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
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
    await _stamp_racked_flag(rows, "SRN")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/short-received-notes/{srn_id}")
async def get_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    await _enrich_note_items([doc])
    await _stamp_racked_flag([doc], "SRN")
    return doc


@router.put("/short-received-notes/{srn_id}", response_model=ShortReceivedNote)
async def update_short_received_note(srn_id: str, payload: ShortReceivedNoteUpdate, response: Response,
                                     user=Depends(_module_dep("stock_in"))):
    """Edit fulfilled_qty / fulfillment_date on an SRN, and recompute its status.

    Stays editable until stock has actually been racked against this SRN — reaching
    COMPLETE is not itself a lock, since a fulfilment recorded in error must be
    correctable right up to the point it becomes physical stock.

    Runs as a transactional read-modify-write (see the SRN/ERN child-row endpoints for
    the same rationale): two operators editing the same SRN concurrently would otherwise
    both read the same items array and the second write would silently discard the first.
    """
    _no_future_date(payload.fulfillment_date, "Fulfillment Date")

    payload_map = {}
    for r in (payload.items or []):
        if not r.get("part_no") or not r.get("make"):
            continue
        key = (r["part_no"], r["make"])
        payload_map[key] = r

    try:
        async with unit_of_work() as uow:
            existing = await uow.srn.get(srn_id)
            if not existing:
                raise HTTPException(status_code=404, detail="Short Received Note not found")
            _enforce_assignee(existing, user, "edit this Short Received Note")
            await svc.assert_note_unracked(uow, "SRN", srn_id, existing.get("srn_no"),
                                           "edit this Short Received Note")

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

            # Floor is what's actually RECORDED (real stock movement) — assert_note_unracked
            # above already guarantees that's zero, so this can only ever be reached if
            # racking happened between that check and here (a same-request race the CAS
            # write below still catches). A DRAFT racking note holding more than the new
            # fulfilled_qty is not a hard block: it shrinks with the edit instead, matching
            # the Receipt Note's own "recompute, don't block" philosophy.
            ceiling_by_key = {}
            for it in items_out:
                k = _key(it.get("part_no"), it.get("make"))
                ceiling_by_key[k] = ceiling_by_key.get(k, 0.0) + float(it.get("fulfilled_qty") or 0)

            update = {
                "items": items_out,
                "fulfillment_date": (payload.fulfillment_date or "").strip(),
                "updated_at": now_iso(),
            }
            new_status = _compute_srn_status({"items": items_out})
            update["status"] = new_status
            await uow.srn.set_fields(srn_id, update)
            await svc.clamp_note_rkns_to_ceiling(uow, "SRN", srn_id, ceiling_by_key, user,
                                                 note_no=existing.get("srn_no"))
            await uow.audit.record(
                action="srn.bulk_updated", actor=user,
                ref_collection="short_received_notes", ref_id=srn_id,
                old={"items": existing.get("items")}, new={"items": items_out},
                reason="Fulfilled qty / fulfillment date edited",
                links={"srn_no": existing.get("srn_no")},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another edit was saved against this SRN at the same time — reload and try again.",
            )
        raise

    await _recompute_srn_racking_status(srn_id)
    # Bubble up to the ultimate RN: its FULLY_RACKED check considers SRN fulfilled qty.
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    auto_rkn_no = await _auto_create_rkn_for_source(
        "SRN", srn_id, user, auto_source="srn-child-save"
    )
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


@router.patch("/short-received-notes/{srn_id}/narration", response_model=ShortReceivedNote)
async def patch_srn_narration(srn_id: str, payload: NarrationUpdate, user=Depends(_module_dep("stock_in"))):
    existing = await db.short_received_notes.find_one({"id": srn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": {"narration": payload.narration.strip(), "updated_at": now_iso()}})
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


@router.post("/short-received-notes/{srn_id}/finalize", response_model=ShortReceivedNote)
async def finalize_short_received_note(srn_id: str, response: Response, user=Depends(_module_dep("stock_in"))):
    """Finalize an SRN. If fulfilled_qty < short_qty for any item, a CHILD SRN is auto-created
    for the residual shortfall, linked back to the same parent_rn_id."""
    srn = await db.short_received_notes.find_one({"id": srn_id})
    if not srn:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(srn, user, "finalize this Short Received Note")
    # Re-finalizing a COMPLETE SRN is allowed while nothing has been racked from it,
    # so a mistaken fulfilment can be corrected and re-saved.
    await svc.assert_note_unracked(db, "SRN", srn_id, srn.get("srn_no"),
                                   "re-finalize this Short Received Note")

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
    auto_rkn_no = await _auto_create_rkn_for_source(
        "SRN", srn_id, user, auto_source="srn-child-save"
    )
    if auto_rkn_no:
        msg += f" Auto-created {auto_rkn_no} for racking."
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    await _notify(
        actor=user, type="srn.finalized", module="stock_in",
        title=f"SRN finalized — {srn['srn_no']}",
        message=msg, audience="module",
        ref_collection="short_received_notes", ref_id=srn_id,
    )

    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


# ===================== SRN child rows (inline batches per item) =====================

@router.post("/short-received-notes/{srn_id}/children", response_model=ShortReceivedNote)
async def add_srn_child_row(srn_id: str, body: SrnChildBody, response: Response,
                            user=Depends(_module_dep("stock_in"))):
    """Append a new fulfillment row to the matching parent SRN item. Auto-allocates
    a letter-suffixed child_srn_no (PARENT-A, PARENT-B, ...). Recomputes status.

    The read-modify-write of ``items[].children`` runs inside a transaction: two
    operators recording a delivery against the same row concurrently would
    otherwise both read the same array and the second ``$set`` would silently
    discard the first slice (and reuse its -A/-B suffix). Under snapshot
    isolation the loser hits a write conflict and is reported as a 409.
    """
    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    try:
        async with unit_of_work() as uow:
            parent = await uow.srn.get(srn_id)
            if not parent:
                raise HTTPException(status_code=404, detail="Short Received Note not found")
            _enforce_assignee(parent, user, "add a fulfillment row on this Short Received Note")

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
            await uow.srn.set_fields(srn_id, {"items": new_items, "status": new_status})
            await uow.audit.record(
                action="srn.delivery_recorded", actor=user,
                ref_collection="short_received_notes", ref_id=srn_id,
                old={"children": children[:-1]}, new={"child": child},
                reason="Partial delivery recorded against shortfall",
                links={"srn_no": parent_no, "receipt_note_id": parent.get("parent_rn_id")},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another delivery was recorded against this SRN at the same time — reload and try again.",
            )
        raise

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


@router.put("/short-received-notes/{srn_id}/children/{child_srn_no:path}", response_model=ShortReceivedNote)
async def edit_srn_child_row(srn_id: str, child_srn_no: str, body: SrnChildBody, response: Response,
                             user=Depends(_module_dep("stock_in"))):
    """Edit a child row (received_qty / not_receivable_qty).

    Blocked only by what's actually RECORDED into stock against this SRN — the
    same "editable until racking starts" rule the parent update endpoint follows.
    A DRAFT racking note holding more than the new total shrinks with the edit
    instead of blocking it.

    Runs as a transactional read-modify-write for the same reason as
    ``add_srn_child_row``: two operators editing different rows on the same SRN
    concurrently must not silently clobber each other.
    """
    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    try:
        async with unit_of_work() as uow:
            parent = await uow.srn.get(srn_id)
            if not parent:
                raise HTTPException(status_code=404, detail="Parent SRN not found")
            _enforce_assignee(parent, user, "edit a row on this Short Received Note")

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

            recorded = await svc.recorded_qty_by_source(uow, "SRN", srn_id)
            k = _key(body.part_no, body.make)
            racked_for_item = float(recorded.get(k, 0))
            new_total_rcv = sum(
                float(c.get("received_qty") or 0)
                for c in children if c.get("child_srn_no") != child_srn_no
            ) + rcv
            if racked_for_item > new_total_rcv + 1e-6:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Cannot reduce — {racked_for_item:.2f} qty already recorded for "
                            f"{body.part_no} / {body.make}. Reverse that racking note first."),
                )

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
            await uow.srn.set_fields(srn_id, {"items": new_items, "status": new_status})
            # Ceiling for every part on the note, not just the row just edited —
            # otherwise a draft racking note's rows for untouched parts would read
            # as over budget and get dropped.
            await svc.clamp_note_rkns_to_ceiling(
                uow, "SRN", srn_id, _srn_rackable_by_key({"items": new_items}), user,
                note_no=parent.get("srn_no"))
            await uow.audit.record(
                action="srn.child_edited", actor=user,
                ref_collection="short_received_notes", ref_id=srn_id,
                old={"items": parent.get("items")}, new={"items": new_items},
                reason="Fulfillment row edited",
                links={"srn_no": parent.get("srn_no"), "child_srn_no": child_srn_no},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another edit was recorded against this SRN at the same time — reload and try again.",
            )
        raise

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


@router.delete("/short-received-notes/{srn_id}/children/{child_srn_no:path}")
async def delete_srn_child_row(srn_id: str, child_srn_no: str,
                               user=Depends(_module_dep("stock_in"))):
    """Delete a fulfillment row. Blocked only by what's actually RECORDED against
    this SRN; a DRAFT racking note holding more than what remains shrinks with the
    deletion. Transactional for the same reason as the sibling child-row endpoints."""
    try:
        async with unit_of_work() as uow:
            parent = await uow.srn.get(srn_id)
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

            p_item = parent["items"][item_idx]
            k = _key(p_item.get("part_no"), p_item.get("make"))
            recorded = await svc.recorded_qty_by_source(uow, "SRN", srn_id)
            racked_for_item = float(recorded.get(k, 0))
            remaining_rcv = sum(
                float(c.get("received_qty") or 0)
                for c in (p_item.get("children") or [])
                if c.get("child_srn_no") != child_srn_no
            )
            if racked_for_item > remaining_rcv + 1e-6:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Cannot delete — {racked_for_item:.2f} qty already recorded for "
                            f"{p_item.get('part_no')} / {p_item.get('make')}. Reverse that racking note first."),
                )

            new_items = []
            for i, it in enumerate(parent["items"]):
                new_it = dict(it)
                if i == item_idx:
                    new_it["children"] = [c for c in (new_it.get("children") or [])
                                          if c.get("child_srn_no") != child_srn_no]
                new_items.append(new_it)
            new_status = _compute_srn_status({**parent, "items": new_items})
            await uow.srn.set_fields(srn_id, {"items": new_items, "status": new_status})
            await svc.clamp_note_rkns_to_ceiling(
                uow, "SRN", srn_id, _srn_rackable_by_key({"items": new_items}), user,
                note_no=parent.get("srn_no"))
            await uow.audit.record(
                action="srn.child_deleted", actor=user,
                ref_collection="short_received_notes", ref_id=srn_id,
                old={"items": parent.get("items")}, new={"items": new_items},
                reason="Fulfillment row deleted",
                links={"srn_no": parent.get("srn_no"), "child_srn_no": child_srn_no},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another edit was recorded against this SRN at the same time — reload and try again.",
            )
        raise

    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return {"ok": True}


# Legacy slice endpoints (kept for back-compat; route to the new model).
@router.delete("/short-received-notes/{srn_id}")
async def delete_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    """Refused by design — an SRN is a derived document, not a standalone one.

    Its existence and quantity are recomputed from the parent Receipt Note's
    shortfall. Deleting it directly would leave the parent claiming a shortfall
    that no document records, so the shortfall must be removed at its source:
    raise Received Qty on the Receipt Note and the SRN is retired automatically
    (see the recompute in ``services/stock_in_service``). Deleting the Receipt
    Note still cascades this note away.
    """
    existing = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0, "srn_no": 1, "parent_rn_no": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    raise HTTPException(
        status_code=409,
        detail=(f"{existing.get('srn_no', 'This SRN')} is derived from Receipt Note "
                f"{existing.get('parent_rn_no', '')} and cannot be deleted on its own. "
                f"Edit the Receipt Note's Received Qty instead — the shortfall, and this "
                f"note with it, is recalculated automatically."),
    )


# ===================== EXTRA RECEIVED NOTES — full CRUD =====================

@router.get("/extra-received-notes/next-no")
async def next_ern_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    last = await db.extra_received_notes.find({}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "next_serial": next_serial,
        "next_ern_no": f"ERN/{note_date_key(today)}/{next_serial:02d}",
        "ern_date": today.date().isoformat(),
    }


@router.get("/extra-received-notes")
async def list_extra_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    search: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if search:
        s = search.strip()
        query["$or"] = [
            {"ern_no": {"$regex": s, "$options": "i"}},
            {"parent_rn_no": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
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
    await _stamp_racked_flag(rows, "ERN")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@router.get("/extra-received-notes/{ern_id}")
async def get_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    await _enrich_note_items([doc])
    await _stamp_racked_flag([doc], "ERN")
    return doc


@router.post("/extra-received-notes/{ern_id}/approve", response_model=ExtraReceivedNote)
async def approve_extra_received_note(ern_id: str, response: Response,
                                      payload: ErnDecisionBody = ErnDecisionBody(),
                                      user=Depends(_module_dep("stock_in"))):
    """Store Manager's decision on the excess quantity — including re-deciding one
    already made.

    Approval is the only thing that makes an ERN's extra qty rackable, and it
    auto-creates a DRAFT Racking Note for the approved amount — a *separate* note
    from the one the Receipt Note already produced, because the warehouse has
    already been handed that one and this is new work.

    Send no body to approve the whole note. Send `items` to split each row, in
    which case only the approved portion becomes a racking note and the rejected
    portion never enters stock. A split that rejects everything lands as REJECTED.

    Callable again on an already-APPROVED or -REJECTED note, with no separate
    "reopen" step, for as long as nothing has actually been racked from it yet —
    the previous decision's draft Racking Note (if any) is discarded and replaced
    by whatever the new decision implies. Once real stock has moved the note is
    locked, same rule the Receipt Note itself follows.
    """
    decided_status = "APPROVED"
    old_status = None
    try:
        async with unit_of_work() as uow:
            existing = await uow.ern.get(ern_id)
            if not existing:
                raise HTTPException(status_code=404, detail="Extra Received Note not found")
            _enforce_assignee(existing, user, "approve this Extra Received Note")
            old_status = (existing.get("status") or "PENDING_APPROVAL").upper()
            await svc.assert_note_unracked(uow, "ERN", ern_id, existing.get("ern_no"),
                                           "decide this Extra Received Note")
            new_items, decided_status = _apply_ern_decision(existing, payload.items)
            now = now_iso()
            # Compare-and-swap rather than a blind write: two managers deciding the
            # same ERN at once must not both succeed and double-count the extra qty.
            if not await uow.ern.transition_status(
                ern_id, from_status=old_status, to_status=decided_status,
                set_fields={"items": new_items, "decided_at": now,
                            "decided_by": user.get("email")},
            ):
                raise HTTPException(status_code=409,
                                    detail="Another decision was recorded against this ERN at the same time — reload and try again.")
            # A prior decision's draft racking note no longer reflects the new
            # split — discard it so the fresh decision starts clean. Guarded by
            # assert_note_unracked above: only DRAFT notes can exist here.
            for rkn in await uow.racking_notes.for_source("ERN", ern_id, status="DRAFT"):
                await uow.racking_notes.delete(rkn["id"])
            await uow.audit.record(
                action="ern.approved" if decided_status == "APPROVED" else "ern.rejected", actor=user,
                ref_collection="extra_received_notes", ref_id=ern_id,
                old={"status": old_status, "items": existing.get("items")},
                new={"status": decided_status, "items": new_items},
                reason=payload.reason or (
                    ("Extra quantity re-decided" if old_status != "PENDING_APPROVAL" else "Extra quantity approved")
                    if payload.items is None else "Extra quantity decided per row"),
                links={"ern_no": existing.get("ern_no"), "receipt_note_id": existing.get("parent_rn_id")},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another decision was recorded against this ERN at the same time — reload and try again.",
            )
        raise

    # A fully-rejected split is terminal — nothing to rack.
    auto_rkn_no = None
    if decided_status == "APPROVED":
        auto_rkn_no = await _auto_create_rkn_for_source("ERN", ern_id, user, auto_source="ern-approved")
    await _recompute_ern_racking_status(ern_id)
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    if auto_rkn_no:
        response.headers["X-Auto-RKN-No"] = auto_rkn_no
        response.headers["Access-Control-Expose-Headers"] = "X-Auto-RKN-No"
    verb = "approved" if decided_status == "APPROVED" else "rejected"
    await _notify(
        actor=user, type=f"ern.{verb}", module="stock_in",
        title=f"ERN {verb} — {existing.get('ern_no', '')}",
        message=f"{user.get('email')} {verb} the extra quantity on {existing.get('ern_no', '')}.",
        audience="module", ref_collection="extra_received_notes", ref_id=ern_id,
    )
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@router.patch("/extra-received-notes/{ern_id}/narration", response_model=ExtraReceivedNote)
async def patch_ern_narration(ern_id: str, payload: NarrationUpdate, user=Depends(_module_dep("stock_in"))):
    existing = await db.extra_received_notes.find_one({"id": ern_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": {"narration": payload.narration.strip(), "updated_at": now_iso()}})
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    return doc


@router.api_route("/extra-received-notes/{ern_id}/reject", methods=["POST", "PUT"], response_model=ExtraReceivedNote)
async def reject_extra_received_note(ern_id: str, payload: ErnDecisionBody = ErnDecisionBody(),
                                     user=Depends(_module_dep("stock_in"))):
    """Store Manager's whole-note decision: reject the entire excess quantity.
    Never creates stock, never creates a Racking Note. The RN's own
    invoice-capped rackable qty is unaffected.

    Callable again on an already-decided note (approve <-> reject) for as long as
    nothing has been racked from it yet — see the note on ``approve_extra_received_note``.
    Runs in the same transactional, compare-and-swap shape so the two can race
    without both landing.
    """
    old_status = None
    try:
        async with unit_of_work() as uow:
            parent = await uow.ern.get(ern_id)
            if not parent:
                raise HTTPException(status_code=404, detail="Extra Received Note not found")
            _enforce_assignee(parent, user, "reject this Extra Received Note")
            old_status = (parent.get("status") or "PENDING_APPROVAL").upper()
            await svc.assert_note_unracked(uow, "ERN", ern_id, parent.get("ern_no"),
                                           "decide this Extra Received Note")
            now = now_iso()
            # Mirror of approve: record the split explicitly so a decided note always
            # says how much was accepted (nothing) rather than leaving it unstated.
            rejected_items = [{**it, "approved_qty": 0.0,
                               "rejected_qty": float(it.get("extra_qty") or 0)}
                              for it in (parent.get("items") or [])]
            if not await uow.ern.transition_status(
                ern_id, from_status=old_status, to_status="REJECTED",
                set_fields={"items": rejected_items, "decided_at": now,
                            "decided_by": user.get("email")},
            ):
                raise HTTPException(status_code=409,
                                    detail="Another decision was recorded against this ERN at the same time — reload and try again.")
            # A prior approval's draft racking note is no longer justified.
            for rkn in await uow.racking_notes.for_source("ERN", ern_id, status="DRAFT"):
                await uow.racking_notes.delete(rkn["id"])
            await uow.audit.record(
                action="ern.rejected", actor=user,
                ref_collection="extra_received_notes", ref_id=ern_id,
                old={"status": old_status, "items": parent.get("items")},
                new={"status": "REJECTED", "items": rejected_items},
                reason=payload.reason or ("Extra quantity re-decided as rejected"
                                          if old_status != "PENDING_APPROVAL" else "Extra quantity rejected"),
                links={"ern_no": parent.get("ern_no"), "receipt_note_id": parent.get("parent_rn_id")},
            )
    except OperationFailure as exc:
        if _is_write_conflict(exc):
            raise HTTPException(
                status_code=409,
                detail="Another decision was recorded against this ERN at the same time — reload and try again.",
            )
        raise

    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    await _notify(
        actor=user, type="ern.rejected", module="stock_in",
        title=f"ERN rejected — {parent.get('ern_no', '')}",
        message=f"{user.get('email')} rejected the extra quantity on {parent.get('ern_no', '')}.",
        audience="module", ref_collection="extra_received_notes", ref_id=ern_id,
    )
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@router.delete("/extra-received-notes/{ern_id}")
async def delete_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    """Refused by design — an ERN is a derived document. See the SRN delete above;
    the overage is removed by lowering Received Qty on the parent Receipt Note,
    which retires this note automatically."""
    existing = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0, "ern_no": 1, "parent_rn_no": 1})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    raise HTTPException(
        status_code=409,
        detail=(f"{existing.get('ern_no', 'This ERN')} is derived from Receipt Note "
                f"{existing.get('parent_rn_no', '')} and cannot be deleted on its own. "
                f"Edit the Receipt Note's Received Qty instead — the overage, and this "
                f"note with it, is recalculated automatically."),
    )
