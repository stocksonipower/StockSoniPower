# Known Limitations

Documentation only — nothing on this page has been fixed as part of this pass. Flagging these so a new developer doesn't rediscover them the hard way.

## Architecture / design

- **Two independent module-ACL enforcement mechanisms** (`_module_dep` per-route dependency + the global `module_access_middleware`) — both must be checked when auditing a specific endpoint's access control; they can drift out of sync since one is per-route and the other is a path-prefix table maintained separately. See [PERMISSIONS.md](PERMISSIONS.md).
- **Default-allow ACL semantics** — a missing `module_access` key means *allowed*, not denied. Anyone testing permission edge cases (or adding a new module) needs to know this or they'll assume the opposite.
- **`item_details` module cannot be individually revoked via the Users UI** — `UsersPage.jsx`'s module-toggle list omits it, even though the backend (`APP_MODULES`, middleware `PATH_TO_MODULE`) treats it as a real module. Because of default-allow, this means Item Details is always accessible to every active non-admin user regardless of what an admin intends. See [PERMISSIONS.md](PERMISSIONS.md).
- **No unified structured audit trail** — `inventory_audit_logs` (before/after snapshots) exists only for the Transfer workflow. RN/SRN/ERN/RKN/Issue Note/Picking Note have no equivalent — only the `transactions` ledger (movement only, no before/after) and best-effort, unstructured `notifications`. If a future compliance/audit requirement needs "who changed what field when" for stock-in/out, this needs to be built, not extended.
- **No approval step on Transfer Requests** despite the name — a request is auto-actionable and immediately spawns a Transfer Note. If the business actually wants an approval gate here, it does not currently exist in the code.
- **Legacy direct `POST /api/stock-out` is still live** and writes an `OUT` transaction directly, bypassing the Issue Note/Picking Note workflow (and its stock-availability/location locking safeguards). Its sibling `POST /api/stock-in` was deliberately disabled (`410`) but this one was not — worth confirming with the business whether that's intentional or an oversight.
- **No repository/service layer** — see [DEPENDENCY_FLOW.md](DEPENDENCY_FLOW.md). Not a defect, but a real constraint: business logic is spread across route handlers and `helpers/*.py` rather than centralized, so changes to one workflow's rules require reading the specific route file end-to-end.
- **No refresh tokens / no revocation list** — a stolen JWT is valid for up to 7 days unless the account is explicitly deactivated. See [AUTHENTICATION.md](AUTHENTICATION.md).
- **Admin password auto-resets on every backend restart** to match `ADMIN_PASSWORD` if it has drifted — changing the admin password through the UI without also updating the env var will silently revert on the next deploy.

## Frontend

- **Two independent Excel-style table-filter implementations** (`DataTable.jsx`'s `useTableSortFilter`/`ColumnHeader` vs. `ExcelColumnFilter.jsx`/`useExcelTableFilter.js`, used only by `StockMasterPage`) — genuine duplication, not a deliberate split; a bug fix or UX change to one will not propagate to the other. See [FRONTEND.md](FRONTEND.md).
- **`StockTransactionPage.jsx` is dead code** — not routed in `App.js`, not linked from `Layout.jsx`'s nav. Calls the legacy `/stock-out` endpoint directly. Safe to delete or worth investigating whether it was meant to replace something.
- **`hooks/use-toast.js` is effectively unused** — the app uses `sonner` directly everywhere observed; this shadcn-boilerplate hook is dead weight.
- **`react-hook-form` + `zod` + `recharts` are declared dependencies with no observed usage** in the pages reviewed — either vestigial from scaffolding or used somewhere not covered by this research pass; worth a grep before assuming they're safe to remove.
- **Image URLs require a `?auth=<jwt>` query-string fallback** for `<img>` tags (since `<img>` can't set headers) — this puts a valid bearer token into browser history and potentially server access logs for every image request. A signed-short-lived-URL pattern would be more conventional, though changing this is out of scope for this documentation pass.

## Data / business rules

- **`IssueNote` model docstring is incomplete** — lists only `PICKING_PENDING | PARTIALLY_PICKED | FULLY_PICKED`, but the actual code also uses `PICKING_IN_PROGRESS` and `OPEN`. Minor code/doc drift inside `models.py` itself.
- **`TransferRequest`/`TransferNote`/`PickingNote` model docstrings list statuses (`CLOSED`, `CANCELLED`, `RECORDED`) that no current code path ever writes** — defensive/legacy values kept in guard-clause checks but not part of the active write-path state machine. See [BUSINESS_RULES.md](BUSINESS_RULES.md) for the verified active sets.
- **`.xls` (old binary Excel format) is accepted by the file-type check but the `xlrd` dependency needed to actually parse it is missing** from `requirements.txt` — uploading a `.xls` file will fail at parse time even though the extension passes validation. Templates are `.xlsx`-only.
- **`/finalize` on an already-`COMPLETE` SRN/ERN returns `409`** rather than a graceful idempotent no-op — a documented backlog item in the PRD, not yet addressed.
- **`stock_balance` collection is read in `item_details.py` but not written anywhere in the backend-core files reviewed** — it's likely maintained by the stock-in/out/transfer route modules as a cached snapshot, but treat the live `transactions`-ledger aggregation (`dashboard.py`'s `/stock-balance` endpoint) as the authoritative source if the two ever appear to disagree.

## Documentation

- **`memory/PRD.md` contains a stale section** describing an older Receipt Note status set (`DRAFT → FINAL (Racking Pending) → RACKING_NOTE_DRAFT → ...`) that was superseded by the iteration-30 cleanup documented later in the same file. If you read the PRD top-to-bottom, the early section will mislead you — the code (and this `/docs` set) is the source of truth, not the PRD's iteration log in isolation. See [CODEBASE_NOTES.md](CODEBASE_NOTES.md).
