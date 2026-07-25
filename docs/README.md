# Stock Management System — Internal Documentation

This is a **warehouse inventory management system**: a FastAPI + MongoDB backend and a React SPA frontend implementing stock receiving (with short/extra-receipt reconciliation), racking (put-away), issuing, and inter-location transfers, on top of a Godown → Rack → Box location hierarchy and a single append-only stock-movement ledger.

This documentation set was produced by a deep, read-only architecture review of the entire codebase (backend routes/helpers/models, frontend pages/components, deployment config) as of **2026-07-25**, on branch `main`. It is meant to let a new developer — or you, in six months — understand every workflow, business rule, API, and data model **without re-reading the source first.**

## Start here, in order

1. **[GLOSSARY.md](GLOSSARY.md)** — domain terms (RN, SRN, ERN, RKN, slice, FY, etc.). Read this first if the acronyms are unfamiliar.
2. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the big picture: tech stack, request flow, the core stock-in/out/transfer engine diagram.
3. **[PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md)** — the full directory tree with a one-line purpose per file/folder.

## Backend

- **[BACKEND.md](BACKEND.md)** — app startup sequence (including every startup-time DB migration), routers, helpers, object storage.
- **[DATABASE.md](DATABASE.md)** — every MongoDB collection, every field, an ER diagram, denormalization/indexing notes.
- **[AUTHENTICATION.md](AUTHENTICATION.md)** — login flow, JWT, lockout, logout (there isn't one), frontend token handling.
- **[PERMISSIONS.md](PERMISSIONS.md)** — role + per-module ACL model, the two independent enforcement mechanisms, workflow assignment.
- **[API_REFERENCE.md](API_REFERENCE.md)** — every endpoint: method, path, body, auth, purpose, errors.

## Frontend

- **[FRONTEND.md](FRONTEND.md)** — routing/guards, state management, API layer, reusable components, build config.
- **[ROUTES.md](ROUTES.md)** — every URL route, its page, its permission gate, and the exact backend endpoints it calls.

## The business logic (the important part)

- **[WORKFLOWS.md](WORKFLOWS.md)** — 14 end-to-end workflow walkthroughs (Login, Create/Finalize Receipt Note, SRN/ERN fulfillment, Racking, Issue/Pick, Transfer, Search, Dashboard, Reports, User Management, Image Upload, Notifications) with actor/trigger/steps/DB-changes/diagrams.
- **[BUSINESS_RULES.md](BUSINESS_RULES.md)** — the authoritative reference: exact status state machines for every document type, exactly when stock does/doesn't move, numbering scheme, audit trail, and every validation rule. **This file is verified directly against the code**, including one place where it corrects a stale section of the product's own PRD.

## Cross-cutting reference

- **[DEPENDENCY_FLOW.md](DEPENDENCY_FLOW.md)** — how a request actually travels from a React component to MongoDB and back, with two worked examples.
- **[FEATURES.md](FEATURES.md)** — full feature inventory, each marked Implemented / Partial / Unused / Planned.
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — Render.com topology, build/start commands, CI/testing notes.
- **[ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)** — every env var, backend and frontend, names and purpose only (no secrets).
- **[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)** — architectural gaps, dead code, model/code drift, and design decisions worth knowing about before you change anything nearby.
- **[CODEBASE_NOTES.md](CODEBASE_NOTES.md)** — the "why does this look like this" context: the codebase was scaffolded and iteratively built on the Emergent AI-agent platform, git history pattern, where to start for common change types.

## How this documentation was produced

Four parallel research passes read every backend route/helper/model file, every frontend page/component, and every deployment/config file in full, cross-checked business-rule claims in `memory/PRD.md` against the actual code (finding and correcting one stale section), and verified specific implementation details (exact status enum values, exact validation thresholds, exact auto-creation trigger points) rather than summarizing from memory. No source code was modified during this pass — this is documentation only.

## Keeping this up to date

These are static snapshots of the codebase as reviewed. When you change a status state machine, an endpoint, a permission, or a route, update the corresponding doc(s) in the same PR — treat drift between `/docs` and the code the same way you'd treat a failing test.
