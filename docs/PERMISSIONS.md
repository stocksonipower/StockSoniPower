# Permissions / Authorization Model

Two layers: a **role** (`admin` vs `staff`) and a **per-module ACL** (`module_access`). A third, orthogonal feature — **assignment** — restricts who may act on an individual document once it has an owner.

## 1. Role: `admin` vs `staff`

- `role` field on the user doc: `"admin"` | `"staff"` (legacy value `"user"` is migrated to `"staff"` at startup).
- `require_admin` dependency gates admin-only endpoints: user management (`/api/users/*` writes), Stock Master column-settings writes.
- **Admins bypass every module-ACL check everywhere** — the global middleware, `_module_dep`, notification visibility, and assignment enforcement all special-case `role == "admin"` to always pass.
- Frontend: `/users` route is `adminOnly`; `isAdmin` from `AuthContext` gates the nav item and the page itself.

## 2. Per-module ACL: `module_access`

`APP_MODULES` (`deps.py`): `stock_master, locations, stock_in, stock_out, stock_transfer, stock_summary, low_stock, transactions, item_details`.

User doc field: `module_access: dict[str, bool]`, e.g. `{"stock_master": true, "locations": false}`.

**Default-allow semantics**: a module key that is *absent* from `module_access` is treated as **allowed**. Only an explicit `false` denies access. This applies consistently across every enforcement point (`_module_dep`, the global middleware, notification visibility filtering, `_resolve_assignee`). Practical implication: when a new module is added to the codebase, every existing user gets access to it by default unless an admin explicitly revokes it — there is a startup migration (`BACKEND.md` step 16) that also explicitly backfills `true` for any newly-added module key on existing users, reinforcing default-allow rather than leaving it implicit.

### Two independent enforcement mechanisms

1. **`_module_dep(module_key)`** (`deps.py`) — a per-route FastAPI dependency, e.g. `Depends(_module_dep("stock_in"))`. Used throughout `stock_in.py`, `stock_out.py`, `transfer.py`. Admins always pass; non-admins are 403'd if `module_access.get(module_key, True) is False`.
2. **Global HTTP middleware `module_access_middleware`** (`server.py`) — runs on *every* request before route dispatch. Maps URL path prefixes to module keys via `PATH_TO_MODULE`:

   | Path prefix | Module |
   |---|---|
   | `/api/stock-master` | `stock_master` |
   | `/api/godowns`, `/api/racks`, `/api/boxes` | `locations` |
   | `/api/stock-in`, `/api/receipt-notes`, `/api/racking-notes`, `/api/short-received-notes`, `/api/extra-received-notes` | `stock_in` |
   | `/api/stock-out`, `/api/issue-notes`, `/api/picking-notes` | `stock_out` |
   | `/api/transfer-requests`, `/api/transfer-notes` | `stock_transfer` |
   | `/api/stock-balance` | `stock_summary` |
   | `/api/low-stock` | `low_stock` |
   | `/api/item-details` | `item_details` |
   | `/api/transactions` | `transactions` |

   For a matching path, the middleware **independently decodes the bearer JWT itself** (a separate code path from `get_current_user`), loads the user's `role`/`module_access`/`is_active`, and if non-admin + active + module disabled → `403 {"detail": "Access denied: '<module>' module is disabled for your account"}` **before the route even executes**. Any exception during this inline decode (missing/malformed token) is **silently swallowed**, and the request proceeds to the route's own `get_current_user` dependency, which will then produce the real `401`.

   Paths **not** in `PATH_TO_MODULE` — `/api/notifications`, `/api/users`, `/api/auth`, `/api/uploads`, `/api/files`, `/api/meta` — are unaffected by module ACL; only the base `get_current_user`/`require_admin` dependency applies to them.

**Documentation note**: because two mechanisms exist, a route can theoretically be protected by the middleware but *not* also carry a `_module_dep` (or vice versa in odd cases) — when auditing a specific endpoint's access control, check both the middleware's path-prefix table above and the route's own dependencies.

### `item_details` module gap (frontend)

The frontend's `UsersPage.jsx` module-toggle UI (`MODULE_KEYS`/`MODULE_LABELS`) does **not** list `item_details`, even though it's a valid `APP_MODULES` key and the `/item-details` route/middleware prefix both check it. Since the ACL is default-allow, this means **Item Details access cannot be individually revoked for a staff user via the Users UI** — it's silently always-on for any active non-admin user. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## 3. Assignment (workflow-level ownership)

Independent of role/module ACL. Certain workflow documents (Receipt Note, Issue Note, Transfer Request, etc.) can carry `assigned_to_user_id` (+ denormalized `assigned_to_user_name/email`).

- `_resolve_assignee(user_id, module, ...)` — validates the target user exists, is active, and (if non-admin) has access to the relevant module; `400` otherwise. Used whenever a note is created/edited with an assignee.
- `_enforce_assignee(parent_note, user, action)` — for a non-admin, non-assignee user attempting to act (edit/finalize/delete/record) on a note that **is** assigned to someone else → `403 "Cannot {action}: this note is assigned to {name}."` Unassigned notes remain actionable by anyone with the relevant module access.
- Frontend: `AssigneeSelect.jsx` (sourced from `GET /users/assignable?module=`) lets a creator pick an assignee at creation time; `AssigneeBadge` displays it read-only elsewhere.

## Permission matrix (typical pages)

| Page / Feature | Admin | Staff (module enabled) | Staff (module disabled) |
|---|---|---|---|
| Users (`/users`) | Full CRUD | No access (`adminOnly`) | No access |
| Stock Master column settings | Read + write | Read only | Blocked by module ACL |
| Any workflow module page (Stock In/Out/Transfer/etc.) | Full access, bypasses ACL & assignment | Full access if module enabled | 403 at both middleware and page level |
| A note assigned to another user | Can always act | Blocked (403) unless they are the assignee | N/A (module already blocks) |
| Item Details (`/item-details`) | Full access | Always accessible (cannot be toggled off — see gap above) | N/A |

See [AUTHENTICATION.md](AUTHENTICATION.md) for how identity is established before any of these checks run, and [API_REFERENCE.md](API_REFERENCE.md) for the auth/ACL column on every individual endpoint.
