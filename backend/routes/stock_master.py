"""Stock Master routes — extracted from server.py with zero logic changes."""
import io
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import pandas as pd
from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from deps import db, get_current_user, _notify, now_iso
from models import StockMaster, StockMasterCreate
from routes._helpers import _csv_response, _csv_safe_value, _csv_streaming_response, _normalize_col

router = APIRouter()


@router.post("/stock-master", response_model=StockMaster)
async def create_stock_master(payload: StockMasterCreate, user=Depends(get_current_user)):
    part_no = payload.part_no.strip()
    make = payload.make.strip()
    if not part_no or not make:
        raise HTTPException(status_code=400, detail="part_no and make are required")
    if payload.images and len(payload.images) > 5:
        raise HTTPException(status_code=400, detail="A maximum of 5 images is allowed per item")
    existing = await db.stock_master.find_one({"part_no": part_no, "make": make})
    if existing:
        raise HTTPException(status_code=400, detail="Item with this part_no + make already exists")
    doc = payload.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = now_iso()
    await db.stock_master.insert_one(doc)
    doc.pop("_id", None)
    await _notify(
        actor=user, type="stock_master.created", module="stock_master",
        title="Stock master item added",
        message=f"{user.get('email')} added {part_no} / {make}.",
        audience="module", ref_collection="stock_master", ref_id=doc["id"],
    )
    return doc


# Whitelist of fields that may be filtered/sorted via query params (security)
_FILTERABLE_FIELDS = {
    "model", "part_no", "old_part_no", "new_part_no", "make_part_no",
    "description_1", "description_2",
    "remarks_oem", "remarks_others",
    "make", "item_category", "unit", "reorder_level",
}
# Sentinel used by frontend to represent "blank/empty" cells in column filters
_BLANK_TOKEN = "(Blanks)"

_SEARCH_FIELDS = [
    "model",
    "part_no",
    "old_part_no",
    "new_part_no",
    "make_part_no",
    "description_1",
    "description_2",
    "remarks_oem",
    "remarks_others",
    "make",
    "item_category",
    "unit",
]


def _build_stock_master_query(request: Request, search: Optional[str] = None) -> dict:
    query: dict = {}

    if search:
        s = search.strip()
        query["$or"] = [{field: {"$regex": s, "$options": "i"}} for field in _SEARCH_FIELDS]

    column_clauses: list = []
    for raw_key, raw_val in request.query_params.multi_items():
        if not (raw_key.startswith("filter[") and raw_key.endswith("]")):
            continue
        field = raw_key[len("filter["):-1]
        values = request.query_params.getlist(raw_key)
        if not values:
            continue

        if field == "images":
            wants_has = "Has image" in values
            wants_none = "No image" in values
            sub = []
            if wants_has:
                sub.append({"$or": [
                    {"images": {"$exists": True, "$type": "array", "$ne": []}},
                    {"image": {"$exists": True, "$nin": [None, ""]}},
                ]})
            if wants_none:
                sub.append({"$and": [
                    {"$or": [
                        {"images": {"$exists": False}},
                        {"images": {"$size": 0}},
                    ]},
                    {"$or": [
                        {"image": {"$exists": False}},
                        {"image": {"$in": [None, ""]}},
                    ]},
                ]})
            if sub:
                column_clauses.append({"$or": sub} if len(sub) > 1 else sub[0])
            continue

        if field not in _FILTERABLE_FIELDS:
            continue

        concrete = [v for v in values if v != _BLANK_TOKEN]
        wants_blank = _BLANK_TOKEN in values

        sub = []
        if concrete:
            if field == "reorder_level":
                ints = []
                for v in concrete:
                    try:
                        ints.append(int(float(v)))
                    except Exception:
                        pass
                if ints:
                    sub.append({field: {"$in": ints}})
            else:
                sub.append({field: {"$in": concrete}})
        if wants_blank:
            sub.append({"$or": [
                {field: {"$exists": False}},
                {field: None},
                {field: ""},
            ]})
        if sub:
            column_clauses.append({"$or": sub} if len(sub) > 1 else sub[0])

    if column_clauses:
        if len(column_clauses) == 1:
            query.update(column_clauses[0])
        else:
            query.setdefault("$and", []).extend(column_clauses)

    return query


@router.get("/stock-master", response_model=List[StockMaster])
async def list_stock_master(
    request: Request,
    response: Response,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    sort_by: Optional[str] = None,
    sort_dir: Optional[str] = None,   # "asc" | "desc"
    user=Depends(get_current_user),
):
    """List stock master items.

    Supports:
      - `search` (free text across multiple fields)
      - `page` / `page_size` (pagination)
      - `sort_by` / `sort_dir` (server-side sort on a whitelisted field)
      - `filter[<field>]` repeated query params for column filters, e.g.
            ?filter[make]=Cummins&filter[make]=Tata
        A value of "(Blanks)" matches empty/missing values.
    """
    query = _build_stock_master_query(request, search)

    # Sort: default is created_at desc; otherwise whitelisted field
    if sort_by and sort_by in _FILTERABLE_FIELDS:
        direction = -1 if (sort_dir or "asc").lower() == "desc" else 1
        sort_spec = [(sort_by, direction)]
    else:
        sort_spec = [("created_at", -1)]

    total = await db.stock_master.count_documents(query)
    skip = (page - 1) * page_size
    items = await db.stock_master.find(query, {"_id": 0}).sort(sort_spec).skip(skip).limit(page_size).to_list(page_size)

    # Mark which items have transactions recorded against them
    used_pairs = set()
    if items:
        async for t in db.transactions.aggregate([
            {"$group": {"_id": {"part_no": "$part_no", "make": "$make"}}},
        ]):
            used_pairs.add((t["_id"]["part_no"], t["_id"]["make"]))
        for it in items:
            it["in_use"] = (it.get("part_no"), it.get("make")) in used_pairs

    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return items


@router.get("/stock-master/distinct/{field}")
async def stock_master_distinct(field: str, user=Depends(get_current_user)):
    """Return all distinct values of a field across the entire stock_master collection.
    Used by the column-filter dropdowns so they reflect the full DB (not just one page)."""
    if field == "images":
        # Special virtual column: only two possible values
        return {"values": ["Has image", "No image"]}
    if field not in _FILTERABLE_FIELDS:
        raise HTTPException(status_code=400, detail="Field not filterable")
    raw = await db.stock_master.distinct(field)
    out = []
    has_blank = False
    for v in raw:
        if v is None or v == "":
            has_blank = True
        else:
            out.append(v)
    # Numeric-aware sort for reorder_level, alphabetic otherwise
    if field == "reorder_level":
        out = sorted(out, key=lambda x: (x is None, x))
    else:
        out = sorted(out, key=lambda x: str(x).lower())
    if has_blank:
        out.append(_BLANK_TOKEN)
    return {"values": [str(v) if not isinstance(v, str) else v for v in out]}


@router.get("/stock-master/lookup/makes")
async def get_makes_for_part(part_no: str = Query(...), user=Depends(get_current_user)):
    makes = await db.stock_master.distinct("make", {"part_no": part_no})
    return {"makes": makes}


@router.get("/stock-master/lookup/item")
async def get_item_by_part_make(part_no: str, make: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("/stock-master/download/template")
async def download_template_route():
    sample_rows = [
        ["1", "Model-X100", "3922900", "OPN-1001", "NPN-2001", "CUM-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Other remark sample",
         "Cummins", "Engine Parts", "PCS", "5"],
        ["2", "Model-X100", "3922900", "OPN-1001", "NPN-2001", "TATA-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Qty per box 1",
         "Tata", "Engine Parts", "PCS", "10"],
    ]
    data = [dict(zip(TEMPLATE_COLUMNS, row)) for row in sample_rows]
    df = pd.DataFrame(data)
    output = io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Stock Master')
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=stock_master_template.xlsx"},
    )


@router.get("/stock-master/download/export")
async def export_stock_master(
    request: Request,
    search: Optional[str] = None,
    sort_by: Optional[str] = None,
    sort_dir: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = _build_stock_master_query(request, search)
    if sort_by and sort_by in _FILTERABLE_FIELDS:
        direction = -1 if (sort_dir or "asc").lower() == "desc" else 1
        sort_spec = [(sort_by, direction), ("created_at", 1)]
    else:
        sort_spec = [("created_at", 1)]

    cursor = db.stock_master.find(query, {"_id": 0}).sort(sort_spec)

    export_fields = [
        "id",
        "created_at",
        "model",
        "part_no",
        "old_part_no",
        "new_part_no",
        "make_part_no",
        "description_1",
        "description_2",
        "remarks_oem",
        "remarks_others",
        "make",
        "item_category",
        "unit",
        "reorder_level",
        "image",
        "images",
    ]

    extras = set()
    async for doc in db.stock_master.find(query, {"_id": 0}):
        extras.update(k for k in doc.keys() if k not in export_fields)

    header = ["sl_no", *export_fields, *sorted(extras)]

    async def row_generator():
        idx = 1
        async for item in cursor:
            yield [
                idx,
                *[_csv_safe_value(item.get(field, "")) for field in export_fields],
                *[_csv_safe_value(item.get(field, "")) for field in sorted(extras)],
            ]
            idx += 1

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return _csv_streaming_response(row_generator(), header, f"stock_master_export_{ts}.csv")


# ============================================================================
# STOCK MASTER COLUMN SETTINGS — admin-editable order + widths, persisted in
# `column_settings` collection (page="stock_master"). All authed users may
# READ; only admins may WRITE.
# Routes are registered BEFORE /stock-master/{item_id} so the dynamic catch-all
# does not shadow them (FastAPI matches in declaration order).
# ============================================================================
DEFAULT_STOCK_MASTER_COLUMNS = [
    {"key": "model",          "label": "MODEL",          "width": 140, "order": 1,  "isNumeric": False, "isImage": False},
    {"key": "part_no",        "label": "PART NO",        "width": 160, "order": 2,  "isNumeric": False, "isImage": False},
    {"key": "old_part_no",    "label": "OLD PART NO",    "width": 160, "order": 3,  "isNumeric": False, "isImage": False},
    {"key": "new_part_no",    "label": "NEW PART NO",    "width": 160, "order": 4,  "isNumeric": False, "isImage": False},
    {"key": "make_part_no",   "label": "MAKE PART NO",   "width": 180, "order": 5,  "isNumeric": False, "isImage": False},
    {"key": "description_1",  "label": "DESCRIPTION 1",  "width": 240, "order": 6,  "isNumeric": False, "isImage": False},
    {"key": "description_2",  "label": "DESCRIPTION 2",  "width": 240, "order": 7,  "isNumeric": False, "isImage": False},
    {"key": "remarks_oem",    "label": "OEM",            "width": 200, "order": 8,  "isNumeric": False, "isImage": False},
    {"key": "remarks_others", "label": "REMARKS",        "width": 200, "order": 9,  "isNumeric": False, "isImage": False},
    {"key": "make",           "label": "MAKE",           "width": 140, "order": 10, "isNumeric": False, "isImage": False},
    {"key": "item_category",  "label": "ITEM CATEGORY",  "width": 160, "order": 11, "isNumeric": False, "isImage": False},
    {"key": "unit",           "label": "UNIT",           "width": 100, "order": 12, "isNumeric": False, "isImage": False},
    {"key": "reorder_level",  "label": "REORDER LEVEL",  "width": 130, "order": 13, "isNumeric": True,  "isImage": False},
    {"key": "images",         "label": "IMAGES",         "width": 120, "order": 99, "isNumeric": False, "isImage": True},
]


class ColumnSettingsPayload(BaseModel):
    columns: List[Dict[str, Any]]


@router.get("/stock-master/column-settings")
async def get_stock_master_column_settings(user=Depends(get_current_user)):
    """Return the current persisted columns for the Stock Master table.
    Falls back to DEFAULT_STOCK_MASTER_COLUMNS when no override has been saved.
    `is_admin` lets the frontend decide whether to expose the settings dialog."""
    doc = await db.column_settings.find_one({"page": "stock_master"}, {"_id": 0})
    cols = (doc or {}).get("columns") or DEFAULT_STOCK_MASTER_COLUMNS
    by_key = {c["key"]: c for c in cols}
    merged = []
    for d in DEFAULT_STOCK_MASTER_COLUMNS:
        existing = by_key.get(d["key"])
        if existing:
            merged.append({
                "key":       d["key"],
                "label":     existing.get("label", d["label"]),
                "width":     int(existing.get("width", d["width"]) or d["width"]),
                "order":     int(existing.get("order", d["order"]) or d["order"]),
                "isNumeric": bool(d["isNumeric"]),
                "isImage":   bool(d["isImage"]),
            })
        else:
            merged.append(d.copy())
    for c in merged:
        if c.get("isImage"):
            c["order"] = 99
    merged.sort(key=lambda c: c["order"])
    return {"columns": merged, "is_admin": user.get("role") == "admin"}


@router.put("/stock-master/column-settings")
async def put_stock_master_column_settings(payload: ColumnSettingsPayload, user=Depends(get_current_user)):
    """Persist new column order / widths. Admin only."""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only admins can change column settings")
    valid_keys = {c["key"] for c in DEFAULT_STOCK_MASTER_COLUMNS}
    cleaned = []
    for c in payload.columns:
        key = c.get("key")
        if key not in valid_keys:
            continue
        default = next((d for d in DEFAULT_STOCK_MASTER_COLUMNS if d["key"] == key), None)
        if not default:
            continue
        try:
            width = int(c.get("width") or default["width"])
            order = int(c.get("order") if c.get("order") is not None else default["order"])
        except (TypeError, ValueError):
            width, order = default["width"], default["order"]
        if default["isImage"]:
            order = 99
        width = max(60, min(800, width))
        cleaned.append({
            "key": key,
            "label": (c.get("label") or default["label"]).strip() or default["label"],
            "width": width,
            "order": order,
            "isNumeric": default["isNumeric"],
            "isImage":   default["isImage"],
        })
    saved_keys = {c["key"] for c in cleaned}
    next_order = (max((c["order"] for c in cleaned if c["order"] != 99), default=0) or 0) + 1
    for d in DEFAULT_STOCK_MASTER_COLUMNS:
        if d["key"] in saved_keys:
            continue
        added = d.copy()
        if not added["isImage"]:
            added["order"] = next_order
            next_order += 1
        cleaned.append(added)
    cleaned.sort(key=lambda c: c["order"])
    await db.column_settings.update_one(
        {"page": "stock_master"},
        {"$set": {"page": "stock_master", "columns": cleaned, "updated_at": now_iso(), "updated_by": user.get("email", "")}},
        upsert=True,
    )
    return {"columns": cleaned, "is_admin": True}


@router.get("/stock-master/{item_id}", response_model=StockMaster)
async def get_stock_master(item_id: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    return item


@router.put("/stock-master/{item_id}", response_model=StockMaster)
async def update_stock_master(item_id: str, payload: StockMasterCreate, user=Depends(get_current_user)):
    existing = await db.stock_master.find_one({"id": item_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    if payload.images and len(payload.images) > 5:
        raise HTTPException(status_code=400, detail="A maximum of 5 images is allowed per item")
    # Check uniqueness if part_no/make changed
    if existing["part_no"] != payload.part_no or existing["make"] != payload.make:
        conflict = await db.stock_master.find_one({"part_no": payload.part_no, "make": payload.make})
        if conflict:
            raise HTTPException(status_code=400, detail="Item with this part_no + make already exists")
    update_doc = payload.model_dump()
    await db.stock_master.update_one({"id": item_id}, {"$set": update_doc})
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    return item


@router.delete("/stock-master/{item_id}")
async def delete_stock_master(item_id: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    # Block delete if any transaction (IN/OUT) exists for this part_no + make
    txn = await db.transactions.find_one({"part_no": item.get("part_no"), "make": item.get("make")})
    if txn:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete — transactions are recorded against {item.get('part_no')} / {item.get('make')}. Remove or reassign those transactions first.",
        )
    await db.stock_master.delete_one({"id": item_id})
    await _notify(
        actor=user, type="stock_master.deleted", module="stock_master",
        title="Stock master item deleted",
        message=f"{user.get('email')} deleted {item.get('part_no')} / {item.get('make')}.",
        audience="module", ref_collection="stock_master", ref_id=item_id,
    )
    return {"ok": True}


# Column header → internal field mapping (case + space insensitive)
COLUMN_ALIASES = {
    "sl no": None, "sl.no": None, "slno": None, "s no": None, "sr no": None,
    "model": "model",
    "part no": "part_no", "part_no": "part_no", "partno": "part_no", "part number": "part_no",
    "old no": "old_part_no", "old part no": "old_part_no", "old_part_no": "old_part_no",
    "new no": "new_part_no", "new part no": "new_part_no", "new_part_no": "new_part_no", "newpartno": "new_part_no",
    "make part no": "make_part_no", "make_part_no": "make_part_no", "makepartno": "make_part_no",
    "description 1": "description_1", "description_1": "description_1", "description1": "description_1", "desc 1": "description_1",
    "description 2": "description_2", "description_2": "description_2", "description2": "description_2", "desc 2": "description_2",
    # NOTE: UI labels were renamed (OEM, Remarks). DB keys remain remarks_oem/remarks_others for back-compat.
    "oem": "remarks_oem", "remarks oem": "remarks_oem", "remarks_oem": "remarks_oem", "oem no": "remarks_oem",
    "remarks": "remarks_others", "remark": "remarks_others", "remarks others": "remarks_others", "remarks_others": "remarks_others",
    "make": "make",
    "item category": "item_category", "item_category": "item_category", "category": "item_category",
    "unit": "unit", "uom": "unit", "u o m": "unit",
    "reorder level": "reorder_level", "reorder_level": "reorder_level", "reorder": "reorder_level", "min stock": "reorder_level",
}

TEMPLATE_COLUMNS = [
    "SL NO", "MODEL", "PART NO", "OLD PART NO", "NEW PART NO", "MAKE PART NO",
    "DESCRIPTION 1", "DESCRIPTION 2", "OEM", "REMARKS",
    "MAKE", "ITEM CATEGORY", "UNIT", "REORDER LEVEL"
]


@router.post("/stock-master/bulk-preview")
async def bulk_preview(file: UploadFile = File(...), user=Depends(get_current_user)):
    content = await file.read()
    file_name = file.filename or "unknown"

    try:
        if file_name.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")

    col_map = {}
    for col in df.columns:
        key = _normalize_col(col)
        if key in COLUMN_ALIASES and COLUMN_ALIASES[key]:
            col_map[col] = COLUMN_ALIASES[key]

    mapped_fields = set(col_map.values())
    if "part_no" not in mapped_fields or "make" not in mapped_fields:
        raise HTTPException(
            status_code=400,
            detail="File must contain PART NO and MAKE columns. Download the template for the correct format.",
        )

    pairs_in_file = []
    skipped_rows = 0
    for _, row in df.iterrows():
        part_no = ""
        make = ""
        for orig_col, field in col_map.items():
            val = str(row.get(orig_col, "") or "").strip()
            if field == "part_no":
                part_no = val
            elif field == "make":
                make = val
        if not part_no or not make:
            skipped_rows += 1
            continue
        pairs_in_file.append((part_no, make))

    total_items = len(pairs_in_file)

    if total_items == 0:
        return {
            "file_name": file_name,
            "total_items": 0,
            "new_items": 0,
            "duplicate_items": 0,
            "skipped_rows": skipped_rows,
        }

    or_query = [{"part_no": pn, "make": mk} for pn, mk in pairs_in_file]
    existing_set = set()
    async for doc in db.stock_master.find(
        {"$or": or_query},
        {"_id": 0, "part_no": 1, "make": 1},
    ):
        existing_set.add((doc["part_no"], doc["make"]))

    duplicate_count = sum(1 for p in pairs_in_file if p in existing_set)
    new_count = total_items - duplicate_count

    return {
        "file_name": file_name,
        "total_items": total_items,
        "new_items": new_count,
        "duplicate_items": duplicate_count,
        "skipped_rows": skipped_rows,
    }


@router.post("/stock-master/bulk-upload")
async def bulk_upload(
    file: UploadFile = File(...),
    mode: str = Query("skip", regex="^(skip|overwrite)$"),
    user=Depends(get_current_user),
):
    content = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")

    col_map = {}
    for col in df.columns:
        key = _normalize_col(col)
        if key in COLUMN_ALIASES and COLUMN_ALIASES[key]:
            col_map[col] = COLUMN_ALIASES[key]

    mapped_fields = set(col_map.values())
    if "part_no" not in mapped_fields or "make" not in mapped_fields:
        raise HTTPException(
            status_code=400,
            detail="File must contain PART NO and MAKE columns. Download the template for the correct format.",
        )

    inserted, skipped, overwritten = 0, 0, 0
    for idx, row in df.iterrows():
        data = {
            "model": "", "part_no": "", "old_part_no": "", "new_part_no": "", "make_part_no": "",
            "description_1": "", "description_2": "",
            "remarks_oem": "", "remarks_others": "",
            "make": "", "item_category": "", "unit": "", "reorder_level": 0, "image": "",
        }
        for orig_col, field in col_map.items():
            val = row.get(orig_col, "")
            data[field] = str(val).strip() if val is not None else ""
        try:
            data["reorder_level"] = int(float(str(data.get("reorder_level") or 0)))
        except Exception:
            data["reorder_level"] = 0

        part_no = data["part_no"]
        make = data["make"]
        if not part_no or not make:
            skipped += 1
            continue

        existing = await db.stock_master.find_one({"part_no": part_no, "make": make})

        if existing:
            if mode == "overwrite":
                update_data = {k: v for k, v in data.items() if k not in ("id", "created_at")}
                await db.stock_master.update_one(
                    {"part_no": part_no, "make": make},
                    {"$set": update_data},
                )
                overwritten += 1
            else:
                skipped += 1
            continue

        doc = {"id": str(uuid.uuid4()), **data, "created_at": now_iso()}
        await db.stock_master.insert_one(doc)
        inserted += 1

    return {
        "inserted": inserted,
        "skipped": skipped,
        "overwritten": overwritten,
        "total_rows": len(df),
        "mode": mode,
    }
