"""Stock In repositories.

Thin data-access wrappers over the Stock In collections. Each repository is
constructed with the shared ``db`` handle and an optional Mongo ``session``;
when a session is supplied (by the UnitOfWork) every read and write joins that
transaction, giving all-or-nothing semantics across collections.

Deliberately free of business rules — validation, status computation and
orchestration all live in ``services/stock_in_service.py``.
"""
from typing import Optional
import uuid

from deps import now_iso


class _BaseRepository:
    collection_name: str = ""

    def __init__(self, db, session=None):
        self.db = db
        self.session = session
        self.col = db[self.collection_name]

    # ---- reads ----
    async def get(self, doc_id: str, *, with_mongo_id: bool = False) -> Optional[dict]:
        projection = None if with_mongo_id else {"_id": 0}
        return await self.col.find_one({"id": doc_id}, projection, session=self.session)

    async def find_one(self, flt: dict, projection: Optional[dict] = None) -> Optional[dict]:
        return await self.col.find_one(flt, projection if projection is not None else {"_id": 0},
                                       session=self.session)

    async def find(self, flt: dict, *, limit: int = 0, sort=None) -> list:
        cur = self.col.find(flt, {"_id": 0}, session=self.session)
        if sort:
            cur = cur.sort(sort)
        if limit:
            cur = cur.limit(limit)
        return await cur.to_list(limit or None)

    async def exists(self, flt: dict) -> bool:
        return await self.col.find_one(flt, {"_id": 1}, session=self.session) is not None

    async def count(self, flt: dict) -> int:
        return await self.col.count_documents(flt, session=self.session)

    # ---- writes ----
    async def insert(self, doc: dict) -> dict:
        await self.col.insert_one(doc, session=self.session)
        return doc

    async def insert_many(self, docs: list) -> int:
        if not docs:
            return 0
        await self.col.insert_many(docs, session=self.session, ordered=True)
        return len(docs)

    async def set_fields(self, doc_id: str, fields: dict) -> int:
        res = await self.col.update_one({"id": doc_id}, {"$set": fields}, session=self.session)
        return res.modified_count

    async def update_one(self, flt: dict, update: dict) -> int:
        res = await self.col.update_one(flt, update, session=self.session)
        return res.modified_count

    async def delete(self, doc_id: str) -> int:
        res = await self.col.delete_one({"id": doc_id}, session=self.session)
        return res.deleted_count

    async def delete_many(self, flt: dict) -> int:
        res = await self.col.delete_many(flt, session=self.session)
        return res.deleted_count


class ReceiptNoteRepository(_BaseRepository):
    collection_name = "receipt_notes"


class ShortReceivedNoteRepository(_BaseRepository):
    collection_name = "short_received_notes"

    async def for_parent_rn(self, rn_id: str) -> list:
        return await self.find({"parent_rn_id": rn_id})


class ExtraReceivedNoteRepository(_BaseRepository):
    collection_name = "extra_received_notes"

    async def for_parent_rn(self, rn_id: str) -> list:
        return await self.find({"parent_rn_id": rn_id})


class RackingNoteRepository(_BaseRepository):
    collection_name = "racking_notes"

    async def for_ultimate_rn(self, rn_id: str, *, status: Optional[str] = None) -> list:
        flt = {"receipt_note_id": rn_id}
        if status:
            flt["status"] = status
        return await self.find(flt)

    async def any_recorded_for_rn(self, rn_id: str) -> bool:
        """True when stock has already moved anywhere in this RN's source graph.

        ``receipt_note_id`` on a racking note always points at the ultimate parent
        RN even when the note is sourced from a descendant SRN/ERN, so this single
        query covers the whole tree.
        """
        return await self.exists({"receipt_note_id": rn_id, "status": "RECORDED"})

    async def for_source(self, source_type: str, source_id: str, *, status: Optional[str] = None) -> list:
        flt = {"source_type": source_type, "source_id": source_id}
        if status:
            flt["status"] = status
        return await self.find(flt)

    async def claim_for_recording(self, rkn_id: str, now: str) -> bool:
        """Optimistic lock: atomically move DRAFT -> RECORDING.

        Returns True only for the caller that won the race; concurrent callers get
        False and must surface a 409 rather than double-writing stock.
        """
        res = await self.col.update_one(
            {"id": rkn_id, "status": "DRAFT"},
            {"$set": {"status": "RECORDING", "recording_started_at": now}},
            session=self.session,
        )
        return res.modified_count == 1

    async def release_recording_lock(self, rkn_id: str) -> int:
        res = await self.col.update_one(
            {"id": rkn_id, "status": "RECORDING"},
            {"$set": {"status": "DRAFT"}, "$unset": {"recording_started_at": ""}},
            session=self.session,
        )
        return res.modified_count


class TransactionRepository(_BaseRepository):
    collection_name = "transactions"

    async def count_for_racking_note(self, rkn_id: str) -> int:
        return await self.count({"racking_note_id": rkn_id, "type": "IN"})

    async def delete_for_racking_note(self, rkn_id: str) -> int:
        return await self.delete_many({"racking_note_id": rkn_id, "type": "IN"})


class AuditRepository(_BaseRepository):
    collection_name = "inventory_audit_logs"

    async def record(
        self,
        *,
        action: str,
        actor: dict,
        ref_collection: str,
        ref_id: str,
        old=None,
        new=None,
        reason: str = "",
        module: str = "stock_in",
        links: Optional[dict] = None,
    ) -> dict:
        """Append an immutable audit entry: who, when, old, new, reason, links."""
        doc = {
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
            "created_by_id": (actor or {}).get("id", ""),
        }
        await self.col.insert_one(doc, session=self.session)
        return doc
