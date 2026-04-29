"""Pydantic models for the Stock Management System.

Extracted from server.py during the routes refactor (no logic changes).
All models are imported back into server.py via `from models import *`.
"""
from typing import List, Optional
from pydantic import BaseModel, Field

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
    quantity: int
    godown_id: str
    rack_id: str
    box_id: str


class StockOutCreate(BaseModel):
    part_no: str
    make: str
    quantity: int
    godown_id: str
    rack_id: str
    box_id: str


class ReceiptNoteItem(BaseModel):
    part_no: str
    make: str
    invoice_qty: float                       # what the invoice claims (== received_qty for GENERAL stock-in)
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
    invoice_no: Optional[str] = ""
    invoice_date: Optional[str] = ""           # ISO "YYYY-MM-DD"
    goods_received_date: Optional[str] = ""    # ISO "YYYY-MM-DD"
    items: List[ReceiptNoteItem] = []
    assigned_to_user_id: Optional[str] = None  # null = unassigned (anyone with module access can rack)


class ReceiptNote(BaseModel):
    id: str
    rn_no: str
    rn_date: str  # ISO "YYYY-MM-DD"
    fy: str
    serial: int
    stock_in_type: str = "INVOICE"
    invoice_no: str = ""
    invoice_date: str = ""
    goods_received_date: str = ""
    items: List[ReceiptNoteItem] = []
    # New flow: DRAFT -> FINAL -> PARTIALLY_RACKED -> FULLY_RACKED
    # Legacy "RACKING_PENDING" is migrated to "FINAL" on startup.
    status: str = "DRAFT"
    finalized_at: Optional[str] = None
    racked_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""
    # Derived on read: True iff at least one Racking Note (DRAFT or RECORDED) references this RN.
    # Frontend uses this to lock edit/delete, overriding the status-based heuristic.
    has_racking_note: Optional[bool] = False

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
    # Status semantics (computed off items):
    #   PENDING            : sum(fulfilled_qty) == 0
    #   PARTIALLY_RECEIVED : 0 < sum(fulfilled_qty) < sum(short_qty)
    #   FULLY_RECEIVED     : sum(fulfilled_qty) == sum(short_qty)
    # Racking visibility: as soon as any fulfilled_qty > 0 is recorded, the SRN is rackable
    # (the partially-received qty is physically in hand). The SRN does NOT need to be in
    # FULLY_RECEIVED state for racking to consume it.
    status: str = "PENDING"
    finalized_at: Optional[str] = None         # the LAST time the user clicked Save Final
    racking_status: str = "RACKING_PENDING"    # RACKING_PENDING | PARTIALLY_RACKED | FULLY_RACKED
    racked_at: Optional[str] = None
    created_at: str
    created_by: str = ""                       # email or "system" when auto-generated
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""


# ===================== EXTRA RECEIVED NOTES (Phase 1: auto-created stubs) =====================

class ExtraReceivedNoteItem(BaseModel):
    part_no: str
    make: str
    invoice_qty: float = 0                    # invoice qty on the parent RN row
    received_qty: float = 0                   # received qty on the parent RN row
    extra_qty: float                          # qty over the invoice (= received_qty - invoice_qty)
    accepted_qty: Optional[float] = None      # filled when finalized; rackable
    rejected_qty: Optional[float] = None      # filled when finalized; returned to supplier (NOT rackable)
    model: Optional[str] = ""
    old_part_no: Optional[str] = ""
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    item_category: Optional[str] = ""
    # Legacy alias - mirrors accepted_qty for the racking pipeline.
    quantity: Optional[float] = None
    # Slice-model: list of accepted batches. Each entry references a child ERN
    # holding the accepted portion. {child_ern_id, child_ern_no, accepted_qty,
    # accepted_date, created_at}.
    children: Optional[List[dict]] = []


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
    # Status semantics (computed off items):
    #   PENDING             : accepted == 0 AND rejected == 0
    #   PARTIALLY_ACCEPTED  : accepted > 0 AND rejected == 0 AND accepted < extra
    #   PARTIALLY_REJECTED  : accepted == 0 AND rejected > 0 AND rejected < extra
    #   COMPLETE            : accepted + rejected == extra
    # When the user finalizes an ERN with accepted+rejected < extra, a CHILD ERN is auto-created
    # for the residual undecided qty.
    status: str = "PENDING"
    finalized_at: Optional[str] = None
    racking_status: str = "RACKING_PENDING"
    racked_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""

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


class IssueNoteItem(BaseModel):
    part_no: str
    make: str
    quantity: float
    # Denormalized stock master fields (for display only)
    model: Optional[str] = ""
    description_1: Optional[str] = ""
    item_category: Optional[str] = ""


class IssueNoteCreate(BaseModel):
    issued_to: str = ""
    items: List[IssueNoteItem] = []
    assigned_to_user_id: Optional[str] = None


class IssueNote(BaseModel):
    id: str
    in_no: str
    in_date: str
    fy: str
    serial: int
    issued_to: str = ""
    items: List[IssueNoteItem] = []
    status: str = "PICKING_PENDING"  # PICKING_PENDING | PARTIALLY_PICKED | FULLY_PICKED
    picked_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""


class PickingNoteItem(BaseModel):
    part_no: str
    make: str
    quantity: float
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
    issued_to: str = ""
    items: List[PickingNoteItem] = []
    status: str = "DRAFT"  # DRAFT | RECORDED
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""


# ===================== STOCK TRANSFER =====================
class TransferRequestItem(BaseModel):
    part_no: str
    make: str
    quantity: float
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
    status: str = "PENDING"  # PENDING | PARTIALLY_TRANSFERRED | FULLY_TRANSFERRED
    transferred_at: Optional[str] = None
    created_at: str
    created_by: str = ""
    assigned_to_user_id: Optional[str] = None
    assigned_to_name: Optional[str] = ""
    assigned_to_email: Optional[str] = ""


class TransferNoteItem(BaseModel):
    part_no: str
    make: str
    quantity: float
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
    dest_rack_id: str
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
    items: List[TransferNoteItem] = []
    status: str = "DRAFT"  # DRAFT | RECORDED
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""


