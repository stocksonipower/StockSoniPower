"""Item Details routes — extracted from server.py with zero logic changes."""
import re
from fastapi import APIRouter, Depends, HTTPException, Query

from deps import db, get_current_user
from helpers.stock_helpers import _stock_locations_for

router = APIRouter()


@router.get("/item-details/search")
async def item_details_search(q: str = Query("", min_length=0, max_length=64),
                              limit: int = Query(20, ge=1, le=50),
                              user=Depends(get_current_user)):
    """Autocomplete: top `limit` (part_no, make) combos that match q (case-insensitive).
    Searches across part_no, old_part_no, new_part_no, make_part_no,
    description_1, description_2, remarks_oem, remarks_others, make, item_category."""
    qs = (q or "").strip()
    flt = {}
    if qs:
        escaped = re.escape(qs)
        flt = {"$or": [
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

    # Stock ledger entries for this part
    txns = await db.transactions.find(
        {"part_no": pn, "make": mk}, {"_id": 0}
    ).sort("created_at", -1).limit(2000).to_list(2000)

    # Totals (best-effort from ledger; current_stock from balance sum)
    def _sum(rows, key):
        return float(sum((r.get(key) or 0) for r in rows))

    totals = {
        "current_stock":   _sum(balance, "quantity"),
        "received_qty":    sum((float(it.get("received_qty") or 0)
                                for r in receipt_notes for it in r.get("items", []))),
        "racked_qty":      sum((float(it.get("quantity") or 0)
                                for r in racking_notes if r.get("status") == "RECORDED"
                                for it in r.get("items", []))),
        "issued_qty":      sum((float(it.get("issued_qty") or it.get("quantity") or 0)
                                for r in issue_notes for it in r.get("items", []))),
        "picked_qty":      sum((float(it.get("quantity") or 0)
                                for r in picking_notes if r.get("status") == "COMPLETED"
                                for it in r.get("items", []))),
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
