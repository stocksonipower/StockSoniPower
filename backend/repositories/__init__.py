"""Repository layer — all Stock In data access lives here.

Every method accepts an optional Mongo ``session`` (bound at construction by the
UnitOfWork) so that a whole business operation can participate in a single
multi-document transaction. Repositories contain NO business rules; they are a
thin, testable seam over Motor collections.
"""
from repositories.stock_in_repo import (
    ReceiptNoteRepository,
    ShortReceivedNoteRepository,
    ExtraReceivedNoteRepository,
    RackingNoteRepository,
    TransactionRepository,
    AuditRepository,
)

__all__ = [
    "ReceiptNoteRepository",
    "ShortReceivedNoteRepository",
    "ExtraReceivedNoteRepository",
    "RackingNoteRepository",
    "TransactionRepository",
    "AuditRepository",
]
