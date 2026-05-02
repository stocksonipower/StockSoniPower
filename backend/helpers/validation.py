from typing import Optional
from fastapi import HTTPException
from deps import db
from helpers.note_helpers import _key
from helpers.status_helpers import (
    _aggregate_other_rkn_qty,
    _aggregate_other_rkn_qty_by_source,
    _pick_aggregate_other,
    _pick_aggregate_other_by_loc,
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
        # box_id is required only when the rack actually has boxes


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


async def _validate_picking_constraints(in_id: str, items, exclude_pn_id: Optional[str] = None):
    from helpers.stock_helpers import _stock_locations_for
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
    from helpers.stock_helpers import _stock_total_for
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
    from helpers.stock_helpers import _stock_locations_for
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
