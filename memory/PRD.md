# Stock Management System — PRD

## Original Problem Statement
Build a warehouse stock management system with:
- **Stock Master** (items; `part_no + make` composite-unique)
- **Godown → Rack → Box** location hierarchy
- **Stock In / Stock Out** transactions with auto-fill from Stock Master and cascading location dropdowns
- **Stock Balance** view (aggregated)
- Search (part_no/make/description), Low stock alerts, Bulk Excel upload, Image upload, JWT login
- Light, clean enterprise/warehouse dashboard

## Architecture
- **Backend**: FastAPI (`/api` prefix), MongoDB (motor), JWT Bearer auth, bcrypt, pandas for Excel/CSV, phosphor icons
- **Frontend**: React 19, React Router 7, shadcn/ui, Tailwind (custom CSS vars, Swiss/High-Contrast theme), JetBrains Mono for part numbers, Chivo headings, IBM Plex Sans body
- **DB collections**: `users`, `stock_master`, `godowns`, `racks`, `boxes`, `transactions`

## User Personas
- **Warehouse admin** — catalog management, location setup, dashboards
- **Warehouse operator** — daily stock in/out entry

## What's Implemented (2026-02)
- JWT auth (register/login/me) + admin seeding (`admin@stockmgmt.com / admin123`)
- Stock Master: full CRUD (delete blocked when transactions exist; trash button disabled in UI), base64 image upload, uniqueness on `(part_no, make)`, multi-field global search (9 fields), CSV/Excel bulk upload, CSV export, Refresh button + Excel-style per-column filter & sort dropdowns, server-side pagination 5000/page with X-Total-Count header (2026-02-25)
- Lookups: `/stock-master/lookup/makes?part_no=`, `/stock-master/lookup/item?part_no=&make=`
- Godown / Rack / Box CRUD with hierarchical filters
- Stock In / Stock Out transactions with auto-fill and validation (qty > 0, sufficient balance on OUT)
- **Stock In → Receipt Note tab** (2026-02-25, 51/51 tests pass cumulative): list view (DD-MM-YYYY dates, right-aligned ITEMS + TOTAL QUANTITY columns, STATUS badge "Racking Pending"/"Racked", Edit + Delete actions per row — disabled when RACKED); Create form auto RN Date + auto RN No `RN/YY-YY/NNN` per Indian FY using **max(serial)+1 algorithm with DuplicateKey retry**; bulk Add Rows (qty input next to button); inline "+ Create New Master" dialog (Part No pre-filled); 3-condition Make dropdown; Edit reuses the create form (PUT preserves rn_no/rn_date/serial/fy); Delete with confirm. Receipt notes ARE blocked from edit/delete when RACKED.
- **Stock In → Racking Note tab** (2026-02-25, 18/18 backend + frontend PASS): right of Receipt Note tab. List columns: SL/RKN Date/RKN No (clickable)/RN Date/RN No/Items Total/Quantity Total/Status/Edit-Delete-Record Stock In. Create form: auto RKN Date + auto RKN No `RKN/YY-YY/NNN` (max-serial+1), Receipt Note dropdown filtered to RACKING_PENDING + not-already-used. **Prepare endpoint** `/api/racking-notes/prepare/{rn_id}` joins stock_master fields and existing locations from balance, prefills location when exactly 1 exists. Cascading Godown→Rack→Box dropdowns per row + box_category auto-fill; "Existing Locations" chips for multi-location parts (click to apply). **Record Stock In** button creates IN transactions for each item, flips RKN→RECORDED + RN→RACKED (terminal states; both block edit/delete and the record button greys out as "Recorded"). Duplicate RKN per RN blocked server-side.
- Stock Balance (aggregation on transactions, IN positive / OUT negative)
- Low Stock alerts with configurable threshold
- Dashboard stats (items, stock, godowns, racks, boxes, low-stock count)
- Transactions history with IN/OUT filter, **server-side pagination 10000/page with X-Total-Count header** (2026-02-25), legacy `?limit=` preserved for Dashboard widget
- UI: Sidebar layout, 8 routes, sharp-edge Swiss design, hover states, sonner toasts, responsive grid
- 25/25 backend tests + frontend verified

## Backlog / Next Tasks
- **P1**: Pagination on stock_master & transactions (currently limit 1000)
- **P1**: Password policy on register (min length), rate-limit login
- **P1**: Edit existing godown/rack/box fields (delete only today)
- **P2**: Barcode/QR generation per item
- **P2**: Export stock balance to Excel
- **P2**: Multi-user roles (admin vs operator vs viewer)
- **P2**: Date-range filters on Transactions page
- **P2**: Reorder quantity threshold per-item (vs global)
- **P3**: Stock transfer between locations (single txn)
- **P3**: Object storage for images (currently base64)

## Test Credentials
See `/app/memory/test_credentials.md`.
