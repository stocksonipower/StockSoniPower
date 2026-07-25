"""Repository layer — all Stock In data access lives here.

Every method accepts an optional Mongo ``session`` (bound at construction by the
UnitOfWork) so that a whole business operation can participate in a single
multi-document transaction. Repositories contain NO business rules; they are a
thin, testable seam over Motor collections.
"""
from repositories.inventory_repo import (
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

__all__ = [
    "ReceiptNoteRepository",
    "ShortReceivedNoteRepository",
    "ExtraReceivedNoteRepository",
    "RackingNoteRepository",
    "PickingNoteRepository",
    "IssueNoteRepository",
    "TransferNoteRepository",
    "TransferRequestRepository",
    "TransactionRepository",
    "AuditRepository",
]
