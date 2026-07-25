"""Unit of Work — the one shared transactional boundary for every inventory
write operation (Stock In, Stock Out, Transfer, and future modules such as
Adjustments/Returns/Cycle Count).

Wraps a Mongo client session + multi-document transaction and exposes every
inventory repository bound to that session. Every write inside the
``async with`` block commits together, or none of them do.

    async with unit_of_work() as uow:
        await uow.receipt_notes.set_fields(rn_id, {...})
        await uow.transactions.insert_many(tx_docs)
        await uow.audit.record(...)
    # committed here; any exception above aborts the whole thing

The Atlas deployment backing this app is a replica set, which is what makes
multi-document transactions available. ``transactions_supported()`` probes that
at startup so a non-replica-set deployment degrades to non-transactional writes
rather than failing every request.

Per-location mutex locks (``stock_out_locks``, guarding concurrent picks/
transfers/direct stock-outs against the same physical bin) are deliberately
NOT part of this transaction — see ``services/locking.py``. They must be held
across the transaction and released only after commit, but the lock documents
themselves are not domain data that needs all-or-nothing semantics with the
business writes.
"""
import logging
from contextlib import asynccontextmanager

from deps import db as _default_db, client as _default_client
from repositories import (
    ReceiptNoteRepository,
    ShortReceivedNoteRepository,
    ExtraReceivedNoteRepository,
    RackingNoteRepository,
    PickingNoteRepository,
    IssueNoteRepository,
    TransferNoteRepository,
    TransferRequestRepository,
    TransactionRepository,
    AuditRepository,
)

logger = logging.getLogger(__name__)

# Collections that must exist before being touched inside a transaction —
# MongoDB cannot implicitly create a collection within a multi-document
# transaction, so a first-ever write to a fresh database would otherwise abort.
INVENTORY_COLLECTIONS = (
    "receipt_notes",
    "short_received_notes",
    "extra_received_notes",
    "racking_notes",
    "picking_notes",
    "issue_notes",
    "transfer_notes",
    "transfer_requests",
    "transactions",
    "inventory_audit_logs",
    "counters",
)

_txn_supported: bool | None = None


async def ensure_collections(database=None) -> None:
    """Create any missing inventory collections (no-op when they already exist)."""
    database = database if database is not None else _default_db
    try:
        existing = set(await database.list_collection_names())
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("ensure_collections: could not list collections: %s", exc)
        return
    for name in INVENTORY_COLLECTIONS:
        if name not in existing:
            try:
                await database.create_collection(name)
                logger.info("ensure_collections: created '%s'", name)
            except Exception as exc:
                # Racing app instances may create it first — harmless.
                logger.debug("ensure_collections: '%s' not created (%s)", name, exc)


async def probe_transaction_support(database=None) -> bool:
    """Detect replica-set/transaction capability once, at startup."""
    global _txn_supported
    database = database if database is not None else _default_db
    try:
        hello = await database.command("hello")
        _txn_supported = bool(hello.get("setName") or hello.get("msg") == "isdbgrid")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("probe_transaction_support failed, assuming no transactions: %s", exc)
        _txn_supported = False
    logger.info("MongoDB multi-document transactions supported: %s", _txn_supported)
    return _txn_supported


def transactions_supported() -> bool:
    # Default to True until probed: Atlas (the supported deployment) always supports them.
    return True if _txn_supported is None else _txn_supported


class UnitOfWork:
    """Holds the active session and the repositories bound to it."""

    def __init__(self, database, session):
        self.db = database
        self.session = session
        self.receipt_notes = ReceiptNoteRepository(database, session)
        self.srn = ShortReceivedNoteRepository(database, session)
        self.ern = ExtraReceivedNoteRepository(database, session)
        self.racking_notes = RackingNoteRepository(database, session)
        self.picking_notes = PickingNoteRepository(database, session)
        self.issue_notes = IssueNoteRepository(database, session)
        self.transfer_notes = TransferNoteRepository(database, session)
        self.transfer_requests = TransferRequestRepository(database, session)
        self.transactions = TransactionRepository(database, session)
        self.audit = AuditRepository(database, session)

    @property
    def transactional(self) -> bool:
        return self.session is not None


@asynccontextmanager
async def unit_of_work(database=None, mongo_client=None):
    """Open a transactional unit of work.

    Falls back to a session-less UnitOfWork when the deployment cannot do
    multi-document transactions, so the app still functions (without atomicity)
    on a standalone mongod.
    """
    database = database if database is not None else _default_db
    mongo_client = mongo_client if mongo_client is not None else _default_client

    if not transactions_supported():
        yield UnitOfWork(database, None)
        return

    async with await mongo_client.start_session() as session:
        async with session.start_transaction():
            yield UnitOfWork(database, session)
