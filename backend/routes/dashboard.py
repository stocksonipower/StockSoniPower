"""Dashboard / Stock Balance / Low Stock routes — extracted from server.py with zero logic changes."""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from deps import db, get_current_user, now_iso

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
