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

### Phase 1 — User Management & Auth Security (2026-02-25, COMPLETE)
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

## Backlog / Next Tasks
- **P1 — Phase 2: In-App Notifications & Activity Log**
  - Backend: `notifications` collection; hook on Stock In/Out, all Note creates, logins/lockouts
  - Frontend: bell icon in Layout with unread count + dropdown
- **P1 — Phase 3: Workflow Assignment Gating**
  - Optional `assigned_to` user dropdown on Receipt Note / Issue Note creation
  - Restrict Racking/Picking creation to assignee (or any user when null)
- **P2**: Barcode/QR generation for scan-based Stock In/Out
- **P2**: Refactor `server.py` (~3000 lines) into routers under `/app/backend/routes/`
- **P2**: Date-range filters on Transactions
- **P3**: Stock transfer between locations (single txn)
- **P3**: Object storage for images (currently base64)

## Test Credentials
See `/app/memory/test_credentials.md`.
