from typing import Optional
from fastapi import HTTPException
from deps import db
from helpers.note_helpers import _key
from helpers.status_helpers import (
    _aggregate_other_rkn_qty,
    _aggregate_other_rkn_qty_by_source,
    _pick_aggregate_other,
    _transfer_other_qty,
    _transfer_other_src_loc_qty,
)


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
        if not (it.box_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required")


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


async def _validate_cumulative_qty_polymorphic(source_type: str, source_id: str, parent_doc: dict, items, exclude_rkn_id: Optional[str] = None):
    """Cumulative racked qty per (part_no, make) across all RKNs for this source must
    not exceed the rackable qty (received_qty for RN, fulfilled_qty for SRN, accepted_qty for ERN)."""
    rackable = {}
    if source_type == "RN":
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            rec = it.get("received_qty")
            if rec is None:
                rec = it.get("quantity") or 0
            rec = float(rec or 0)
            inv = float(it.get("invoice_qty") or 0)
            # Cap at invoice qty: extra qty (received > invoice) is tracked via ERN
            rackable[k] = rackable.get(k, 0) + (min(rec, inv) if inv > 0 else rec)
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


async def _box_id_required_for_rack(rack_id: str) -> bool:
    """A box must be picked only if the selected rack has at least one box defined."""
    return await db.boxes.count_documents({"rack_id": rack_id}) > 0


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


async def _validate_picking_constraints(in_id: str, items, exclude_pn_id: Optional[str] = None, assigned_items: Optional[list] = None):
    from helpers.stock_helpers import _stock_locations_for
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    requested = {}
    allowed_godowns = {}
    base_items = assigned_items if assigned_items is not None else inn.get("items", [])
    for it in base_items:
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
        gid = it.get("selected_godown_id") or ""
        if gid:
            allowed_godowns.setdefault(k, set()).add(gid)
    other_sums = {} if assigned_items is not None else await _pick_aggregate_other(in_id, exclude_pn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.godown_id or ''}||{it.rack_id or ''}||{it.box_id or ''}"
        new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked issue note")
        allowed = allowed_godowns.get(k)
        if allowed and it.godown_id not in allowed:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make}: selected godown does not match the issue note")
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
    # 2. per-location stock availability. Draft picking does not reserve stock.
    # Group by part||make to fetch locations once
    loc_cache = {}
    for k_full, new_q in new_loc_sums.items():
        part_no, make, godown_id, rack_id, box_id = k_full.split("||", 4)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        loc = next((L for L in locs if (L.get("godown_id") or "") == godown_id and (L.get("rack_id") or "") == rack_id and (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen location")
        available = loc.get("current_qty") or 0
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to pick {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))


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
    """Block requesting more than current stock total, and selected-godown stock if set."""
    from helpers.stock_helpers import _stock_total_for
    # Sum requested qty in this payload per (part_no, make)
    req = {}
    req_by_godown = {}
    for it in items:
        k = _key(it.part_no, it.make)
        req[k] = req.get(k, 0) + (it.quantity or 0)
        gid = (getattr(it, "selected_godown_id", None) or "").strip()
        if gid:
            gk = f"{k}||{gid}"
            req_by_godown[gk] = req_by_godown.get(gk, 0) + (it.quantity or 0)
    for k, q in req.items():
        part_no, make = k.split("||", 1)
        avail = await _stock_total_for(part_no, make)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot issue {q} — only {avail} in stock",
            )
    for gk, q in req_by_godown.items():
        part_no, make, godown_id = gk.split("||", 2)
        rows = await db.transactions.aggregate([
            {"$match": {"part_no": part_no, "make": make, "godown_id": godown_id}},
            {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        ]).to_list(1)
        avail = rows[0]["q"] if rows else 0
        if q > avail + 1e-6:
            godown = await db.godowns.find_one({"id": godown_id}, {"_id": 0, "godown_name": 1}) or {}
            label = godown.get("godown_name") or godown_id
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot issue {q} from {label} — only {avail} in that godown",
            )


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
    from helpers.stock_helpers import _stock_total_for
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


async def _validate_transfer_note_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")

    # Batch-fetch referenced locations once (avoids N+1 lookups per row) so we can
    # confirm every godown/rack/box id still exists and hasn't been deleted/altered
    # by another user since the dropdown was populated.
    godown_ids, rack_ids, box_ids = set(), set(), set()
    for it in items:
        for gid in (it.src_godown_id, it.dest_godown_id):
            if (gid or "").strip():
                godown_ids.add(gid)
        for rid in (it.src_rack_id, it.dest_rack_id):
            if (rid or "").strip():
                rack_ids.add(rid)
        for bid in (it.src_box_id, it.dest_box_id):
            if (bid or "").strip():
                box_ids.add(bid)
    valid_godowns = set()
    if godown_ids:
        async for g in db.godowns.find({"id": {"$in": list(godown_ids)}}, {"_id": 0, "id": 1}):
            valid_godowns.add(g["id"])
    racks_by_id = {}
    if rack_ids:
        async for rk in db.racks.find({"id": {"$in": list(rack_ids)}}, {"_id": 0, "id": 1, "godown_id": 1}):
            racks_by_id[rk["id"]] = rk.get("godown_id")
    boxes_by_id = {}
    if box_ids:
        async for bx in db.boxes.find({"id": {"$in": list(box_ids)}}, {"_id": 0, "id": 1, "rack_id": 1}):
            boxes_by_id[bx["id"]] = bx.get("rack_id")

    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.src_godown_id or "").strip() or not (it.src_rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown and Rack are required")
        if not (it.dest_godown_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown is required")
        if it.src_godown_id == it.dest_godown_id:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source and destination godown must differ")
        # Existence + referential-integrity checks (rack must belong to its stated
        # godown, box must belong to its stated rack) — rejects stale/fabricated
        # location ids, e.g. a godown/rack/box deleted after the form was loaded.
        if it.src_godown_id not in valid_godowns:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown is invalid or no longer exists")
        if it.src_rack_id not in racks_by_id:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Rack is invalid or no longer exists")
        if racks_by_id[it.src_rack_id] != it.src_godown_id:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Rack does not belong to the selected Source Godown")
        if (it.src_box_id or "").strip():
            if it.src_box_id not in boxes_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is invalid or no longer exists")
            if boxes_by_id[it.src_box_id] != it.src_rack_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box does not belong to the selected Source Rack")
        if it.dest_godown_id not in valid_godowns:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown is invalid or no longer exists")
        if (it.dest_rack_id or "").strip():
            if it.dest_rack_id not in racks_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Rack is invalid or no longer exists")
            if racks_by_id[it.dest_rack_id] != it.dest_godown_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Rack does not belong to the selected Destination Godown")
        if (it.dest_box_id or "").strip():
            if it.dest_box_id not in boxes_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is invalid or no longer exists")
            if (it.dest_rack_id or "").strip() and boxes_by_id[it.dest_box_id] != it.dest_rack_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box does not belong to the selected Destination Rack")


async def _validate_transfer_note_constraints(str_id: str, items, exclude_stn_id: Optional[str] = None, assigned_items: Optional[list] = None):
    from helpers.stock_helpers import _stock_locations_for
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    requested = {}
    base_items = assigned_items if assigned_items is not None else s.get("items", [])
    for it in base_items:
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    other_sums = {} if assigned_items is not None else await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.src_godown_id or ''}||{it.src_rack_id or ''}||{it.src_box_id or ''}"
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
        part_no, make, godown_id, rack_id, box_id = k_full.split("||", 4)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        loc = next((L for L in locs if (L.get("godown_id") or "") == godown_id and (L.get("rack_id") or "") == rack_id and (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen source location")
        already_pending_here = other_loc_sums.get(k_full, 0)
        available = (loc.get("current_qty") or 0) - already_pending_here
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to transfer {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))
