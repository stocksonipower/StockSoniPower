# Stock Management System — PRD

## Original Problem Statement
Build an MVP Stock Management System with modules: Stock Master, Godown, Rack,
Box, Stock In, Stock Out, Stock Transfer, Stock Summary. Unique key
`part_no + make`. Hierarchical locations. Auto-fill via lookup. Bulk Excel
upload. Low-stock alerts. Light/clean enterprise warehouse dashboard, JWT
email+password auth, object storage for images.

## Tech Stack
- Frontend: React + Tailwind + Shadcn UI
- Backend: FastAPI + Motor (MongoDB async)
- Storage: Emergent Object Storage (up to 5 images / Stock Master item)
- Auth: JWT, 5-strike 15-min lockout
- Universal Emergent LLM key for future AI features

## Implemented (as of 2026-04-28)
### Core
- Stock Master (CRUD, bulk upload, 5 images via object storage, column reordering)
- Item Details 360° page with cross-app deep linking (`<PartNoLink>`)
- Location Master (Godown / Rack / Box hierarchy)
- Users & module access (admin CRUD, per-module ACL)
- Stock Balance with Low-Stock alerts
- Dashboard widgets (Godown stock aggregation, Stock In/Out/Transfer pending)

### Workflows
- Stock In: Receipt Note → Racking Note → transaction (with SRN/ERN sub-flows)
- Stock Out: Issue Note → Picking Note → transaction
- Stock Transfer: Transfer Request → Transfer Note → transaction
- Polymorphic Racking Notes consume from RN, SRN, or ERN sources
- In-App Notifications on workflow transitions

### UI / Tables
- HTML5 Drag/Drop sidebar nav (persisted per user)
- Excel-style sort/filter via shared `useExcelTableFilter` hook + `ExcelColumnFilter` component
- Applied to: Receipt Note, SRN, ERN, Racking Note, Issue Note, Picking Note,
  Transfer Request, Transfer Note, Stock Master, Stock Summary lists
- `.xlsx` export on all major tabs

### Stock-In Status Workflow (iter-22, 2026-04-28)
- **Receipt Note**: DRAFT → FINAL (Racking Pending) → RACKING_NOTE_DRAFT → PARTIALLY_RACKED → FULLY_RACKED
  - Any DRAFT racking note (against RN OR any SRN/ERN descendant) → RACKING_NOTE_DRAFT
  - FULLY_RACKED only when RN.received + ALL descendant SRN.fulfilled + ALL descendant ERN.accepted is fully racked
- **SRN**: PENDING → PARTIALLY_RECEIVED → COMPLETE (renamed from FULLY_RECEIVED, with startup migration)
- **ERN**: PENDING → PARTIALLY_ACCEPTED / PARTIALLY_REJECTED → COMPLETE
- **Racking Note**: DRAFT → RECORDED (display: "Fully Racked")
- SRN/ERN PUT + finalize now propagate status changes up to parent RN
- Clickable parent RN links in SRN, ERN, and Racking Note list views

### Stock-In Slice Workflow (iter-24, 2026-04-28) ⭐
- **Major redesign**: SRN/ERN per-batch slice mechanism
  - Each fulfillment batch (qty + date) creates its OWN child SRN/ERN holding the fulfilled portion (the child IS the rackable artifact)
  - Parent SRN.items[i].children[] tracks all batches; pending = short_qty - Σ(children.fulfilled_qty)
  - Status flips to COMPLETE only when all items are fully filled
- **New endpoints**:
  - `POST /api/short-received-notes/{id}/fulfill` — save a slice
  - `PUT /api/short-received-notes/{id}/children/{cid}` — edit slice (blocked if RKN exists against child)
  - `DELETE /api/short-received-notes/{id}/children/{cid}` — delete slice (blocked if RKN exists)
  - Mirror endpoints on ERN: `/accept`, `/children/{cid}`, `/reject` (rejection stays at parent)
- **Frontend rebuilt**: `SrnFinalizeForm` and `ErnFinalizeForm` with row-per-slice + pending-input row UX
- **Tested**: 10/10 new tests (TC1–TC9 + TC11) pass; visual demo confirms full 2+3+1=6 → COMPLETE flow


- Atomic FY-scoped serial counters via `counters` collection
- Startup self-heal: counter = max(existing_serial) per (series, fy)

## Active Backlog
### P0 — Refactor (IN PROGRESS, 2026-04-29)
- ✅ **Phase 1 done**: Pydantic models extracted to `/app/backend/models.py`
- ✅ **Phase 2 done**: Shared infra (db, JWT, auth deps, _notify, helpers) extracted to `/app/backend/deps.py`
- ✅ **Phase 3 done**: 8 route groups extracted to `/app/backend/routes/`:
  - `auth.py`, `users.py`, `notifications.py` (~360 lines)
  - `dashboard.py` (stock-balance, low-stock, dashboard/stats — 162 lines)
  - `item_details.py` (search + 360° detail — 143 lines)
  - `uploads.py` (image upload + serve — 93 lines)
  - `locations.py` (Godown/Rack/Box CRUD + bulk + range — 372 lines)
  - `stock_master.py` (Stock Master CRUD + bulk + column-settings — 612 lines)
  - `_helpers.py` (shared CSV/upload helpers — 46 lines)
- 📊 **Result**: server.py 6646 → 4299 lines (35% reduction, 2347 lines extracted)
- 📋 **Remaining in server.py**: stock_in/out, RN, SRN/ERN, Racking, Issue, Picking, Transfer (the deeply interlinked core workflows). Left intact for safety.
- ✅ **Regression**: 30/30 tests pass via `tests/test_iter27_refactor_regression.py`

### Auto-creation workflow — RN → SRN → RKN (DONE 2026-04-29, iter-29)
Implemented per detailed user spec — adds 5 hooks to existing pipeline:
- **Rule 1**: RN finalize → DRAFT RKN auto-created for received qty (per item)
- **Rule 2**: RKN record → balance DRAFT RKN auto-created if any item still has unracked qty
- **Rule 3**: SRN child save (POST + PUT) → DRAFT RKN against the SRN for the new received qty
- **Rule 3 ERN parallel**: ERN child save (POST + PUT) → DRAFT RKN against the ERN for accepted qty
- **Status rule**: RN now stays PARTIALLY_RACKED while any descendant SRN/ERN is non-COMPLETE; FULLY_RACKED only when both rackable racked AND all descendants COMPLETE
- New helper: `_auto_create_rkn_for_source(source_type, source_id, actor, *, auto_source)` (server.py)
- DB columns: `racking_notes.auto_created` (bool), `racking_notes.auto_source` (str)
- Frontend toasts on all 5 endpoints + purple "AUTO" badge in RKN list (data-testid=`rkn-auto-badge-<rkn_no>`)
- ✅ Tests: **69/69 backend PASS** (iter27+iter28+iter29+iter29_edge_cases) + frontend smoke (74 AUTO badges rendered correctly across all 4 auto_source tooltips)

### Status cleanup — active 12-status set (DONE 2026-04-29, iter-30)
User-driven cleanup. Removed legacy values **FINAL, RACKING_PENDING, FULLY_RECEIVED, RACKED, PARTIALLY_REJECTED**. Active set:
- Receipt Note: DRAFT · RACKING_NOTE_DRAFT · PARTIALLY_RACKED · FULLY_RACKED
- SRN: PENDING · PARTIALLY_RECEIVED · COMPLETE
- ERN: PENDING · PARTIALLY_ACCEPTED · COMPLETE
- Racking Note: DRAFT · RECORDED

Backend: `_recompute_rn_status` now returns RACKING_NOTE_DRAFT (never FINAL); `_compute_ern_status` collapses rejected-only → PARTIALLY_ACCEPTED. New helper `_is_source_fully_racked()` replaces the cached `racking_status` field on SRN/ERN — field & index are dropped at startup. Startup migrations remap any legacy data: FINAL/RACKED/RACKING_PENDING → RACKING_NOTE_DRAFT/FULLY_RACKED/RACKING_NOTE_DRAFT; FULLY_RECEIVED → COMPLETE; PARTIALLY_REJECTED → PARTIALLY_ACCEPTED. Models cleaned: SRN/ERN no longer expose `racking_status`/`racked_at`.

Frontend: `statusMeta()` (StockInPage.jsx) and `STATUS_CLS` (ItemDetailsPage.jsx) reduced to active set. All legacy cases fall through to default chip if ever returned.

DB wiped to fresh slate: 0 transactions, counters reset to 1. Stock master + users + locations preserved.

✅ **78/78 backend tests PASS** (iter27 + iter28 + iter29 + iter29_edge_cases + iter30_status_cleanup).

### P1 — UX Polish
- StockMasterPage audit fixes:
  1. Search "Enter" key auto-scroll to matches
  2. Ctrl+F intercepted inside Add/Edit dialog
  3. Avoid double API call on Search+Pagination

### P2
- `.xls` accepted but `xlrd` dep missing (template downloads .xlsx only)
- Idempotent `/finalize` for already-COMPLETE SRN/ERN (currently 409s)
- Notification when RN status flips backwards (FULLY_RACKED → PARTIALLY_RACKED)

### P3 — Future
- Barcode/QR Stock In/Out scanner support
- Saved filter presets per user/page on data tables
- Migrate Transactions/Users/LowStock pages to `useExcelTableFilter` hook

## Test Credentials
admin@stockmgmt.com / admin123
