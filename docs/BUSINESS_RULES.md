# Business Rules

The authoritative reference for status state machines, stock-movement rules, numbering, audit trail, and validation. Verified directly against `backend/routes/stock_in.py`, `stock_out.py`, `transfer.py`, and `backend/helpers/*.py` — not just the PRD (the PRD contains a stale section, flagged below).

## Stock update rules — when quantity actually changes

**Core principle**: `transactions` is the single source of truth ledger. Balance = `SUM(IN.quantity) − SUM(OUT.quantity)` per `(part_no, make, godown_id, rack_id, box_id)`, always computed live via aggregation — there is no mutable "current quantity" field anywhere in the system.

**Stock increments (`type=IN`) — exactly one code path**: `POST /api/racking-notes/{rkn_id}/record`. Creating/editing any draft RN, SRN, ERN, or RKN never touches `transactions`. The legacy `POST /api/stock-in` endpoint is permanently disabled (`410 Gone`) — direct stock-in is fully blocked; only RN → RKN → record can add stock.

**Stock decrements (`type=OUT`) — two code paths**:
1. Legacy `POST /api/stock-out` — still active, writes a direct `OUT` transaction. Appears to be a manual-adjustment leftover, not part of the Issue/Picking workflow.
2. `POST /api/picking-notes/{pn_id}/record` — the real Issue Note/Picking Note workflow's decrement point.

**Stock transfer (`OUT`+`IN` together)**: `POST /api/transfer-notes/{stn_id}/record` inserts a matched pair of transactions per item — one `OUT` at the source location, one `IN` at the destination — sharing `transfer_note_id`/`transfer_request_id` linkage.

**What never moves stock**: creating/editing/deleting DRAFT RN/SRN/ERN/RKN; finalizing RN/SRN/ERN (only auto-creates further drafts); creating Issue Notes, Picking Notes (DRAFT), Transfer Requests, Transfer Notes (DRAFT); a `/record` call on a document whose transactions already fully exist (idempotent no-op, not a re-write).

## Receipt Note (RN) — status lifecycle

**Active statuses**: `DRAFT` → `RACKING_NOTE_DRAFT` → `PARTIALLY_RACKED` → `FULLY_RACKED`

- `DRAFT` is only left via the `/finalize` action (never auto-promoted).
- `_recompute_rn_status()` (status_helpers.py) walks the full source graph — the RN plus every descendant SRN/ERN (recursively, via `parent_srn_id`/`parent_ern_id` chains):
  - `rackable` = RN's `min(received_qty, invoice_qty)` per (part,make) + all descendant SRN `children[].received_qty` + all descendant ERN `children[].accepted_qty`.
  - `racked` = sum of quantities across every `RECORDED` RKN whose `(source_type, source_id)` is the RN or any descendant SRN/ERN.
  - If **no** `RECORDED` RKN exists anywhere in the graph → `RACKING_NOTE_DRAFT` (covers "only draft RKNs exist" and "no RKN at all").
  - Once **any** `RECORDED` RKN exists, status never falls back to `RACKING_NOTE_DRAFT` again — adding a further draft RKN on top does not regress it.
  - **`FULLY_RACKED`** only when `racked >= rackable` for every (part,make) key **and** every descendant SRN is `COMPLETE` **and** every descendant ERN is `COMPLETE`. An RN cannot reach `FULLY_RACKED` while any child SRN/ERN is still open, even if the currently-known rackable quantity is fully racked.
  - Otherwise → `PARTIALLY_RACKED`.
  - `racked_at` is set only on the transition to `FULLY_RACKED`, and cleared if the status regresses to `PARTIALLY_RACKED`.

> **PRD discrepancy**: `memory/PRD.md` line ~41 (an older, un-cleaned-up section from iteration 22) still describes `DRAFT → FINAL (Racking Pending) → RACKING_NOTE_DRAFT → ...`. This is **stale** — a later section of the same file (iteration 30, "Status cleanup") correctly documents the current 4-status set, which matches the code exactly. Don't trust the PRD's early sections in isolation.

## SRN (Short Received Note) — status lifecycle

**Active statuses**: `PENDING` → `PARTIALLY_RECEIVED` → `COMPLETE`

`_compute_srn_status()`:
- `total_short <= 0` → `PENDING`.
- No child slice activity, or `total_decided <= 0` → `PENDING`.
- `total_decided >= total_short` (1e-6 epsilon) → `COMPLETE`.
- Otherwise → `PARTIALLY_RECEIVED`.
- `total_decided` = sum across all slices of `(received_qty + not_receivable_qty)`.

**Slice mechanism**: each `ShortReceivedNoteItem.children[]` entry is one fulfillment batch, `{child_srn_no, received_qty, not_receivable_qty, created_at, status}` — the slice, not the parent SRN, is the actual rackable unit. Suffix allocation is `A, B, C… Z, AA, AB…`.

**Edit/delete guard**: reducing a slice's `received_qty`, or deleting a slice, is blocked with `409` if it would drop the item's total received quantity below what has already been racked against it (computed by aggregating other RKNs against the SRN's source).

**Finalize** (legacy bulk path, `fulfilled_qty` per item): every item must have `fulfilled_qty` set. Residual (`short_qty − fulfilled_qty`) `> 0` spawns a **child SRN** carrying the leftover for further decision.

## ERN (Extra Received Note) — status lifecycle

**Active statuses**: `PENDING` → `PARTIALLY_ACCEPTED` → `COMPLETE`

`_compute_ern_status()`:
- `total_extra <= 0` → `PENDING`.
- No activity or `decided (accepted+rejected) <= 0` → `PENDING`.
- `decided >= total_extra` → `COMPLETE`.
- If `total_accepted > 0` → `PARTIALLY_ACCEPTED`.
- **Legacy `PARTIALLY_REJECTED` is collapsed into `PARTIALLY_ACCEPTED`** — explicit in code: rejections-only (zero accepted) is still reported as `PARTIALLY_ACCEPTED` so the user knows a decision is in progress. This confirms the PRD's iteration-30 cleanup claim.

**Reject flow** (`POST/PUT .../{ern_id}/reject`): appends a slice with `accepted_qty:0, rejected_qty:X, status:"REJECTED"`. **Never creates stock and never triggers Racking Note auto-creation** — rejection is a dead end for that quantity, returned to the supplier.

**Finalize**: `accepted_qty` mandatory per row; residual (`extra_qty − accepted − rejected`) `> 0` spawns a **child ERN**.

## Racking Note (RKN) — status lifecycle

**Active statuses**: `DRAFT` → `RECORDED` (only two states — no partial state on the RKN itself; partial racking is expressed as *multiple* RKNs against the same source, not a partial status on one RKN).

- Polymorphic source: `source_type ∈ {RN, SRN, ERN}` + `source_id`. The doc also always carries legacy `receipt_note_id/no/date`, which point to the **ultimate parent RN** even when the real source is an SRN/ERN — kept for backward-compatible RN-grouping UIs.
- **Creation** rejected (`409`) if the resolved source is already fully racked.
- Validation caps cumulative quantity across *all* RKNs (draft + recorded) against the same source's rackable qty — you cannot over-allocate racking beyond what was actually received/accepted.
- **`/record`** is the sole stock-increment trigger (see above). Idempotency: if matching `IN` transactions already exist for this RKN and the count matches item count, it just flips to `RECORDED` without re-inserting; a count mismatch raises `409` ("manual audit required") rather than silently guessing.
- Edit/Delete blocked once `RECORDED`.

### Auto-creation rules ("hooks")

Four distinct `auto_source` tags, fired from these trigger points:

| `auto_source` | Trigger |
|---|---|
| `"rn-finalize"` | RN `/finalize` — after SRN/ERN auto-creation, a DRAFT RKN is auto-created for whatever is immediately rackable from the RN itself. |
| `"rkn-record-balance"` | RKN `/record` — after successfully recording, if the source (RN/SRN/ERN) still has unracked pending qty, a new DRAFT "balance" RKN is auto-created. |
| `"srn-child-save"` | Any SRN slice-save action (`POST`/`PUT` children, or the bulk `PUT`/`finalize`) where `received_qty > 0` — auto-creates/extends a DRAFT RKN for the newly-fulfilled qty. |
| `"ern-child-save"` | Parallel to the above for ERN's `accepted_qty > 0` on slice-save actions. The `/reject` endpoint explicitly does **not** trigger this. |

`_auto_create_rkn_for_source()` computes the exact still-pending quantity and prefills locations; if nothing is pending it returns `None` (no empty RKN is ever created). Auto-created RKNs are flagged `auto_created: true` with the matching `auto_source` string; the response header `X-Auto-RKN-No` surfaces the new number to the frontend for a toast notification.

## Issue Note — status lifecycle

**Active statuses**: `OPEN` (degenerate fallback) · `PICKING_PENDING` · `PICKING_IN_PROGRESS` · `PARTIALLY_PICKED` · `FULLY_PICKED`

> The `IssueNote` model docstring in `models.py` only lists `PICKING_PENDING | PARTIALLY_PICKED | FULLY_PICKED` — the actual code additionally uses `PICKING_IN_PROGRESS` and `OPEN`. Minor model/code drift, not a legacy-value issue.

`_recompute_in_status()`:
- `FULLY_PICKED` if recorded qty across all `COMPLETED` picking notes covers all requested qty (sets `picked_at`).
- `PARTIALLY_PICKED` if some recorded qty exists but coverage is incomplete.
- `PICKING_IN_PROGRESS` if a `DRAFT` picking note exists but nothing recorded yet.
- `PICKING_PENDING` if only an unallocated `PENDING` picking note exists.
- `OPEN` as final fallback (e.g. no items requested).

**Creating an Issue Note auto-creates a `PENDING` Picking Note** immediately (rolled back together if creation fails).

## Picking Note — status lifecycle

**Active statuses**: `PENDING` (auto-created stub, no allocation) → `DRAFT` (locations allocated, not yet recorded) → `RECORDING` (transient optimistic-lock state) → `COMPLETED` (terminal). Legacy `RECORDED` is referenced only in edit/delete guard clauses defensively — no current code path ever writes it.

**Record flow** (`POST /picking-notes/{pn_id}/record`):
1. Requires status exactly `DRAFT`. Optimistic lock: atomic `DRAFT→RECORDING` transition (`409` if someone else already flipped it).
2. Per-location distributed lock via `stock_out_locks` (unique key `part||make||godown||rack||box`) — `409` if another user is concurrently recording against the same location.
3. Final real-ledger balance re-check (belt-and-suspenders on top of the draft-time check) — `400` with exact shortfall numbers if insufficient.
4. Writes `OUT` transactions.
5. Atomic `RECORDING→COMPLETED`.
6. **Partial picking**: any quantity from the frozen `assigned_items` (the original request) not yet picked auto-creates a follow-up Picking Note (`parent_picking_note_id` set, `auto_source: "partial-pick-remaining"`, status `PENDING`).
7. Any exception in the process triggers a full compensating rollback: delete inserted transactions, delete any created follow-up PN, reset status to `DRAFT`, release locks.

## Transfer Request — status lifecycle

**Active statuses** (code-verified): `NEW` (degenerate) · `PENDING` (default/fallback) · `IN_PROGRESS` · `COMPLETED`. The model docstring additionally lists `CLOSED`/`CANCELLED`, but **no code path sets either** — treat them as reserved/unused.

`_recompute_str_status()`: `COMPLETED` when transferred qty (from `COMPLETED` transfer notes only) covers all requested qty for every (part,make) — sets `transferred_at`; `IN_PROGRESS` if any transferred qty exists or an active transfer note (`PENDING`/`DRAFT`/`PROCESSING`) exists; `PENDING` otherwise.

**No approval step exists.** Creating a Transfer Request is immediately actionable and **auto-creates a Transfer Note** right away — there is no separate "approve the request" endpoint anywhere in the codebase. Gating happens only via live stock-availability checks and assignment enforcement, not a workflow-approval state.

## Transfer Note — status lifecycle

**Active statuses**: `PENDING` (auto-created stub) → `DRAFT` (user has entered actual allocations) → `PROCESSING` (transient lock) → `COMPLETED` (terminal). Legacy `RECORDED` appears only in guard-clause status lists, never written by current code.

**Record flow** mirrors Picking Note: `DRAFT→PROCESSING` atomic lock → final balance re-check at the source location → writes matched `OUT`(source)+`IN`(dest) transaction pairs → `PROCESSING→COMPLETED` → partial-transfer follow-up Transfer Note if remainder exists (`parent_transfer_note_id`, `execution_attempt += 1`) → full rollback on exception. Also writes an `inventory_audit_logs` entry (`"transfer_note.completed"`) — the only workflow in the system with a dedicated before/after audit log (see below).

## Confirmed legacy status removal

A full search of the route/helper files confirms **no code path writes** `FINAL`, `RACKING_PENDING`, `FULLY_RECEIVED`, `RACKED`, or `PARTIALLY_REJECTED` anywhere — matching the PRD's "iteration 30 status cleanup" claim. (The startup migration code that remaps any *pre-existing* documents with these legacy values lives in `server.py`, not the route/helper files — see [BACKEND.md](BACKEND.md) → Startup sequence, steps 3 & 13.)

## Numbering / serial scheme

`_alloc_serial(series, fy)` (`note_helpers.py`) is atomic and race-free:

```python
key = f"{series}:{fy}"
res = await db.counters.find_one_and_update(
    {"_id": key}, {"$inc": {"value": 1}}, upsert=True,
    return_document=ReturnDocument.AFTER,
)
```

One `counters` document per `(series, fy)`. `fy` = Indian financial year (April-start), formatted `26-27`. Series: `rn, rkn, srn, ern, in, pn, str, stn`. Number format: `f"{PREFIX}/{fy}/{serial:03d}"`, e.g. `RN/26-27/003`. Every creation endpoint additionally wraps allocation+insert in a 5-attempt retry loop catching `DuplicateKeyError` (a defense against a rare id-level collision, not the counter itself, which is already atomic).

## Audit trail

Two distinct, **not unified** mechanisms:

1. **`transactions` collection** — the actual stock-movement ledger (see above). Append-only; queryable via `GET /transactions`. No explicit before/after-quantity snapshot per row — balance at any point in time must be recomputed by aggregation.
2. **`inventory_audit_logs` collection** — **used only by `transfer.py`**: `{action, ref_collection, ref_id, old_value, new_value, created_at, created_by}`. Confirmed actions: `request.created`, `transfer_note.generated`, `transfer_note.draft_saved`, `transfer_note.completed`. **RN/SRN/ERN/RKN/Issue Note/Picking Note have no equivalent structured audit log** — they rely solely on the `transactions` ledger (for stock movement) and the `notifications` feed (for a human-readable activity stream, not structured before/after data). See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Validation rules (`helpers/validation.py`)

| Function | Rule |
|---|---|
| `_validate_txn` | Item/godown/rack/box must exist; `quantity > 0`. (Legacy direct stock-in/out endpoints.) |
| `_validate_racking_items` | Non-empty; each row needs part_no, make, `quantity>0`, godown_id+rack_id, box_id. |
| `_validate_cumulative_qty_polymorphic` | Sum of (other RKNs' qty + this note's qty) per (part,make) cannot exceed the source's rackable qty (RN/SRN/ERN-aware); error message reports exact `rackable`/`used`/`new` numbers. |
| `_box_id_required_for_rack` | Box is mandatory only if the target rack actually has ≥1 box defined. |
| `_validate_picking_items` | Non-empty; part_no/make required, `quantity>0`, godown_id+rack_id required. |
| `_validate_picking_constraints` | Every (part,make) must be on the linked Issue Note; if the Issue Note pinned a `selected_godown_id`, the picking row must match it exactly; cumulative picked qty per item can't exceed requested; live per-location stock availability check (drafts don't reserve stock). |
| `_validate_issue_items` / `_validate_issue_qty_against_stock` | Non-empty rows; total requested per (part,make) can't exceed live total stock (and per-godown stock if `selected_godown_id` set). |
| `_validate_transfer_request_items` / `_validate_transfer_request_qty` | Non-empty rows; total requested per (part,make) can't exceed live total stock (no per-location check yet — that's deferred to Transfer Note stage). |
| `_validate_transfer_note_items` | Non-empty; `src_godown_id != dest_godown_id` (same-godown transfers are rejected; same-rack-different-godown etc. is not separately checked). |
| `_validate_transfer_note_constraints` | Every (part,make) must be on the linked Transfer Request; cumulative transferred qty can't exceed requested; per-source-location stock check net of qty reserved by other **active** transfer notes (prevents double-booking the same physical stock across two in-flight notes). |

**Other edge-case rules found inline in route handlers** (not in `validation.py`):
- `_no_future_date()` — rejects dates more than +1 day past UTC-today (timezone leniency for `invoice_date`, `goods_received_date`).
- RN finalize: `received_qty` cannot be negative; `GENERAL` type requires `received_qty > 0`.
- SRN/ERN slices: quantities cannot be negative, at least one field must be `>0`, sum cannot exceed the item's remaining `short_qty`/`extra_qty`.
- Reducing a slice below already-racked quantity is blocked (`409`) everywhere, both SRN and ERN, both edit and delete.
- RKN record: every row needs godown+rack+box+positive quantity or a row-indexed `400`.
- Picking Note / Transfer Note record: a final real-ledger balance re-check happens immediately before writing transactions, on top of the earlier draft-time check.

See [WORKFLOWS.md](WORKFLOWS.md) for these rules expressed as end-to-end actor/trigger/step narratives, and [API_REFERENCE.md](API_REFERENCE.md) for the endpoint each rule is enforced on.
