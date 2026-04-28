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

### Stability (iter-19, 2026-04-27)
- Atomic FY-scoped serial counters via `counters` collection
- Startup self-heal: counter = max(existing_serial) per (series, fy)

## Active Backlog
### P0 — Refactor
- Split `server.py` (~6100 lines) into `/app/backend/routes/` modules

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
