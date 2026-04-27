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

## Implemented (as of 2026-04-27)
### Core
- Stock Master (CRUD, bulk upload, 5 images via object storage)
- Location Master (Godown / Rack / Box hierarchy)
- Users & module access (admin CRUD, per-module ACL)
- Stock Balance with Low-Stock alerts
- Dashboard widgets (Godown stock aggregation, Stock In/Out/Transfer pending)

### Workflows
- Stock In: Receipt Note (Draft/Final) → Racking Note → transaction
- Stock Out: Issue Note (Draft/Final) → Picking Note → transaction
- Stock Transfer: Transfer Request → Transfer Note → transaction
- In-App Notifications on workflow transitions
- HTML5 Drag/Drop sidebar nav (persisted per user)
- Excel-style sort/filter + .xlsx export on all major tabs

### Stability (iter-19, 2026-04-27)
- Atomic FY-scoped serial counters via `counters` collection
- Startup self-heal: counter = max(existing_serial) per (series, fy)
- Legacy `{series}_{fy}` counter docs auto-purged
- `ReturnDocument.AFTER` imported explicitly for pymongo compatibility

## Active Backlog
### P0 — Refactor
- Split `server.py` (4800+ lines) into `/app/backend/routes/` modules

### P1 — StockMasterPage audit fixes (from earlier fork, pending user approval)
1. Search "Enter" key auto-scroll to matches
2. Bulk Import template has legacy `IMAGE` column (broken under object storage)
3. Column filters only apply to current page

### P2
4. Ctrl+F hijacks focus inside Add/Edit dialog
5. `.xls` accepted but `xlrd` dep missing
6. Search + pagination race condition (double fetch)

### P2/P3 Future
- Barcode/QR-based Stock In/Out
- Saved filter presets

## Test Credentials
See `/app/memory/test_credentials.md` — admin@stockmgmt.com / admin123
