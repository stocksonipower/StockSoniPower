"""Pydantic models for the Stock Management System.

Extracted from server.py during the routes refactor (no logic changes).
All models are imported back into server.py via `from models import *`.
"""
from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field, EmailStr, ConfigDict
import uuid

# -------------------- MODELS --------------------
class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: str = "staff"  # admin | staff
    module_access: Optional[dict] = None
    force_password_reset: bool = False


class UserUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    role: Optional[str] = None
    password: Optional[str] = None
    is_active: Optional[bool] = None
    module_access: Optional[dict] = None
    force_password_reset: Optional[bool] = None


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    password: Optional[str] = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class AuthResponse(BaseModel):
    token: str
    user: dict


class StockMasterBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    model: Optional[str] = ""
    part_no: str
    old_part_no: Optional[str] = ""
    new_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""    # UI label: "OEM"
    remarks_others: Optional[str] = "" # UI label: "Remarks"
    make: str
    item_category: Optional[str] = ""
    unit: Optional[str] = ""           # e.g. PCS, KG, LTR, M, BOX
    reorder_level: int = 0
    image: Optional[str] = ""  # legacy single-image (kept for backwards compatibility) — first of `images`
    images: List[str] = Field(default_factory=list)  # storage paths, max 5


class StockMasterCreate(StockMasterBase):
    pass


class StockMaster(StockMasterBase):
    id: str
    created_at: str
    in_use: Optional[bool] = False


class GodownCreate(BaseModel):
    godown_name: str


class Godown(BaseModel):
    id: str
    godown_name: str
    created_at: str


class RackCreate(BaseModel):
    godown_id: str
    rack_no: str
    total_boxes: int = 0


class Rack(BaseModel):
    id: str
    godown_id: str
    rack_no: str
    total_boxes: int
    created_at: str


class BoxCreate(BaseModel):
    rack_id: str
    box_no: str
    box_category: Optional[str] = ""


class Box(BaseModel):
    id: str
    rack_id: str
    box_no: str
    box_category: Optional[str] = ""
    created_at: str


class StockInCreate(BaseModel):
    part_no: str
    make: str
    quantity: float
    godown_id: str
    rack_id: str
    box_id: str


class StockOutCreate(BaseModel):
    part_no: str
    make: str
    quantity: float
    godown_id: str
    rack_id: str
    box_id: str


class ReceiptNoteItem(BaseModel):
    part_no: str
    make: str
    invoice_qty: Optional[float] = None      # what the invoice claims; omitted for GENERAL stock-in
    received_qty: Optional[float] = None     # what physically arrived (None on draft)
    description_1: Optional[str] = ""        # denormalized from stock_master.description_1 (read-only display)
    # Legacy alias — kept so existing racking code keeps working without changes.
    # Always written equal to received_qty when finalized, else equal to invoice_qty.
    quantity: Optional[float] = None


class ReceiptNoteCreate(BaseModel):
    # "INVOICE" -> against an invoice (invoice_no/invoice_date editable, invoice_qty per row required).
    # "GENERAL" -> no invoice (invoice_qty forced equal to received_qty -> qty_diff is always zero,
    # so no SRN/ERN ever auto-created from a GENERAL receipt).
    stock_in_type: str = "INVOICE"             # "INVOICE" | "GENERAL"
    supplier_name: Optional[str] = ""
    invoice_no: Optional[str] = ""
    invoice_date: Optional[str] = ""           # ISO "YYYY-MM-DD"
    goods_received_date: Optional[str] = ""    # ISO "YYYY-MM-DD"
    items: List[ReceiptNoteItem] = []
    assigned_to_user_id: Optional[str] = None  # null = unassigned (anyone with module access can rack)
    narration: Optional[str] = ""
    # Optional client-generated token so a retried/duplicated submit (double-click,
    # network retry) returns the already-created document instead of creating a duplicate.
    client_token: Optional[str] = None
    # Optimistic lock: the `version` the client loaded. When supplied, an edit is
    # rejected with 409 if someone else saved in the meantime. Omit for
    # last-write-wins (older clients).
    version: Optional[int] = None


class ReceiptNote(BaseModel):
    id: str
    rn_no: str
    rn_date: str  # ISO "YYYY-MM-DD"
    fy: str
    serial: int
    stock_in_type: str = "INVOICE"
    supplier_name: str = ""
    invoice_no: str = ""
    invoice_date: str = ""
    goods_received_date: str = ""
    items: List[ReceiptNoteItem] = []
    # DRAFT is an internal pre-finalize marker only (gates /finalize; always shown as
    # "Pending" in the UI). Once finalized, the racking-progress status follows the
    # standard 3-status set: PENDING -> IN_PROCESS -> COMPLETE (see _recompute_rn_status).
    # Legacy RACKING_NOTE_DRAFT/PARTIALLY_RACKED/FULLY_RACKED/FINAL/RACKING_PENDING/RACKED
    # are migrated on startup.
    status: str = "DRAFT"
    finalized_at: Optional[str] = None
    racked_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""
    # Derived on read: True iff at least one RECORDED Racking Note references this RN
    # (i.e. stock has genuinely moved). Frontend uses this to lock edit/delete — a DRAFT
    # racking note holds no stock and must not lock the parent.
    has_racking_note: Optional[bool] = False
    narration: Optional[str] = ""
    # Bumped on every edit; drives the optimistic-lock check on PUT.
    version: int = 0

# ===================== SHORT RECEIVED NOTES (Phase 1: auto-created stubs) =====================

class ShortReceivedNoteItem(BaseModel):
    part_no: str
    make: str
    invoice_qty: float = 0                    # qty on the original invoice (carried from parent RN row)
    received_qty: float = 0                   # qty already received on the parent RN row (carried over)
    short_qty: float                          # qty that was short on the parent (= invoice_qty - received_qty)
    fulfilled_qty: Optional[float] = None     # qty user has now received against the shortfall (filled at finalize)
    # Master snapshot — denormalized for display
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    new_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""
    unit: Optional[str] = ""
    # Legacy alias - mirrors fulfilled_qty so racking flow can read it like any other note.
    quantity: Optional[float] = None
    # Slice-model: list of fulfilled batches. Each entry references a child SRN
    # holding the fulfilled portion. {child_srn_id, child_srn_no, fulfilled_qty,
    # fulfilled_date, created_at}.
    children: Optional[List[dict]] = []


class ShortReceivedNote(BaseModel):
    id: str
    srn_no: str                                # e.g. "SRN/26-27/001"
    srn_date: str
    fy: str
    serial: int
    parent_rn_id: str
    parent_rn_no: str = ""
    parent_rn_date: str = ""                   # carried for display in the SRN list view
    parent_srn_id: Optional[str] = None        # set if generated from another SRN's residual short
    parent_srn_no: Optional[str] = ""
    chain_remarks: str = ""                    # human-readable lineage
    invoice_no: str = ""
    invoice_date: str = ""
    fulfillment_date: str = ""                 # ISO "YYYY-MM-DD" — set on Final Save when shortfall arrives
    items: List[ShortReceivedNoteItem] = []
    # Status semantics (active 3-status set after iter-30 cleanup):
    #   PENDING            : no children, or all children with zero received+not_receivable
    #   PARTIALLY_RECEIVED : received_qty + not_receivable_qty across children > 0 and < short
    #   COMPLETE           : received_qty + not_receivable_qty across children >= short
    # Racking visibility: as soon as any received_qty > 0 is recorded on a child slice,
    # the SRN is rackable (the partially-received qty is physically in hand). The SRN
    # does NOT need to be COMPLETE for racking to consume it.
    status: str = "PENDING"
    finalized_at: Optional[str] = None         # the LAST time the user clicked Save Final
    created_at: str
    created_by: str = ""                       # email or "system" when auto-generated
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""
    # Derived on read: True once a Racking Note sourced from THIS note is RECORDED.
    # Drives the UI's edit gate — the note stays editable until stock actually moves.
    has_recorded_racking: Optional[bool] = False
    narration: Optional[str] = ""


# ===================== EXTRA RECEIVED NOTES (Phase 1: auto-created stubs) =====================

class ExtraReceivedNoteItem(BaseModel):
    part_no: str
    make: str
    invoice_qty: float = 0                    # invoice qty on the parent RN row
    received_qty: float = 0                   # received qty on the parent RN row
    extra_qty: float                          # qty over the invoice (= received_qty - invoice_qty)
    # Store Manager's decision split. Null until the note is decided. On a
    # whole-note approve/reject these mirror extra_qty/0 (or 0/extra_qty); a
    # partial decision splits them, and only approved_qty ever becomes rackable.
    approved_qty: Optional[float] = None
    rejected_qty: Optional[float] = None
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""


class ExtraReceivedNote(BaseModel):
    id: str
    ern_no: str                                # e.g. "ERN/26-27/001"
    ern_date: str
    fy: str
    serial: int
    parent_rn_id: str
    parent_rn_no: str = ""
    parent_rn_date: str = ""
    parent_ern_id: Optional[str] = None        # for chained ERNs (residual undecided extra)
    parent_ern_no: Optional[str] = ""
    chain_remarks: str = ""
    invoice_no: str = ""
    invoice_date: str = ""
    goods_received_date: str = ""              # carried from parent at create time
    items: List[ExtraReceivedNoteItem] = []
    # Status values (approval-workflow set):
    #   PENDING_APPROVAL : created, awaiting a whole-note approve/reject decision
    #   APPROVED         : decided; full extra qty is rackable; not yet fully racked
    #   REJECTED         : decided; terminal; never rackable
    #   COMPLETE         : APPROVED and its Racking Note is fully RECORDED
    status: str = "PENDING_APPROVAL"
    decided_at: Optional[str] = None
    decided_by: Optional[str] = None
    finalized_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""
    # Derived on read: True once a Racking Note sourced from THIS note is RECORDED.
    # Drives the UI's edit gate — the note stays editable until stock actually moves.
    has_recorded_racking: Optional[bool] = False
    narration: Optional[str] = ""

class RackingNoteItem(BaseModel):
    part_no: str
    make: str
    quantity: float
    # Denormalized stock master fields (filled at create time)
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""
    # Location (set when user fills in cascading dropdowns)
    godown_id: Optional[str] = ""
    godown_name: Optional[str] = ""
    rack_id: Optional[str] = ""
    rack_no: Optional[str] = ""
    box_id: Optional[str] = ""
    box_no: Optional[str] = ""
    box_category: Optional[str] = ""


class RackingNoteCreate(BaseModel):
    # Polymorphic source — any of these can supply rackable quantity.
    # Legacy clients may still send only receipt_note_id (back-compat: source_type="RN").
    source_type: Optional[str] = None    # "RN" | "SRN" | "ERN"
    source_id: Optional[str] = None
    receipt_note_id: Optional[str] = None  # legacy field, ignored if source_id given
    items: List[RackingNoteItem] = []
    narration: Optional[str] = ""
    # Optional client-generated token so a retried/duplicated submit (double-click,
    # network retry) returns the already-created document instead of creating a duplicate.
    client_token: Optional[str] = None


class RackingNote(BaseModel):
    id: str
    rkn_no: str
    rkn_date: str
    fy: str
    serial: int
    # Polymorphic source. For legacy rows that only have receipt_note_id, source_type is "RN"
    # and source_id == receipt_note_id (set during startup migration).
    source_type: str = "RN"             # "RN" | "SRN" | "ERN"
    source_id: str = ""
    source_no: str = ""                  # display string ("RN/26-27/001" etc)
    source_date: str = ""
    # Legacy fields retained for back-compat / display in old code paths.
    receipt_note_id: str = ""           # always points to the ULTIMATE parent RN, even when source is SRN/ERN
    receipt_note_no: str = ""
    receipt_note_date: str = ""
    items: List[RackingNoteItem] = []
    status: str = "DRAFT"  # DRAFT | RECORDED
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    # Auto-creation provenance (NEW — Rule 1/2/3 of RN→SRN→RKN auto-workflow)
    auto_created: bool = False
    # one of: "rn-finalize" | "rkn-record-balance" | "srn-child-save" | "ern-child-save"
    auto_source: Optional[str] = None
    narration: Optional[str] = ""


class IssueNoteItem(BaseModel):
    part_no: str
    make: str
    # 1-based position of this line on the note, assigned at save time. The same
    # part/make may legitimately appear on several lines (e.g. 15 for one purpose and 5
    # for another), so part+make alone cannot identify a line — picking rows carry this
    # through to stay mapped to the exact line they were raised against.
    line_no: Optional[int] = None
    # None = "open quantity": the office user could not predict how much a godown
    # package actually holds, so the store incharge fills it in on the Picking Note.
    # An open line is uncapped (bounded only by real stock) and is resolved as soon
    # as any quantity is picked/rejected against it.
    quantity: Optional[float] = None
    # Optional office-selected godown preference — narrows which locations
    # allocated_locations may be drawn from.
    selected_godown_id: Optional[str] = None
    selected_godown_name: Optional[str] = None
    # Denormalized stock master fields (for display only)
    model: Optional[str] = ""
    description_1: Optional[str] = ""
    item_category: Optional[str] = ""
    # Suggested picking locations — computed server-side (greedy-fill across existing
    # stock locations) at create/edit time, pre-filled onto the Picking Note. Not a
    # lock: the store user may accept, partially pick, or choose a different valid
    # location (see _validate_picking_constraints). Each entry:
    # {godown_id, godown_name, rack_id, rack_no, box_id, box_no, box_category, quantity}.
    allocated_locations: Optional[List[dict]] = Field(default_factory=list)


class StockOutTypeCreate(BaseModel):
    """User-maintained Issue Note classification (Sale / Transfer / Return / …).

    Kept as a master list rather than free text so the same classification is spelled
    identically on every Issue Note — new values are created once, then reused.
    """
    name: str


class StockOutType(BaseModel):
    id: str
    name: str
    created_at: str
    created_by: str = ""


class IssueNoteCreate(BaseModel):
    # Name of a stock_out_types entry. Free-form on the wire so the UI can create and
    # use a new type in one step; normalized/registered server-side.
    stock_out_type: Optional[str] = ""
    # Optional pointer to whatever paper/ERP document triggered this issue.
    reference_doc_name: Optional[str] = ""
    reference_doc_date: Optional[str] = ""     # ISO "YYYY-MM-DD"
    reference_doc_no: Optional[str] = ""
    items: List[IssueNoteItem] = []
    assigned_to_user_id: Optional[str] = None
    narration: Optional[str] = ""
    # True -> land as DRAFT (no Picking Note yet; use POST .../finalize when ready).
    # False (default) -> unchanged existing behavior: immediately PENDING with its
    # Picking Note auto-created, same as before this field existed.
    save_as_draft: Optional[bool] = False


class IssueNote(BaseModel):
    id: str
    in_no: str
    in_date: str
    fy: str
    serial: int
    stock_out_type: Optional[str] = ""
    reference_doc_name: Optional[str] = ""
    reference_doc_date: Optional[str] = ""
    reference_doc_no: Optional[str] = ""
    items: List[IssueNoteItem] = []
    # DRAFT is an internal pre-finalize marker only (gates /finalize; no Picking Note
    # exists yet; always shown as "Pending" in the UI). Once finalized (or created
    # directly as final), the active 3-status set applies: PENDING (nothing
    # picked/rejected yet) -> IN_PROCESS (some picked/rejected, some pending) ->
    # COMPLETE (picked+rejected == requested for every line). Legacy
    # PICKING_PENDING/PICKING_IN_PROGRESS/PARTIALLY_PICKED/FULLY_PICKED/OPEN are
    # migrated on startup.
    status: str = "PENDING"
    picked_at: Optional[str] = None
    narration: Optional[str] = ""
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""


class PickingNoteItem(BaseModel):
    part_no: str
    make: str
    # Which Issue Note line this row picks against (see IssueNoteItem.line_no). Kept so
    # two lines of the same part/make never merge into one picking row.
    line_no: Optional[int] = None
    quantity: float  # picked qty (physically issued); 0 = this line was left unpicked
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""
    godown_id: Optional[str] = ""
    godown_name: Optional[str] = ""
    rack_id: Optional[str] = ""
    rack_no: Optional[str] = ""
    box_id: Optional[str] = ""
    box_no: Optional[str] = ""
    box_category: Optional[str] = ""
    # Legacy: rejection is no longer captured on the Picking Note (the picker simply
    # picks what is actually there). Kept so historical notes still deserialize and
    # their recorded values keep showing in read-only views.
    rejected_qty: Optional[float] = 0
    rejection_reason: Optional[str] = ""


class PickingNoteCreate(BaseModel):
    issue_note_id: str
    items: List[PickingNoteItem] = []


class PickingNote(BaseModel):
    id: str
    pn_no: str
    pn_date: str
    fy: str
    serial: int
    issue_note_id: str
    issue_note_no: str = ""
    issue_note_date: str = ""
    parent_picking_note_id: Optional[str] = None
    assigned_items: List[IssueNoteItem] = []
    items: List[PickingNoteItem] = []
    status: str = "PENDING"  # PENDING | DRAFT | COMPLETED | RECORDED(legacy)
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""


# ===================== STOCK TRANSFER =====================
class TransferRequestItem(BaseModel):
    part_no: str
    make: str
    quantity: float
    # Optional source preference — as specific as the requester knows (godown only,
    # godown+rack, or full godown+rack+box). Whatever is left blank is auto-resolved
    # against current inventory when the Transfer Note is prepared (see
    # prepare_transfer_note / _allocate_locations_for).
    src_godown_id: Optional[str] = ""
    src_godown_name: Optional[str] = ""
    src_rack_id: Optional[str] = ""
    src_rack_no: Optional[str] = ""
    src_box_id: Optional[str] = ""
    src_box_no: Optional[str] = ""
    src_box_category: Optional[str] = ""
    # Optional destination preference (the Transfer Note can override)
    dest_godown_id: Optional[str] = ""
    dest_godown_name: Optional[str] = ""
    dest_rack_id: Optional[str] = ""
    dest_rack_no: Optional[str] = ""
    dest_box_id: Optional[str] = ""
    dest_box_no: Optional[str] = ""
    dest_box_category: Optional[str] = ""


class TransferRequestCreate(BaseModel):
    purpose: str = ""  # free-form reason for the transfer
    items: List[TransferRequestItem] = []
    assigned_to_user_id: Optional[str] = None


class TransferRequest(BaseModel):
    id: str
    str_no: str
    str_date: str
    fy: str
    serial: int
    purpose: str = ""
    items: List[TransferRequestItem] = []
    # Active 3-status set: PENDING (nothing transferred/rejected yet) -> IN_PROCESS
    # (some transferred/rejected, some pending) -> COMPLETE (transferred+rejected ==
    # requested for every line). Legacy NEW/IN_PROGRESS/COMPLETED/CLOSED/CANCELLED
    # are migrated on startup.
    status: str = "PENDING"
    transferred_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""


class TransferNoteItem(BaseModel):
    part_no: str
    make: str
    quantity: float  # transferred qty (physically moved)
    # Partial-transfer-with-rejection (does not move stock; resolves the request
    # without a follow-up transfer). quantity + rejected_qty <= requested qty.
    rejected_qty: Optional[float] = 0
    rejection_reason: Optional[str] = ""
    # Master snapshot
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""
    # Source location (picked from)
    src_godown_id: str
    src_godown_name: Optional[str] = ""
    src_rack_id: str
    src_rack_no: Optional[str] = ""
    src_box_id: Optional[str] = ""
    src_box_no: Optional[str] = ""
    src_box_category: Optional[str] = ""
    # Destination location (placed at)
    dest_godown_id: str
    dest_godown_name: Optional[str] = ""
    dest_rack_id: Optional[str] = ""
    dest_rack_no: Optional[str] = ""
    dest_box_id: Optional[str] = ""
    dest_box_no: Optional[str] = ""
    dest_box_category: Optional[str] = ""


class TransferNoteCreate(BaseModel):
    transfer_request_id: str
    items: List[TransferNoteItem] = []


class TransferNote(BaseModel):
    id: str
    stn_no: str
    stn_date: str
    fy: str
    serial: int
    transfer_request_id: str
    transfer_request_no: str = ""
    transfer_request_date: str = ""
    parent_transfer_note_id: Optional[str] = None
    execution_attempt: int = 1
    assigned_items: List[TransferRequestItem] = []
    items: List[TransferNoteItem] = []
    status: str = "PENDING"  # PENDING | DRAFT | PROCESSING | COMPLETED | CANCELLED | RECORDED(legacy)
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""
