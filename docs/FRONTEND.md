# Frontend

React 19 SPA built with Create React App, wrapped by CRACO (webpack overrides without ejecting). No TypeScript (plain `.jsx`/`.js`). See [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) for the file tree.

## Routing & App shell

`src/App.js` defines every route inside a single `<BrowserRouter>` within `<AuthProvider>`. Two wrapper components enforce access:
- **`Public`** — redirects to `/` if already logged in (used only by `/login`).
- **`Protected`** — redirects to `/login` if not logged in; accepts `module="<key>"` (checks `canAccess`) or `adminOnly` (checks `isAdmin`); force-redirects to `/profile?reset=1` if `user.force_password_reset` is true (except when already on `/profile`).

Full route table: [ROUTES.md](ROUTES.md).

## State management

No global store (no Redux/Zustand/MobX):
- **React Context** — `AuthContext` (`lib/auth.jsx`) is the only app-wide context: `{user, loading, login, logout, refresh, isAdmin, canAccess}`.
- **Local component state** everywhere else — every page owns its own fetching/forms/dialogs/filters via `useState`/`useReducer`.
- **URL search params** for shareable state — `ItemDetailsPage` (`?part_no=&make=`), `ProfilePage` (`?reset=1`).
- **`localStorage`** — JWT/user cache (`token`, `user`) and per-user sidebar nav order (`stockmgmt:nav_order:v1:<userId>`).
- **Toasts** — the app uses the `sonner` library directly (`import { toast } from "sonner"`) throughout pages. A legacy shadcn-style `hooks/use-toast.js` reducer also exists but is largely superseded/unused — see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## API layer (`lib/api.js`)

- `axios.create({ baseURL: `${REACT_APP_BACKEND_URL}/api` })` (trailing slashes trimmed; defaults to `http://localhost:8000` if unset).
- Request interceptor injects `Authorization: Bearer <token>` from `localStorage`.
- Response interceptor: any `401` clears `token`/`user` and hard-redirects to `/login` (unless already on `/login`/`/register`) — a global catch-all independent of `AuthContext`'s own 401 handling in `refresh()`.

Full auth flow (login/logout/token storage/force-reset): [AUTHENTICATION.md](AUTHENTICATION.md).

## Reusable components (`src/components/`)

| Component | Purpose |
|---|---|
| `Layout.jsx` | App shell: permission-filtered, drag-reorderable sidebar nav (persisted per-user in `localStorage`) + top bar with `NotificationBell`. See drag/drop mechanics below. |
| `NotificationBell.jsx` | Bell icon + unread badge + dropdown. Polls `GET /notifications?limit=50` every 30s and on window focus; mark-one/mark-all-read and clear-all actions. |
| `DataTable.jsx` | Exports `useTableSortFilter(rows, columns)` hook + `<ColumnHeader>` — one of two parallel Excel-style sort/filter implementations. Used by LowStockPage, TransactionsPage, UsersPage. |
| `ExcelColumnFilter.jsx` + `useExcelTableFilter.js` | The **second**, independently-implemented Excel-style filter engine, used only by `StockMasterPage.jsx`. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for the duplication note. |
| `PartNoLink.jsx` | Deep-links a part number to `/item-details?part_no=&make=`; used across nearly every table in the app. |
| `AuthImage.jsx` | Fetches `GET /files/{path}` as an authenticated blob (bearer token) and renders it as an `<img>` via object URL; handles legacy `data:`/`http(s):` URLs directly too. |
| `DocumentDetailDialog.jsx` | Generic modal fetching/rendering a Racking/Picking/Transfer Note's line items given `kind`+`id`. |
| `AssigneeSelect.jsx` / `AssigneeBadge` | Assign a workflow document to a specific user (sourced from `GET /users/assignable?module=`); read-only badge display elsewhere. |
| `ImageViewerDialog.jsx` | Full-screen lightbox for a set of image paths with keyboard navigation. |
| `StockMasterImageUploader.jsx` | Multi-image (max 5) uploader for Stock Master items via `POST /uploads/image`. |

## Excel-style table filtering (two parallel implementations)

Both reinvent the same UX independently — worth knowing when maintaining either:

**A. `DataTable.jsx`** (`useTableSortFilter` + `<ColumnHeader>`): `columns = [{key, label, value: row => ...}]`. Returns `{filteredRows, sort, setSort, filters, setColumnFilter, clearAllFilters, getColumnHeaderProps}`. Filters are a map `columnKey → Set<normalizedValue> | null`; blank values normalize to `"(Blank)"`. Clicking a column funnel opens a popover with sort A→Z/Z→A, search box, tri-state "(Select All)", and a checkbox list of all unique values in the *unfiltered* dataset (true Excel semantics).

**B. `ExcelColumnFilter.jsx` + `useExcelTableFilter.js`** (StockMasterPage only): standalone Radix-`Popover`-based component taking `values/selected/onChange/sortDir/onSort/isQty` props directly; same sort/search/select-all/apply UX, driven by the separate `useExcelTableFilter` hook rather than `ColumnHeader`.

## Notification bell — polling & read state

`load()` → `GET /notifications?limit=50` sets `items` + `unread` (`data.unread_count`). Polls every 30s + on window `focus` + on dropdown open. Mark-all: `POST /notifications/mark-read {ids: null}`. Mark-one: `{ids: [id]}` (skipped if already read). Clear-all: confirm dialog → `POST /notifications/clear {ids: null}`. Type→icon/color map covers `auth.login`, `auth.lockout`, `user.created/updated/deactivated/reactivated`, `stock_master.created/deleted`, `receipt_note.created`, `stock_in.recorded`, `issue_note.created`, `stock_out.recorded` (unknown types fall back to a generic gray bell icon).

## Sidebar nav drag/drop persistence (`Layout.jsx`)

Native HTML5 Drag and Drop API — no library.

- `NAV` is a hardcoded ordered array of `{to, label, icon, testid, module?, adminOnly?}`; `visibleItems` filters it by the current user's `isAdmin`/`canAccess(module)`.
- **Persistence key**: `localStorage["stockmgmt:nav_order:v1:<userId>"]` (or `:anon`) — a JSON array of `to` path strings, **per user**.
- Only a small drag-handle icon (visible on hover) is `draggable` — the nav row/link itself is not, preventing accidental drags on click-to-navigate.
- `onDragStart` stores the source index (React state + `dataTransfer` fallback); `onDragOver` calls `preventDefault()` and highlights the drop target (`ring-2 ring-blue-500`); `onDrop` splices the moved item into its new position among currently-visible items, then re-appends any permission-hidden-but-still-persisted entries so they aren't lost from storage; `onDragEnd` clears drag state.
- **Reconciliation**: whenever `visibleItems` or `user.id` changes, the persisted order is filtered down to currently-allowed items and any newly-visible items (new modules, permission changes) are appended — forward-compatible without resetting existing customization.
- "Reset" control restores the default code-order.

## Build configuration

- `package.json` scripts: `start`→`craco start`, `build`→`craco build`, `test`→`craco test`.
- `craco.config.js`: webpack alias `@`→`src/`; restricts watched directories (`node_modules`, `.git`, `build`, `dist`, `coverage`, `public` ignored) to reduce file-watcher load; optionally loads a custom health-check webpack plugin + dev-server middleware from `plugins/health-check/` when `ENABLE_HEALTH_CHECK=true`; in dev-server mode only, conditionally wraps the config with `@emergentbase/visual-edits`'s `withVisualEdits` (silently disabled if the package isn't installed) — see [CODEBASE_NOTES.md](CODEBASE_NOTES.md).
- `components.json` (shadcn config): `style: "new-york"`, plain JS (`tsx: false`), Tailwind CSS variables, `@/` aliases, `lucide` icon library (though Phosphor Icons is the primary icon set actually used in pages).

## Key dependencies

React 19, React Router 7, Axios, Radix UI primitives + Tailwind (shadcn "new-york"), `sonner` (toasts), `xlsx` (SheetJS, bulk import/export), `recharts` (present, not observed in use), `react-hook-form`+`zod` (present as deps, but pages largely use raw controlled `useState` forms instead), `date-fns`/`react-day-picker`, `@phosphor-icons/react` + `lucide-react`.

## Known dead code

`src/pages/StockTransactionPage.jsx` — a generic Stock In/Out form posting to the legacy `/stock-out` endpoint — exists on disk but is **not routed anywhere** in `App.js` and not linked from `Layout.jsx`'s nav. Orphaned/unreachable. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

For the full route table and per-page API-call inventory, see [ROUTES.md](ROUTES.md).
