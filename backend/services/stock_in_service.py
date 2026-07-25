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


def srn_decided_by_key(srn: dict) -> dict:
    """Quantity already committed on an SRN (received + written off) per part."""
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
    """Quantity already accepted or rejected on an ERN per part."""
    out: dict = {}
    for it in ern.get("items", []) or []:
        k = _key(it.get("part_no"), it.get("make"))
        decided = sum(_f(c.get("accepted_qty")) + _f(c.get("rejected_qty"))
                      for c in (it.get("children") or []))
        if decided <= 0:
            decided = _f(it.get("accepted_qty")) + _f(it.get("rejected_qty"))
        out[k] = out.get(k, 0) + decided
    return out


# ----------------------------------------------------------------------------
# Mutability
# ----------------------------------------------------------------------------
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
async def resync_srn_for_rn(uow, rn_id: str, shorts: dict, actor: dict) -> list:
    """Align every SRN under an RN with the RN's new shortfall.

    Refuses to shrink a shortfall below what has already been received or written
    off — that would strand committed quantity and is exactly the "cannot receive
    more than pending" integrity rule inverted.
    """
    touched = []
    for srn in await uow.srn.for_parent_rn(rn_id):
        decided = srn_decided_by_key(srn)
        new_items, removed = [], []
        for it in srn.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            target = shorts.get(k, 0.0)
            already = decided.get(k, 0.0)
            if target < already - EPS:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Cannot edit — {it.get('part_no')}/{it.get('make')} already has "
                            f"{already:g} qty decided on {srn.get('srn_no')}, which exceeds the new "
                            f"shortfall of {target:g}. Reverse those deliveries first."),
                )
            if target <= EPS:
                removed.append(it)
                continue
            new_items.append({**it, "short_qty": target,
                              "invoice_qty": it.get("invoice_qty"), "received_qty": it.get("received_qty")})
        if not new_items:
            await uow.srn.delete(srn["id"])
            await uow.audit.record(action="srn.auto_deleted", actor=actor,
                                   ref_collection="short_received_notes", ref_id=srn["id"],
                                   old={"srn_no": srn.get("srn_no"), "items": srn.get("items")}, new=None,
                                   reason="Parent receipt note edited; shortfall no longer exists",
                                   links={"receipt_note_id": rn_id})
            touched.append(("deleted", srn.get("srn_no")))
            continue
        if new_items != srn.get("items"):
            await uow.srn.set_fields(srn["id"], {"items": new_items, "updated_at": now_iso()})
            await uow.audit.record(action="srn.resynced", actor=actor,
                                   ref_collection="short_received_notes", ref_id=srn["id"],
                                   old={"items": srn.get("items")}, new={"items": new_items},
                                   reason="Parent receipt note quantities edited",
                                   links={"receipt_note_id": rn_id})
            touched.append(("resynced", srn.get("srn_no")))
    return touched


async def resync_ern_for_rn(uow, rn_id: str, extras: dict, actor: dict) -> list:
    """Align every ERN under an RN with the RN's new overage."""
    touched = []
    for ern in await uow.ern.for_parent_rn(rn_id):
        decided = ern_decided_by_key(ern)
        new_items = []
        for it in ern.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            target = extras.get(k, 0.0)
            already = decided.get(k, 0.0)
            if target < already - EPS:
                raise HTTPException(
                    status_code=409,
                    detail=(f"Cannot edit — {it.get('part_no')}/{it.get('make')} already has "
                            f"{already:g} qty accepted/rejected on {ern.get('ern_no')}, which exceeds the "
                            f"new overage of {target:g}. Reverse those decisions first."),
                )
            if target <= EPS:
                continue
            new_items.append({**it, "extra_qty": target})
        if not new_items:
            await uow.ern.delete(ern["id"])
            await uow.audit.record(action="ern.auto_deleted", actor=actor,
                                   ref_collection="extra_received_notes", ref_id=ern["id"],
                                   old={"ern_no": ern.get("ern_no"), "items": ern.get("items")}, new=None,
                                   reason="Parent receipt note edited; overage no longer exists",
                                   links={"receipt_note_id": rn_id})
            touched.append(("deleted", ern.get("ern_no")))
            continue
        if new_items != ern.get("items"):
            await uow.ern.set_fields(ern["id"], {"items": new_items, "updated_at": now_iso()})
            await uow.audit.record(action="ern.resynced", actor=actor,
                                   ref_collection="extra_received_notes", ref_id=ern["id"],
                                   old={"items": ern.get("items")}, new={"items": new_items},
                                   reason="Parent receipt note quantities edited",
                                   links={"receipt_note_id": rn_id})
            touched.append(("resynced", ern.get("ern_no")))
    return touched


async def resync_draft_rkns_for_rn(uow, rn_id: str, rackable: dict, actor: dict) -> list:
    """Clamp DRAFT racking notes sourced from the RN to the new rackable quantity.

    Location assignments the user already made are preserved; only quantities are
    adjusted, rows for parts no longer on the RN are dropped, and a racking note
    left with no rows is removed so no empty artifact is stranded.
    """
    touched = []
    remaining = dict(rackable)
    drafts = await uow.racking_notes.for_source("RN", rn_id, status="DRAFT")
    for rkn in drafts:
        new_items = []
        for it in rkn.get("items", []) or []:
            k = _key(it.get("part_no"), it.get("make"))
            budget = remaining.get(k, 0.0)
            if budget <= EPS:
                continue  # part removed from RN, or fully covered by an earlier draft
            qty = min(_f(it.get("quantity")), budget)
            if qty <= EPS:
                continue
            remaining[k] = budget - qty
            new_items.append({**it, "quantity": qty})
        if not new_items:
            await uow.racking_notes.delete(rkn["id"])
            await uow.audit.record(action="racking_note.auto_deleted", actor=actor,
                                   ref_collection="racking_notes", ref_id=rkn["id"],
                                   old={"rkn_no": rkn.get("rkn_no"), "items": rkn.get("items")}, new=None,
                                   reason="Parent receipt note edited; nothing left to rack",
                                   links={"receipt_note_id": rn_id})
            touched.append(("deleted", rkn.get("rkn_no")))
            continue
        if new_items != rkn.get("items"):
            await uow.racking_notes.set_fields(rkn["id"], {"items": new_items, "updated_at": now_iso()})
            await uow.audit.record(action="racking_note.resynced", actor=actor,
                                   ref_collection="racking_notes", ref_id=rkn["id"],
                                   old={"items": rkn.get("items")}, new={"items": new_items},
                                   reason="Parent receipt note quantities edited",
                                   links={"receipt_note_id": rn_id})
            touched.append(("resynced", rkn.get("rkn_no")))
    return touched


async def synchronize_children_after_rn_edit(uow, rn: dict, new_items: list,
                                             stock_in_type: str, actor: dict) -> dict:
    """Propagate a Receipt Note edit to every derived document."""
    shorts, extras = short_extra_from_items(new_items, stock_in_type)
    rackable = rackable_from_rn_items(new_items)
    rn_id = rn["id"]
    return {
        "srn": await resync_srn_for_rn(uow, rn_id, shorts, actor),
        "ern": await resync_ern_for_rn(uow, rn_id, extras, actor),
        "racking": await resync_draft_rkns_for_rn(uow, rn_id, rackable, actor),
    }


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
        decided = sum(srn_decided_by_key(srn).values())
        if decided > EPS:
            raise HTTPException(
                status_code=409,
                detail=(f"Cannot delete — {srn.get('srn_no')} already has {decided:g} qty received or "
                        f"written off. Reverse those deliveries first."),
            )
        removed["srn"].append(srn.get("srn_no"))

    for ern in await uow.ern.for_parent_rn(rn_id):
        decided = sum(ern_decided_by_key(ern).values())
        if decided > EPS:
            raise HTTPException(
                status_code=409,
                detail=(f"Cannot delete — {ern.get('ern_no')} already has {decided:g} qty accepted or "
                        f"rejected. Reverse those decisions first."),
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
