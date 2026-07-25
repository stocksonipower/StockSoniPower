# Backend

FastAPI + Motor (async MongoDB). Entry point: `backend/server.py`. See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for the file tree and [ARCHITECTURE.md](ARCHITECTURE.md) for the big picture.

## App construction (`server.py`)

- `app = FastAPI(title="Stock Management API")`.
- CORS: `CORS_ORIGINS` env var parsed by `_parse_cors_origins()` (comma-separated, trailing `/` stripped per origin); defaults to `["*"]` if unset. `CORSMiddleware` added with `allow_credentials=True`, `allow_methods=["*"]`, `allow_headers=["*"]`.
- `api_router = APIRouter(prefix="/api")` — every route in this document lives under `/api`.
- Routers mounted (order matters for a few catch-alls, see below): `auth`, `users`, `notifications`, `dashboard`, `item_details`, `uploads`, `locations`, `stock_master`, `stock_in`, `stock_out`, `transfer`, `transactions`.
- A single `@app.middleware("http")` — `module_access_middleware` — enforces per-module ACL globally (see [PERMISSIONS.md](PERMISSIONS.md)).
- `GET /health` → `{"status": "ok"}`, unauthenticated, **outside** the `/api` prefix and outside `PATH_TO_MODULE`. Used as Render's health-check path.
- **Ordering constraint**: `app.include_router(api_router)` must be the last line of `server.py` (all sub-routers must be registered first). Within `stock_master.py`, the `column-settings` routes are registered *before* the `/{item_id}` catch-all route for the same reason (declaration-order route matching in FastAPI).

## Startup sequence (`@app.on_event("startup")`)

Runs once per process boot, in this order:

1. `init_storage()` — best-effort; failure only logs, doesn't crash boot.
2. Index creation across nearly every collection (uniqueness on `id`, `(part_no, make)`, `(fy, serial)`, plus lookup indexes on `status`, `created_at`, parent-ref fields).
3. **Receipt-note status migration** — backfills missing `status`→`RACKING_NOTE_DRAFT`; renames legacy `RACKED`→`FULLY_RACKED`, `RACKING_PENDING`→`RACKING_NOTE_DRAFT`, `FINAL`→`RACKING_NOTE_DRAFT`.
4. **Receipt-note item-shape migration** — splits legacy single `quantity` into `invoice_qty`/`received_qty`.
5. Recomputes every RN's status via `_recompute_rn_status()` (idempotent, skips DRAFT).
6. Creates indexes for `short_received_notes` / `extra_received_notes`.
7. Unique index on `column_settings.page`.
8. **Counter self-heal** — for each series (`rn, rkn, srn, ern, in, pn, str, stn`), aggregates `max(serial)` per `fy` from the corresponding collection and seeds/bumps `db.counters` so future allocation never collides with pre-existing data.
9. Backfills `receipt_notes.stock_in_type` missing → `"INVOICE"`.
10. Backfills `receipt_notes.items[].description_1` from `stock_master` where missing.
11. Backfills `racking_notes` polymorphic source fields (`source_type/id/no/date`) from legacy `receipt_note_id/no/date`; creates compound index `(source_type, source_id)`.
12. Drops legacy `racking_status_1` index on SRN/ERN (status is now always computed at read time, never cached).
13. **SRN/ERN status migration to the active status set** — remaps legacy `DRAFT`/`FINAL`→`PENDING`, `FULLY_RECEIVED`→`COMPLETE` (SRN), `PARTIALLY_REJECTED`→`PARTIALLY_ACCEPTED` (ERN); unsets legacy `racking_status`/`racked_at` fields; recomputes every SRN/ERN status.
14. **Stock Master schema migration** — `oem`→`remarks_oem`, `remarks`→`remarks_others`.
15. **Admin seeding** — creates the admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars if absent (default `admin@stockmgmt.com` / `admin123`); if present but the password hash doesn't match `ADMIN_PASSWORD`, resets it — i.e. **the admin password re-syncs to the env var on every restart** if they've drifted.
16. Backfills defaults on every user doc (`is_active`, role `"user"`→`"staff"`, `module_access` defaults, `force_password_reset`, `failed_login_attempts`).
17. Re-creates `users.id`/`users.email` unique indexes.

`@app.on_event("shutdown")` simply closes the Mongo client.

## Shared infrastructure (`deps.py`)

- Loads `backend/.env`, connects `AsyncIOMotorClient(MONGO_URL)`, exposes `db = client[DB_NAME]`.
- `JWT_SECRET`, `JWT_ALGORITHM = "HS256"`.
- `get_current_user` — FastAPI dependency validating the bearer JWT and loading the user; `require_admin` — wraps it, 403s non-admins.
- `_module_dep(module_key)` — dependency factory for per-route module-ACL enforcement.
- `_notify(...)` — creates an in-app notification document (never raises — swallows and logs on failure).
- `_resolve_assignee` / `_enforce_assignee` — the workflow-assignment feature (assign a note to a specific user; block non-assignees from acting on it).
- `APP_MODULES` — the tuple of valid module keys for the ACL system.

## Routers (`routes/`)

| Router | Lines | Responsibility |
|---|---|---|
| `auth.py` | 99 | Login, `/auth/me` (get/update own profile) |
| `users.py` | 174 | Admin user CRUD, module list, assignable-users lookup |
| `notifications.py` | 115 | List/mark-read/clear in-app notifications |
| `dashboard.py` | 162 | Live stock-balance, low-stock, dashboard stat counters |
| `item_details.py` | 143 | Autocomplete search + full 360° item drill-down |
| `uploads.py` | 93 | Image upload to object storage, authenticated image serving |
| `locations.py` | 372 | Godown/Rack/Box CRUD, CSV bulk upload/delete, "range" bulk-create |
| `stock_master.py` | 654 | Item catalog CRUD, bulk import/export, column-layout persistence |
| `stock_in.py` | 2071 | Receipt Note, SRN, ERN, Racking Note — the stock-in engine (see [WORKFLOWS.md](WORKFLOWS.md)) |
| `stock_out.py` | 742 | Issue Note, Picking Note — the stock-out engine |
| `transfer.py` | 606 | Transfer Request, Transfer Note — the transfer engine |
| `transactions.py` | 37 | Read-only ledger listing |
| `_helpers.py` | 79 | Shared CSV parsing/streaming helpers (not a router) |

Full endpoint-level detail for all of these: [API_REFERENCE.md](API_REFERENCE.md).

## Business-logic helpers (`helpers/`)

| Helper | Purpose |
|---|---|
| `auto_create.py` (360 lines) | The auto-creation engine: `_auto_create_srn_for_rn`, `_auto_create_ern_for_rn`, `_auto_create_rkn_for_source` (the 4 `auto_source` trigger tags), `_auto_create_picking_note_for_issue`, `_auto_create_transfer_note_for_request`. |
| `status_helpers.py` (464 lines) | The status state-machine functions: `_compute_srn_status`, `_compute_ern_status`, `_recompute_rn_status`, `_recompute_in_status`, `_recompute_str_status`, `_is_source_fully_racked`, `_recompute_source_status_after_rkn`. See [BUSINESS_RULES.md](BUSINESS_RULES.md) for exact transition tables. |
| `stock_helpers.py` (132 lines) | Live aggregation queries against `transactions`: `_get_balance`, `_stock_total_for`, `_stock_locations_for`. Stock quantity is **never** stored as a mutable field — always derived from this ledger on every read. |
| `validation.py` (359 lines) | Every business-rule validation function (quantity limits, cumulative-qty checks, location requirements). Full list in [BUSINESS_RULES.md](BUSINESS_RULES.md). |
| `note_helpers.py` (95 lines) | `_alloc_serial(series, fy)` (atomic FY-scoped counters), `current_fy_label()`, `_no_future_date()`. |

## Object storage (`storage.py`)

Client for Emergent's external object-storage HTTP API (`https://integrations.emergentagent.com/objstore/api/v1/storage`), not local disk or direct S3. `init_storage()` exchanges `EMERGENT_LLM_KEY` for a `storage_key`; `put_object`/`get_object` wrap the PUT/GET calls. Storage paths follow `stock-management/uploads/{user_id}/{uuid4}.{ext}`. See [WORKFLOWS.md](WORKFLOWS.md) → Image Upload, and [API_REFERENCE.md](API_REFERENCE.md) → `routes/uploads.py`.

## Testing

`backend/tests/` contains ~24 pytest files: a general smoke suite (`backend_test.py`), feature suites (receipt notes, racking notes, partial racking, issue/picking notes, stock transfer, user management, notifications, image storage, live-join enrichment), and a run of iteration-numbered regression suites (`test_iter19_regression.py` … `test_iter30_status_cleanup.py`) tracking each development phase. `test_result.md` at the repo root documents a structured "main agent ↔ testing agent" protocol used during Emergent-platform iterative development — see [CODEBASE_NOTES.md](CODEBASE_NOTES.md).
