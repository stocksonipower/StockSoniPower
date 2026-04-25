# Stock Management System — PRD

## Original Problem Statement
Build a warehouse stock management system with:
- **Stock Master** (items; `part_no + make` composite-unique)
- **Godown → Rack → Box** location hierarchy
- **Stock In / Stock Out** transactions with auto-fill from Stock Master and cascading location dropdowns
- **Stock Balance** view (aggregated)
- Search (part_no/make/description), Low stock alerts, Bulk Excel upload, Image upload, JWT login
- Light, clean enterprise/warehouse dashboard

## Recent Additions (User-requested)
- Remove public registration; Admin-only User Management (CRUD)
- Module-level RBAC (per-user feature flags)
- 5-failed-login lockout (15 min)
- Track `last_login`
- In-App Notifications for all data entries / logins (Phase 2)
- Assign Receipt Notes / Issue Notes to specific users for downstream completion gating (Phase 3)

## Architecture
- **Backend**: FastAPI (`/api` prefix), MongoDB (motor), JWT Bearer auth, bcrypt, pandas for Excel/CSV
- **Frontend**: React 19, React Router 7, shadcn/ui, Tailwind, JetBrains Mono for part numbers
- **DB collections**: `users`, `stock_master`, `godowns`, `racks`, `boxes`, `transactions`, `receipt_notes`, `racking_notes`, `issue_notes`, `picking_notes`

## User Personas
- **Warehouse admin** — catalog, locations, user management, dashboards
- **Warehouse staff** — daily stock in/out, only the modules admin grants

## What's Implemented
### Core (pre-2026-02)
- JWT auth (login/me) + admin seed (`admin@stockmgmt.com / admin123`)
- Stock Master CRUD with images (base64), bulk CSV/Excel upload, server-side pagination, per-column filter/sort, delete-block when in-use
- Godown / Rack / Box CRUD, range create, bulk upload, hierarchical filters
- Stock In / Stock Out (legacy direct transactions) with auto-fill + qty validation
- Stock In → Receipt Note + Racking Note (FY-numbered, partial racking, split locations, edit/delete blocked when racked)
- Stock Out → Issue Note + Picking Note (cascading locations, available-qty hints, over-allocation blocks both client + server)
- Stock Balance, Low Stock alerts, Transactions history with pagination + filter
- Live data consistency: `_enrich_items` overwrites snapshotted master/location fields with latest values on every read

### Phase 2 — In-App Notifications & Activity Log (2026-02-25, COMPLETE, 14/14 tests pass)
- New `notifications` collection with `_notify(...)` helper (failures swallowed, never break the underlying op)
- **Visibility rules**:
  - `audience="admin"` → admins only (auth events, user CRUD)
  - `audience="module"` → admins + staff with `module_access[module] != False`
  - `audience="user"` → only `target_user_id`
- **Triggers**: `auth.login`, `auth.lockout`, `user.created`, `user.updated`, `user.deactivated` (DELETE + PUT is_active=false), `user.reactivated`, `stock_master.created`, `stock_master.deleted`, `receipt_note.created`, `stock_in.recorded` (racking record), `issue_note.created`, `stock_out.recorded` (picking record)
- **Endpoints**:
  - `GET /api/notifications?unread_only=&limit=` — returns `{items, unread_count}` + `X-Unread-Count` header, sorted desc by created_at
  - `GET /api/notifications/unread-count`
  - `POST /api/notifications/mark-read` — `{ids:[...] | null}` (null/empty = mark all visible as read)
- **Frontend `NotificationBell.jsx`**:
  - Sticky topbar in Layout (`backdrop-blur`, right-aligned)
  - Unread count badge (caps at 99+)
  - Dropdown: per-type icon + colour, title, message, relative time-ago, unread blue dot, hover, click-to-mark-read
  - "Mark all read" button (auto-disables when nothing unread)
  - Click-outside dismiss; polls every 30s + on `window.focus`

### Phase 1 — User Management & Auth Security (2026-02-25, COMPLETE, 16/16 tests pass)
- **Public `/auth/register` removed** (returns 404)
- **5-failed-login lockout**: 423 response, 15-min `lockout_until`, auto-cleared on admin reactivation or successful login
- **`last_login` tracking** on every successful login
- **`force_password_reset` flag**: user redirected to `/profile?reset=1` until they set a new password
- **Admin `/users` CRUD**:
  - GET / POST / PUT / DELETE (soft-deactivate)
  - Module access map (7 modules)
  - Cannot self-deactivate (UI hides Power button on own row)
- **Module-level RBAC middleware** (`_module_dep`): admin always allowed; staff blocked with 403 when module flag is false
- **`PUT /api/auth/me`**: self-service name + password change; clears `force_password_reset` on password change
- **`GET /api/meta/modules`**: returns the 7 module keys
- **Frontend**:
  - `UsersPage.jsx` — list with status badges (Active/Locked/Deactivated), New/Edit dialog with module checkboxes, deactivate/reactivate, clear lockout button
  - `ProfilePage.jsx` — read-only email/role, editable name + password, force-reset banner, post-save redirect home
  - `Layout.jsx` — sidebar filters nav by `module_access`/`adminOnly`; Profile link in footer
  - `App.js` `Protected` route — redirects on `force_password_reset` (skips redirect when already on `/profile`), shows 403 AccessDenied for missing module/admin role

### Backend Tests
- `/app/backend/tests/test_user_management.py` — 16/16 PASS (lockout, RBAC, CRUD, force-reset, module middleware)
- `/app/backend/tests/test_notifications.py` — 14/14 PASS
- `/app/backend/tests/test_phase3_assignment.py` — 10/10 PASS
- `/app/backend/tests/test_stock_transfer.py` — 6/6 PASS (next-no, qty validation, end-to-end flow with balance shift, src≠dest, assignment gating, module-access middleware)

### Stock Transfer Module (2026-04-25, COMPLETE, 6/6 tests pass)
- **New module**: `stock_transfer` added to `APP_MODULES` (granular RBAC) + middleware path mappings for `/api/transfer-requests` and `/api/transfer-notes`
- **Schema**: `TransferRequest` (`STR/FY/###`, optional preferred destination per item, `assigned_to_*`, status `PENDING / PARTIALLY_TRANSFERRED / FULLY_TRANSFERRED`) + `TransferNote` (`STN/FY/###`, source loc + dest loc per item, status `DRAFT / RECORDED`)
- **Endpoints**: full CRUD + `/lookup/{part_no}` (stock-aware makes), `/next-no`, `/prepare/{str_id}` (prefilled with available source locations), `/{stn_id}/record`
- **Recording**: each item creates 2 transactions (1 OUT from src + 1 IN at dest) atomically; net balance unchanged
- **Validation**: cumulative qty across all STNs ≤ STR qty; per-source-location stock check (DRAFT-aware reservations); src ≠ dest; box required when rack has boxes
- **Phase 3 gating**: STR `assigned_to_user_id` propagates → STN POST/PUT/DELETE/`/record` enforce parent assignee; admin bypasses; unassigned = anyone with module access
- **Notifications**: `transfer_request.created` (audience=module), `transfer_request.assigned` (audience=user), `stock_transfer.recorded` (audience=module)
- **Frontend** (`/app/frontend/src/pages/StockTransferPage.jsx`): top-level sidebar nav between Stock Out and Stock Summary; 2 tabs (Transfer Request + Transfer Note); cascading source/destination dropdowns + available-location chips; assignee select on STR form; assignee badge on lists; locked tooltips for non-assignee staff
- **Migrations**: startup backfills `module_access[stock_transfer]=true` on existing user docs (default-allow)

### Phase 3 — Workflow Assignment Gating (2026-04-25, COMPLETE, 10/10 tests pass)
- **Models extended**: `assigned_to_user_id`, `assigned_to_name`, `assigned_to_email` on Receipt Notes and Issue Notes
- **Helpers**: `_resolve_assignee(user_id, module)` (validates user is active + has module access; admin always passes) and `_enforce_assignee(parent_note, user, action)` (raises 403 if note is assigned and user is not the assignee or admin)
- **New endpoint**: `GET /api/users/assignable?module=stock_in|stock_out` — auth-only (any logged-in user); admins always returned, staff filtered by module_access
- **Receipt Note**: POST/PUT accept `assigned_to_user_id`; PUT/DELETE enforce assignee. Sends `receipt_note.assigned` notification (audience=user) on new assignment
- **Issue Note**: POST/PUT accept `assigned_to_user_id`; PUT/DELETE enforce assignee. Sends `issue_note.assigned` notification on new assignment
- **Racking Note**: POST/PUT/DELETE/`/record` all enforce parent Receipt Note's assignee
- **Picking Note**: POST/PUT/DELETE/`/record` all enforce parent Issue Note's assignee
- **List endpoints** GET `/racking-notes` and `/picking-notes` enriched with `parent_assigned_to_user_id` / `_name` / `_email` via batched join
- **Frontend `<AssigneeSelect>`** + `<AssigneeBadge>` in `/app/frontend/src/components/AssigneeSelect.jsx`:
  - Used in Receipt Note form (testid `rn-assignee`) and Issue Note form (`in-assignee`)
  - Defaults to `— Unassigned (anyone) —`, returns null on submit
  - Filters dropdown by relevant module
- **List rows** show `<AssigneeBadge />` (`rn-assignee-{rn_no}`, `in-assignee-{in_no}`, `rkn-assignee-{rkn_no}`, `pn-assignee-{pn_no}`)
- **Disabled buttons + tooltip** "Locked — assigned to {name}" for non-assignee staff (Edit/Delete on RN+IN; Edit/Delete/Record on RKN+PN). Admin bypass.
- **Detail dialogs** all show `Assigned To` row (parent assignee for RKN/PN)

## Backlog / Next Tasks
- **P1 — Dashboard Activity Widget** (proposed; not yet started)
  - Recent activity feed using existing notifications collection
  - Top widgets: pending racking/picking/transfers, low-stock count, my-assigned-notes count
- **P2**: Barcode/QR generation for scan-based Stock In/Out/Transfer
- **P2**: Refactor `server.py` (~3500 lines) into routers under `/app/backend/routes/`
- **P2**: Date-range filters on Transactions
- **P3**: Object storage for images (currently base64)

## Recent UI Work (2026-04-25)
- **Users / Low Stock / Transactions tabs rebuilt**: Excel-style per-column sort + multi-select filter popover (`useTableSortFilter` hook + `<ColumnHeader>` in `/app/frontend/src/components/DataTable.jsx`); Export to Excel via `xlsx` package
- **Low Stock**: removed Shortage and Category columns; added Sl No (auto), Model, Description 1, Description 2, Make
- **Transactions**: split Date/Time, added Document No clickable column → opens `<DocumentDetailDialog>` (fetches racking-note / picking-note / transfer-note by id and renders body), pagination at 500/page, includes Stock In and Stock Out sub-tabs

## UI Improvements Across Tabs (2026-04-25, COMPLETE — iteration_15.json 100% pass)
- **Users**: added "Sl No" first column; renamed "Export to Excel" → "Export"
- **Low Stock**: renamed "Export to Excel" → "Export"
- **Transactions**: added "Sl No" first column to All / Stock In / Stock Out sub-tabs; renamed Export
- **Stock Summary**: per-column sort (asc/desc) added inline alongside the existing filter popover (single trigger now offers Sort A→Z / Z→A, or Smallest→Largest / Largest→Smallest for numeric columns); sticky **TOTALS row at TOP** of `<tbody>` showing live sum of REORDER LEVEL + QTY based on currently filtered rows (data-testid `totals-row`, `totals-{key}`)
- **Stock In / Stock Out / Stock Transfer list pages** (Receipt Note, Racking Note, Issue Note, Picking Note, Transfer Request, Transfer Note): each refactored to use `useTableSortFilter` + `<ColumnHeader>` for per-column Excel-style sort+filter (excluding the static SL NO column and Actions); each list now has new `Export` and `Refresh` buttons next to the Create CTA. Export downloads `.xlsx` of currently visible (filtered+sorted) rows including a "Sl No" column. Refresh re-fetches from `/api/<resource>` without a full page reload.
- Files touched: `UsersPage.jsx`, `LowStockPage.jsx`, `TransactionsPage.jsx`, `StockBalancePage.jsx`, `StockInPage.jsx`, `RackingNoteTab.jsx`, `StockOutPage.jsx`, `StockTransferPage.jsx`

## Test Credentials
See `/app/memory/test_credentials.md`.
