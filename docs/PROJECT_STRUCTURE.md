# Project Structure

```
01-STOCKAPP01/
├── backend/                       FastAPI + Motor (async MongoDB) API
│   ├── server.py                  App factory, CORS, middleware, router mounting, startup/shutdown hooks & migrations
│   ├── deps.py                    DB client, JWT config, auth dependencies, module-ACL dependency, _notify(), assignment helpers
│   ├── models.py                  All Pydantic request/response models (the full data model)
│   ├── storage.py                 Emergent object-storage client (image upload/download)
│   ├── requirements.txt
│   ├── .env / .env.example        Backend environment variables (see ENVIRONMENT_VARIABLES.md)
│   ├── routes/                    One router module per feature area, all mounted under /api
│   │   ├── auth.py                 Login, /auth/me
│   │   ├── users.py                 Admin user CRUD, module list, assignable users
│   │   ├── notifications.py         In-app notification feed
│   │   ├── dashboard.py             stock-balance, low-stock, dashboard/stats
│   │   ├── item_details.py          Item search + 360° drill-down
│   │   ├── uploads.py               Image upload + authenticated serving
│   │   ├── locations.py             Godown/Rack/Box CRUD, bulk upload, range-create
│   │   ├── stock_master.py          Item catalog CRUD, bulk import/export, column settings
│   │   ├── stock_in.py (2071 lines) Receipt Note, SRN, ERN, Racking Note — the core stock-in engine
│   │   ├── stock_out.py             Issue Note, Picking Note — the stock-out engine
│   │   ├── transfer.py              Transfer Request, Transfer Note — the transfer engine
│   │   ├── transactions.py          Read-only ledger listing
│   │   └── _helpers.py              Shared CSV/upload helpers used by stock_master.py & locations.py
│   ├── helpers/                   Business-logic helpers shared across route modules
│   │   ├── auto_create.py           Auto-creation rules for Racking Notes (Rule 1/2/3) and Picking/Transfer Note stubs
│   │   ├── note_helpers.py          Serial allocation (_alloc_serial), FY labeling, date validation
│   │   ├── status_helpers.py        Status state-machine computation for every document type
│   │   ├── stock_helpers.py         Live stock balance/location aggregation queries
│   │   └── validation.py            All business-rule validation functions
│   └── tests/                     ~24 pytest files (iteration-numbered regression suites + feature suites)
│
├── frontend/                      React 19 (Create React App via CRACO) SPA
│   ├── src/
│   │   ├── App.js                  Route table, Public/Protected route guards
│   │   ├── index.js, index.css, App.css
│   │   ├── lib/
│   │   │   ├── auth.jsx             AuthContext/AuthProvider — login/logout/refresh/isAdmin/canAccess
│   │   │   ├── api.js               Axios instance, bearer-token interceptor, global 401 handler
│   │   │   ├── exportExcel.js       Client-side .xlsx export helper
│   │   │   └── utils.js
│   │   ├── hooks/use-toast.js       Legacy shadcn toast hook (superseded by `sonner` in practice)
│   │   ├── components/              Reusable app components (see FRONTEND.md) + components/ui/ (shadcn primitives)
│   │   └── pages/                   One file per route (see ROUTES.md)
│   ├── plugins/health-check/        Custom CRACO/webpack dev-server health-check plugin (dev only)
│   ├── public/, build/              Static assets / production build output
│   ├── package.json, craco.config.js, tailwind.config.js, components.json (shadcn config)
│   └── .env / .env.example         Frontend environment variables
│
├── docs/                          You are here — internal documentation (this pass)
├── memory/PRD.md                  Product requirements / dev-iteration log (partially stale — see CODEBASE_NOTES.md)
├── test_reports/, test_result.md  Test run artifacts + Emergent agent testing-protocol file
├── tests/                         Root-level test package (separate from backend/tests)
├── render.yaml                    Render.com deployment blueprint (backend web service + frontend static site)
├── design_guidelines.json         Design-system spec used to guide UI generation (not runtime config)
├── .emergent/                     Emergent platform scaffolding markers (confirms this app was built via Emergent's AI agent platform)
└── README.md                      Top-level repo readme
```

## Backend layering

There is no separate "repository" layer — routes call MongoDB (via the shared `db` handle from `deps.py`) directly, with cross-cutting business logic factored into `helpers/`. See [DEPENDENCY_FLOW.md](DEPENDENCY_FLOW.md) for how a request actually travels through these layers.

## Frontend layering

`pages/` (one per route) → call `lib/api.js`'s axios instance directly (no separate "service" layer) → backend `/api/*`. Shared UI logic lives in `components/` and `hooks/`; shared list-filtering logic is duplicated across two implementations (`components/DataTable.jsx` and `components/ExcelColumnFilter.jsx` + `useExcelTableFilter.js`) — see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).
