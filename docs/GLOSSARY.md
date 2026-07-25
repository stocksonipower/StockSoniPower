# Glossary

Domain terms used throughout this documentation and the codebase. Read this first if you're new to warehouse/inventory terminology — every other doc assumes you know these.

| Term | Meaning |
|---|---|
| **Godown** | A warehouse / top-level storage site. Top of the location hierarchy. |
| **Rack** | A storage rack inside a Godown. |
| **Box** | A storage bin/box inside a Rack. Bottom of the location hierarchy: `Godown → Rack → Box`. |
| **Stock Master** | The item catalog. One row per unique `(part_no, make)` pair, with metadata, reorder level, and up to 5 images. |
| **RN — Receipt Note** | Records goods physically received into the warehouse, either against a supplier invoice (`INVOICE` type) or without one (`GENERAL` type). The entry point of the Stock-In workflow. |
| **SRN — Short Received Note** | Auto-generated when the quantity actually received against an RN is *less* than the invoiced quantity. Tracks the shortfall and its eventual fulfillment. |
| **ERN — Extra Received Note** | Auto-generated when the quantity actually received against an RN is *more* than the invoiced quantity. Tracks the surplus and whether it is accepted (racked) or rejected (returned to supplier). |
| **RKN — Racking Note** | Records the physical put-away of received stock into a specific Godown/Rack/Box. This is the only stock-in document whose "record" action actually increments stock. Can be sourced from an RN, SRN, or ERN (**polymorphic source**). |
| **Slice / child row** | An inline fulfillment batch inside an SRN or ERN item's `children[]` array (e.g. `children: [{child_srn_no: "SRN/26-27/004-A", received_qty: 5}, ...]`). Each slice is what actually gets racked, not the parent SRN/ERN as a whole. |
| **Child SRN / Child ERN** | A brand-new SRN or ERN document created to carry forward a *residual* (still-undecided) shortfall/surplus when a parent SRN/ERN is finalized without fully deciding all quantity. Linked via `parent_srn_id`/`parent_ern_id`. Distinct from a "slice" (which is an array entry, not a new document). |
| **Issue Note (IN)** | A request to release stock from the warehouse to a requester. Entry point of the Stock-Out workflow. |
| **Picking Note (PN)** | Records the physical picking of stock from specific Godown/Rack/Box locations against an Issue Note. Recording a Picking Note is what actually decrements stock. |
| **Transfer Request (STR)** | A request to move stock from its current location to a different location (possibly a different Godown). |
| **Transfer Note (STN)** | Records the physical execution of a Transfer Request — the source and destination locations for each item. Recording a Transfer Note writes both an `OUT` (source) and `IN` (destination) transaction. |
| **Transaction** | A single immutable ledger entry in the `transactions` collection, `type: "IN"` or `"OUT"`, tied to a quantity/location/part. This is the *only* source of truth for current stock — there is no mutable "current quantity" field anywhere. |
| **FY (Financial Year)** | Indian financial year, April-to-March, formatted as `26-27` (April 2026–March 2027). Used to scope document serial numbers. |
| **Serial / Document Number** | Human-facing document number, format `{PREFIX}/{fy}/{serial:03d}` (e.g. `RN/26-27/003`). Allocated atomically per `(series, fy)` via the `counters` collection. |
| **DRAFT** | A document that has been saved but not yet finalized/recorded — no stock or downstream documents are affected by a DRAFT. |
| **Finalize** | The action that locks in an RN/SRN/ERN's decided quantities and triggers auto-creation of downstream documents (SRN/ERN/RKN). Does **not** move stock itself. |
| **Record** | The action (on a Racking Note, Picking Note, or Transfer Note) that actually writes to the `transactions` ledger, i.e. actually moves stock. |
| **Auto-created document** | A DRAFT document (RKN, Picking Note, Transfer Note, child SRN/ERN) created automatically by the backend as a side effect of another action, rather than directly by a user. Marked `auto_created: true` with an `auto_source` tag. |
| **Module** | A permission unit in the ACL system (e.g. `stock_master`, `stock_in`, `locations`). See [PERMISSIONS.md](PERMISSIONS.md). |
| **Stock Balance** | The live, computed-on-read view of current quantity per `(part_no, make, godown, rack, box)`, derived by summing `transactions`. |
| **Low Stock** | An item whose total quantity (across all locations) is at or below its configured `reorder_level` (only evaluated when `reorder_level > 0`). |
| **Assignee** | A specific user a workflow document (RN, Issue Note, Transfer Request, etc.) can be assigned to via `assigned_to_user_id`. Non-admin non-assignees are blocked from acting on an assigned document. |
| **Emergent** | The AI-agent-driven cloud development platform this project was scaffolded and iteratively built on (`fastapi_react_mongo_shadcn` template). Also supplies the object-storage backend used for images. See [CODEBASE_NOTES.md](CODEBASE_NOTES.md). |
