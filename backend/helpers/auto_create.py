import uuid
from datetime import datetime, timezone
from typing import Optional
from pymongo.errors import DuplicateKeyError
from fastapi import HTTPException
from deps import db, logger, now_iso
from helpers.note_helpers import current_fy_label, note_date_key_from_iso, _next_serial, _linked_note_no
from helpers.stock_helpers import _enrich_items


def _session_of(uow) -> Optional[object]:
    """Mongo session backing a unit of work, or None when called outside one.

    Every auto-create helper below accepts an optional `uow` so it can be reused
    from inside a caller's transaction (the Receipt Note edit resync) as well as
    standalone (finalize, ERN approval). When a uow is supplied all reads and
    writes join its session and commit/roll back with the rest of the edit.
    """
    return getattr(uow, "session", None) if uow is not None else None


async def _build_master_snapshot(part_no: str, make: str, session=None) -> dict:
    """Pull denormalized master fields for an SRN/ERN item row."""
    sm = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}, session=session) or {}
    return {
        "model": sm.get("model", ""),
        "old_part_no": sm.get("old_part_no", ""),
        "make_part_no": sm.get("make_part_no", ""),
        "description_1": sm.get("description_1", ""),
        "description_2": sm.get("description_2", ""),
        "remarks_oem": sm.get("remarks_oem", ""),
        "remarks_others": sm.get("remarks_others", ""),
        "item_category": sm.get("item_category", ""),
    }


async def _auto_create_srn_for_rn(rn: dict, short_rows: list, actor: dict, parent_srn: dict = None,
                                  uow=None) -> str:
    """Create a PENDING Short Received Note for the given short rows.

    If `parent_srn` is provided, this is a CHILD SRN auto-created from the residual
    shortfall of an ancestor SRN whose user-entered fulfilled_qty was less than its
    short_qty. The chain links back to the original parent RN through parent_rn_id.

    Items consolidate duplicates by (part_no, make) so racking sees one row per pair.
    """
    session = _session_of(uow)
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    rn_date_key = note_date_key_from_iso(rn.get("rn_date", ""))
    for _ in range(5):
        serial = await _next_serial("short_received_notes", session=session)
        srn_no = await _linked_note_no(
            "short_received_notes", "srn_no", "parent_rn_id", rn["id"],
            "SRN", rn_date_key, rn.get("serial", 0), session=session,
        )
        # Consolidate duplicates — sum short_qty for the same (part_no, make).
        merged = {}
        for r in short_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            sh_q  = float(r.get("short_qty") or 0)
            if key in merged:
                merged[key]["short_qty"]  += sh_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "short_qty": sh_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"], session=session)
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "short_qty": m["short_qty"],
                "fulfilled_qty": None,
                "quantity": None,
                **snap,
            })
        if parent_srn:
            chain = f"Auto-generated from {parent_srn['srn_no']} — residual shortfall on {len(items)} item(s)."
            parent_srn_id = parent_srn["id"]
            parent_srn_no = parent_srn["srn_no"]
        else:
            chain = f"Auto-generated from {rn['rn_no']} — short on {len(items)} item(s)."
            parent_srn_id = None
            parent_srn_no = ""
        doc = {
            "id": str(uuid.uuid4()),
            "srn_no": srn_no, "srn_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_stock_in_type": rn.get("stock_in_type", ""),
            "parent_srn_id": parent_srn_id,
            "parent_srn_no": parent_srn_no,
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "fulfillment_date": "",
            "items": items,
            "status": "PENDING",
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.short_received_notes.insert_one(doc, session=session)
            # Track child SRN reference on each parent item that contributed residual.
            if parent_srn:
                child_keys = {(it["part_no"], it["make"]): float(it.get("short_qty") or 0) for it in items}
                new_parent_items = []
                for p_it in parent_srn.get("items", []):
                    new_p = dict(p_it)
                    k = (p_it.get("part_no"), p_it.get("make"))
                    if k in child_keys:
                        children = list(new_p.get("children") or [])
                        children.append({
                            "child_srn_id": doc["id"],
                            "child_srn_no": srn_no,
                            "short_qty": child_keys[k],
                            "created_at": doc["created_at"],
                        })
                        new_p["children"] = children
                    new_parent_items.append(new_p)
                await db.short_received_notes.update_one(
                    {"id": parent_srn["id"]}, {"$set": {"items": new_parent_items}}, session=session
                )
            return srn_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate SRN number after 5 attempts")
    return ""


async def _auto_create_ern_for_rn(rn: dict, extra_rows: list, actor: dict, uow=None) -> str:
    """Create a PENDING_APPROVAL Extra Received Note for the given overage rows.

    Awaits a single whole-note approve/reject decision (see the ERN approve/reject
    routes) — no per-row acceptance and no residual chaining. Items consolidate
    duplicates by (part_no, make).
    """
    session = _session_of(uow)
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    rn_date_key = note_date_key_from_iso(rn.get("rn_date", ""))
    for _ in range(5):
        serial = await _next_serial("extra_received_notes", session=session)
        ern_no = await _linked_note_no(
            "extra_received_notes", "ern_no", "parent_rn_id", rn["id"],
            "ERN", rn_date_key, rn.get("serial", 0), session=session,
        )
        merged = {}
        for r in extra_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            ex_q  = float(r.get("extra_qty") or 0)
            if key in merged:
                merged[key]["extra_qty"]   += ex_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "extra_qty": ex_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"], session=session)
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "extra_qty": m["extra_qty"],
                "approved_qty": None,
                "rejected_qty": None,
                **snap,
            })
        chain = f"Auto-generated from {rn['rn_no']} — extra on {len(items)} item(s)."
        doc = {
            "id": str(uuid.uuid4()),
            "ern_no": ern_no, "ern_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_stock_in_type": rn.get("stock_in_type", ""),
            "parent_ern_id": None,
            "parent_ern_no": "",
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "goods_received_date": rn.get("goods_received_date", ""),
            "items": items,
            "status": "PENDING_APPROVAL",
            "decided_at": None,
            "decided_by": None,
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.extra_received_notes.insert_one(doc, session=session)
            return ern_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate ERN number after 5 attempts")
    return ""


# --- Auto-create RKN against any source (RN | SRN | ERN) --------------------
async def _auto_create_rkn_for_source(
    source_type: str,
    source_id: str,
    actor: dict,
    *,
    auto_source: str,
) -> Optional[str]:
    """Auto-create a DRAFT Racking Note for whatever rackable qty is still pending
    against (source_type, source_id). Returns the new rkn_no, or None when there's
    nothing to rack (avoids creating empty RKNs).

    Reuses the same prepare-rackable logic so qty + locations exactly match what the
    user would have seen in /racking-notes/prepare-source. Inherits assignee from the
    source's parent doc so the workflow keeps the same owner.

    `auto_source` is a free-form tag persisted on the doc:
        "rn-finalize" | "rkn-record-balance" | "srn-child-save" | "ern-child-save"
    """
    source_type = (source_type or "").upper()
    if source_type not in ("RN", "SRN", "ERN"):
        return None

    # Resolve the parent doc + ultimate RN (re-uses existing helper, avoids drift)
    try:
        from routes.stock_in import _resolve_racking_source
        _, _, parent_doc, ultimate_rn = await _resolve_racking_source(
            {"source_type": source_type, "source_id": source_id}
        )
    except HTTPException:
        return None

    # Use the existing prepare logic to compute pending qty + prefilled locations.
    # Pass user=actor; prepare_racking_for_source ignores user (it's only there for
    # the FastAPI dependency contract).
    try:
        from routes.stock_in import prepare_racking_for_source
        prepared = await prepare_racking_for_source(
            source_type=source_type,
            source_id=source_id,
            exclude_rkn_id=None,
            user=actor,
        )
    except HTTPException as e:
        # 409 if source is already FULLY_RACKED — nothing to do
        if e.status_code == 409:
            return None
        raise
    items = prepared.get("items") or []
    if not items:
        return None

    # Strip helper-only fields the model doesn't accept
    rkn_items = []
    for it in items:
        rkn_items.append({
            "part_no": it.get("part_no", ""),
            "make":    it.get("make", ""),
            "quantity": float(it.get("pending_qty") or 0),
            "model":          it.get("model", ""),
            "old_part_no":    it.get("old_part_no", ""),
            "make_part_no":   it.get("make_part_no", ""),
            "description_1":  it.get("description_1", ""),
            "description_2":  it.get("description_2", ""),
            "remarks_oem":    it.get("remarks_oem", ""),
            "remarks_others": it.get("remarks_others", ""),
            "item_category":  it.get("item_category", ""),
            "godown_id":   it.get("godown_id", ""),
            "godown_name": it.get("godown_name", ""),
            "rack_id":     it.get("rack_id", ""),
            "rack_no":     it.get("rack_no", ""),
            "box_id":      it.get("box_id", ""),
            "box_no":      it.get("box_no", ""),
            "box_category":it.get("box_category", ""),
        })
    rkn_items = [it for it in rkn_items if it["quantity"] > 0]
    if not rkn_items:
        return None

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    # Display strings for the source
    if source_type == "RN":
        source_no = parent_doc.get("rn_no", "")
        source_date = parent_doc.get("rn_date", "")
    elif source_type == "SRN":
        source_no = parent_doc.get("srn_no", "")
        source_date = parent_doc.get("srn_date", "")
    else:  # ERN
        source_no = parent_doc.get("ern_no", "")
        source_date = parent_doc.get("ern_date", "")

    ult_rn_id = (ultimate_rn or {}).get("id", "")
    ult_rn_no = (ultimate_rn or {}).get("rn_no", "")
    ult_rn_date = (ultimate_rn or {}).get("rn_date", "")
    ult_rn_date_key = note_date_key_from_iso(ult_rn_date)
    ult_rn_serial = (ultimate_rn or {}).get("serial", 0)

    last_err = None
    for _ in range(5):
        serial = await _next_serial("racking_notes")
        rkn_no = await _linked_note_no(
            "racking_notes", "rkn_no", "receipt_note_id", ult_rn_id,
            "RKN", ult_rn_date_key, ult_rn_serial,
        )
        doc = {
            "id": str(uuid.uuid4()),
            "rkn_no": rkn_no,
            "rkn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "source_type": source_type,
            "source_id": source_id,
            "source_no": source_no,
            "source_date": source_date,
            "receipt_note_id": ult_rn_id,
            "receipt_note_no": ult_rn_no,
            "receipt_note_date": ult_rn_date,
            "items": rkn_items,
            "status": "DRAFT",
            "auto_created": True,
            "auto_source": auto_source,
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
        }
        try:
            await db.racking_notes.insert_one(doc)
            from helpers.status_helpers import _recompute_source_status_after_rkn
            await _recompute_source_status_after_rkn(source_type, source_id, ult_rn_id)
            return rkn_no
        except DuplicateKeyError as e:
            last_err = e
            continue
    logger.warning(f"Could not allocate auto-RKN number after 5 attempts: {last_err}")
    return None
