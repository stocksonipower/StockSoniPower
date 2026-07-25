# Frontend Routes

All routes defined in `frontend/src/App.js`. "Access" reflects the `Protected`/`Public` wrapper used (see [FRONTEND.md](FRONTEND.md)).

| Path | Page component | Access | Purpose |
|---|---|---|---|
| `/login` | `LoginPage` | Public (redirects to `/` if already logged in) | Email/password sign-in |
| `/` | `Dashboard` | Protected (any user) | Overview stats, per-workflow pending-item widgets, godown stock summary |
| `/profile` | `ProfilePage` | Protected (any user) | Edit name/password; handles forced password reset (`?reset=1`) |
| `/users` | `UsersPage` | Protected, `adminOnly` | User management: CRUD, module access toggles, lock/deactivate |
| `/stock-master` | `StockMasterPage` | Protected, `module="stock_master"` | Item master CRUD, bulk import/export, images, column customization |
| `/item-details` | `ItemDetailsPage` | Protected, `module="item_details"` | Full cross-workflow item lookup; deep-linkable via `?part_no=&make=` |
| `/locations` | `LocationsPage` | Protected, `module="locations"` | Godown / Rack / Box master management |
| `/stock-in` | `StockInPage` | Protected, `module="stock_in"` | Tabs: Receipt Note, Short Received Note, Extra Received Note, Racking Note (renders `RackingNoteTab`) |
| `/stock-out` | `StockOutPage` | Protected, `module="stock_out"` | Tabs: Issue Note, Picking Note |
| `/stock-transfer` | `StockTransferPage` | Protected, `module="stock_transfer"` | Tabs: Transfer Request, Transfer Note |
| `/balance` | `StockBalancePage` | Protected, `module="stock_summary"` | Current stock balance by location |
| `/transactions` | `TransactionsPage` | Protected, `module="transactions"` | Full stock ledger, paginated, IN/OUT filter |
| `/low-stock` | `LowStockPage` | Protected, `module="low_stock"` | Items at/below reorder level |

> `module="item_details"` is checked here and in the backend middleware, but the Users page's module-toggle UI doesn't expose it — see [PERMISSIONS.md](PERMISSIONS.md) for the gap this creates.

> `StockTransactionPage.jsx` exists in `src/pages/` but has **no route** — unreachable, see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Per-page API calls

### `LoginPage` (`/login`)
`POST /auth/login`

### `Dashboard` (`/`)
`GET /dashboard/stats` · `GET /receipt-notes?not_status=FULLY_RACKED&page_size=1` · `GET /racking-notes?status=DRAFT&page_size=1` · `GET /issue-notes?not_status=FULLY_PICKED,COMPLETED&page_size=1` · `GET /picking-notes?status=PENDING,DRAFT&page_size=1` · `GET /transfer-requests?not_status=FULLY_TRANSFERRED&page_size=1` · `GET /transfer-notes?status=DRAFT&page_size=1` · `GET /stock-balance` (client-aggregated into a godown summary). Auto-refreshes every 60s. (Pending-count queries read the `X-Total-Count` header rather than the body.)

### `StockMasterPage` (`/stock-master`)
`GET/PUT /stock-master/column-settings` · `GET /stock-master?<query>` · `GET /stock-master/distinct/{column}` · `POST /stock-master` · `PUT/DELETE /stock-master/{id}` · `POST /stock-master/bulk-preview` · `POST /stock-master/bulk-upload?mode=` · `GET /stock-master/download/template` · `GET /stock-master/download/export[?params]` · (images) `POST /uploads/image`, `GET /files/{path}` via `AuthImage`.

### `ItemDetailsPage` (`/item-details`)
`GET /item-details/search?q=&limit=20` (debounced, also preloaded on mount) · `GET /item-details?part_no=&make=`.

### `LocationsPage` (`/locations`)
`GET/POST/PUT/DELETE /godowns[/{id}]` · `GET/POST/PUT/DELETE /racks[/{id}]` (`?godown_id=`) · `GET/POST/PUT/DELETE /boxes[/{id}]` (`?rack_id=`) · `POST /racks/range` · `POST /boxes/range` · `POST /{godowns|racks|boxes}/bulk-delete` · CSV template download / bulk-upload for each level.

### `StockInPage` (`/stock-in`)
**Receipt Notes**: `GET /receipt-notes` (paginated/search) · `GET /receipt-notes/{id}` · `GET /receipt-notes/next-no` · `POST /receipt-notes` · `PUT /receipt-notes/{id}` · `DELETE /receipt-notes/{id}` · `POST /receipt-notes/{id}/finalize`.
**Lookups**: `GET /stock-master/lookup/makes?part_no=` · `GET /stock-master/lookup/item?part_no=&make=` · inline `POST /stock-master` (create master from within the form).
**SRN**: `GET /short-received-notes?parent_rn_id=` · `GET /short-received-notes/{id}` · `POST .../{parentId}/children` · `PUT .../{parentId}/children/{childNo}` · `DELETE .../{parentId}/children/{childNo}` · `PATCH .../{parentId}/narration`.
**ERN**: same shape as SRN, `extra-received-notes`.
**Generic list**: `GET {path}?page=&page_size=&search=`, `DELETE {path}/{id}` for both SRN/ERN tabs.
**Racking Note tab** → rendered by `RackingNoteTab.jsx`: `GET /receipt-notes/{rnId}` · `GET /racking-notes?page=&page_size=&search=` · `DELETE /racking-notes/{id}` · `POST /racking-notes/{id}/record` · `GET /godowns` / `GET /racks?godown_id=` / `GET /boxes?rack_id=` · `GET /racking-notes/prepare-source?source_type=&source_id=&exclude_rkn_id=` · `GET /racking-notes/next-no` · `GET /racking-notes/sources` · `PUT /racking-notes/{id}` / `POST /racking-notes`.

### `StockOutPage` (`/stock-out`)
**Issue Notes**: `GET /issue-notes` (paginated) · `GET /issue-notes/next-no` · `GET /issue-notes/lookup/{partNo}` · `GET /issue-notes/lookup/{partNo}/godowns?make=` · `GET /issue-notes/lookup/{value}` · `POST/PUT/DELETE /issue-notes[/{id}]`.
**Picking Notes**: `GET /picking-notes?issue_note_id=` · `GET /picking-notes?page=&page_size=` (or `not_status=`) · `GET /picking-notes/next-no` · `GET /picking-notes/prepare/{issueNoteId}?exclude_pn_id=` · `GET /picking-notes/prepare/{id}` · `POST/PUT/DELETE /picking-notes[/{id}]` · `POST /picking-notes/{id}/record`.
Plus `GET /godowns`, `GET /racks?godown_id=`, `GET /boxes?rack_id=`.

### `StockTransferPage` (`/stock-transfer`)
**Transfer Requests**: `GET /transfer-requests?page=&page_size=` (or `not_status=`) · `GET /transfer-requests/next-no` · `GET /transfer-requests/lookup/{partNo}` · `GET /transfer-requests/lookup/{value}` · `POST/PUT/DELETE /transfer-requests[/{id}]`.
**Transfer Notes**: `GET /transfer-notes?transfer_request_id=` · `GET /transfer-notes?page=&page_size=` · `GET /transfer-notes/next-no` · `GET /transfer-notes/prepare/{transferRequestId}?exclude_stn_id=` · `GET /transfer-notes/prepare/{id}` · `POST/PUT/DELETE /transfer-notes[/{id}]` · `POST /transfer-notes/{id}/record`.
Plus `GET /godowns`, `GET /racks?godown_id=`, `GET /boxes?rack_id=`.

### `StockBalancePage` (`/balance`)
`GET /stock-balance?search=` (client-side sort/filter).

### `TransactionsPage` (`/transactions`)
`GET /transactions?page=&page_size=&type=` (header `X-Total-Count` for pagination); row links open `DocumentDetailDialog`, which fetches `GET /racking-notes/{id}`, `GET /picking-notes/{id}`, or `GET /transfer-notes/{id}`.

### `LowStockPage` (`/low-stock`)
`GET /low-stock`.

### `UsersPage` (`/users`, admin only)
`GET /users` · `POST /users` · `PUT /users/{id}` (also used to reactivate / clear lockout by setting `is_active: true`) · `DELETE /users/{id}` (soft-delete).

### `ProfilePage` (`/profile`)
`PUT /auth/me`.

### Dead route — `StockTransactionPage.jsx` (unrouted)
`GET /godowns` · `GET /stock-master/lookup/makes` · `GET /stock-master/lookup/item` · `GET /racks` · `GET /boxes` · `POST /stock-out`.

For full request/response shape of each endpoint above, see [API_REFERENCE.md](API_REFERENCE.md).
