# Codebase Notes

Miscellaneous context useful for a new developer that doesn't fit neatly into the other docs.

## This project was built on the Emergent AI-agent platform

`.emergent/emergent.yml` pins the dev environment image to `fastapi_react_mongo_shadcn_base_image_cloud_arm:...` — confirming the app was scaffolded from Emergent's "FastAPI + React + MongoDB + shadcn" cloud template and iteratively developed by an AI coding agent (or agents) rather than hand-built from scratch. Evidence throughout the repo:

- `.emergent/summary.txt` is an **agent-to-agent handoff/continuity log**, not human documentation — it records mid-task state (current feature phase, architecture snapshot, pending work) for a coding agent to resume from.
- `test_result.md` (repo root) documents a formal **"main agent ↔ testing agent" protocol** — structured YAML-in-Markdown task entries (`implemented`, `working`, `stuck_count`, `priority`, `needs_retesting`, `status_history`) plus a `test_plan` and `agent_communication` log. This is an internal AI-development-process artifact, not a CI config — there is no GitHub Actions workflow in the repo.
- `memory/PRD.md` reads as an iteration log (`iter-19` through `iter-30` referenced by name) rather than a static requirements doc — it accumulates notes across development sessions and, as a result, contains at least one stale/superseded section (see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)).
- `frontend/package.json` includes `@emergentbase/visual-edits`, a dev-only visual-editing overlay fetched from `assets.emergent.sh`, wired up conditionally in `craco.config.js` (dev-server only, never in production builds).
- `backend/requirements.txt` includes several unused LLM-provider SDKs (`google-generativeai`, `openai`, `litellm`, `tiktoken`) and a `stripe` payment SDK — remnants of the platform's general-purpose base image rather than intentional app dependencies. See [DEPLOYMENT.md](DEPLOYMENT.md).

**Practical implication**: expect the codebase to show signs of rapid, iterative, session-by-session feature development (confirmed by git history — see below) rather than a single up-front architecture design. This is not a criticism, just calibration for how to read the code: recent iteration-numbered test files and PRD sections are usually the most trustworthy source for "how does X actually work right now," more so than older comments or the earliest PRD sections.

## Git history pattern

Recent commits show heavy iterative redesign work on Stock In/Stock Out/Stock Transfer pages, a "Monolithic to Modular" backend restructuring (the original ~6600-line `server.py` was split into `routes/*.py` — see PRD's "P0 Refactor" backlog notes), some git-history-repair commits (`Preserve recovered ... commit ancestry`), and a recent cluster of deployment-stabilization fixes. Treat `git log`/`git blame` as authoritative for "what changed recently and why" rather than relying on this documentation snapshot, which reflects the codebase as of 2026-07-25.

## Design guidelines

`design_guidelines.json` (repo root) is a design-system spec — a "Swiss & High-Contrast" light theme (colors, typography scale using Chivo/IBM Plex Sans/JetBrains Mono, layout density, component styling rules) — used to guide the AI agent's UI generation for visual consistency. It is not runtime configuration and has no bearing on deployment or business logic.

## Test credentials (development only)

Per `memory/PRD.md`: `admin@stockmgmt.com` / `admin123` — this is also the *default* seeded admin account if `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars are unset (see [BACKEND.md](BACKEND.md) → startup step 15, and [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)). **Do not rely on these defaults in any shared/production environment** — set real `ADMIN_EMAIL`/`ADMIN_PASSWORD` values there.

## Where to look first for a given kind of change

| If you need to... | Start here |
|---|---|
| Add/modify a stock-in business rule | `backend/routes/stock_in.py` + `backend/helpers/{auto_create,status_helpers,validation}.py`, then update [BUSINESS_RULES.md](BUSINESS_RULES.md) |
| Add a new permission/module | `deps.py` (`APP_MODULES`), `server.py` (`PATH_TO_MODULE`), `UsersPage.jsx` (`MODULE_KEYS`/`MODULE_LABELS`) — **all three**, or you'll reproduce the `item_details` gap. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). |
| Add a new frontend route | `App.js` route table + `Layout.jsx`'s `NAV` array (for sidebar visibility) |
| Change how stock balance is computed | `backend/helpers/stock_helpers.py` and `routes/dashboard.py` — remember there is no cached quantity field, only live aggregation |
| Investigate "why did stock not move" | Check whether the relevant action was a `/finalize` or `POST`/`PUT` (never moves stock) vs. a `/record` call (does move stock) — see [BUSINESS_RULES.md](BUSINESS_RULES.md) → Stock update rules |
| Understand a document's current status | The corresponding `_compute_*_status`/`_recompute_*_status` function in `helpers/status_helpers.py` — statuses are always computed, never trusted as stored truth on read (except as a cached field for query filtering) |
