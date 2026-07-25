"""Per-location mutex locking — shared by every inventory write operation that
draws down a physical (part, make, godown, rack, box) location: direct Stock
Out, Picking Note completion, and Transfer Note completion.

All three share one collection (``stock_out_locks``) and key format so they
mutually exclude each other on the same physical location, closing the
cross-module race that could otherwise drive a location's stock negative.

This lock is deliberately NOT part of the MongoDB transaction (see
``services/unit_of_work.py`` docstring) — it must be visible to other requests
immediately on acquire and released only after the transaction commits, so
callers open ``location_locks(...)`` around (outside) their ``unit_of_work()``
block:

    async with location_locks(keys, owner_field="picking_note_id", owner_value=pn_id,
                               conflict_message="Stock at one selected location is being recorded by another user"):
        async with unit_of_work() as uow:
            ...  # business writes
        # transaction committed here, still holding the locks
    # locks released here
"""
import logging
from contextlib import asynccontextmanager

from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from deps import db, now_iso

logger = logging.getLogger(__name__)


@asynccontextmanager
async def location_locks(keys: list[str], *, owner_field: str, owner_value: str, conflict_message: str):
    """Acquire each key in ``stock_out_locks`` in order, stopping at the first
    conflict (raises 409 with ``conflict_message``). Releases every key this
    call acquired, always, regardless of how the block exits.

    A TTL index on ``stock_out_locks.created_at`` (see server.py startup) is a
    safety net if a worker crashes before this ``finally`` can run.
    """
    acquired: list[str] = []
    try:
        for key in keys:
            try:
                await db.stock_out_locks.insert_one({"_id": key, owner_field: owner_value, "created_at": now_iso()})
                acquired.append(key)
            except DuplicateKeyError:
                raise HTTPException(status_code=409, detail=conflict_message)
        yield
    finally:
        if acquired:
            await db.stock_out_locks.delete_many({"_id": {"$in": acquired}, owner_field: owner_value})
