# API Reference

All routes are mounted under `/api` (plus the unauthenticated `GET /health` outside the prefix). Auth column: **public** = no dependency; **user** = `Depends(get_current_user)`, any active logged-in user; **admin** = `Depends(require_admin)`. Many routes are additionally gated by the module-ACL system — see [PERMISSIONS.md](PERMISSIONS.md) for the path-prefix table; that table is not repeated per-row here.

Response shapes marked "raw dict" have no FastAPI `response_model` — the actual shape must be read from the handler, not from `/docs` OpenAPI output.

---
## Auth — `routes/auth.py`

| Method | Path | Body | Auth | Purpose | Errors |
|---|---|---|---|---|---|
| POST | `/auth/login` | `UserLogin{email,password}` | public | Login; returns JWT + user | `401` bad creds, `403` deactivated, `423` locked |
| GET | `/auth/me` | — | user | Current profile | `401` |
| PUT | `/auth/me` | `ProfileUpdate{name?,password?}` | user | Self-edit name/password | `400` empty payload / password <6 chars |

## Users — `routes/users.py`

| Method | Path | Body/Query | Auth | Purpose | Errors |
|---|---|---|---|---|---|
| GET | `/users` | — | admin | List all users (sorted `created_at` desc, limit 5000) | — |
| POST | `/users` | `UserCreate` | admin | Create user | `400` bad role / short password / email in use |
| PUT | `/users/{user_id}` | `UserUpdate` | admin | Update; role-change-self blocked unless staying admin; self-deactivation blocked; reactivation clears lockout | `404`, `400` |
| DELETE | `/users/{user_id}` | — | admin | Soft-delete (`is_active=false`, `deactivated_at`) | `400` self-delete, `404` |
| GET | `/meta/modules` | — | user | List `APP_MODULES` | — |
| GET | `/users/assignable` | `?module=` | user | Active users assignable to a workflow (filtered by module access unless admin) | — |

## Notifications — `routes/notifications.py`

| Method | Path | Body/Query | Auth | Purpose |
|---|---|---|---|---|
| GET | `/notifications` | `?unread_only=false&limit=50(1-500)` | user | Visible, non-dismissed notifications, newest first; header `X-Unread-Count`; `{items, unread_count}` |
| GET | `/notifications/unread-count` | — | user | `{unread_count}` |
| POST | `/notifications/mark-read` | `{ids?}` (null=all visible) | user | `$addToSet` into `read_by` |
| POST | `/notifications/clear` | `{ids?}` | user | `$addToSet` into `dismissed_by` + `read_by` (per-user dismiss) |

Visibility, delivery (polling), and notification `type` taxonomy: see [WORKFLOWS.md](WORKFLOWS.md) → Notifications, and [DATABASE.md](DATABASE.md) → `notifications`.

## Dashboard — `routes/dashboard.py`

| Method | Path | Query | Purpose |
|---|---|---|---|
| GET | `/stock-balance` | `?search=` | Live per-`(part_no,make,godown,rack,box)` balance aggregated from `transactions` (IN positive/OUT negative), joined live with `stock_master`/`godowns`/`racks`/`boxes`; rows with `total_quantity<=0` dropped; sorted `(part_no, make)` |
| GET | `/low-stock` | — | Items with `reorder_level>0` and current total qty `<= reorder_level`, sorted ascending (most critical first) |
| GET | `/dashboard/stats` | — | Counts (`total_items, total_godowns, total_racks, total_boxes, total_transactions`), `total_stock_qty`, `low_stock_count` |

## Item Details — `routes/item_details.py`

| Method | Path | Query | Purpose | Errors |
|---|---|---|---|---|
| GET | `/item-details/search` | `q`(0-64), `limit`(1-50,default 20) | Autocomplete across many `stock_master` fields (case-insensitive regex) | — |
| GET | `/item-details` | `part_no`, `make` (required) | Full drill-down: `stock_master` doc + `stock_balance` rows + filtered rows from every note collection (RN/SRN/ERN/RKN/IN/PN/transfer_requests/transfer_notes) + `transactions` ledger + computed `totals` | `400` if params missing |

## Uploads — `routes/uploads.py`

| Method | Path | Body | Auth | Purpose | Errors |
|---|---|---|---|---|---|
| POST | `/uploads/image` | multipart `file` (png/jpeg/jpg/gif/webp, ≤10MB) | user | Upload to object storage, tracked in `db.uploads`; returns `{path, content_type, size}` | `400` bad type/empty/too large, `502` storage failure |
| GET | `/files/{file_path:path}` | `?auth=<token>` or `Authorization: Bearer` | user (inline JWT check) | Serve stored image bytes | `401` bad/missing token or disabled user, `404` untracked/deleted file, `502` storage failure |

Note: no route explicitly ties an uploaded image to a Stock Master item — the association happens because the frontend includes the returned `path` in `StockMaster.images[]` on the subsequent create/update call.

## Locations — `routes/locations.py`

| Method | Path | Body | Purpose | Errors |
|---|---|---|---|---|
| GET | `/godowns/download/template` | — | CSV template (public) | — |
| POST | `/godowns/bulk-upload` | multipart CSV/XLSX | Bulk create from `GODOWN NAME` column; skips dupes/blank | `400` missing column |
| GET | `/racks/download/template` | — | CSV template (public) | — |
| POST | `/racks/bulk-upload` | multipart | Needs `GODOWN NAME`+`RACK NO`(+`TOTAL BOXES`); reports `missing_godowns` | `400` missing columns |
| GET | `/boxes/download/template` | — | CSV template (public) | — |
| POST | `/boxes/bulk-upload` | multipart | Needs `GODOWN NAME`+`RACK NO`+`BOX NO`(+`CATEGORY`); reports `missing_parents` | `400` missing columns |
| POST | `/godowns/bulk-delete` | `{ids}` | Deletes only ids not referenced in `transactions`; `{deleted, blocked}` | — |
| POST | `/racks/bulk-delete` | `{ids}` | Same, keyed `rack_id` | — |
| POST | `/boxes/bulk-delete` | `{ids}` | Same, keyed `box_id` | — |
| POST | `/racks/range` | `{godown_id,start,end,total_boxes=0,prefix=""}` | Generates racks `{prefix}{start}..{prefix}{end}` (max span 1000), skips existing | `400` godown not found / end<start / span>1000 |
| POST | `/boxes/range` | `{rack_id,start,end,box_category="",prefix=""}` | Same for boxes under a rack | `400` rack not found / end<start / span>1000 |
| POST/GET/PUT/DELETE | `/godowns[/{id}]` | `GodownCreate` | Standard CRUD; list adds `in_use`; delete blocked (`400`) if in use | `404` |
| POST/GET/PUT/DELETE | `/racks[/{id}]` | `RackCreate`/`RackUpdate` | Standard CRUD (list filterable by `?godown_id=`) | `404`, `400` godown not found / in use |
| POST/GET/PUT/DELETE | `/boxes[/{id}]` | `BoxCreate`/`BoxUpdate` | Standard CRUD (list filterable by `?rack_id=`) | `404`, `400` rack not found / in use |

## Stock Master — `routes/stock_master.py`

| Method | Path | Body/Query | Purpose | Errors |
|---|---|---|---|---|
| POST | `/stock-master` | `StockMasterCreate` | Create item; unique `(part_no,make)`; max 5 images | `400` missing part_no/make, >5 images, duplicate |
| GET | `/stock-master` | `search, page(>=1), page_size(1-5000,default 5000), sort_by, sort_dir, filter[<field>]*` | Paginated/filterable/sortable list; headers `X-Total-Count/X-Page/X-Page-Size`; `in_use` per row | — |
| GET | `/stock-master/distinct/{field}` | — | Distinct values for a whitelisted filterable field (or virtual `images`) | `400` field not filterable |
| GET | `/stock-master/lookup/makes` | `part_no` required | Distinct `make` values for a part | — |
| GET | `/stock-master/lookup/item` | `part_no, make` required | Single item lookup | `404` |
| GET | `/stock-master/download/template` | — | XLSX template with sample rows | — |
| GET | `/stock-master/download/export` | `search, sort_by, sort_dir` | Streaming CSV export honoring filters | — |
| GET | `/stock-master/column-settings` | — | Persisted (or default) grid column layout + `is_admin` flag | — |
| PUT | `/stock-master/column-settings` | `{columns}` | Persist column order/widths/labels (admin-checked in-handler); widths clamped 60-800 | `403` non-admin |
| GET/PUT/DELETE | `/stock-master/{item_id}` | `StockMasterCreate` | Get/update/delete; delete blocked if transactions exist | `404`, `400` >5 images/duplicate, `409` delete conflict |
| POST | `/stock-master/bulk-preview` | multipart | Dry-run bulk import preview (new/duplicate/skipped counts) | `400` parse error/missing columns |
| POST | `/stock-master/bulk-upload` | multipart, `?mode=skip\|overwrite` | Bulk create/update via `COLUMN_ALIASES` mapping | `400` parse error/missing PART NO or MAKE |

`column-settings` routes are registered before `/{item_id}` to avoid FastAPI's catch-all swallowing them.

---
## Stock In engine — `routes/stock_in.py`

### Legacy / disabled
| Method | Path | Purpose |
|---|---|---|
| POST | `/stock-in/lookup` | Part/make + location lookup for prefill |
| POST | `/stock-in` | **Disabled — always returns `410`**: "Create a Receipt Note and record Stock In through a finalized Racking Note." |

### Receipt Note (RN)
| Method | Path | Body/Query | Purpose | Errors |
|---|---|---|---|---|
| GET | `/receipt-notes/next-no` | — | Preview next RN number | — |
| POST | `/receipt-notes` | `ReceiptNoteCreate` | Create RN, `status=DRAFT` | `400` validation (see [BUSINESS_RULES.md](BUSINESS_RULES.md)) |
| GET | `/receipt-notes` | filters, pagination | List | — |
| GET | `/receipt-notes/{rn_id}` | — | Detail | `404` |
| PUT | `/receipt-notes/{rn_id}` | `ReceiptNoteCreate` | Edit — allowed at **any status** as long as no Racking Note exists against it | `409` RKN exists, `403` assignee-blocked (non-DRAFT), `400` validation |
| POST | `/receipt-notes/{rn_id}/finalize` | — | `DRAFT→RACKING_NOTE_DRAFT`; computes diff per row; auto-creates SRN (short rows), ERN (extra rows), and a Rule-1 DRAFT RKN | `409` not DRAFT, `400` negative/missing qty |
| DELETE | `/receipt-notes/{rn_id}` | — | Delete | `409` RKN exists |

### Racking Note (RKN) — polymorphic source RN/SRN/ERN
| Method | Path | Body/Query | Purpose | Errors |
|---|---|---|---|---|
| GET | `/racking-notes/next-no` | — | Preview next RKN number | — |
| GET | `/racking-notes/prepare/{rn_id}` | — | Legacy RN-only prepare (delegates to polymorphic) | — |
| GET | `/racking-notes/prepare-source` | `?source_type=&source_id=&exclude_rkn_id=` | Polymorphic prepare: pending qty + location prefill | — |
| GET | `/racking-notes/sources` | — | All rackable sources (RN/SRN/ERN) grouped by ultimate RN | — |
| POST | `/racking-notes` | `RackingNoteCreate` | Create RKN, `status=DRAFT` | `409` source fully racked, `400` item/cumulative-qty validation |
| GET | `/racking-notes` | filters, pagination | List | — |
| GET | `/racking-notes/{rkn_id}` | — | Detail | `404` |
| PUT | `/racking-notes/{rkn_id}` | `RackingNoteCreate` | Edit — blocked once `RECORDED` | `409` |
| DELETE | `/racking-notes/{rkn_id}` | — | Delete — blocked once `RECORDED` | `409` |
| POST | `/racking-notes/{rkn_id}/record` | — | **`DRAFT→RECORDED`; writes `type=IN` transactions (the actual stock increment); Rule-2 auto-creates a balance DRAFT RKN if pending qty remains**; header `X-Auto-RKN-No` | `409` already recorded / row missing location / partial-transaction mismatch, `400` row validation |

### Short Received Note (SRN)
| Method | Path | Body | Purpose | Errors |
|---|---|---|---|---|
| GET | `/short-received-notes/next-no` | — | Preview number | — |
| GET | `/short-received-notes` | filters: `status, not_status, parent_rn_id, search`, pagination | List | — |
| GET | `/short-received-notes/{srn_id}` | — | Detail | `404` |
| PUT | `/short-received-notes/{srn_id}` | `ShortReceivedNoteUpdate` | Bulk edit `fulfilled_qty`/`fulfillment_date` per item (legacy path); blocked if `COMPLETE` | `409`, `400` |
| PATCH | `/short-received-notes/{srn_id}/narration` | `{narration}` | Edit narration, no status restriction | — |
| POST | `/short-received-notes/{srn_id}/finalize` | — | Requires every item's `fulfilled_qty` set; spawns a **child SRN** for any residual; fires Rule-3 RKN auto-creation | `409` COMPLETE, `400` missing qty |
| POST | `/short-received-notes/{srn_id}/children` | `SrnChildBody{part_no,make,received_qty=0,not_receivable_qty=0}` | Add a fulfillment slice; ≥1 field >0; capped at remaining `short_qty`; Rule-3 RKN if `received_qty>0` | `400` exceeds pending qty |
| PUT | `/short-received-notes/{srn_id}/children/{child_srn_no}` | same body | Edit a slice; blocked if reducing below already-racked qty | `409` |
| DELETE | `/short-received-notes/{srn_id}/children/{child_srn_no}` | — | Delete a slice; blocked if it would drop received qty below already-racked | `409` |
| DELETE | `/short-received-notes/{srn_id}` | — | Delete whole SRN; blocked if any RKN or child SRN references it | `409` |

### Extra Received Note (ERN) — mirror of SRN
| Method | Path | Body | Purpose | Errors |
|---|---|---|---|---|
| GET | `/extra-received-notes/next-no` | — | Preview number | — |
| GET | `/extra-received-notes` | filters, pagination | List | — |
| GET | `/extra-received-notes/{ern_id}` | — | Detail | `404` |
| PUT | `/extra-received-notes/{ern_id}` | bulk `accepted_qty`/`rejected_qty` | Blocked if `COMPLETE`; `accepted+rejected<=extra_qty` | `409`, `400` |
| PATCH | `/extra-received-notes/{ern_id}/narration` | `{narration}` | Edit narration | — |
| POST | `/extra-received-notes/{ern_id}/finalize` | — | `accepted_qty` mandatory per row; spawns **child ERN** for residual; Rule-3-parallel RKN auto-creation | `409`, `400` |
| POST/PUT | `/extra-received-notes/{ern_id}/reject` | `ErnRejectBody{items?}` (empty=reject all pending) | Rejects pending extra qty; **never creates stock or an RKN** | `409` COMPLETE / nothing pending |
| POST | `/extra-received-notes/{ern_id}/children` | `ErnChildBody{part_no,make,accepted_qty=0,rejected_qty=0}` | Add accept/reject slice, capped at remaining `extra_qty`; Rule-3-parallel RKN if `accepted_qty>0` | `400` exceeds pending |
| PUT | `/extra-received-notes/{ern_id}/children/{child_ern_no}` | same body | Edit slice; blocked if reducing below already-racked | `409` |
| DELETE | `/extra-received-notes/{ern_id}/children/{child_ern_no}` | — | Delete slice; blocked if it would drop accepted qty below already-racked | `409` |
| DELETE | `/extra-received-notes/{ern_id}` | — | Delete whole ERN; blocked if any RKN or child ERN references it | `409` |

---
## Stock Out engine — `routes/stock_out.py`

| Method | Path | Body/Query | Purpose | Errors |
|---|---|---|---|---|
| POST | `/stock-out` | `StockOutCreate` | **Legacy direct stock-out** — writes an `OUT` transaction directly, bypassing Issue/Picking. Still active (not disabled like `/stock-in`). | validation errors |
| GET | `/issue-notes/lookup/{part_no}` | — | Makes with positive stock for a part | — |
| GET | `/issue-notes/lookup/{part_no}/godowns` | `?make=` | Godowns with positive stock | — |
| GET | `/issue-notes/next-no` | — | Preview IN number | — |
| POST | `/issue-notes` | `IssueNoteCreate` | Create Issue Note; **auto-creates a PENDING Picking Note**; rolls back both on failure | `400` qty exceeds stock |
| GET | `/issue-notes` | filters, pagination | List | — |
| GET | `/issue-notes/{in_id}` | — | Detail | `404` |
| PUT | `/issue-notes/{in_id}` | `IssueNoteCreate` | Edit; blocked once linked picking note is non-PENDING or has items | `409` |
| DELETE | `/issue-notes/{in_id}` | — | Delete; same block | `409` |
| GET | `/picking-notes/next-no` | — | Preview PN number | — |
| GET | `/picking-notes/prepare/{in_id}` | `?exclude_pn_id=` | Prepared pick rows with location prefill (auto-fills if exactly one qualifying location) | — |
| POST | `/picking-notes` | `PickingNoteCreate` | Create/replace allocation, `status=DRAFT` | `409` active PN already exists / issue note already fulfilled, `400` validation |
| GET | `/picking-notes` | filters (`issue_note_id`, `status`/`not_status`), pagination | List | — |
| GET | `/picking-notes/{pn_id}` | — | Detail | `404` |
| PUT | `/picking-notes/{pn_id}` | `PickingNoteCreate` | Edit — resets to `DRAFT`; blocked if `RECORDED`/`COMPLETED` | `409` |
| DELETE | `/picking-notes/{pn_id}` | — | Delete — same block | `409` |
| POST | `/picking-notes/{pn_id}/record` | — | **`DRAFT→RECORDING→COMPLETED`; writes `OUT` transactions (the actual stock decrement); per-location distributed lock; auto-creates a follow-up Picking Note for any remaining unpicked qty**; full rollback on exception | `409` not DRAFT/concurrent lock, `400` insufficient live stock |

## Stock Transfer engine — `routes/transfer.py`

| Method | Path | Body/Query | Purpose | Errors |
|---|---|---|---|---|
| GET | `/transfer-requests/lookup/{part_no}` | — | Makes with positive stock | — |
| GET | `/transfer-requests/next-no` | — | Preview STR number | — |
| POST | `/transfer-requests` | `TransferRequestCreate` | Create request, `status=PENDING`; **auto-creates a PENDING Transfer Note**; audit-logged (`request.created`, `transfer_note.generated`); rolls back on failure | `400` qty exceeds stock |
| GET | `/transfer-requests` | filters, pagination | List (+ requested/transferred qty totals) | — |
| GET | `/transfer-requests/{str_id}` | — | Detail | `404` |
| PUT | `/transfer-requests/{str_id}` | `TransferRequestCreate` | Edit; blocked if a Transfer Note already exists | `409` |
| DELETE | `/transfer-requests/{str_id}` | — | Delete; same block | `409` |
| GET | `/transfer-notes/next-no` | — | Preview STN number | — |
| GET | `/transfer-notes/prepare/{str_id}` | `?exclude_stn_id=` | Prepared rows with source-location prefill, aware of qty reserved by other **active** transfer notes | — |
| POST | `/transfer-notes` | `TransferNoteCreate` | Create/allocate, `status=DRAFT`; `src_godown_id != dest_godown_id` enforced | `409` active note exists / request already complete, `400` validation |
| GET | `/transfer-notes` | filters, pagination | List | — |
| GET | `/transfer-notes/{stn_id}` | — | Detail | `404` |
| PUT | `/transfer-notes/{stn_id}` | `TransferNoteCreate` | Edit — resets to `DRAFT`; blocked if `RECORDED`/`COMPLETED`/`PROCESSING`; audit-logged (`transfer_note.draft_saved`) | `409` |
| DELETE | `/transfer-notes/{stn_id}` | — | Delete — same block | `409` |
| POST | `/transfer-notes/{stn_id}/record` | — | **`DRAFT→PROCESSING→COMPLETED`; writes one `OUT`@source + one `IN`@destination transaction per item; auto-creates a follow-up Transfer Note for remaining qty**; audit-logged (`transfer_note.completed`); full rollback on exception | `409` not DRAFT/concurrent, `400` insufficient live stock at source |

## Transactions — `routes/transactions.py`

| Method | Path | Query | Purpose |
|---|---|---|---|
| GET | `/transactions` | `type` (IN/OUT filter), pagination or legacy `limit` mode | Read-only ledger listing |

---
## Misc

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Unauthenticated liveness probe (outside `/api`, used by Render) — `{"status":"ok"}` |

For the exact status-machine and validation rule behind every "Errors" column entry above, see [BUSINESS_RULES.md](BUSINESS_RULES.md). For which frontend page calls which of these endpoints, see [ROUTES.md](ROUTES.md).
