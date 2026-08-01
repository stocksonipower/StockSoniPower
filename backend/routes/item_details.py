"""Item Details routes — extracted from server.py with zero logic changes."""
import re
from fastapi import APIRouter, Depends, HTTPException, Query

from deps import db, get_current_user
from helpers.stock_helpers import _stock_locations_for
from helpers.note_helpers import _key as _pm_key
from services.stock_in_service import srn_decided_by_key, ern_decided_by_key

router = APIRouter()


def _pending_qty(notes, decided_fn, qty_field):
    """Sum of `qty_field` still undecided across a list of SRN/ERN docs.

    Mirrors the children-first / flat-fallback "decided" logic used by the
    Stock In workflow itself (srn_decided_by_key / ern_decided_by_key) so this
    matches whatever the SRN/ERN screens consider fulfilled, instead of the
    naive (and frequently wrong once child rows are involved) `short_qty -
    fulfilled_qty` subtraction.
    """
    total_pending = 0.0
    for r in notes:
        decided_map = decided_fn(r)
        raw_by_key = {}
        for it in r.get("items", []):
            k = _pm_key(it.get("part_no"), it.get("make"))
            raw_by_key[k] = raw_by_key.get(k, 0.0) + float(it.get(qty_field) or 0)
        for k, raw in raw_by_key.items():
            total_pending += max(0.0, raw - decided_map.get(k, 0.0))
    return total_pending


def _rn_received_qty(receipt_notes, extra_received_notes):
    """Physically received qty booked against the invoice, across finalized RNs.

    Two rules the raw `received_qty` field does not encode on its own:
      * DRAFT receipt notes are not a business fact yet, so they contribute 0.
      * On an over-receipt the surplus is split off into an ERN and reported
        under Extra until it is accepted/rejected, so it must not also be counted
        here — that would report the same physical units twice.

    The surplus is deducted using the ERN actually raised for that RN rather than
    by capping at invoice_qty. Both give the same answer on the normal workflow,
    but editing an already-finalized RN upward does not raise an ERN, and a blind
    cap would silently drop those units from every total instead of showing them.
    """
    surplus = {}
    for e in extra_received_notes:
        if e.get("parent_ern_id"):
            continue  # child ERN — its qty is already carried by the parent row
        rn_id = e.get("parent_rn_id")
        if not rn_id:
            continue
        for it in e.get("items", []):
            k = (rn_id, _pm_key(it.get("part_no"), it.get("make")))
            surplus[k] = surplus.get(k, 0.0) + float(it.get("extra_qty") or 0)

    total = 0.0
    for r in receipt_notes:
        if (r.get("status") or "").upper() == "DRAFT":
            continue
        for it in r.get("items", []):
            rec = float(it.get("received_qty") or 0)
            k = (r.get("id"), _pm_key(it.get("part_no"), it.get("make")))
            total += max(0.0, rec - surplus.get(k, 0.0))
    return total


def _srn_received_qty(short_received_notes):
    """Qty physically delivered later against short notes.

    Only the `received_qty` half of each child row counts — `not_receivable_qty`
    is a write-off that closes the shortfall without any material arriving.
    Falls back to the legacy flat `fulfilled_qty` when a note has no child rows.
    """
    total = 0.0
    for r in short_received_notes:
        for it in r.get("items", []):
            children = it.get("children") or []
            if children:
                total += sum(float(c.get("received_qty") or 0) for c in children)
            else:
                total += float(it.get("fulfilled_qty") or 0)
    return total


@router.get("/item-details/search")
async def item_details_search(q: str = Query("", min_length=0, max_length=64),
                              limit: int = Query(20, ge=1, le=50),
                              user=Depends(get_current_user)):
    """Autocomplete: top `limit` (part_no, make) combos that match q (case-insensitive).
    Searches across model, part_no, old_part_no, new_part_no, make_part_no,
    description_1, description_2, remarks_oem, remarks_others, make, item_category."""
    qs = (q or "").strip()
    flt = {}
    if qs:
        escaped = re.escape(qs)
        flt = {"$or": [
            # `model` is shown as the first column of every suggestion row, so it
            # has to be searchable too — it was missing from this list.
            {"model": {"$regex": escaped, "$options": "i"}},
            {"part_no": {"$regex": escaped, "$options": "i"}},
            {"old_part_no": {"$regex": escaped, "$options": "i"}},
            {"new_part_no": {"$regex": escaped, "$options": "i"}},
            {"make_part_no": {"$regex": escaped, "$options": "i"}},
            {"description_1": {"$regex": escaped, "$options": "i"}},
            {"description_2": {"$regex": escaped, "$options": "i"}},
            {"remarks_oem": {"$regex": escaped, "$options": "i"}},
            {"remarks_others": {"$regex": escaped, "$options": "i"}},
            {"make": {"$regex": escaped, "$options": "i"}},
            {"item_category": {"$regex": escaped, "$options": "i"}},
        ]}
    rows = await db.stock_master.find(
        flt,
        {"_id": 0, "id": 1, "part_no": 1, "make": 1, "description_1": 1,
         "description_2": 1, "model": 1, "item_category": 1}
    ).limit(limit).to_list(limit)
    return rows


@router.get("/item-details")
async def item_details(part_no: str, make: str, user=Depends(get_current_user)):
    """Aggregate every transactional record that touches the given (part_no, make).

    Returns a tree:
      {
        master: {...stock_master fields...} | None,
        stock_balance: [...per-location rows...],
        receipt_notes:        [{header + matched item rows}],
        short_received_notes: [{...}],
        extra_received_notes: [{...}],
        racking_notes:        [{...}],
        issue_notes:          [{...}],
        picking_notes:        [{...}],
        transfer_requests:    [{...}],
        transfer_notes:       [{...}],
        transactions:         [...ledger rows for this part/make...],
        totals: {received, racked, issued, transferred_in, transferred_out, current_stock},
      }

    Item rows are filtered server-side so the payload stays compact even when
    the same RN has 50 items but only 1 matches our (part_no, make).
    """
    pn = (part_no or "").strip()
    mk = (make or "").strip()
    if not pn or not mk:
        raise HTTPException(status_code=400, detail="part_no and make are required")

    master = await db.stock_master.find_one(
        {"part_no": pn, "make": mk}, {"_id": 0}
    )

    # Per-location balance for this part/make — computed live from the transaction
    # ledger (the `stock_balance` collection is not maintained anywhere in this
    # codebase and is always empty; the ledger is the only source of truth).
    balance = []
    for loc in await _stock_locations_for(pn, mk):
        qty = loc.pop("current_qty")
        balance.append({**loc, "quantity": qty})

    # Helper: pull docs from a notes collection where any item row matches the part/make,
    # then trim the items array down to just the matching rows.
    async def _notes(coll, header_fields, item_part_field="part_no", item_make_field="make"):
        rows = await coll.find(
            {"items": {"$elemMatch": {item_part_field: pn, item_make_field: mk}}},
            {"_id": 0}
        ).sort("created_at", -1).to_list(5000)
        out = []
        for r in rows:
            items_match = [it for it in (r.get("items") or [])
                           if (it.get(item_part_field) or "").strip() == pn
                           and (it.get(item_make_field) or "").strip() == mk]
            r["items"] = items_match
            out.append(r)
        return out

    receipt_notes        = await _notes(db.receipt_notes,        None)
    short_received_notes = await _notes(db.short_received_notes, None)
    extra_received_notes = await _notes(db.extra_received_notes, None)
    racking_notes        = await _notes(db.racking_notes,        None)
    issue_notes          = await _notes(db.issue_notes,          None)
    picking_notes        = await _notes(db.picking_notes,        None)
    transfer_requests    = await _notes(db.transfer_requests,    None)
    transfer_notes       = await _notes(db.transfer_notes,       None)

    # Stock ledger entries for this part. Fetch the FULL history in true
    # chronological order (created_at, then _id as a tiebreak for rows stamped
    # with the same timestamp — e.g. a Transfer Note's OUT+IN pair) so the
    # running balance below is accurate, then reverse to the newest-first order
    # the UI expects and cap the page size for display.
    all_txns = await db.transactions.find(
        {"part_no": pn, "make": mk}
    ).sort([("created_at", 1), ("_id", 1)]).to_list(20000)
    running = 0
    for tx in all_txns:
        tx.pop("_id", None)
        running += tx["quantity"] if tx.get("type") == "IN" else -tx["quantity"]
        tx["balance_after"] = running
        # Same document-reference precedence used by the Transactions page:
        # racking note (Stock In) > picking note (Stock Out) > transfer note.
        tx["ref_no"] = tx.get("racking_note_no") or tx.get("picking_note_no") or tx.get("transfer_note_no") or ""
    txns = list(reversed(all_txns))[:2000]

    # Totals (best-effort from ledger; current_stock from balance sum)
    def _sum(rows, key):
        return float(sum((r.get(key) or 0) for r in rows))

    totals = {
        "current_stock":   _sum(balance, "quantity"),
        # Physical receipt qty (never invoice qty): what actually arrived against
        # the invoice, plus anything delivered later to close a shortfall.
        "received_qty":    (_rn_received_qty(receipt_notes, extra_received_notes)
                            + _srn_received_qty(short_received_notes)),
        # Pending (undecided) short/extra qty — zeroes out once every child
        # delivery/decision row accounts for the full short_qty/extra_qty.
        "short_qty":       _pending_qty(short_received_notes, srn_decided_by_key, "short_qty"),
        "extra_qty":       _pending_qty(extra_received_notes, ern_decided_by_key, "extra_qty"),
        # Only actually-completed racking, summed across every RKN regardless
        # of source (RN / SRN fulfillment / ERN acceptance) — each RECORDED
        # RKN's quantity is disjoint by construction (see prepare_racking_for_source),
        # so a plain sum can't double-count.
        "racked_qty":      sum((float(it.get("quantity") or 0)
                                for r in racking_notes if r.get("status") == "RECORDED"
                                for it in r.get("items", []))),
        # Total requested qty, regardless of how much has been picked so far.
        "issued_qty":      sum((float(it.get("quantity") or 0)
                                for r in issue_notes for it in r.get("items", []))),
        # Only actually-completed picks (a Picking Note's quantity is always
        # the physically-picked amount for that document, never the request).
        "picked_qty":      sum((float(it.get("quantity") or 0)
                                for r in picking_notes if r.get("status") == "COMPLETED"
                                for it in r.get("items", []))),
        # Total requested qty, regardless of how much has been transferred so far.
        "transfer_requested_qty": sum((float(it.get("quantity") or 0)
                                for r in transfer_requests for it in r.get("items", []))),
        # Only actually-completed transfers.
        "transferred_qty": sum((float(it.get("quantity") or 0)
                                for r in transfer_notes if r.get("status") == "COMPLETED"
                                for it in r.get("items", []))),
        "txn_count":       len(txns),
    }

    return {
        "master":               master,
        "stock_balance":        balance,
        "receipt_notes":        receipt_notes,
        "short_received_notes": short_received_notes,
        "extra_received_notes": extra_received_notes,
        "racking_notes":        racking_notes,
        "issue_notes":          issue_notes,
        "picking_notes":        picking_notes,
        "transfer_requests":    transfer_requests,
        "transfer_notes":       transfer_notes,
        "transactions":         txns,
        "totals":               totals,
    }
