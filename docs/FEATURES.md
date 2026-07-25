# Feature Inventory

Status legend: **Implemented** (working, exercised by tests/UI) · **Partial** (exists but incomplete/inconsistent) · **Unused** (code present, not reachable or not active) · **Planned** (evidenced in backlog notes, not built).

| Feature | Status | Notes |
|---|---|---|
| Email+password login, JWT auth | Implemented | 7-day flat token, no refresh. [AUTHENTICATION.md](AUTHENTICATION.md) |
| 5-strike / 15-minute account lockout | Implemented | [AUTHENTICATION.md](AUTHENTICATION.md) |
| Forced password reset (admin-triggered) | Implemented | Frontend hard-redirects until resolved |
| Role (admin/staff) + per-module ACL | Implemented | Default-allow semantics; two enforcement mechanisms. [PERMISSIONS.md](PERMISSIONS.md) |
| Workflow assignment (assign a note to a user) | Implemented | `assigned_to_user_id`, `_enforce_assignee` |
| Stock Master CRUD | Implemented | Unique `(part_no, make)` |
| Stock Master bulk import (preview + confirm, skip/overwrite modes) | Implemented | CSV/XLSX via pandas |
| Stock Master column customization (admin-managed layout) | Implemented | `column_settings` collection |
| Up to 5 images per Stock Master item | Implemented | Emergent object storage, authenticated serving |
| Location hierarchy (Godown → Rack → Box) CRUD | Implemented | |
| Location bulk import (CSV) | Implemented | Per level, with parent-resolution reporting |
| Location "range" bulk-create (e.g. Rack 1–50) | Implemented | Max span 1000 |
| Location bulk delete (blocked if in use) | Implemented | |
| Receipt Note (invoice & general receiving) | Implemented | [WORKFLOWS.md](WORKFLOWS.md) #2–3 |
| Short Received Note (shortfall tracking, slice fulfillment, chaining) | Implemented | [WORKFLOWS.md](WORKFLOWS.md) #4 |
| Extra Received Note (surplus tracking, accept/reject, chaining) | Implemented | [WORKFLOWS.md](WORKFLOWS.md) #5 |
| Racking Note (polymorphic RN/SRN/ERN source, partial racking) | Implemented | Sole stock-in trigger. [WORKFLOWS.md](WORKFLOWS.md) #6 |
| Auto-creation of downstream drafts (RKN/SRN/ERN/Picking/Transfer Note) | Implemented | 4 `auto_source` tags + Issue/Transfer auto-creation |
| Issue Note → Picking Note (with partial picking follow-ups) | Implemented | [WORKFLOWS.md](WORKFLOWS.md) #7 |
| Transfer Request → Transfer Note (with partial transfer follow-ups) | Implemented | No approval step — see note below. [WORKFLOWS.md](WORKFLOWS.md) #8 |
| Legacy direct Stock In (`POST /stock-in`) | **Removed / disabled** | Always `410 Gone` — kept only as a deliberate dead-end pointer to the RN→RKN flow |
| Legacy direct Stock Out (`POST /stock-out`) | Partial | Still live/writable, bypasses Issue/Picking entirely — see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |
| Transaction ledger listing/filtering | Implemented | Read-only, paginated |
| Live stock balance (per location) | Implemented | Computed on every read, no cache |
| Low-stock alerts | Implemented | Only for items with `reorder_level > 0` |
| Item Details 360° drill-down + cross-app deep-linking | Implemented | `PartNoLink` used throughout |
| Dashboard (stats + pending-workflow widgets + godown summary) | Implemented | Auto-refreshes every 60s |
| In-app notifications (polling, per-user read/dismiss) | Implemented | No push/WebSocket delivery |
| Excel-style column sort/filter on data tables | Implemented (duplicated) | Two independent implementations — see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |
| CSV/XLSX export | Implemented | Stock Master + Locations |
| Drag-and-drop sidebar nav ordering, persisted per user | Implemented | Native HTML5 DnD, `localStorage` |
| Audit trail (structured before/after) | **Partial** | Only implemented for the Transfer workflow (`inventory_audit_logs`); RN/SRN/ERN/RKN/Issue/Picking have no equivalent |
| Approval workflow for Transfer Requests | **Not implemented** | Despite the name "Request," there is no approve/reject gate — it's auto-actionable |
| Barcode/QR scanner support | Planned | Listed in PRD backlog (P3), no code present |
| Saved per-user filter presets | Planned | PRD backlog (P3) |
| `.xls` (old Excel format) import | Partial | Accepted by file-type check but `xlrd` dependency is missing; template downloads are `.xlsx` only, per PRD |
| Idempotent `/finalize` on an already-`COMPLETE` SRN/ERN | Partial | Currently returns `409` rather than a graceful no-op (PRD-noted backlog item) |
| Generic `StockTransactionPage.jsx` (unified Stock In/Out form) | **Unused** | File exists, not routed, not linked — dead code. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) |
| `hooks/use-toast.js` (shadcn toast reducer) | **Unused** | Superseded by direct `sonner` usage in practice |
| `react-hook-form` / `zod` (declared dependencies) | **Unused** in reviewed pages | Pages use raw controlled `useState` forms instead |
| `recharts` (declared dependency) | **Unused** in reviewed pages | No chart usage observed |
| Emergent visual-edits dev overlay | Implemented (dev-only) | Conditionally loaded in `craco.config.js`, never in production build |
