"""Shared structured audit-log writer — single source of truth for the
`inventory_audit_logs` shape used by Stock Out and Stock Transfer edit/record
actions (old value, new value, actor, timestamp, optional reason).
"""
import uuid
from deps import db, now_iso


async def _write_audit_log(*, module: str, action: str, actor: dict, ref_collection: str,
                            ref_id: str, old=None, new=None, reason: str = "", links: dict = None):
    await db.inventory_audit_logs.insert_one({
        "id": str(uuid.uuid4()),
        "module": module,
        "action": action,
        "ref_collection": ref_collection,
        "ref_id": ref_id,
        "old_value": old,
        "new_value": new,
        "reason": reason or "",
        "linked_documents": links or {},
        "created_at": now_iso(),
        "created_by": (actor or {}).get("email", ""),
    })
