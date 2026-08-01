"""Stock In domain service.

Owns the business rules for the Receipt Note -> SRN/ERN -> Racking Note -> Stock
chain, and keeps every derived document synchronized with its parent.

Design notes
------------
* **Mutability gate.** A Receipt Note is mutable until stock has actually moved,
  i.e. until some Racking Note in its source graph reaches ``RECORDED``. The
  previous rule ("any racking note exists") locked the RN the instant it was
  finalized, because finalize auto-creates a DRAFT racking note — so the note was
  never editable in practice. See ``assert_rn_mutable``.
* **Transactions.** Each mutating operation runs inside a single unit of work, so
  the parent edit, the child re-synchronization and the audit entry commit
  together or not at all.
* **Status recomputation runs after commit.** The status helpers derive state by
  re-reading the source graph and are idempotent, so they are invoked once the
  data change is durable. This keeps the transaction small and avoids mixing
  sessioned and non-sessioned reads (a non-sessioned read cannot see uncommitted
  writes).
"""
from typing import Optional

from fastapi import HTTPException

from deps import now_iso
from helpers.note_helpers import _key

EPS = 1e-6


# ----------------------------------------------------------------------------
# Quantity helpers
# ----------------------------------------------------------------------------
def _f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


def rackable_from_rn_items(items: list) -> dict:
    """Quantity rackable directly from the RN: min(received, invoice) per part."""
    out: dict = {}
    for it in items or []:
        inv, rec = _f(it.get("invoice_qty")), _f(it.get("received_qty"))
        qty = min(rec, inv) if inv > 0 else rec
        if qty > 0:
            out[_key(it.get("part_no"), it.get("make"))] = out.get(_key(it.get("part_no"), it.get("make")), 0) + qty
    return out


def short_extra_from_items(items: list, stock_in_type: str) -> tuple[dict, dict]:
    """Per-part shortfall and overage implied by the RN's current quantities."""
    shorts: dict = {}
    extras: dict = {}
    if (stock_in_type or "INVOICE").upper() == "GENERAL":
        return shorts, extras  # GENERAL receipts are self-consistent by definition
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        diff = _f(it.get("received_qty")) - _f(it.get("invoice_qty"))
        if diff < -EPS:
            shorts[k] = shorts.get(k, 0) + abs(diff)
        elif diff > EPS:
            extras[k] = extras.get(k, 0) + diff
    return shorts, extras


async def recorded_qty_by_source(uow, source_type: str, source_id: str) -> dict:
    """Quantity actually RECORDED into stock (never merely decided/approved) per
    part, via racking notes sourced from this SRN/ERN. This is the only thing an
    RN edit's resync should ever be blocked by — matches assert_rn_mutable's own
    "mutable until stock physically moves" philosophy."""
    out: dict = {}
    for rkn in await uow.racking_notes.for_source(source_type, source_id, status="RECORDED"):
        for it in rkn.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            out[k] = out.get(k, 0) + _f(it.get("quantity"))
    return out


def srn_decided_by_key(srn: dict) -> dict:
    """Quantity already committed on an SRN (received + written off) per part.

    Distinct from `recorded_qty_by_source` above: this is the general "how much
    of this SRN's shortfall has a fulfilment decision against it" figure used by
    read-only consumers (e.g. Item Details' pending-qty total), not the RN-edit
    mutability guard."""
    out: dict = {}
    for it in srn.get("items", []) or []:
        k = _key(it.get("part_no"), it.get("make"))
        decided = sum(_f(c.get("received_qty")) + _f(c.get("not_receivable_qty"))
                      for c in (it.get("children") or []))
        if decided <= 0:
            decided = _f(it.get("fulfilled_qty"))  # legacy bulk-fulfilment path
        out[k] = out.get(k, 0) + decided
    return out


def ern_decided_by_key(ern: dict) -> dict:
    """Quantity considered decided on an ERN per part, for read-only consumers
    (e.g. Item Details' pending-qty total). Under the whole-note approval model
    there's no per-row decision — either the whole extra_qty is decided (once
    APPROVED/REJECTED/COMPLETE) or none of it is (still PENDING_APPROVAL)."""
    out: dict = {}
    decided_whole_note = (ern.get("status") or "PENDING_APPROVAL").upper() != "PENDING_APPROVAL"
    if not decided_whole_note:
        return out
    for it in ern.get("items", []) or []:
        k = _key(it.get("part_no"), it.get("make"))
        out[k] = out.get(k, 0) + _f(it.get("extra_qty"))
    return out


# ----------------------------------------------------------------------------
# Mutability
# ----------------------------------------------------------------------------
async def note_has_recorded_racking(uow_or_db, source_type: str, source_id: str) -> bool:
    """True once stock has been racked against THIS SRN/ERN specifically.

    Deliberately scoped to the note's own racking, not the parent RN's. An SRN is
    normally fulfilled *after* the receipt's own quantity has been racked — gating
    on the parent would freeze every SRN the moment its RN was racked and break the
    ordinary shortfall workflow.
    """
    # A UnitOfWork's `.racking_notes` is a real repository object with `.exists`.
    # A raw Motor database's `.racking_notes` is a collection whose `__getattr__`
    # returns a (sub-)collection accessor for *any* name, including "exists" — so
    # `hasattr`/attribute presence can't tell the two apart. An explicit type
    # check can.
    from services.unit_of_work import UnitOfWork
    if isinstance(uow_or_db, UnitOfWork):
        return await uow_or_db.racking_notes.exists(
            {"source_type": source_type, "source_id": source_id, "status": "RECORDED"}
        )
    return await uow_or_db.racking_notes.find_one(
        {"source_type": source_type, "source_id": source_id, "status": "RECORDED"}, {"_id": 1}
    ) is not None


async def assert_note_unracked(uow_or_db, source_type: str, source_id: str,
                               note_no: str, action: str) -> None:
    """Gate SRN/ERN mutation on 'nothing racked from this note yet'.

    This replaces the old 'terminal status is final' rule: a decision or a
    fulfilment stays revisable right up until it becomes physical stock, which is
    the same 'mutable until stock actually moves' philosophy the Receipt Note uses.
    """
    if await note_has_recorded_racking(uow_or_db, source_type, source_id):
        raise HTTPException(
            status_code=409,
            detail=(f"Cannot {action} — stock has already been racked against "
                    f"{note_no or 'this note'}. Reverse that racking note first."),
        )


async def assert_rn_mutable(uow, rn_id: str, action: str) -> None:
    """Block edits/deletes only once stock has genuinely moved.

    A racking note in DRAFT holds no stock, so its mere existence must not freeze
    the parent Receipt Note.
    """
    if await uow.racking_notes.any_recorded_for_rn(rn_id):
        raise HTTPException(
            status_code=409,
            detail=(f"Cannot {action} — stock has already been recorded against this receipt note. "
                    f"Reverse the recorded racking note first."),
        )


# ----------------------------------------------------------------------------
# Child re-synchronization after a Receipt Note edit
# ----------------------------------------------------------------------------
def _is_root(doc: dict, parent_field: str) -> bool:
    """True for a note hanging directly off the RN rather than off a sibling note.

    Only root SRNs/ERNs represent the RN's own shortfall/overage. Chain children
    (an SRN spawned from an ancestor SRN's residual, say) re-slice quantity that a
    root already accounts for, so they must never be double-counted when deciding
    whether the RN's shortfall/overage is already covered.
    """
    return not doc.get(parent_field)


def rn_figures_by_key(items: list) -> dict:
    """Per-part invoice/received figures from the RN, for stamping onto derived rows.

    An SRN/ERN row displays the parent's invoice and received quantities alongside
    its own short/extra figure. Those must track the *edited* Receipt Note, not the
    values captured when the note was first created — otherwise a resynced note
    shows a shortfall computed from numbers it no longer displays.
    """
    out: dict = {}
    for it in items or []:
        k = _key(it.get("part_no"), it.get("make"))
        cur = out.setdefault(k, {"invoice_qty": 0.0, "received_qty": 0.0})
        cur["invoice_qty"] += _f(it.get("invoice_qty"))
        cur["received_qty"] += _f(it.get("received_qty"))
    return out


def _srn_plan(srns: list, shorts: dict, recorded: dict, figures: dict) -> dict:
    """Recompute every SRN under the RN from the new shortfall.

    Returns ``{"update": [...], "delete": [...], "create": [...], "blocked": [...]}``.
    Nothing is written — see ``apply_rn_sync_plan``.
    """
    update, delete, blocked = [], [], []
    covered: dict = {}
    for srn in srns:
        already = recorded.get(srn["id"], {})
        new_items = []
        for it in srn.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            target = shorts.get(k, 0.0)
            done = already.get(k, 0.0)
            if target < done - EPS:
                blocked.append(
                    f"{it.get('part_no')}/{it.get('make')} already has {done:g} qty recorded on "
                    f"{srn.get('srn_no')}, which exceeds the new shortfall of {target:g}. "
                    f"Reverse that racking note first."
                )
                continue
            if target <= EPS:
                continue
            fig = figures.get(k) or {}
            new_items.append({**it, "short_qty": target,
                              "invoice_qty": fig.get("invoice_qty", it.get("invoice_qty")),
                              "received_qty": fig.get("received_qty", it.get("received_qty"))})
        if not new_items:
            delete.append(srn)
            continue
        if _is_root(srn, "parent_srn_id"):
            for it in new_items:
                k = _key(it.get("part_no"), it.get("make"))
                covered[k] = covered.get(k, 0.0) + _f(it.get("short_qty"))
        if new_items != srn.get("items"):
            update.append((srn, new_items))

    # Shortfall the surviving notes do not account for needs a brand-new SRN —
    # this is the "Received drops below Invoice and no SRN exists yet" case.
    create = []
    for k, target in shorts.items():
        gap = target - covered.get(k, 0.0)
        if gap > EPS:
            part_no, make = k.split("||", 1)
            fig = figures.get(k) or {}
            create.append({"part_no": part_no, "make": make, "short_qty": gap,
                           "invoice_qty": fig.get("invoice_qty", 0.0),
                           "received_qty": fig.get("received_qty", 0.0)})
    return {"update": update, "delete": delete, "create": create, "blocked": blocked}


def _ern_plan(erns: list, extras: dict, recorded: dict, figures: dict) -> dict:
    """Recompute every ERN under the RN from the new overage.

    A quantity change on an already-APPROVED/COMPLETE ERN resets it to
    PENDING_APPROVAL — the Store Manager decided on a figure that no longer exists
    and must decide again — and any DRAFT racking note that approval created is
    dropped, because an undecided ERN is never rackable.

    A REJECTED ERN is a terminal decision: its quantity is never rewritten. It
    still counts as covering that much overage, so re-raising Received Qty spills
    only the *delta* into a fresh pending ERN rather than silently reviving a
    rejection.
    """
    update, delete, blocked = [], [], []
    covered: dict = {}
    for ern in erns:
        already = recorded.get(ern["id"], {})
        status = (ern.get("status") or "PENDING_APPROVAL").upper()
        new_items = []
        for it in ern.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            target = extras.get(k, 0.0)
            done = already.get(k, 0.0)
            if target < done - EPS:
                blocked.append(
                    f"{it.get('part_no')}/{it.get('make')} already has {done:g} qty recorded on "
                    f"{ern.get('ern_no')}, which exceeds the new overage of {target:g}. "
                    f"Reverse that racking note first."
                )
                continue
            if target <= EPS:
                continue
            # Re-deciding wipes any prior per-item approve/reject split.
            fig = figures.get(k) or {}
            new_items.append({**it, "extra_qty": target,
                              "invoice_qty": fig.get("invoice_qty", it.get("invoice_qty")),
                              "received_qty": fig.get("received_qty", it.get("received_qty")),
                              "approved_qty": None, "rejected_qty": None})

        if status == "REJECTED":
            # Frozen. Count what it already decided, then leave it exactly as-is.
            for it in ern.get("items", []) or []:
                k = _key(it.get("part_no"), it.get("make"))
                if extras.get(k, 0.0) > EPS:
                    covered[k] = covered.get(k, 0.0) + _f(it.get("extra_qty"))
            if not new_items:
                delete.append(ern)
            continue

        if not new_items:
            delete.append(ern)
            continue

        if _is_root(ern, "parent_ern_id"):
            for it in new_items:
                k = _key(it.get("part_no"), it.get("make"))
                covered[k] = covered.get(k, 0.0) + _f(it.get("extra_qty"))

        qty_changed = [
            {kk: vv for kk, vv in i.items() if kk not in ("approved_qty", "rejected_qty")}
            for i in new_items
        ] != [
            {kk: vv for kk, vv in (i or {}).items() if kk not in ("approved_qty", "rejected_qty")}
            for i in (ern.get("items") or [])
        ]
        reset_approval = qty_changed and status in ("APPROVED", "COMPLETE")
        if qty_changed:
            update.append((ern, new_items, reset_approval))

    create = []
    for k, target in extras.items():
        gap = target - covered.get(k, 0.0)
        if gap > EPS:
            part_no, make = k.split("||", 1)
            fig = figures.get(k) or {}
            create.append({"part_no": part_no, "make": make, "extra_qty": gap,
                           "invoice_qty": fig.get("invoice_qty", 0.0),
                           "received_qty": fig.get("received_qty", 0.0)})
    return {"update": update, "delete": delete, "create": create, "blocked": blocked}


def _rkn_plan(drafts: list, target_by_key: dict, recorded_by_key: dict) -> dict:
    """Recompute DRAFT racking notes against a new per-part quantity ceiling.

    Quantities move in both directions. Shrinking clamps rows down (and deletes a
    note left with nothing to rack); growing raises the *existing* row back up, so
    the warehouse keeps working from the same document with the locations already
    chosen on it. Only a part with no draft row at all falls through to
    ``create_needed``, which the caller satisfies by auto-creating a note with
    properly prefilled locations.

    RECORDED racking is subtracted from the ceiling and never touched — a recorded
    note is history, not work-in-progress.
    """
    update, delete = [], []
    remaining = {k: max(0.0, v - recorded_by_key.get(k, 0.0)) for k, v in target_by_key.items()}
    ordered = sorted(drafts, key=lambda r: (r.get("created_at") or "", r.get("serial") or 0))

    planned: list = []
    for rkn in ordered:
        new_items = []
        for it in rkn.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            budget = remaining.get(k, 0.0)
            if budget <= EPS:
                continue  # part removed, or fully absorbed by an earlier draft
            qty = min(_f(it.get("quantity")), budget)
            if qty <= EPS:
                continue
            remaining[k] = budget - qty
            new_items.append({**it, "quantity": qty})
        planned.append((rkn, new_items))

    # Anything still unallocated is growth. Give it to the first draft row that
    # already covers that part so the original note simply gets bigger.
    for k, leftover in list(remaining.items()):
        if leftover <= EPS:
            continue
        for _rkn, new_items in planned:
            row = next((i for i in new_items if _key(i.get("part_no"), i.get("make")) == k), None)
            if row is not None:
                row["quantity"] = _f(row["quantity"]) + leftover
                remaining[k] = 0.0
                break

    for rkn, new_items in planned:
        if not new_items:
            delete.append(rkn)
        elif new_items != rkn.get("items"):
            update.append((rkn, new_items))

    create_needed = {k: v for k, v in remaining.items() if v > EPS}
    return {"update": update, "delete": delete, "create_needed": create_needed}


async def _recorded_by_note(uow, source_type: str, notes: list) -> dict:
    return {n["id"]: await recorded_qty_by_source(uow, source_type, n["id"]) for n in notes}


async def build_rn_sync_plan(uow, rn: dict, new_items: list, stock_in_type: str) -> dict:
    """Recompute every derived document from the updated Receipt Note.

    Read-only: returns what *would* change, so the same plan can drive both the
    pre-save preview the user confirms and the write that follows. Derived
    quantities are always recomputed from the RN's current figures — never patched
    by the delta — so repeated edits can never drift.
    """
    rn_id = rn["id"]
    shorts, extras = short_extra_from_items(new_items, stock_in_type)
    rackable = rackable_from_rn_items(new_items)

    srns = await uow.srn.for_parent_rn(rn_id)
    erns = await uow.ern.for_parent_rn(rn_id)
    drafts = await uow.racking_notes.for_source("RN", rn_id, status="DRAFT")
    recorded_rn = await recorded_qty_by_source(uow, "RN", rn_id)

    figures = rn_figures_by_key(new_items)
    srn = _srn_plan(srns, shorts, await _recorded_by_note(uow, "SRN", srns), figures)
    ern = _ern_plan(erns, extras, await _recorded_by_note(uow, "ERN", erns), figures)
    rkn = _rkn_plan(drafts, rackable, recorded_rn)

    # An ERN whose approval is being revoked loses the racking note that approval
    # created — an undecided extra quantity is not warehouse work.
    ern["revoke_rkns_for"] = [e["id"] for e, _i, reset in ern["update"] if reset] + \
                             [e["id"] for e in ern["delete"]]

    return {
        "shorts": shorts, "extras": extras, "rackable": rackable,
        "srn": srn, "ern": ern, "rkn": rkn,
        "blocked": srn["blocked"] + ern["blocked"],
    }


def assert_plan_not_blocked(plan: dict) -> None:
    if plan.get("blocked"):
        raise HTTPException(status_code=409, detail="Cannot edit — " + " ".join(plan["blocked"]))


async def clamp_note_rkns_to_ceiling(uow, source_type: str, source_id: str,
                                     ceiling_by_key: dict, actor: dict, note_no: str = "") -> list:
    """Shrink DRAFT racking notes sourced from an SRN/ERN down to a new per-part
    ceiling, deleting a note left with nothing to rack.

    Used when a user directly lowers an SRN's fulfilled_qty or an ERN's decided
    split — the note stays editable until stock is actually racked (see
    ``assert_note_unracked``), but a DRAFT racking note holding more than the note
    now claims must shrink with it rather than silently overstating the pending
    work. Growth is handled separately by ``_auto_create_rkn_for_source``, which
    already creates a fresh note (with properly prefilled locations) for however
    much is newly pending — so only the shrink direction is needed here.
    """
    drafts = await uow.racking_notes.for_source(source_type, source_id, status="DRAFT")
    if not drafts:
        return []
    recorded = await recorded_qty_by_source(uow, source_type, source_id)
    plan = _rkn_plan(drafts, ceiling_by_key, recorded)
    touched = []
    for rkn in plan["delete"]:
        await uow.racking_notes.delete(rkn["id"])
        await uow.audit.record(action="racking_note.auto_deleted", actor=actor,
                               ref_collection="racking_notes", ref_id=rkn["id"],
                               old={"rkn_no": rkn.get("rkn_no"), "items": rkn.get("items")}, new=None,
                               reason=f"{note_no or source_type} edited; nothing left to rack",
                               links={"source_type": source_type, "source_id": source_id})
        touched.append(("deleted", rkn.get("rkn_no")))
    for rkn, new_items in plan["update"]:
        await uow.racking_notes.set_fields(rkn["id"], {"items": new_items, "updated_at": now_iso()})
        await uow.audit.record(action="racking_note.resynced", actor=actor,
                               ref_collection="racking_notes", ref_id=rkn["id"],
                               old={"items": rkn.get("items")}, new={"items": new_items},
                               reason=f"{note_no or source_type} edited; quantities reduced",
                               links={"source_type": source_type, "source_id": source_id})
        touched.append(("resynced", rkn.get("rkn_no")))
    return touched


async def apply_rn_sync_plan(uow, rn: dict, plan: dict, actor: dict) -> dict:
    """Execute a plan from ``build_rn_sync_plan`` inside the caller's transaction.

    Returns ``{"srn": [...], "ern": [...], "racking": [...], "auto_rkn_needed": bool}``.
    ``auto_rkn_needed`` tells the route to auto-create a racking note once the
    transaction has committed, since that path prefills locations from live stock
    and must read committed data.
    """
    from helpers.auto_create import _auto_create_srn_for_rn, _auto_create_ern_for_rn

    assert_plan_not_blocked(plan)
    rn_id = rn["id"]
    touched = {"srn": [], "ern": [], "racking": []}

    # ---- Short Received Notes ----
    for srn in plan["srn"]["delete"]:
        await uow.srn.delete(srn["id"])
        await uow.audit.record(action="srn.auto_deleted", actor=actor,
                               ref_collection="short_received_notes", ref_id=srn["id"],
                               old={"srn_no": srn.get("srn_no"), "items": srn.get("items")}, new=None,
                               reason="Parent receipt note edited; shortfall no longer exists",
                               links={"receipt_note_id": rn_id})
        touched["srn"].append(("deleted", srn.get("srn_no")))
    for srn, new_items in plan["srn"]["update"]:
        await uow.srn.set_fields(srn["id"], {"items": new_items, "updated_at": now_iso()})
        await uow.audit.record(action="srn.resynced", actor=actor,
                               ref_collection="short_received_notes", ref_id=srn["id"],
                               old={"items": srn.get("items")}, new={"items": new_items},
                               reason="Parent receipt note quantities edited",
                               links={"receipt_note_id": rn_id})
        touched["srn"].append(("resynced", srn.get("srn_no")))
    if plan["srn"]["create"]:
        srn_no = await _auto_create_srn_for_rn(rn, plan["srn"]["create"], actor, uow=uow)
        await uow.audit.record(action="srn.auto_created", actor=actor,
                               ref_collection="short_received_notes", ref_id=srn_no,
                               old=None, new={"items": plan["srn"]["create"]},
                               reason="Parent receipt note edited; received qty fell below invoice qty",
                               links={"receipt_note_id": rn_id, "rn_no": rn.get("rn_no")})
        touched["srn"].append(("created", srn_no))

    # ---- Extra Received Notes ----
    for ern in plan["ern"]["delete"]:
        await uow.ern.delete(ern["id"])
        await uow.audit.record(action="ern.auto_deleted", actor=actor,
                               ref_collection="extra_received_notes", ref_id=ern["id"],
                               old={"ern_no": ern.get("ern_no"), "items": ern.get("items")}, new=None,
                               reason="Parent receipt note edited; overage no longer exists",
                               links={"receipt_note_id": rn_id})
        touched["ern"].append(("deleted", ern.get("ern_no")))
    for ern, new_items, reset_approval in plan["ern"]["update"]:
        update = {"items": new_items, "updated_at": now_iso()}
        if reset_approval:
            update.update({"status": "PENDING_APPROVAL", "decided_at": None, "decided_by": None})
        await uow.ern.set_fields(ern["id"], update)
        await uow.audit.record(action="ern.resynced", actor=actor,
                               ref_collection="extra_received_notes", ref_id=ern["id"],
                               old={"items": ern.get("items"), "status": ern.get("status")},
                               new={"items": new_items, "status": update.get("status", ern.get("status"))},
                               reason=("Parent receipt note edited; extra quantity changed, re-approval required"
                                       if reset_approval else "Parent receipt note quantities edited"),
                               links={"receipt_note_id": rn_id})
        touched["ern"].append(("resynced", ern.get("ern_no")))
    if plan["ern"]["create"]:
        ern_no = await _auto_create_ern_for_rn(rn, plan["ern"]["create"], actor, uow=uow)
        await uow.audit.record(action="ern.auto_created", actor=actor,
                               ref_collection="extra_received_notes", ref_id=ern_no,
                               old=None, new={"items": plan["ern"]["create"]},
                               reason="Parent receipt note edited; received qty rose above invoice qty",
                               links={"receipt_note_id": rn_id, "rn_no": rn.get("rn_no")})
        touched["ern"].append(("created", ern_no))

    # ---- Racking notes an ERN's revoked approval no longer justifies ----
    for ern_id in plan["ern"].get("revoke_rkns_for", []):
        for rkn in await uow.racking_notes.for_source("ERN", ern_id, status="DRAFT"):
            await uow.racking_notes.delete(rkn["id"])
            await uow.audit.record(action="racking_note.auto_deleted", actor=actor,
                                   ref_collection="racking_notes", ref_id=rkn["id"],
                                   old={"rkn_no": rkn.get("rkn_no"), "items": rkn.get("items")}, new=None,
                                   reason="Parent receipt note edited; the ERN approval behind this racking note was revoked",
                                   links={"receipt_note_id": rn_id, "ern_id": ern_id})
            touched["racking"].append(("deleted", rkn.get("rkn_no")))

    # ---- Racking notes sourced directly from the RN ----
    for rkn in plan["rkn"]["delete"]:
        await uow.racking_notes.delete(rkn["id"])
        await uow.audit.record(action="racking_note.auto_deleted", actor=actor,
                               ref_collection="racking_notes", ref_id=rkn["id"],
                               old={"rkn_no": rkn.get("rkn_no"), "items": rkn.get("items")}, new=None,
                               reason="Parent receipt note edited; nothing left to rack",
                               links={"receipt_note_id": rn_id})
        touched["racking"].append(("deleted", rkn.get("rkn_no")))
    for rkn, new_items in plan["rkn"]["update"]:
        await uow.racking_notes.set_fields(rkn["id"], {"items": new_items, "updated_at": now_iso()})
        await uow.audit.record(action="racking_note.resynced", actor=actor,
                               ref_collection="racking_notes", ref_id=rkn["id"],
                               old={"items": rkn.get("items")}, new={"items": new_items},
                               reason="Parent receipt note quantities edited",
                               links={"receipt_note_id": rn_id})
        touched["racking"].append(("resynced", rkn.get("rkn_no")))

    touched["auto_rkn_needed"] = bool(plan["rkn"]["create_needed"])
    return touched


async def synchronize_children_after_rn_edit(uow, rn: dict, new_items: list,
                                             stock_in_type: str, actor: dict) -> dict:
    """Propagate a Receipt Note edit to every derived document."""
    plan = await build_rn_sync_plan(uow, rn, new_items, stock_in_type)
    return await apply_rn_sync_plan(uow, rn, plan, actor)


# ----------------------------------------------------------------------------
# Cascade delete
# ----------------------------------------------------------------------------
async def cascade_delete_rn(uow, rn: dict, actor: dict, reason: str = "") -> dict:
    """Delete an RN and every pending artifact derived from it — no orphans.

    Only reachable when no racking note has been RECORDED (enforced by
    ``assert_rn_mutable``), so nothing here can strand recorded stock.
    """
    rn_id = rn["id"]
    removed = {"racking_notes": [], "srn": [], "ern": []}

    for srn in await uow.srn.for_parent_rn(rn_id):
        decided = sum((await recorded_qty_by_source(uow, "SRN", srn["id"])).values())
        if decided > EPS:
            raise HTTPException(
                status_code=409,
                detail=(f"Cannot delete — {srn.get('srn_no')} already has {decided:g} qty recorded. "
                        f"Reverse that racking note first."),
            )
        removed["srn"].append(srn.get("srn_no"))

    for ern in await uow.ern.for_parent_rn(rn_id):
        decided = sum((await recorded_qty_by_source(uow, "ERN", ern["id"])).values())
        if decided > EPS:
            raise HTTPException(
                status_code=409,
                detail=(f"Cannot delete — {ern.get('ern_no')} already has {decided:g} qty recorded. "
                        f"Reverse that racking note first."),
            )
        removed["ern"].append(ern.get("ern_no"))

    for rkn in await uow.racking_notes.for_ultimate_rn(rn_id):
        if rkn.get("status") == "RECORDED":  # defensive; gate should have caught this
            raise HTTPException(status_code=409,
                                detail=f"Cannot delete — {rkn.get('rkn_no')} is already recorded.")
        removed["racking_notes"].append(rkn.get("rkn_no"))

    await uow.racking_notes.delete_many({"receipt_note_id": rn_id})
    await uow.srn.delete_many({"parent_rn_id": rn_id})
    await uow.ern.delete_many({"parent_rn_id": rn_id})
    await uow.receipt_notes.delete(rn_id)

    await uow.audit.record(
        action="receipt_note.deleted", actor=actor,
        ref_collection="receipt_notes", ref_id=rn_id,
        old={"rn_no": rn.get("rn_no"), "status": rn.get("status"), "items": rn.get("items")},
        new=None,
        reason=reason or "Receipt note deleted before any stock was recorded",
        links={"cascade_removed": removed},
    )
    return removed


# ----------------------------------------------------------------------------
# Racking note recording (the only operation that creates stock)
# ----------------------------------------------------------------------------
async def build_stock_in_transactions(uow, rkn: dict, items: list, src_type: str,
                                      src_id: str, actor: dict, now: str) -> list:
    """Build the IN ledger rows for a racking note.

    Transaction ids are deterministic (``<rkn_id>:stock-in:<idx>``) so a duplicate
    record attempt collides on the unique index instead of double-counting stock.
    """
    tx_docs = []
    for idx, it in enumerate(items):
        master = await uow.db.stock_master.find_one(
            {"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}, session=uow.session
        ) or {}
        tx_docs.append({
            "id": f"{rkn['id']}:stock-in:{idx}",
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
            "created_by": (actor or {}).get("email"),
        })
    return tx_docs
