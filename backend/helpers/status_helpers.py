from typing import Optional
from fastapi import HTTPException
from deps import db, now_iso
from helpers.note_helpers import _key


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
    has_activity = False
    for it in items:
        total_short += float(it.get("short_qty") or 0)
        children = it.get("children") or []
        if children:
            for c in children:
                has_activity = True
                total_decided += float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
        elif it.get("fulfilled_qty") is not None:
            has_activity = True
            total_decided += float(it.get("fulfilled_qty") or 0)
    if total_short <= 0:
        return "PENDING"
    if not has_activity or total_decided <= 0:
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
    has_activity = False
    for it in items:
        total_extra += float(it.get("extra_qty") or 0)
        children = it.get("children") or []
        if children:
            for c in children:
                has_activity = True
                total_acc += float(c.get("accepted_qty") or 0)
                total_rej += float(c.get("rejected_qty") or 0)
        elif it.get("accepted_qty") is not None or it.get("rejected_qty") is not None:
            has_activity = True
            total_acc += float(it.get("accepted_qty") or 0)
            total_rej += float(it.get("rejected_qty") or 0)
    if total_extra <= 0:
        return "PENDING"
    decided = total_acc + total_rej
    if not has_activity or decided <= 0:
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


async def _recompute_rn_status(rn_id: str):
    """Recompute racking-progress status. DRAFT (pre-finalize) receipts stay at DRAFT
    — that's an internal pre-finalize marker only (gates the /finalize endpoint and
    child-sync behavior), and always displays as "Pending" in the UI.

    Status precedence (highest to lowest), active 3-status set for finalized RNs:
      PENDING     : finalized RN with at most DRAFT racking notes (or none yet —
                    SRN/ERN tree may still emit auto-RKNs later). Nothing racked.
      COMPLETE    : all rackable qty (RN.received + SRN.fulfilled + ERN.accepted
                    across descendants) is covered by RECORDED racking notes
                    AND every descendant SRN/ERN is COMPLETE
      IN_PROCESS  : some RECORDED racking exists but not yet fully covered
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

    # First check: any RECORDED RKN exists? If yes -> IN_PROCESS / COMPLETE.
    # Once any qty is recorded, status NEVER goes back to PENDING
    # (even if a later draft RKN is added on top).
    has_recorded_rkn = await db.racking_notes.find_one(
        {"status": "RECORDED", "$or": or_clauses}, {"_id": 0, "id": 1}
    )

    if not has_recorded_rkn:
        # No recorded RKNs yet — RN sits in PENDING (covers both
        # "draft RKN exists" and "no RKN at all" cases — the SRN/ERN tree may
        # still produce RKNs later via the auto-creation workflow).
        new_status = "PENDING"
        update: dict = {"status": new_status}
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
        await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})
        return

    # Total rackable qty = RN.invoice (capped) + each SRN.fulfilled + each ERN.accepted.
    # RN contribution is capped at invoice_qty so extra qty (tracked via ERN) is not
    # double-counted here.
    rackable: dict = {}
    for it in rn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        rec = it.get("received_qty")
        if rec is None:
            rec = it.get("quantity") or 0
        rec = float(rec or 0)
        inv = float(it.get("invoice_qty") or 0)
        rackable[k] = rackable.get(k, 0) + (min(rec, inv) if inv > 0 else rec)
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

    # New spec rule: RN cannot be COMPLETE while ANY descendant SRN/ERN is
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
    # IN_PROCESS unless every rackable qty is fully covered AND no SRN/ERN
    # descendant is still pending.
    if not rackable or sum(rackable.values()) == 0:
        new_status = "IN_PROCESS"
    else:
        all_full = all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)
        if all_full and not has_open_descendant:
            new_status = "COMPLETE"
        else:
            new_status = "IN_PROCESS"

    update = {"status": new_status}
    if new_status == "COMPLETE":
        update["racked_at"] = rn.get("racked_at") or now_iso()
    else:
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})


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


async def _recompute_in_status(in_id: str):
    """Active 3-status set: PENDING (nothing picked/rejected yet) -> IN_PROCESS
    (some picked+rejected, some still pending) -> COMPLETE (picked+rejected covers
    every requested line — the request is fully resolved, whether by pick or reject).
    Only COMPLETED Picking Notes count toward "processed"; DRAFT allocations (nothing
    recorded yet) do not move the status off PENDING, so editing stays unlocked until
    the first quantity is actually processed."""
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        return
    # DRAFT (pre-finalize, no Picking Note exists yet) never gets auto-promoted —
    # mirrors Receipt Note's _recompute_rn_status DRAFT guard.
    if inn.get("status") == "DRAFT":
        return
    requested = {}
    for it in inn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    processed = {}
    async for pn in db.picking_notes.find({"issue_note_id": in_id}, {"_id": 0, "items": 1, "status": 1}):
        status = (pn.get("status") or "").upper()
        if status in ("RECORDED", "COMPLETED"):
            for it in pn.get("items", []):
                k = _key(it.get("part_no"), it.get("make"))
                processed[k] = processed.get(k, 0) + (it.get("quantity") or 0) + (it.get("rejected_qty") or 0)
    has_processed = any(v > 1e-6 for v in processed.values())
    if not requested:
        new_status = "PENDING"
    elif has_processed and all(processed.get(k, 0) + 1e-6 >= q for k, q in requested.items() if q > 0):
        new_status = "COMPLETE"
    elif has_processed:
        new_status = "IN_PROCESS"
    else:
        new_status = "PENDING"
    update = {"status": new_status}
    if new_status == "COMPLETE":
        update["picked_at"] = inn.get("picked_at") or now_iso()
    else:
        if inn.get("picked_at"):
            await db.issue_notes.update_one({"id": in_id}, {"$unset": {"picked_at": ""}})
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})


async def _recompute_str_status(str_id: str):
    """Active 3-status set: PENDING (nothing transferred/rejected yet) -> IN_PROCESS
    (some transferred+rejected, some still pending) -> COMPLETE (transferred+rejected
    covers every requested line). Only COMPLETED Transfer Notes count toward
    "processed"; DRAFT allocations do not move the status off PENDING, so editing
    stays unlocked until the first quantity is actually transferred."""
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        return
    requested = {}
    for it in s.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    processed = await _transfer_other_qty(str_id, completed_only=True)
    has_processed = any(v > 1e-6 for v in processed.values())
    if not requested:
        new_status = "PENDING"
    elif has_processed and all(processed.get(k, 0) + 1e-6 >= q for k, q in requested.items() if q > 0):
        new_status = "COMPLETE"
    elif has_processed:
        new_status = "IN_PROCESS"
    else:
        new_status = "PENDING"
    update = {"status": new_status}
    if new_status == "COMPLETE":
        update["transferred_at"] = s.get("transferred_at") or now_iso()
    else:
        if s.get("transferred_at"):
            await db.transfer_requests.update_one({"id": str_id}, {"$unset": {"transferred_at": ""}})
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})


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


async def _pick_aggregate_other(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Sum picking-note (picked + rejected) qty per (part,make) across other PNs for
    an Issue Note (DRAFT + RECORDED) — both consume the requested allocation."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1}):
        for it in pn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0) + (it.get("rejected_qty") or 0)
    return sums


async def _pick_aggregate_other_by_loc(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Per-location sum across other PNs. Key = part||make||godown_id||rack_id||box_id."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1, "status": 1}):
        # Kept for legacy callers; draft picks no longer reduce available stock.
        if pn.get("status") != "DRAFT":
            continue
        for it in pn.get("items", []):
            loc_key = (
                f"{it.get('part_no','')}||{it.get('make','')}||"
                f"{it.get('godown_id','') or ''}||{it.get('rack_id','') or ''}||{it.get('box_id','') or ''}"
            )
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


async def _transfer_other_qty(str_id: str, exclude_stn_id: Optional[str] = None, completed_only: bool = False) -> dict:
    """Sum (transferred + rejected) qty per (part,make) across other STNs (DRAFT +
    RECORDED, or COMPLETED-only) for a given STR — both consume the requested allocation."""
    q = {"transfer_request_id": str_id}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    if completed_only:
        q["status"] = {"$in": ["COMPLETED", "RECORDED"]}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0) + (it.get("rejected_qty") or 0)
    return sums


async def _transfer_other_src_loc_qty(exclude_stn_id: Optional[str] = None) -> dict:
    """Per-source-location sum across active STNs (used to reserve source qty so two executions can't double-book)."""
    q = {"status": {"$in": ["DRAFT", "PROCESSING"]}}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            loc_key = (
                f"{it.get('part_no','')}||{it.get('make','')}||"
                f"{it.get('src_godown_id','') or ''}||{it.get('src_rack_id','') or ''}||{it.get('src_box_id','') or ''}"
            )
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


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
