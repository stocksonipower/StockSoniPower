"""Dashboard / Stock Balance / Low Stock routes — extracted from server.py with zero logic changes."""
import io
import uuid
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from deps import db, get_current_user, now_iso, _notify
from routes._helpers import _normalize_col

router = APIRouter()


# ============================================================================
# STOCK SUMMARY COLUMN SETTINGS — order + widths, persisted PER USER in
# `user_column_settings` (unique on user_id + page).
#
# Deliberately different from Stock Master's equivalent, which is one global
# admin-owned layout: the Stock Summary table is a personal working view, so
# every user arranges it for themselves and nobody can rearrange it for anyone
# else. There is no admin gate for the same reason — you can only ever write
# your own row.
#
# Registered before any dynamic route that could shadow it (FastAPI matches in
# declaration order).
# ============================================================================
DEFAULT_STOCK_SUMMARY_COLUMNS = [
    {"key": "model",          "label": "MODEL",          "width": 140, "order": 1},
    {"key": "part_no",        "label": "PART NO",        "width": 150, "order": 2},
    {"key": "old_part_no",    "label": "OLD PART NO",    "width": 150, "order": 3},
    {"key": "make_part_no",   "label": "MAKE PART NO",   "width": 170, "order": 4},
    {"key": "description_1",  "label": "DESCRIPTION 1",  "width": 230, "order": 5},
    {"key": "description_2",  "label": "DESCRIPTION 2",  "width": 230, "order": 6},
    {"key": "remarks_oem",    "label": "REMARKS OEM",    "width": 180, "order": 7},
    {"key": "remarks_others", "label": "REMARKS OTHERS", "width": 180, "order": 8},
    {"key": "make",           "label": "MAKE",           "width": 130, "order": 9},
    {"key": "item_category",  "label": "ITEM CATEGORY",  "width": 150, "order": 10},
    {"key": "reorder_level",  "label": "REORDER LEVEL",  "width": 130, "order": 11},
    {"key": "godown_name",    "label": "GODOWN",         "width": 140, "order": 12},
    {"key": "rack_no",        "label": "RACK NO",        "width": 110, "order": 13},
    {"key": "box_no",         "label": "BOX NO",         "width": 110, "order": 14},
    {"key": "box_category",   "label": "BOX CATEGORY",   "width": 140, "order": 15},
    {"key": "total_quantity", "label": "QTY",            "width": 100, "order": 16},
    # Pinned last, like Stock Master's IMAGES column: a thumbnail strip reads as
    # the end of a row, and letting it float into the middle just breaks the scan.
    {"key": "image",          "label": "IMAGE",          "width": 110, "order": 99},
]

# Traits that belong to the DATA, not to the user's layout preference: which
# column is numeric, which renders an image, which is the quantity. They are
# always taken from the defaults below and never from the stored document, so a
# saved layout can never claim a column is something it isn't.
_STOCK_SUMMARY_COLUMN_TRAITS = {
    "reorder_level":  {"isNumeric": True},
    "total_quantity": {"isNumeric": True, "isQty": True, "total": True},
    "image":          {"isImage": True},
}


def _merge_stock_summary_columns(saved: Optional[List[dict]]) -> List[dict]:
    """Overlay a user's saved order/widths onto the defaults.

    Only `order` and `width` are ever taken from the saved document. Columns the
    user has never seen (added to the app after they last saved) fall back to
    their default position rather than vanishing from the table.
    """
    by_key = {c.get("key"): c for c in (saved or []) if isinstance(c, dict)}
    merged = []
    for d in DEFAULT_STOCK_SUMMARY_COLUMNS:
        existing = by_key.get(d["key"]) or {}
        # `is None` rather than a truthiness fallback: order 0 is a legitimate
        # position (leftmost) and must not be mistaken for "not set".
        try:
            raw_width = existing.get("width")
            width = int(d["width"] if raw_width is None else raw_width) or d["width"]
        except (TypeError, ValueError):
            width = d["width"]
        try:
            raw_order = existing.get("order")
            order = int(d["order"] if raw_order is None else raw_order)
        except (TypeError, ValueError):
            order = d["order"]
        traits = _STOCK_SUMMARY_COLUMN_TRAITS.get(d["key"], {})
        if traits.get("isImage"):
            order = 99   # always last, whatever a stale/hand-edited document says
        merged.append({
            "key": d["key"],
            "label": d["label"],
            "width": max(60, min(800, width)),
            "order": order,
            "isNumeric": bool(traits.get("isNumeric")),
            "isImage": bool(traits.get("isImage")),
            "isQty": bool(traits.get("isQty")),
            "total": bool(traits.get("total")),
        })
    merged.sort(key=lambda c: c["order"])
    return merged


class StockSummaryColumnSettings(BaseModel):
    columns: List[Dict[str, Any]]


@router.get("/stock-summary/column-settings")
async def get_stock_summary_column_settings(user=Depends(get_current_user)):
    """This user's own Stock Summary column order + widths, defaults where unset."""
    doc = await db.user_column_settings.find_one(
        {"user_id": user.get("id"), "page": "stock_summary"}, {"_id": 0},
    )
    return {"columns": _merge_stock_summary_columns((doc or {}).get("columns"))}


@router.put("/stock-summary/column-settings")
async def put_stock_summary_column_settings(
    payload: StockSummaryColumnSettings, user=Depends(get_current_user),
):
    """Save this user's own Stock Summary layout. Always scoped to the caller —
    there is no path by which one user writes another's row."""
    valid_keys = {c["key"] for c in DEFAULT_STOCK_SUMMARY_COLUMNS}
    cleaned = []
    for c in payload.columns:
        key = c.get("key")
        if key not in valid_keys:
            continue
        default = next(d for d in DEFAULT_STOCK_SUMMARY_COLUMNS if d["key"] == key)
        try:
            width = int(c.get("width") or default["width"])
        except (TypeError, ValueError):
            width = default["width"]
        try:
            raw_order = c.get("order")
            order = int(default["order"] if raw_order is None else raw_order)
        except (TypeError, ValueError):
            order = default["order"]
        cleaned.append({"key": key, "width": max(60, min(800, width)), "order": order})
    await db.user_column_settings.update_one(
        {"user_id": user.get("id"), "page": "stock_summary"},
        {"$set": {
            "user_id": user.get("id"), "page": "stock_summary",
            "columns": cleaned, "updated_at": now_iso(),
        }},
        upsert=True,
    )
    return {"columns": _merge_stock_summary_columns(cleaned)}


# ============================================================================
# STOCK SUMMARY IMPORT — bring existing stock in from a spreadsheet whose
# columns are the Stock Summary columns.
#
# What it produces is ORDINARY STOCK: one normal IN transaction per row, exactly
# like any other stock-in. Nothing about these rows is special-cased anywhere
# else in the app — they are picked, transferred and reported like stock that
# arrived through a Receipt Note.
#
# Location (Godown / Rack / Box) is entirely OPTIONAL and is taken as it comes:
# a row that leaves it blank produces a transaction with blank location, which is
# a state the rest of the app already handles (stock can legitimately sit in a
# godown with no racking, and the aggregation groups on the empty triple fine).
# Nothing is invented to fill a gap. Where a name IS given it must resolve to an
# existing Godown/Rack/Box — unknown names are reported as row errors rather than
# silently creating location masters from a typo.
#
# Both endpoints are batched (a handful of queries regardless of file size)
# rather than per-row, so a large sheet does not turn into tens of thousands of
# sequential round trips.
# ============================================================================

# Column header -> field. Accepts the Stock Summary labels, the export's labels
# and the underlying field names, so a sheet exported from the page re-imports
# without editing.
STOCK_SUMMARY_IMPORT_ALIASES = {
    "sl no": None, "sl.no": None, "slno": None, "s no": None, "sr no": None, "sr": None,
    "model": "model",
    "part no": "part_no", "part_no": "part_no", "partno": "part_no", "part number": "part_no",
    "old part no": "old_part_no", "old_part_no": "old_part_no", "old no": "old_part_no",
    "make part no": "make_part_no", "make_part_no": "make_part_no", "makepartno": "make_part_no",
    "description 1": "description_1", "description_1": "description_1", "description1": "description_1",
    "description 2": "description_2", "description_2": "description_2", "description2": "description_2",
    "remarks oem": "remarks_oem", "remarks_oem": "remarks_oem", "oem": "remarks_oem",
    "remarks others": "remarks_others", "remarks_others": "remarks_others", "remarks": "remarks_others",
    "make": "make",
    "item category": "item_category", "item_category": "item_category", "category": "item_category",
    "reorder level": "reorder_level", "reorder_level": "reorder_level", "reorder": "reorder_level",
    "godown": "godown_name", "godown name": "godown_name", "godown_name": "godown_name",
    "rack no": "rack_no", "rack_no": "rack_no", "rack": "rack_no",
    "box no": "box_no", "box_no": "box_no", "box": "box_no",
    "box category": "box_category", "box_category": "box_category",
    "qty": "quantity", "quantity": "quantity", "total quantity": "quantity", "total_quantity": "quantity",
    # Images are not importable — a spreadsheet cell cannot carry one.
    "image": None, "images": None,
}

STOCK_SUMMARY_TEMPLATE_COLUMNS = [
    "SL NO", "MODEL", "PART NO", "OLD PART NO", "MAKE PART NO",
    "DESCRIPTION 1", "DESCRIPTION 2", "REMARKS OEM", "REMARKS OTHERS",
    "MAKE", "ITEM CATEGORY", "REORDER LEVEL",
    "GODOWN", "RACK NO", "BOX NO", "BOX CATEGORY", "QTY",
]

# Master fields carried on each row — used to create a Stock Master entry for a
# part/make the catalogue has never seen, so imported stock is never orphaned.
_MASTER_FIELDS = [
    "model", "old_part_no", "make_part_no", "description_1", "description_2",
    "remarks_oem", "remarks_others", "item_category",
]


def _read_upload_dataframe(content: bytes, file_name: str):
    try:
        if (file_name or "").lower().endswith(".csv"):
            return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        return pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")


async def _parse_stock_summary_rows(content: bytes, file_name: str) -> dict:
    """Parse, validate and resolve every row. Shared by preview and import so the
    two can never disagree about what a file means.

    Returns parsed rows (each already carrying resolved location ids and the
    master snapshot to write), plus per-row errors and the counts the preview
    reports.
    """
    df = _read_upload_dataframe(content, file_name)

    col_map = {}
    for col in df.columns:
        key = _normalize_col(col)
        if key in STOCK_SUMMARY_IMPORT_ALIASES and STOCK_SUMMARY_IMPORT_ALIASES[key]:
            col_map[col] = STOCK_SUMMARY_IMPORT_ALIASES[key]
    mapped = set(col_map.values())
    missing = [lbl for lbl, f in (("PART NO", "part_no"), ("MAKE", "make"), ("QTY", "quantity")) if f not in mapped]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"File must contain {', '.join(missing)} column(s). Download the sample file for the correct format.",
        )

    # --- pass 1: read the sheet into plain rows, collecting shape errors --------
    raw_rows, errors = [], []
    for idx, row in df.iterrows():
        # +2: pandas is 0-based and the sheet's first line is the header, so this
        # is the row number the user sees in Excel.
        line = int(idx) + 2
        data = {f: "" for f in set(col_map.values())}
        for orig_col, field in col_map.items():
            val = row.get(orig_col, "")
            data[field] = "" if val is None else str(val).strip()

        part_no, make = data.get("part_no", ""), data.get("make", "")
        qty_raw = data.get("quantity", "")
        if not part_no and not make and not qty_raw:
            continue  # entirely blank line — not an error, just padding
        if not part_no:
            errors.append({"row": line, "message": "Part No is required"}); continue
        if not make:
            errors.append({"row": line, "message": f"{part_no}: Make is required"}); continue
        try:
            qty = float(qty_raw)
        except (TypeError, ValueError):
            errors.append({"row": line, "message": f"{part_no} / {make}: Qty '{qty_raw}' is not a number"}); continue
        if qty <= 0:
            errors.append({"row": line, "message": f"{part_no} / {make}: Qty must be greater than 0"}); continue
        # A box without a rack has no resolvable position — the same rule the
        # racking note validator applies.
        if data.get("box_no") and not data.get("rack_no"):
            errors.append({"row": line, "message": f"{part_no} / {make}: Box No given without a Rack No"}); continue

        try:
            reorder = int(float(data.get("reorder_level") or 0))
        except (TypeError, ValueError):
            reorder = 0

        raw_rows.append({
            "line": line, "part_no": part_no, "make": make, "quantity": qty,
            "godown_name": data.get("godown_name", ""), "rack_no": data.get("rack_no", ""),
            "box_no": data.get("box_no", ""), "box_category": data.get("box_category", ""),
            "reorder_level": reorder,
            **{f: data.get(f, "") for f in _MASTER_FIELDS},
        })

    if not raw_rows:
        return {"rows": [], "errors": errors, "new_items": 0, "known_locations": 0}

    # --- pass 2: resolve locations, batched -------------------------------------
    godown_names = {r["godown_name"].strip().lower() for r in raw_rows if r["godown_name"].strip()}
    godowns_by_name = {}
    if godown_names:
        async for g in db.godowns.find({}, {"_id": 0, "id": 1, "godown_name": 1}):
            godowns_by_name[(g.get("godown_name") or "").strip().lower()] = g
    racks_by_key, boxes_by_key = {}, {}
    if any(r["rack_no"].strip() for r in raw_rows):
        async for rk in db.racks.find({}, {"_id": 0, "id": 1, "godown_id": 1, "rack_no": 1}):
            racks_by_key[(rk.get("godown_id"), (rk.get("rack_no") or "").strip().lower())] = rk
    if any(r["box_no"].strip() for r in raw_rows):
        async for bx in db.boxes.find({}, {"_id": 0, "id": 1, "rack_id": 1, "box_no": 1, "box_category": 1}):
            boxes_by_key[(bx.get("rack_id"), (bx.get("box_no") or "").strip().lower())] = bx

    # --- pass 3: resolve masters, batched ---------------------------------------
    pairs = {(r["part_no"], r["make"]) for r in raw_rows}
    existing_masters = set()
    if pairs:
        async for sm in db.stock_master.find(
            {"part_no": {"$in": sorted({p for p, _ in pairs})}}, {"_id": 0, "part_no": 1, "make": 1},
        ):
            existing_masters.add((sm.get("part_no"), sm.get("make")))

    resolved, seen_new_masters = [], set()
    for r in raw_rows:
        gname = r["godown_name"].strip()
        godown_id = godown_name = ""
        rack_id = rack_no = ""
        box_id = box_no = box_category = ""
        if gname:
            g = godowns_by_name.get(gname.lower())
            if not g:
                errors.append({"row": r["line"], "message": f"Godown '{gname}' does not exist — create it in Location Master first"})
                continue
            godown_id, godown_name = g["id"], g.get("godown_name", "")
            rname = r["rack_no"].strip()
            if rname:
                rk = racks_by_key.get((godown_id, rname.lower()))
                if not rk:
                    errors.append({"row": r["line"], "message": f"Rack '{rname}' does not exist in godown '{godown_name}'"})
                    continue
                rack_id, rack_no = rk["id"], rk.get("rack_no", "")
                bname = r["box_no"].strip()
                if bname:
                    bx = boxes_by_key.get((rack_id, bname.lower()))
                    if not bx:
                        errors.append({"row": r["line"], "message": f"Box '{bname}' does not exist in rack '{rack_no}'"})
                        continue
                    box_id, box_no = bx["id"], bx.get("box_no", "")
                    box_category = bx.get("box_category", "") or r["box_category"]
        elif r["rack_no"].strip():
            # A rack means nothing without the godown that owns it.
            errors.append({"row": r["line"], "message": f"Rack '{r['rack_no'].strip()}' given without a Godown"})
            continue

        key = (r["part_no"], r["make"])
        is_new_master = key not in existing_masters and key not in seen_new_masters
        if is_new_master:
            seen_new_masters.add(key)

        resolved.append({
            **r,
            "godown_id": godown_id, "godown_name": godown_name,
            "rack_id": rack_id, "rack_no": rack_no,
            "box_id": box_id, "box_no": box_no, "box_category": box_category,
            "needs_master": key not in existing_masters,
            "counts_as_new_master": is_new_master,
        })

    return {
        "rows": resolved,
        "errors": errors,
        "new_items": len(seen_new_masters),
        "known_locations": sum(1 for r in resolved if r["godown_id"]),
    }


def _stock_location_key(r: dict) -> tuple:
    """Identity of a stock position — the same five fields the Stock Summary
    aggregation groups on, so "this row's location" means the same thing here as
    it does on the page the file came from."""
    return (
        r.get("part_no", ""), r.get("make", ""),
        r.get("godown_id", "") or "", r.get("rack_id", "") or "", r.get("box_id", "") or "",
    )


async def _locations_already_holding_stock(rows: list) -> set:
    """Which of the file's locations already carry a positive balance.

    Re-running the same sheet would otherwise silently double the stock, which is
    the single most damaging mistake this feature could allow. The preview
    surfaces the count and the caller chooses what to do about it.
    """
    if not rows:
        return set()
    part_nos = sorted({r["part_no"] for r in rows})
    wanted = {_stock_location_key(r) for r in rows}
    held = set()
    async for grp in db.transactions.aggregate([
        {"$match": {"part_no": {"$in": part_nos}}},
        {"$group": {
            "_id": {
                "part_no": "$part_no", "make": "$make", "godown_id": "$godown_id",
                "rack_id": "$rack_id", "box_id": "$box_id",
            },
            "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"q": {"$gt": 0}}},
    ]):
        k = grp["_id"]
        key = (
            k.get("part_no", ""), k.get("make", ""),
            k.get("godown_id", "") or "", k.get("rack_id", "") or "", k.get("box_id", "") or "",
        )
        if key in wanted:
            held.add(key)
    return held


@router.post("/stock-summary/import/preview")
async def stock_summary_import_preview(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Read the file and report exactly what an import would do — nothing is written."""
    content = await file.read()
    file_name = file.filename or "unknown"
    parsed = await _parse_stock_summary_rows(content, file_name)
    rows = parsed["rows"]
    already = await _locations_already_holding_stock(rows)
    duplicate_rows = sum(1 for r in rows if _stock_location_key(r) in already)
    return {
        "file_name": file_name,
        "total_rows": len(rows) + len(parsed["errors"]),
        "valid_rows": len(rows),
        "total_qty": sum(r["quantity"] for r in rows),
        "new_items": parsed["new_items"],
        "duplicate_rows": duplicate_rows,
        "error_rows": len(parsed["errors"]),
        # Capped: a badly-shaped file can produce thousands of these and the
        # dialog only needs enough to show the user what is wrong.
        "errors": parsed["errors"][:50],
    }


@router.post("/stock-summary/import")
async def stock_summary_import(
    file: UploadFile = File(...),
    mode: str = Query("skip", regex="^(skip|add)$"),
    user=Depends(get_current_user),
):
    """Write the file's rows in as ordinary stock — one IN transaction each.

    `mode` decides what happens to a location that already holds stock:
      skip — leave it alone (default; makes a re-run of the same sheet a no-op)
      add  — record the quantity on top of what is already there

    Rows with errors are never written; they are reported and skipped, so a
    partially-wrong file still imports its good rows instead of failing whole.
    """
    content = await file.read()
    file_name = file.filename or "unknown"
    parsed = await _parse_stock_summary_rows(content, file_name)
    rows = parsed["rows"]
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No valid rows to import" + (f" — {len(parsed['errors'])} row(s) have errors" if parsed["errors"] else ""),
        )

    already = await _locations_already_holding_stock(rows) if mode == "skip" else set()
    now = now_iso()
    batch_id = str(uuid.uuid4())

    # Masters first: stock must never reference a part/make the catalogue does not
    # know. Only genuinely-new entries are created — an existing master is left
    # exactly as it is, because the spreadsheet is a stock count, not a catalogue
    # edit, and must not quietly rewrite item descriptions.
    new_masters, seen = [], set()
    for r in rows:
        key = (r["part_no"], r["make"])
        if not r["needs_master"] or key in seen:
            continue
        seen.add(key)
        new_masters.append({
            "id": str(uuid.uuid4()),
            "part_no": r["part_no"], "make": r["make"],
            "new_part_no": "", "unit": "",
            "reorder_level": r.get("reorder_level") or 0,
            "images": [], "image": "",
            "created_at": now, "created_by": user.get("email", ""),
            **{f: r.get(f, "") for f in _MASTER_FIELDS},
        })
    if new_masters:
        try:
            await db.stock_master.insert_many(new_masters, ordered=False)
        except Exception:
            # A concurrent create can claim the same (part_no, make); the unique
            # index rejects just that document and the rest still land.
            pass

    # Master snapshot for the transaction rows, re-read so both pre-existing and
    # just-created items denormalize the same way every other stock-in does.
    masters = {}
    async for sm in db.stock_master.find(
        {"part_no": {"$in": sorted({r["part_no"] for r in rows})}}, {"_id": 0},
    ):
        masters[(sm.get("part_no"), sm.get("make"))] = sm

    tx_docs, skipped_existing = [], 0
    for r in rows:
        if mode == "skip" and _stock_location_key(r) in already:
            skipped_existing += 1
            continue
        m = masters.get((r["part_no"], r["make"]), {})
        tx_docs.append({
            "id": str(uuid.uuid4()),
            "type": "IN",
            "part_no": r["part_no"], "make": r["make"],
            "model": m.get("model", r.get("model", "")),
            "old_part_no": m.get("old_part_no", r.get("old_part_no", "")),
            "make_part_no": m.get("make_part_no", r.get("make_part_no", "")),
            "description_1": m.get("description_1", r.get("description_1", "")),
            "description_2": m.get("description_2", r.get("description_2", "")),
            "remarks_oem": m.get("remarks_oem", r.get("remarks_oem", "")),
            "remarks_others": m.get("remarks_others", r.get("remarks_others", "")),
            "item_category": m.get("item_category", r.get("item_category", "")),
            "image": m.get("image", ""),
            "quantity": r["quantity"],
            # Taken exactly as the file gave it — blank stays blank. The rest of
            # the app already handles stock held with no godown/rack/box.
            "godown_id": r["godown_id"], "godown_name": r["godown_name"],
            "rack_id": r["rack_id"], "rack_no": r["rack_no"],
            "box_id": r["box_id"], "box_no": r["box_no"], "box_category": r["box_category"],
            # Neutral provenance marker so one import can be identified later
            # (e.g. to reverse a mistaken run). It changes no behaviour.
            "import_batch_id": batch_id,
            "created_at": now, "created_by": user.get("email"),
        })

    if tx_docs:
        await db.transactions.insert_many(tx_docs)

    await _notify(
        actor=user, type="stock.imported", module="stock_summary",
        title=f"Stock imported ({len(tx_docs)} row(s))",
        message=(
            f"{user.get('email')} imported {len(tx_docs)} stock row(s) from {file_name}"
            f", total qty {sum(d['quantity'] for d in tx_docs):g}."
            + (f" {len(new_masters)} new item(s) added to Stock Master." if new_masters else "")
            + (f" {skipped_existing} row(s) skipped — location already had stock." if skipped_existing else "")
        ),
        audience="module",
    )

    return {
        "imported": len(tx_docs),
        "total_qty": sum(d["quantity"] for d in tx_docs),
        "new_items": len(new_masters),
        "skipped_existing": skipped_existing,
        "error_rows": len(parsed["errors"]),
        "errors": parsed["errors"][:50],
        "batch_id": batch_id,
        "mode": mode,
    }


@router.get("/stock-summary/import/template")
async def stock_summary_import_template():
    """Sample file, in exactly the shape the importer expects. The second row
    deliberately leaves Godown/Rack/Box blank to show that location is optional."""
    sample_rows = [
        ["1", "Model-X100", "3922900", "OPN-1001", "CUM-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Other remark sample",
         "Cummins", "Engine Parts", "5", "Main Godown", "R-01", "B-01", "Small", "25"],
        ["2", "Model-X100", "3922901", "OPN-1002", "CUM-3922901",
         "Filter Element", "", "", "",
         "Cummins", "Engine Parts", "2", "", "", "", "", "12"],
    ]
    data = [dict(zip(STOCK_SUMMARY_TEMPLATE_COLUMNS, row)) for row in sample_rows]
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine="openpyxl") as writer:
        pd.DataFrame(data).to_excel(writer, index=False, sheet_name="Stock Summary")
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=stock_summary_import_sample.xlsx"},
    )


# -------------------- STOCK BALANCE --------------------
@router.get("/stock-balance")
async def stock_balance(search: Optional[str] = None, user=Depends(get_current_user)):
    # 1. Aggregate transactions by (part_no, make, godown_id, rack_id, box_id)
    pipeline = [
        {"$group": {
            "_id": {
                "part_no": "$part_no",
                "make": "$make",
                "godown_id": "$godown_id",
                "rack_id": "$rack_id",
                "box_id": "$box_id",
            },
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"total_quantity": {"$gt": 0}}},
    ]
    raw = await db.transactions.aggregate(pipeline).to_list(20000)

    # 2. Build lookup caches with FRESH data
    sm_pairs = list({(r["_id"]["part_no"], r["_id"]["make"]) for r in raw})
    sm_map = {}
    if sm_pairs:
        or_q = [{"part_no": pn, "make": mk} for pn, mk in sm_pairs]
        async for sm in db.stock_master.find({"$or": or_q}, {"_id": 0}):
            sm_map[(sm["part_no"], sm["make"])] = sm

    godown_ids = list({r["_id"]["godown_id"] for r in raw if r["_id"].get("godown_id")})
    rack_ids = list({r["_id"]["rack_id"] for r in raw if r["_id"].get("rack_id")})
    box_ids = list({r["_id"]["box_id"] for r in raw if r["_id"].get("box_id")})

    g_map, r_map, b_map = {}, {}, {}
    if godown_ids:
        async for g in db.godowns.find({"id": {"$in": godown_ids}}, {"_id": 0}):
            g_map[g["id"]] = g
    if rack_ids:
        async for rk in db.racks.find({"id": {"$in": rack_ids}}, {"_id": 0}):
            r_map[rk["id"]] = rk
    if box_ids:
        async for bx in db.boxes.find({"id": {"$in": box_ids}}, {"_id": 0}):
            b_map[bx["id"]] = bx

    # 3. Build flat rows with fresh data joined in
    out = []
    for r in raw:
        k = r["_id"]
        sm = sm_map.get((k["part_no"], k["make"]), {})
        g = g_map.get(k.get("godown_id"), {})
        rk = r_map.get(k.get("rack_id"), {})
        bx = b_map.get(k.get("box_id"), {})
        out.append({
            "part_no": k["part_no"],
            "make": k["make"],
            "model": sm.get("model", ""),
            "old_part_no": sm.get("old_part_no", ""),
            "make_part_no": sm.get("make_part_no", ""),
            "description_1": sm.get("description_1", ""),
            "description_2": sm.get("description_2", ""),
            "remarks_oem": sm.get("remarks_oem", ""),
            "remarks_others": sm.get("remarks_others", ""),
            "item_category": sm.get("item_category", ""),
            "reorder_level": sm.get("reorder_level", 0) or 0,
            "image": sm.get("image", ""),
            "images": sm.get("images", []) or [],
            "godown_id": k.get("godown_id", ""),
            "godown_name": g.get("godown_name", ""),
            "rack_id": k.get("rack_id", ""),
            "rack_no": rk.get("rack_no", ""),
            "box_id": k.get("box_id", ""),
            "box_no": bx.get("box_no", ""),
            "box_category": bx.get("box_category", ""),
            "total_quantity": r["total_quantity"],
        })

    # 4. Server-side search across all listed fields
    if search:
        s = search.lower().strip()
        search_fields = [
            "part_no", "old_part_no", "make_part_no",
            "description_1", "description_2",
            "remarks_oem", "remarks_others",
            "make", "item_category",
        ]
        out = [
            row for row in out
            if any(s in str(row.get(f, "") or "").lower() for f in search_fields)
        ]

    # Full deterministic ordering: MongoDB's $group does not guarantee stable output
    # order, so without a tiebreak beyond (part_no, make) the multiple location rows
    # a single item can have (different godown/rack/box) could shuffle relative to
    # each other on every refresh. Sorting on the complete row identity fixes that.
    out.sort(key=lambda r: (
        r.get("part_no", ""), r.get("make", ""),
        r.get("godown_name", ""), r.get("rack_no", ""), r.get("box_no", ""),
    ))
    return out


@router.get("/low-stock")
async def low_stock(user=Depends(get_current_user)):
    """Items where current stock <= reorder_level (per-item from Stock Master)."""
    items = await db.stock_master.find({"reorder_level": {"$gt": 0}}, {"_id": 0}).to_list(50000)
    if not items:
        return []
    # A single indexed $in on part_no (the compound (part_no, make) index already
    # covers this) scales far better than an $or of one clause per item — at large
    # catalogs (tens of thousands of low-stock-tracked items) an $or that size is
    # past what the query planner handles well and risks a full collection scan.
    part_nos = list({i["part_no"] for i in items})
    pipeline = [
        {"$match": {"part_no": {"$in": part_nos}}},
        {"$group": {
            "_id": {"part_no": "$part_no", "make": "$make"},
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
    ]
    qty_map = {}
    async for r in db.transactions.aggregate(pipeline):
        qty_map[(r["_id"]["part_no"], r["_id"]["make"])] = r["total_quantity"]
    out = []
    for item in items:
        rl = int(item.get("reorder_level") or 0)
        qty = qty_map.get((item["part_no"], item["make"]), 0)
        if qty <= rl:
            out.append({
                "part_no": item["part_no"],
                "make": item["make"],
                "model": item.get("model", ""),
                "description_1": item.get("description_1", ""),
                "item_category": item.get("item_category", ""),
                "reorder_level": rl,
                "total_quantity": qty,
            })
    # Tiebreak on (part_no, make): ties on total_quantity are common (e.g. several
    # items sitting at exactly 0), and without a full tiebreak their relative order
    # depends on the unordered stock_master scan above, which can shuffle on every
    # refresh — same class of instability fixed for Stock Summary and Transactions.
    out.sort(key=lambda x: (x["total_quantity"], x["part_no"], x["make"]))
    return out


@router.get("/dashboard/godown-summary")
async def dashboard_godown_summary(user=Depends(get_current_user)):
    """Total quantity per godown — same semantics as summing the positive-balance
    location rows from /stock-balance grouped by godown name, but computed entirely
    in the database. The Dashboard widget only needs one row per godown; fetching
    the full per-(part, make, location) Stock Summary just to sum it client-side
    doesn't scale (the response grows with the whole catalog, not with the number
    of godowns)."""
    pipeline = [
        {"$group": {
            "_id": {
                "godown_id": "$godown_id", "rack_id": "$rack_id", "box_id": "$box_id",
                "part_no": "$part_no", "make": "$make",
            },
            "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"quantity": {"$gt": 0}}},
        {"$group": {"_id": "$_id.godown_id", "total_quantity": {"$sum": "$quantity"}}},
    ]
    rows = await db.transactions.aggregate(pipeline).to_list(20000)
    godown_ids = [r["_id"] for r in rows if r["_id"]]
    g_map = {}
    if godown_ids:
        async for g in db.godowns.find({"id": {"$in": godown_ids}}, {"_id": 0, "id": 1, "godown_name": 1}):
            g_map[g["id"]] = g.get("godown_name", "")
    by_name = {}
    for r in rows:
        name = g_map.get(r["_id"], "") or "Unknown"
        by_name[name] = by_name.get(name, 0) + r["total_quantity"]
    out = [{"godown_name": name, "total_quantity": qty} for name, qty in by_name.items()]
    out.sort(key=lambda x: x["godown_name"])
    return out


@router.get("/dashboard/stats")
async def dashboard_stats(user=Depends(get_current_user)):
    total_items = await db.stock_master.count_documents({})
    total_godowns = await db.godowns.count_documents({})
    total_racks = await db.racks.count_documents({})
    total_boxes = await db.boxes.count_documents({})
    total_txn = await db.transactions.count_documents({})

    # Total stock qty
    pipeline = [
        {"$group": {"_id": None, "qty": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}}
    ]
    result = await db.transactions.aggregate(pipeline).to_list(1)
    total_stock = result[0]["qty"] if result else 0

    low = await low_stock(user=user)
    return {
        "total_items": total_items,
        "total_godowns": total_godowns,
        "total_racks": total_racks,
        "total_boxes": total_boxes,
        "total_transactions": total_txn,
        "total_stock_qty": total_stock,
        "low_stock_count": len(low),
    }
