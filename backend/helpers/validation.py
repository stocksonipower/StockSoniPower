from typing import Optional
from fastapi import HTTPException
from deps import db
from helpers.note_helpers import _key, _ern_rackable_qty
from helpers.status_helpers import (
    _aggregate_other_rkn_qty,
    _aggregate_other_rkn_qty_by_source,
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
        gid, rid, bid = (it.godown_id or "").strip(), (it.rack_id or "").strip(), (it.box_id or "").strip()
        if not gid:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown is required")
        if bid and not rid:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Rack is required when Box is selected")


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
    not exceed the rackable qty (received_qty for RN, fulfilled_qty for SRN, extra_qty for an APPROVED ERN)."""
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
        if (parent_doc.get("status") or "").upper() in ("APPROVED", "COMPLETE"):
            for it in parent_doc.get("items", []):
                k = _key(it.get("part_no"), it.get("make"))
                rackable[k] = rackable.get(k, 0) + _ern_rackable_qty(it)

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


async def _validate_racking_locations(items):
    """Confirm every godown/rack/box referenced by a racking-note row still exists and
    that rack->godown / box->rack parentage is intact — mirrors the same check already
    done for Transfer Notes (_validate_transfer_note_items). Without this, a rack/box
    deleted after being selected on a Draft Racking Note could still be recorded as a
    valid stock-in location."""
    godown_ids, rack_ids, box_ids = set(), set(), set()
    for it in items:
        if (it.godown_id or "").strip():
            godown_ids.add(it.godown_id)
        if (it.rack_id or "").strip():
            rack_ids.add(it.rack_id)
        if (it.box_id or "").strip():
            box_ids.add(it.box_id)

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
        gid, rid, bid = (it.godown_id or "").strip(), (it.rack_id or "").strip(), (it.box_id or "").strip()
        if gid and gid not in valid_godowns:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown is invalid or no longer exists")
        if rid:
            if rid not in racks_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Rack is invalid or no longer exists")
            if gid and racks_by_id[rid] != gid:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Rack does not belong to the selected Godown")
        if bid:
            if bid not in boxes_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Box is invalid or no longer exists")
            if rid and boxes_by_id[bid] != rid:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Box does not belong to the selected Rack")


async def _box_id_required_for_rack(rack_id: str) -> bool:
    """A box must be picked only if the selected rack has at least one box defined."""
    return await db.boxes.count_documents({"rack_id": rack_id}) > 0


def _is_whole(v) -> bool:
    return abs(float(v) - round(float(v))) < 1e-9


def _validate_reject_rules(groups: dict, actual_label: str) -> None:
    """Enforce the Reject Quantity rules for one note, per requested line.

    Reject Quantity records the part of a request that was deliberately NOT fulfilled.
    It moves no stock and creates no transaction — it only closes the request so no
    follow-up note is raised for the shortfall. That is exactly why it is bounded by
    what is still outstanding:

        actual + rejected <= requested          (and remaining = requested - actual)

    `groups` maps "<part> / <make>" to {"requested", "actual", "rejected"}, aggregated
    over every row of the note that belongs to the same requested line. `requested`
    is None for an open line (the office left the quantity to the store incharge), so
    there is no target to measure a rejection against and only the shape rules apply.
    """
    for label, g in groups.items():
        rejected = float(g.get("rejected") or 0)
        if rejected < 0:
            raise HTTPException(status_code=400, detail=f"{label}: Rejected Qty cannot be negative")
        if rejected <= 1e-9:
            continue  # nothing rejected on this line — every rule below is vacuous
        actual = float(g.get("actual") or 0)
        requested = g.get("requested")
        # Whole-number items must be rejected in whole numbers — a half-rejected
        # discrete part is not a quantity anyone can act on.
        if requested is not None and _is_whole(requested) and _is_whole(actual) and not _is_whole(rejected):
            raise HTTPException(
                status_code=400,
                detail=f"{label}: Rejected Qty must be a whole number for this item",
            )
        if requested is None:
            continue  # open line — unbounded by design
        if actual > requested + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{label}: Reject Quantity cannot be entered because the actual quantity "
                f"exceeds the requested quantity ({actual_label.lower()} {actual}, requested {requested})"
            ))
        if abs(actual - requested) <= 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{label}: Rejected Qty must be 0 — the full requested quantity of "
                f"{requested} was already {actual_label.lower()}"
            ))
        if rejected > requested + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{label}: Rejected Qty {rejected} exceeds the requested quantity {requested}"
            ))
        remaining = requested - actual
        if rejected > remaining + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{label}: Rejected Qty {rejected} exceeds the remaining quantity {remaining} "
                f"(requested {requested} − {actual_label.lower()} {actual})"
            ))


def _validate_picking_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        qty = it.quantity or 0
        rejected = getattr(it, "rejected_qty", 0) or 0
        if qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Picked Qty cannot be negative")
        if rejected < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Rejected Qty cannot be negative")
        # A 0 row is meaningful and must survive: it records that this specific Issue Note
        # line was deliberately left unpicked (e.g. its quantity was taken on another
        # line of the same part). It moves no stock and needs no location. The note as a
        # whole still has to account for something — checked once after the loop.
        # Godown is always required for the physically-picked portion. Rack and box are
        # NOT demanded here: stock can legitimately sit in a godown that has no racking,
        # in which case rack_id/box_id are empty on the very transactions the pick draws
        # from. `_validate_picking_constraints` is the real guard — it requires the exact
        # godown/rack/box triple to match a location that currently holds stock.
        if qty > 0 and not (it.godown_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown is required")
    # A note that neither picks nor rejects anything decides nothing — there is no answer
    # in it for the Issue Note to act on. Rejecting the whole quantity is a valid answer
    # (it closes the request out without stock moving), so it counts here.
    if not any((it.quantity or 0) > 0 or (getattr(it, "rejected_qty", 0) or 0) > 0 for it in items):
        raise HTTPException(
            status_code=400,
            detail="Enter a Picked Qty or a Rejected Qty on at least one row",
        )


async def _validate_picking_constraints(in_id: str, items, exclude_pn_id: Optional[str] = None, assigned_items: Optional[list] = None):
    """Picking locations are a suggestion, not a lock: the Issue Note's Godown
    Preference and greedy `allocated_locations` only decide what's pre-filled on the
    Picking Note (see `prepare_picking_note`). The store user may accept the
    suggestion, pick partially from it, or choose any other valid stock location.

    The ISSUED quantity is a target, not a ceiling: the store incharge may pick more
    than the office asked for (a package rarely breaks down exactly the way the office
    assumed). The surplus is an EXTRA and simply stands. Picking under it leaves a
    PENDING quantity that rolls into a follow-up Picking Note — unless it is REJECTED,
    which closes it out with no follow-up. Pending and Extra are pure arithmetic and are
    never entered; Picked and Rejected are the only two inputs.

    The one hard limit is real stock: nothing may be picked that isn't physically on
    the shelf, at the exact location it is being picked from, and no more in total than
    the live Available Qty for that part/make."""
    from helpers.stock_helpers import _stock_locations_for
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    requested = {}
    # An OPEN line (the office left the quantity to the store incharge) has no target
    # number, so it is tracked as None rather than 0 — otherwise every reject against it
    # would read as "rejecting more than the 0 that was asked for".
    open_keys = set()
    for it in (assigned_items if assigned_items is not None else inn.get("items", [])):
        k = _key(it.get("part_no"), it.get("make"))
        requested.setdefault(k, 0)
        if it.get("quantity") is None:
            open_keys.add(k)
        else:
            requested[k] += it.get("quantity") or 0

    new_loc_sums = {}
    new_item_sums = {}
    reject_groups = {}
    for it in items:
        k = _key(it.part_no, it.make)
        if (it.quantity or 0) > 0:
            loc_key = f"{it.part_no}||{it.make}||{it.godown_id or ''}||{it.rack_id or ''}||{it.box_id or ''}"
            new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        new_item_sums[(it.part_no, it.make)] = new_item_sums.get((it.part_no, it.make), 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked issue note")
        # Pooled per part+make — the same level `_remaining_assigned_items` and the Issue
        # Note status recompute resolve at, so a note that passes here is exactly a note
        # those two can account for. (The form bounds reject per line, which is stricter.)
        g = reject_groups.setdefault(f"{it.part_no} / {it.make}", {
            "requested": None if k in open_keys else requested.get(k, 0),
            "actual": 0, "rejected": 0,
        })
        g["actual"] += it.quantity or 0
        g["rejected"] += getattr(it, "rejected_qty", 0) or 0
    # Reject bounds first: "Picked exceeds Issued, so Reject must be 0" is the rule the
    # user actually broke, and it reads better than a downstream stock message.
    _validate_reject_rules(reject_groups, "Picked")

    # Per-location stock availability. Draft picking does not reserve stock.
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

    # Total Available Qty ceiling. The per-location checks above already imply this, but
    # stated explicitly it produces the message the picker needs — "you asked for 10 and
    # only 8 exist" — instead of a location-by-location one that never names the real
    # constraint. Picking is bounded by live availability, never by the issued quantity.
    for (part_no, make), picked_total in new_item_sums.items():
        if picked_total <= 0:
            continue
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        total_available = sum(L.get("current_qty") or 0 for L in loc_cache[(part_no, make)])
        if picked_total > total_available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: cannot pick {picked_total} — only {total_available} available in stock"
            ))


def _validate_issue_items(items):
    """Quantity is optional on an Issue Note: the office user often cannot predict how
    much a godown package holds, so a blank ("open") quantity is allowed and gets filled
    in by the store incharge on the Picking Note. A stated quantity must still be > 0."""
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is not None and it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0 (leave it blank to let the store incharge decide)")


async def _validate_issue_qty_against_stock(items, exclude_in_id: Optional[str] = None):
    """Block requesting more than current stock total, and selected-godown stock if set."""
    from helpers.stock_helpers import _stock_total_for
    # Sum requested qty in this payload per (part_no, make)
    req = {}
    req_by_godown = {}
    for it in items:
        # Open (blank) quantities claim nothing up front — there is no number to check
        # against stock yet; the real check happens per-location at picking time.
        if it.quantity is None:
            continue
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
    """A Transfer Request line may legitimately ask for 0.

    The requester often knows WHICH item has to move and where it should end up, but not
    how much — the operator settles that at the shelf. A 0 line names the item and the
    destination and leaves the quantity to the Transfer Note, where anything moved against
    it simply reads as an EXTRA (0 requested, n transferred). It is not "nothing to do",
    which is why the line is kept rather than rejected. Negative is still meaningless.
    """
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity cannot be negative")


async def _validate_transfer_request_qty(items, exclude_str_id: Optional[str] = None):
    """Block requesting more than available stock for any (part,make).

    If a row names a source location (godown, optionally + rack/box), the qty is
    checked against that specific location's balance — not the part/make grand
    total — since the requester has already committed to a source. Rows that
    leave the source blank fall back to the grand total (the exact location is
    decided later, at Transfer Note stage)."""
    from helpers.stock_helpers import _stock_total_for, _stock_at_location_for
    req = {}
    loc_req = {}
    for it in items:
        if (it.src_godown_id or "").strip():
            lk = (it.part_no, it.make, it.src_godown_id, it.src_rack_id or "", it.src_box_id or "")
            loc_req[lk] = loc_req.get(lk, 0) + (it.quantity or 0)
        else:
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
    for (part_no, make, godown_id, rack_id, box_id), q in loc_req.items():
        avail = await _stock_at_location_for(part_no, make, godown_id, rack_id, box_id)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot transfer {q} from the selected location — only {avail} there",
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
        qty = it.quantity or 0
        rejected = getattr(it, "rejected_qty", 0) or 0
        if qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Transferred Qty cannot be negative")
        if rejected < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Rejected Qty cannot be negative")
        # A 0 row is allowed and preserved: it records a requested line that this note
        # did not move. The note as a whole must account for something — checked once
        # after the loop. A rejection reason is optional: Reject Qty is a quantity field
        # on the note, not a form to justify. Any reason supplied is still stored.
        # Source/destination locations are only required for the portion that
        # actually moves — a row that moves nothing may carry no location at all.
        if qty > 0:
            if not (it.src_godown_id or "").strip() or not (it.src_rack_id or "").strip():
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown and Rack are required")
            if not (it.dest_godown_id or "").strip():
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown is required")
            if not (it.dest_rack_id or "").strip():
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Rack is required")
            # A rack that has boxes must be resolved to the box on both sides, otherwise
            # the stock's real position is ambiguous.
            if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
            if not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
                raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
            # Transferring within one godown is legitimate (rack-to-rack, box-to-box);
            # only moving stock onto the shelf it already occupies is meaningless, so the
            # full godown/rack/box triple must differ somewhere.
            same_location = (
                (it.src_godown_id or "") == (it.dest_godown_id or "")
                and (it.src_rack_id or "") == (it.dest_rack_id or "")
                and (it.src_box_id or "") == (it.dest_box_id or "")
            )
            if same_location:
                raise HTTPException(
                    status_code=400,
                    detail=f"Row {idx}: Source and destination are the same location — change the rack or box",
                )
        # Existence + referential-integrity checks (rack must belong to its stated
        # godown, box must belong to its stated rack) — rejects stale/fabricated
        # location ids, e.g. a godown/rack/box deleted after the form was loaded.
        if (it.src_godown_id or "").strip():
            if it.src_godown_id not in valid_godowns:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown is invalid or no longer exists")
        if (it.src_rack_id or "").strip():
            if it.src_rack_id not in racks_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Rack is invalid or no longer exists")
            if (it.src_godown_id or "").strip() and racks_by_id[it.src_rack_id] != it.src_godown_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Rack does not belong to the selected Source Godown")
        if (it.src_box_id or "").strip():
            if it.src_box_id not in boxes_by_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is invalid or no longer exists")
            if boxes_by_id[it.src_box_id] != it.src_rack_id:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box does not belong to the selected Source Rack")
        if (it.dest_godown_id or "").strip():
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
    if not any((it.quantity or 0) > 0 or (getattr(it, "rejected_qty", 0) or 0) > 0 for it in items):
        raise HTTPException(status_code=400, detail="Enter a Transferred Qty or a Rejected Qty on at least one row")


async def _validate_transfer_note_constraints(str_id: str, items, exclude_stn_id: Optional[str] = None, assigned_items: Optional[list] = None):
    """The Transfer Note counterpart of `_validate_picking_constraints`, and deliberately
    the same rules.

    The REQUESTED quantity is a target, not a ceiling: the operator may move more than the
    request asked for (a package rarely breaks down exactly the way the requester assumed).
    The surplus is an EXTRA and simply stands. Moving less leaves a PENDING quantity that
    rolls into a follow-up Transfer Note — unless it is REJECTED, which closes it out with
    no follow-up. Pending and Extra are pure arithmetic and are never entered; Transferred
    and Rejected are the only two inputs, and Reject is legal only while Extra is 0.

    The one hard limit is real stock: nothing may be transferred that isn't physically on
    the shelf, at the exact source location it is being drawn from, and no more in total
    than the live Available Qty for that part/make.
    """
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

    new_item_sums = {}
    new_loc_sums = {}
    reject_groups = {}
    for it in items:
        k = _key(it.part_no, it.make)
        rejected = getattr(it, "rejected_qty", 0) or 0
        new_item_sums[(it.part_no, it.make)] = new_item_sums.get((it.part_no, it.make), 0) + (it.quantity or 0)
        if (it.quantity or 0) > 0:
            loc_key = f"{it.part_no}||{it.make}||{it.src_godown_id or ''}||{it.src_rack_id or ''}||{it.src_box_id or ''}"
            new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked transfer request")
        # Pooled per part+make, and measured against what is still outstanding after any
        # other note for this request — the same level `_remaining_assigned_items` and the
        # request's status recompute resolve at, so a note that passes here is exactly a
        # note those two can account for.
        g = reject_groups.setdefault(f"{it.part_no} / {it.make}", {
            "requested": max(0, requested.get(k, 0) - other_sums.get(k, 0)),
            "actual": 0, "rejected": 0,
        })
        g["actual"] += it.quantity or 0
        g["rejected"] += rejected
    # Reject bounds first: "Transferred exceeds Requested, so Reject must be 0" is the
    # rule the user actually broke, and it reads better than a downstream stock message.
    _validate_reject_rules(reject_groups, "Transferred")

    # NO cumulative cap against the requested quantity: moving more than was asked for is
    # an EXTRA, which is legal by design (see this function's docstring). Real stock is the
    # only ceiling, checked per source location below and in total further down.

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

    # Total Available Qty ceiling. The per-location checks above already imply this, but
    # stated explicitly it produces the message the operator needs — "you asked for 10 and
    # only 8 exist" — instead of a location-by-location one that never names the real
    # constraint. Transferring is bounded by live availability, never by the requested qty.
    for (part_no, make), moved_total in new_item_sums.items():
        if moved_total <= 0:
            continue
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        total_available = sum(L.get("current_qty") or 0 for L in loc_cache[(part_no, make)])
        if moved_total > total_available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: cannot transfer {moved_total} — only {total_available} available in stock"
            ))
