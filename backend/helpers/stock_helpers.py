from typing import Optional
from deps import db


# ----------- Live-join helper for consistent master / location data -----------
_MASTER_FIELDS = (
    "model", "old_part_no", "new_part_no", "make_part_no",
    "description_1", "description_2",
    "remarks_oem", "remarks_others",
    "item_category", "unit", "image", "reorder_level",
)


async def _get_balance(part_no, make, godown_id, rack_id, box_id) -> int:
    pipeline = [
        {"$match": {"part_no": part_no, "make": make, "godown_id": godown_id, "rack_id": rack_id, "box_id": box_id}},
        {"$group": {"_id": None, "qty": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}}
    ]
    result = await db.transactions.aggregate(pipeline).to_list(1)
    return result[0]["qty"] if result else 0


async def _stock_total_for(part_no: str, make: str) -> float:
    """Total available qty for a part/make across all locations (sum of IN - OUT)."""
    rows = await db.transactions.aggregate([
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
    ]).to_list(1)
    return rows[0]["q"] if rows else 0


async def _stock_at_location_for(part_no: str, make: str, godown_id: str = "", rack_id: str = "", box_id: str = "") -> float:
    """Available qty for a part/make restricted to whichever of godown/rack/box
    are given (a requester may know only the godown, or the full godown+rack+box)."""
    match = {"part_no": part_no, "make": make}
    if godown_id:
        match["godown_id"] = godown_id
    if rack_id:
        match["rack_id"] = rack_id
    if box_id:
        match["box_id"] = box_id
    rows = await db.transactions.aggregate([
        {"$match": match},
        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
    ]).to_list(1)
    return rows[0]["q"] if rows else 0


async def _stock_locations_for(part_no: str, make: str) -> list:
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


async def _allocate_locations_for(part_no: str, make: str, qty: float, selected_godown_id: Optional[str] = None) -> list:
    """Greedily allocate `qty` across existing stock locations for a part/make, in the
    same natural order `_stock_locations_for` returns (godown_name, rack_no, box_no).

    Used to pre-determine the *authorized* picking locations for an Issue Note line at
    creation/edit time — once set, picking is restricted to exactly these locations
    (an Issue Note no longer just requests a quantity; it also dictates where it must
    be drawn from). Deterministic and reproducible: given the same live stock state,
    the same allocation always results, so re-running it after an edit is safe.
    """
    locs = await _stock_locations_for(part_no, make)
    if selected_godown_id:
        locs = [L for L in locs if L.get("godown_id") == selected_godown_id]
    remaining = float(qty or 0)
    allocation = []
    for L in locs:
        if remaining <= 1e-9:
            break
        take = min(remaining, L.get("current_qty") or 0)
        if take <= 1e-9:
            continue
        allocation.append({
            "godown_id": L.get("godown_id", ""), "godown_name": L.get("godown_name", ""),
            "rack_id": L.get("rack_id", ""), "rack_no": L.get("rack_no", ""),
            "box_id": L.get("box_id", ""), "box_no": L.get("box_no", ""),
            "box_category": L.get("box_category", ""),
            "quantity": take,
        })
        remaining -= take
    return allocation


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
    """Add parent_assigned_to_user_id / _name / _email + parent_stock_in_type onto each row
    by joining against a parent collection."""
    if not rows:
        return rows
    parent_ids = list({r.get(parent_id_field) for r in rows if r.get(parent_id_field)})
    if not parent_ids:
        return rows
    coll = getattr(db, parent_collection)
    pmap = {}
    async for p in coll.find(
        {"id": {"$in": parent_ids}},
        {"_id": 0, "id": 1, "assigned_to_user_id": 1, "assigned_to_name": 1, "assigned_to_email": 1,
         "stock_in_type": 1},
    ):
        pmap[p["id"]] = p
    for r in rows:
        p = pmap.get(r.get(parent_id_field), {})
        r["parent_assigned_to_user_id"] = p.get("assigned_to_user_id")
        r["parent_assigned_to_name"] = p.get("assigned_to_name", "") or ""
        r["parent_assigned_to_email"] = p.get("assigned_to_email", "") or ""
        # Only set stock_in_type if parent collection supplies it (RN/IssueNote do; ERN/SRN don't)
        if "stock_in_type" in p:
            r["parent_stock_in_type"] = p.get("stock_in_type", "") or ""
    return rows
