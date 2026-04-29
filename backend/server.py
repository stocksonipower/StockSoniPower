from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import io
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional, Dict, Any

import bcrypt
import jwt
import pandas as pd
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, Query, Response, Header
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pydantic import BaseModel, Field, EmailStr, ConfigDict

from storage import init_storage, put_object, get_object, build_path


# -------------------- DB / APP SETUP --------------------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI(title="Stock Management API")
api_router = APIRouter(prefix="/api")

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
bearer_scheme = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# -------------------- HELPERS --------------------
# Modules a Staff user can be granted/denied access to. Admin always has access.
APP_MODULES = (
    "stock_master",
    "locations",
    "stock_in",
    "stock_out",
    "stock_transfer",
    "stock_summary",
    "low_stock",
    "transactions",
    "item_details",
)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=7),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)):
    if not credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0, "password_hash": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if user.get("is_active") is False:
        raise HTTPException(status_code=403, detail="Account deactivated. Contact your administrator.")
    return user


async def require_admin(user=Depends(get_current_user)):
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def _module_dep(module_key: str):
    """Returns a FastAPI dependency that allows admins always, and staff only if their module_access map permits."""
    async def _dep(user=Depends(get_current_user)):
        if user.get("role") == "admin":
            return user
        access = user.get("module_access") or {}
        if access.get(module_key, True) is False:  # default-allow if key missing
            raise HTTPException(status_code=403, detail=f"Access denied: you don't have permission to use the '{module_key}' module")
        return user
    return _dep


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# -------------------- NOTIFICATIONS HELPER --------------------
# Notifications are stored in `notifications` collection. Each row has:
#   id, created_at, actor_id, actor_name, actor_email,
#   type, module, title, message,
#   ref_collection, ref_id,
#   audience: "admin" | "module" | "user",
#   target_user_id  (only when audience=="user"),
#   read_by: [user_id, ...]
#
# Visibility rules (computed at GET time):
#   - audience=="admin"  → admins only
#   - audience=="module" → admins + staff with module_access[module] != False
#   - audience=="user"   → only the target user
NOTIFICATION_AUDIENCES = ("admin", "module", "user")


async def _notify(
    actor: Optional[dict],
    type: str,
    title: str,
    message: str = "",
    *,
    module: Optional[str] = None,
    audience: str = "admin",
    target_user_id: Optional[str] = None,
    ref_collection: Optional[str] = None,
    ref_id: Optional[str] = None,
):
    """Insert a notification row. Failures are swallowed (notifications must never break a real operation)."""
    try:
        if audience not in NOTIFICATION_AUDIENCES:
            audience = "admin"
        doc = {
            "id": str(uuid.uuid4()),
            "created_at": now_iso(),
            "actor_id": (actor or {}).get("id"),
            "actor_name": (actor or {}).get("name") or (actor or {}).get("email") or "system",
            "actor_email": (actor or {}).get("email"),
            "type": type,
            "module": module,
            "title": title,
            "message": message,
            "ref_collection": ref_collection,
            "ref_id": ref_id,
            "audience": audience,
            "target_user_id": target_user_id,
            "read_by": [],
        }
        await db.notifications.insert_one(doc)
    except Exception as e:
        logger.warning(f"_notify failed: {e}")


# -------------------- ASSIGNMENT HELPERS (Phase 3) --------------------
async def _resolve_assignee(user_id: Optional[str], module: str) -> dict:
    """Validate and resolve an assignee user_id into name/email fields. Returns {} if user_id is empty."""
    if not user_id:
        return {"assigned_to_user_id": None, "assigned_to_name": "", "assigned_to_email": ""}
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    if not u:
        raise HTTPException(status_code=400, detail="Assigned user not found")
    if u.get("is_active") is False:
        raise HTTPException(status_code=400, detail="Cannot assign to a deactivated user")
    if u.get("role") != "admin":
        access = u.get("module_access") or {}
        if access.get(module, True) is False:
            raise HTTPException(status_code=400, detail=f"User does not have access to '{module}' module")
    return {
        "assigned_to_user_id": u["id"],
        "assigned_to_name": u.get("name") or u.get("email", ""),
        "assigned_to_email": u.get("email", ""),
    }


def _enforce_assignee(parent_note: dict, user: dict, action: str):
    """Raise 403 if note is assigned to someone else and current user is neither admin nor the assignee.
    No-op if note is unassigned or current user is admin or matches assignee."""
    if user.get("role") == "admin":
        return
    a = parent_note.get("assigned_to_user_id")
    if not a:
        return  # unassigned -> any user with module access can act
    if a == user.get("id"):
        return
    name = parent_note.get("assigned_to_name") or parent_note.get("assigned_to_email") or "another user"
    raise HTTPException(
        status_code=403,
        detail=f"Cannot {action}: this note is assigned to {name}.",
    )


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


# -------------------- AUTH ROUTES --------------------
@api_router.post("/auth/login", response_model=AuthResponse)
async def login(payload: UserLogin):
    email = payload.email.lower()
    user = await db.users.find_one({"email": email})
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if user.get("is_active") is False:
        raise HTTPException(status_code=403, detail="Account deactivated. Contact your administrator.")
    # Lockout check
    lock_until = user.get("lockout_until")
    if lock_until:
        try:
            until = datetime.fromisoformat(lock_until)
        except Exception:
            until = None
        if until and datetime.now(timezone.utc) < until:
            mins = max(1, int((until - datetime.now(timezone.utc)).total_seconds() // 60) + 1)
            raise HTTPException(status_code=423, detail=f"Account locked due to repeated failed logins. Try again in ~{mins} minute(s).")
    # Password check
    if not verify_password(payload.password, user.get("password_hash", "")):
        attempts = (user.get("failed_login_attempts") or 0) + 1
        update = {"failed_login_attempts": attempts}
        if attempts >= 5:
            until = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
            update["lockout_until"] = until
            update["failed_login_attempts"] = 0
        await db.users.update_one({"id": user["id"]}, {"$set": update})
        if attempts >= 5:
            # Lockout triggered → notify admins
            await _notify(
                actor={"id": user["id"], "name": user.get("name"), "email": email},
                type="auth.lockout",
                title="Account locked",
                message=f"{email} was locked for 15 minutes after 5 failed login attempts.",
                audience="admin",
                ref_collection="users", ref_id=user["id"],
            )
        raise HTTPException(status_code=401, detail="Invalid credentials")
    # Success: reset counters, set last_login
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"failed_login_attempts": 0, "last_login": now_iso()}, "$unset": {"lockout_until": ""}},
    )
    await _notify(
        actor={"id": user["id"], "name": user.get("name"), "email": email},
        type="auth.login",
        title="User signed in",
        message=f"{user.get('name') or email} signed in.",
        audience="admin",
        ref_collection="users", ref_id=user["id"],
    )
    token = create_access_token(user["id"], email)
    return {
        "token": token,
        "user": {
            "id": user["id"], "email": email,
            "name": user.get("name", ""),
            "role": user.get("role", "staff"),
            "is_active": user.get("is_active", True),
            "module_access": user.get("module_access") or {},
            "force_password_reset": user.get("force_password_reset", False),
        },
    }


@api_router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


@api_router.put("/auth/me")
async def update_my_profile(payload: ProfileUpdate, user=Depends(get_current_user)):
    """Self-service: edit own name and/or password (cannot change own role)."""
    update = {}
    if payload.name is not None:
        update["name"] = payload.name.strip()
    if payload.password:
        if len(payload.password) < 6:
            raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
        update["password_hash"] = hash_password(payload.password)
        update["force_password_reset"] = False
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.users.update_one({"id": user["id"]}, {"$set": update})
    return {"ok": True}


# -------------------- USER MANAGEMENT (admin only) --------------------
def _user_to_public(user: dict) -> dict:
    return {
        "id": user["id"],
        "email": user.get("email", ""),
        "name": user.get("name", ""),
        "role": user.get("role", "staff"),
        "is_active": user.get("is_active", True),
        "module_access": user.get("module_access") or {},
        "force_password_reset": user.get("force_password_reset", False),
        "last_login": user.get("last_login"),
        "created_at": user.get("created_at"),
        "lockout_until": user.get("lockout_until"),
    }


@api_router.get("/users")
async def list_users(admin=Depends(require_admin)):
    rows = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(5000)
    return [_user_to_public(u) for u in rows]


@api_router.post("/users")
async def create_user(payload: UserCreate, admin=Depends(require_admin)):
    if payload.role not in ("admin", "staff"):
        raise HTTPException(status_code=400, detail="Role must be 'admin' or 'staff'")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    email = payload.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="Email already in use")
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "name": payload.name.strip(),
        "password_hash": hash_password(payload.password),
        "role": payload.role,
        "is_active": True,
        "module_access": payload.module_access or {m: True for m in APP_MODULES},
        "force_password_reset": payload.force_password_reset,
        "failed_login_attempts": 0,
        "created_at": now_iso(),
        "created_by": admin.get("email"),
    }
    await db.users.insert_one(doc)
    await _notify(
        actor=admin, type="user.created", title="New user created",
        message=f"{admin.get('email')} created user {email} ({payload.role}).",
        audience="admin", ref_collection="users", ref_id=user_id,
    )
    return _user_to_public(doc)


@api_router.put("/users/{user_id}")
async def update_user(user_id: str, payload: UserUpdate, admin=Depends(require_admin)):
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    update = {}
    if payload.name is not None:
        update["name"] = payload.name.strip()
    if payload.email is not None:
        new_email = payload.email.lower()
        if new_email != target.get("email"):
            if await db.users.find_one({"email": new_email, "id": {"$ne": user_id}}):
                raise HTTPException(status_code=400, detail="Email already in use")
            update["email"] = new_email
    if payload.role is not None:
        if payload.role not in ("admin", "staff"):
            raise HTTPException(status_code=400, detail="Role must be 'admin' or 'staff'")
        if user_id == admin["id"] and payload.role != "admin":
            raise HTTPException(status_code=400, detail="Cannot change your own role")
        update["role"] = payload.role
    if payload.password:
        if len(payload.password) < 6:
            raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
        update["password_hash"] = hash_password(payload.password)
    if payload.is_active is not None:
        if user_id == admin["id"] and payload.is_active is False:
            raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
        update["is_active"] = payload.is_active
        if payload.is_active is True:
            # On reactivation, also clear any lockout
            update["failed_login_attempts"] = 0
            await db.users.update_one({"id": user_id}, {"$unset": {"lockout_until": ""}})
    if payload.module_access is not None:
        # only allow keys we know about; coerce values to bool
        cleaned = {k: bool(v) for k, v in payload.module_access.items() if k in APP_MODULES}
        update["module_access"] = cleaned
    if payload.force_password_reset is not None:
        update["force_password_reset"] = payload.force_password_reset
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update")
    await db.users.update_one({"id": user_id}, {"$set": update})
    fresh = await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})
    # Targeted user-level notification for status changes; admin feed for everything else
    if "is_active" in update:
        await _notify(
            actor=admin,
            type="user.deactivated" if update["is_active"] is False else "user.reactivated",
            title=("User deactivated" if update["is_active"] is False else "User reactivated"),
            message=f"{admin.get('email')} {'deactivated' if update['is_active'] is False else 'reactivated'} {target.get('email')}.",
            audience="admin", ref_collection="users", ref_id=user_id,
        )
    elif update:
        await _notify(
            actor=admin, type="user.updated", title="User updated",
            message=f"{admin.get('email')} updated {target.get('email')} ({', '.join(k for k in update.keys() if k != 'password_hash')}).",
            audience="admin", ref_collection="users", ref_id=user_id,
        )
    return _user_to_public(fresh)


@api_router.delete("/users/{user_id}")
async def deactivate_user(user_id: str, admin=Depends(require_admin)):
    """Soft delete: deactivate. Records remain attributed to the user."""
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    target = await db.users.find_one({"id": user_id})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one({"id": user_id}, {"$set": {"is_active": False, "deactivated_at": now_iso()}})
    await _notify(
        actor=admin, type="user.deactivated", title="User deactivated",
        message=f"{admin.get('email')} deactivated {target.get('email')}.",
        audience="admin", ref_collection="users", ref_id=user_id,
    )
    return {"ok": True, "deactivated": True}


@api_router.get("/meta/modules")
async def list_modules(user=Depends(get_current_user)):
    return {"modules": list(APP_MODULES)}


@api_router.get("/users/assignable")
async def list_assignable_users(module: Optional[str] = None, user=Depends(get_current_user)):
    """List active users that can be assigned to a workflow note. Auth-only (any logged-in user).
    Optional `module` filter returns only users whose module_access permits that module
    (admins always included)."""
    rows = await db.users.find(
        {"is_active": {"$ne": False}},
        {"_id": 0, "id": 1, "email": 1, "name": 1, "role": 1, "module_access": 1},
    ).sort("name", 1).to_list(5000)
    out = []
    for u in rows:
        if module and u.get("role") != "admin":
            access = u.get("module_access") or {}
            if access.get(module, True) is False:
                continue
        out.append({
            "id": u["id"],
            "email": u.get("email", ""),
            "name": u.get("name", ""),
            "role": u.get("role", "staff"),
        })
    return out


# -------------------- NOTIFICATIONS API --------------------
def _notif_visibility_filter(user: dict) -> dict:
    """Build a Mongo filter that matches only notifications the given user can see."""
    is_admin = user.get("role") == "admin"
    if is_admin:
        # Admins see everything
        return {}
    access = user.get("module_access") or {}
    # Modules the staff user is allowed to see
    allowed_modules = [m for m in APP_MODULES if access.get(m, True) is not False]
    return {
        "$or": [
            {"audience": "user", "target_user_id": user["id"]},
            {"audience": "module", "module": {"$in": allowed_modules}},
        ]
    }


def _notif_to_public(n: dict, user_id: str) -> dict:
    return {
        "id": n["id"],
        "created_at": n.get("created_at"),
        "actor_id": n.get("actor_id"),
        "actor_name": n.get("actor_name"),
        "actor_email": n.get("actor_email"),
        "type": n.get("type"),
        "module": n.get("module"),
        "title": n.get("title", ""),
        "message": n.get("message", ""),
        "ref_collection": n.get("ref_collection"),
        "ref_id": n.get("ref_id"),
        "audience": n.get("audience"),
        "read": user_id in (n.get("read_by") or []),
    }


@api_router.get("/notifications")
async def list_notifications(
    response: Response,
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=500),
    user=Depends(get_current_user),
):
    q = _notif_visibility_filter(user)
    if unread_only:
        q = {**q, "read_by": {"$nin": [user["id"]]}}
    rows = await db.notifications.find(q, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
    unread = await db.notifications.count_documents({**_notif_visibility_filter(user), "read_by": {"$nin": [user["id"]]}})
    response.headers["X-Unread-Count"] = str(unread)
    response.headers["Access-Control-Expose-Headers"] = "X-Unread-Count"
    return {"items": [_notif_to_public(r, user["id"]) for r in rows], "unread_count": unread}


@api_router.get("/notifications/unread-count")
async def unread_count(user=Depends(get_current_user)):
    q = {**_notif_visibility_filter(user), "read_by": {"$nin": [user["id"]]}}
    n = await db.notifications.count_documents(q)
    return {"unread_count": n}


class MarkReadRequest(BaseModel):
    ids: Optional[List[str]] = None  # if None or empty → mark ALL visible as read


@api_router.post("/notifications/mark-read")
async def mark_read(payload: MarkReadRequest, user=Depends(get_current_user)):
    base = _notif_visibility_filter(user)
    if payload.ids:
        q = {**base, "id": {"$in": payload.ids}}
    else:
        q = base
    res = await db.notifications.update_many(q, {"$addToSet": {"read_by": user["id"]}})
    return {"updated": res.modified_count}


# -------------------- STOCK MASTER --------------------
@api_router.post("/stock-master", response_model=StockMaster)
async def create_stock_master(payload: StockMasterCreate, user=Depends(get_current_user)):
    part_no = payload.part_no.strip()
    make = payload.make.strip()
    if not part_no or not make:
        raise HTTPException(status_code=400, detail="part_no and make are required")
    if payload.images and len(payload.images) > 5:
        raise HTTPException(status_code=400, detail="A maximum of 5 images is allowed per item")
    existing = await db.stock_master.find_one({"part_no": part_no, "make": make})
    if existing:
        raise HTTPException(status_code=400, detail="Item with this part_no + make already exists")
    doc = payload.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = now_iso()
    await db.stock_master.insert_one(doc)
    doc.pop("_id", None)
    await _notify(
        actor=user, type="stock_master.created", module="stock_master",
        title="Stock master item added",
        message=f"{user.get('email')} added {part_no} / {make}.",
        audience="module", ref_collection="stock_master", ref_id=doc["id"],
    )
    return doc


# Whitelist of fields that may be filtered/sorted via query params (security)
_FILTERABLE_FIELDS = {
    "model", "part_no", "old_part_no", "new_part_no", "make_part_no",
    "description_1", "description_2",
    "remarks_oem", "remarks_others",
    "make", "item_category", "unit", "reorder_level",
}
# Sentinel used by frontend to represent "blank/empty" cells in column filters
_BLANK_TOKEN = "(Blanks)"


@api_router.get("/stock-master", response_model=List[StockMaster])
async def list_stock_master(
    request: Request,
    response: Response,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    sort_by: Optional[str] = None,
    sort_dir: Optional[str] = None,   # "asc" | "desc"
    user=Depends(get_current_user),
):
    """List stock master items.

    Supports:
      - `search` (free text across multiple fields)
      - `page` / `page_size` (pagination)
      - `sort_by` / `sort_dir` (server-side sort on a whitelisted field)
      - `filter[<field>]` repeated query params for column filters, e.g.
            ?filter[make]=Cummins&filter[make]=Tata
        A value of "(Blanks)" matches empty/missing values.
    """
    query: dict = {}

    # Free-text search across many fields
    if search:
        s = search.strip()
        query["$or"] = [
            {"part_no": {"$regex": s, "$options": "i"}},
            {"old_part_no": {"$regex": s, "$options": "i"}},
            {"new_part_no": {"$regex": s, "$options": "i"}},
            {"make_part_no": {"$regex": s, "$options": "i"}},
            {"description_1": {"$regex": s, "$options": "i"}},
            {"description_2": {"$regex": s, "$options": "i"}},
            {"remarks_oem": {"$regex": s, "$options": "i"}},
            {"remarks_others": {"$regex": s, "$options": "i"}},
            {"make": {"$regex": s, "$options": "i"}},
            {"item_category": {"$regex": s, "$options": "i"}},
        ]

    # Per-column filters: ?filter[make]=A&filter[make]=B  → make ∈ {A, B}
    # Also accept the "images" virtual filter: filter[images]=Has image / No image
    column_clauses: list = []
    for raw_key, raw_val in request.query_params.multi_items():
        if not (raw_key.startswith("filter[") and raw_key.endswith("]")):
            continue
        field = raw_key[len("filter["):-1]
        # Collect all values for this field (multi-select)
        values = request.query_params.getlist(raw_key)
        if not values:
            continue

        if field == "images":
            # Special case: "Has image" => images array non-empty OR legacy image set
            wants_has = "Has image" in values
            wants_none = "No image" in values
            sub = []
            if wants_has:
                sub.append({"$or": [
                    {"images": {"$exists": True, "$type": "array", "$ne": []}},
                    {"image": {"$exists": True, "$nin": [None, ""]}},
                ]})
            if wants_none:
                sub.append({"$and": [
                    {"$or": [
                        {"images": {"$exists": False}},
                        {"images": {"$size": 0}},
                    ]},
                    {"$or": [
                        {"image": {"$exists": False}},
                        {"image": {"$in": [None, ""]}},
                    ]},
                ]})
            if sub:
                column_clauses.append({"$or": sub} if len(sub) > 1 else sub[0])
            continue

        if field not in _FILTERABLE_FIELDS:
            continue  # silently ignore unknown fields

        concrete = [v for v in values if v != _BLANK_TOKEN]
        wants_blank = _BLANK_TOKEN in values

        sub = []
        if concrete:
            # For numeric reorder_level we need to coerce to int when possible
            if field == "reorder_level":
                ints = []
                for v in concrete:
                    try:
                        ints.append(int(float(v)))
                    except Exception:
                        pass
                if ints:
                    sub.append({field: {"$in": ints}})
            else:
                sub.append({field: {"$in": concrete}})
        if wants_blank:
            sub.append({"$or": [
                {field: {"$exists": False}},
                {field: None},
                {field: ""},
            ]})
        if sub:
            column_clauses.append({"$or": sub} if len(sub) > 1 else sub[0])

    if column_clauses:
        # Combine column filters with each other (AND), then with any existing query (AND)
        if len(column_clauses) == 1:
            query.update(column_clauses[0])
        else:
            query.setdefault("$and", []).extend(column_clauses)

    # Sort: default is created_at desc; otherwise whitelisted field
    if sort_by and sort_by in _FILTERABLE_FIELDS:
        direction = -1 if (sort_dir or "asc").lower() == "desc" else 1
        sort_spec = [(sort_by, direction)]
    else:
        sort_spec = [("created_at", -1)]

    total = await db.stock_master.count_documents(query)
    skip = (page - 1) * page_size
    items = await db.stock_master.find(query, {"_id": 0}).sort(sort_spec).skip(skip).limit(page_size).to_list(page_size)

    # Mark which items have transactions recorded against them
    used_pairs = set()
    if items:
        async for t in db.transactions.aggregate([
            {"$group": {"_id": {"part_no": "$part_no", "make": "$make"}}},
        ]):
            used_pairs.add((t["_id"]["part_no"], t["_id"]["make"]))
        for it in items:
            it["in_use"] = (it.get("part_no"), it.get("make")) in used_pairs

    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return items


@api_router.get("/stock-master/distinct/{field}")
async def stock_master_distinct(field: str, user=Depends(get_current_user)):
    """Return all distinct values of a field across the entire stock_master collection.
    Used by the column-filter dropdowns so they reflect the full DB (not just one page)."""
    if field == "images":
        # Special virtual column: only two possible values
        return {"values": ["Has image", "No image"]}
    if field not in _FILTERABLE_FIELDS:
        raise HTTPException(status_code=400, detail="Field not filterable")
    raw = await db.stock_master.distinct(field)
    out = []
    has_blank = False
    for v in raw:
        if v is None or v == "":
            has_blank = True
        else:
            out.append(v)
    # Numeric-aware sort for reorder_level, alphabetic otherwise
    if field == "reorder_level":
        out = sorted(out, key=lambda x: (x is None, x))
    else:
        out = sorted(out, key=lambda x: str(x).lower())
    if has_blank:
        out.append(_BLANK_TOKEN)
    return {"values": [str(v) if not isinstance(v, str) else v for v in out]}
@api_router.get("/stock-master/lookup/makes")
async def get_makes_for_part(part_no: str = Query(...), user=Depends(get_current_user)):
    makes = await db.stock_master.distinct("make", {"part_no": part_no})
    return {"makes": makes}


@api_router.get("/stock-master/lookup/item")
async def get_item_by_part_make(part_no: str, make: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@api_router.get("/stock-master/download/template")
async def download_template_route():
    import io as _io
    sample_rows = [
        ["1", "Model-X100", "3922900", "OPN-1001", "NPN-2001", "CUM-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Other remark sample",
         "Cummins", "Engine Parts", "PCS", "5"],
        ["2", "Model-X100", "3922900", "OPN-1001", "NPN-2001", "TATA-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Qty per box 1",
         "Tata", "Engine Parts", "PCS", "10"],
    ]
    data = [dict(zip(TEMPLATE_COLUMNS, row)) for row in sample_rows]
    df = pd.DataFrame(data)
    output = _io.BytesIO()
    with pd.ExcelWriter(output, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Stock Master')
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=stock_master_template.xlsx"},
    )


@api_router.get("/stock-master/download/export")
async def export_stock_master(user=Depends(get_current_user)):
    items = await db.stock_master.find({}, {"_id": 0}).sort("created_at", 1).to_list(100000)
    rows = []
    for idx, it in enumerate(items, start=1):
        rows.append([
            idx,
            it.get("model", ""),
            it.get("part_no", ""),
            it.get("old_part_no", ""),
            it.get("new_part_no", ""),
            it.get("make_part_no", ""),
            it.get("description_1", ""),
            it.get("description_2", ""),
            it.get("remarks_oem", ""),
            it.get("remarks_others", ""),
            it.get("make", ""),
            it.get("item_category", ""),
            it.get("unit", ""),
            it.get("reorder_level", 0) or 0,
        ])
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return _csv_response(rows, TEMPLATE_COLUMNS, f"stock_master_export_{ts}.csv")


# ============================================================================
# STOCK MASTER COLUMN SETTINGS — admin-editable order + widths, persisted in
# `column_settings` collection (page="stock_master"). All authed users may
# READ; only admins may WRITE.
# Routes are registered BEFORE /stock-master/{item_id} so the dynamic catch-all
# does not shadow them (FastAPI matches in declaration order).
# ============================================================================
DEFAULT_STOCK_MASTER_COLUMNS = [
    {"key": "model",          "label": "MODEL",          "width": 140, "order": 1,  "isNumeric": False, "isImage": False},
    {"key": "part_no",        "label": "PART NO",        "width": 160, "order": 2,  "isNumeric": False, "isImage": False},
    {"key": "old_part_no",    "label": "OLD PART NO",    "width": 160, "order": 3,  "isNumeric": False, "isImage": False},
    {"key": "new_part_no",    "label": "NEW PART NO",    "width": 160, "order": 4,  "isNumeric": False, "isImage": False},
    {"key": "make_part_no",   "label": "MAKE PART NO",   "width": 180, "order": 5,  "isNumeric": False, "isImage": False},
    {"key": "description_1",  "label": "DESCRIPTION 1",  "width": 240, "order": 6,  "isNumeric": False, "isImage": False},
    {"key": "description_2",  "label": "DESCRIPTION 2",  "width": 240, "order": 7,  "isNumeric": False, "isImage": False},
    {"key": "remarks_oem",    "label": "OEM",            "width": 200, "order": 8,  "isNumeric": False, "isImage": False},
    {"key": "remarks_others", "label": "REMARKS",        "width": 200, "order": 9,  "isNumeric": False, "isImage": False},
    {"key": "make",           "label": "MAKE",           "width": 140, "order": 10, "isNumeric": False, "isImage": False},
    {"key": "item_category",  "label": "ITEM CATEGORY",  "width": 160, "order": 11, "isNumeric": False, "isImage": False},
    {"key": "unit",           "label": "UNIT",           "width": 100, "order": 12, "isNumeric": False, "isImage": False},
    {"key": "reorder_level",  "label": "REORDER LEVEL",  "width": 130, "order": 13, "isNumeric": True,  "isImage": False},
    {"key": "images",         "label": "IMAGES",         "width": 120, "order": 99, "isNumeric": False, "isImage": True},
]


class ColumnSettingsPayload(BaseModel):
    columns: List[Dict[str, Any]]


@api_router.get("/stock-master/column-settings")
async def get_stock_master_column_settings(user=Depends(get_current_user)):
    """Return the current persisted columns for the Stock Master table.
    Falls back to DEFAULT_STOCK_MASTER_COLUMNS when no override has been saved.
    `is_admin` lets the frontend decide whether to expose the settings dialog."""
    doc = await db.column_settings.find_one({"page": "stock_master"}, {"_id": 0})
    cols = (doc or {}).get("columns") or DEFAULT_STOCK_MASTER_COLUMNS
    by_key = {c["key"]: c for c in cols}
    merged = []
    for d in DEFAULT_STOCK_MASTER_COLUMNS:
        existing = by_key.get(d["key"])
        if existing:
            merged.append({
                "key":       d["key"],
                "label":     existing.get("label", d["label"]),
                "width":     int(existing.get("width", d["width"]) or d["width"]),
                "order":     int(existing.get("order", d["order"]) or d["order"]),
                "isNumeric": bool(d["isNumeric"]),
                "isImage":   bool(d["isImage"]),
            })
        else:
            merged.append(d.copy())
    for c in merged:
        if c.get("isImage"):
            c["order"] = 99
    merged.sort(key=lambda c: c["order"])
    return {"columns": merged, "is_admin": user.get("role") == "admin"}


@api_router.put("/stock-master/column-settings")
async def put_stock_master_column_settings(payload: ColumnSettingsPayload, user=Depends(get_current_user)):
    """Persist new column order / widths. Admin only."""
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Only admins can change column settings")
    valid_keys = {c["key"] for c in DEFAULT_STOCK_MASTER_COLUMNS}
    cleaned = []
    for c in payload.columns:
        key = c.get("key")
        if key not in valid_keys:
            continue
        default = next((d for d in DEFAULT_STOCK_MASTER_COLUMNS if d["key"] == key), None)
        if not default:
            continue
        try:
            width = int(c.get("width") or default["width"])
            order = int(c.get("order") if c.get("order") is not None else default["order"])
        except (TypeError, ValueError):
            width, order = default["width"], default["order"]
        if default["isImage"]:
            order = 99
        width = max(60, min(800, width))
        cleaned.append({
            "key": key,
            "label": (c.get("label") or default["label"]).strip() or default["label"],
            "width": width,
            "order": order,
            "isNumeric": default["isNumeric"],
            "isImage":   default["isImage"],
        })
    saved_keys = {c["key"] for c in cleaned}
    next_order = (max((c["order"] for c in cleaned if c["order"] != 99), default=0) or 0) + 1
    for d in DEFAULT_STOCK_MASTER_COLUMNS:
        if d["key"] in saved_keys:
            continue
        added = d.copy()
        if not added["isImage"]:
            added["order"] = next_order
            next_order += 1
        cleaned.append(added)
    cleaned.sort(key=lambda c: c["order"])
    await db.column_settings.update_one(
        {"page": "stock_master"},
        {"$set": {"page": "stock_master", "columns": cleaned, "updated_at": now_iso(), "updated_by": user.get("email", "")}},
        upsert=True,
    )
    return {"columns": cleaned, "is_admin": True}


@api_router.get("/stock-master/{item_id}", response_model=StockMaster)
async def get_stock_master(item_id: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    return item


@api_router.put("/stock-master/{item_id}", response_model=StockMaster)
async def update_stock_master(item_id: str, payload: StockMasterCreate, user=Depends(get_current_user)):
    existing = await db.stock_master.find_one({"id": item_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    if payload.images and len(payload.images) > 5:
        raise HTTPException(status_code=400, detail="A maximum of 5 images is allowed per item")
    # Check uniqueness if part_no/make changed
    if existing["part_no"] != payload.part_no or existing["make"] != payload.make:
        conflict = await db.stock_master.find_one({"part_no": payload.part_no, "make": payload.make})
        if conflict:
            raise HTTPException(status_code=400, detail="Item with this part_no + make already exists")
    update_doc = payload.model_dump()
    await db.stock_master.update_one({"id": item_id}, {"$set": update_doc})
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    return item


@api_router.delete("/stock-master/{item_id}")
async def delete_stock_master(item_id: str, user=Depends(get_current_user)):
    item = await db.stock_master.find_one({"id": item_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Not found")
    # Block delete if any transaction (IN/OUT) exists for this part_no + make
    txn = await db.transactions.find_one({"part_no": item.get("part_no"), "make": item.get("make")})
    if txn:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete — transactions are recorded against {item.get('part_no')} / {item.get('make')}. Remove or reassign those transactions first.",
        )
    await db.stock_master.delete_one({"id": item_id})
    await _notify(
        actor=user, type="stock_master.deleted", module="stock_master",
        title="Stock master item deleted",
        message=f"{user.get('email')} deleted {item.get('part_no')} / {item.get('make')}.",
        audience="module", ref_collection="stock_master", ref_id=item_id,
    )
    return {"ok": True}


# Column header → internal field mapping (case + space insensitive)
COLUMN_ALIASES = {
    "sl no": None, "sl.no": None, "slno": None, "s no": None, "sr no": None,
    "model": "model",
    "part no": "part_no", "part_no": "part_no", "partno": "part_no", "part number": "part_no",
    "old no": "old_part_no", "old part no": "old_part_no", "old_part_no": "old_part_no",
    "new no": "new_part_no", "new part no": "new_part_no", "new_part_no": "new_part_no", "newpartno": "new_part_no",
    "make part no": "make_part_no", "make_part_no": "make_part_no", "makepartno": "make_part_no",
    "description 1": "description_1", "description_1": "description_1", "description1": "description_1", "desc 1": "description_1",
    "description 2": "description_2", "description_2": "description_2", "description2": "description_2", "desc 2": "description_2",
    # NOTE: UI labels were renamed (OEM, Remarks). DB keys remain remarks_oem/remarks_others for back-compat.
    "oem": "remarks_oem", "remarks oem": "remarks_oem", "remarks_oem": "remarks_oem", "oem no": "remarks_oem",
    "remarks": "remarks_others", "remark": "remarks_others", "remarks others": "remarks_others", "remarks_others": "remarks_others",
    "make": "make",
    "item category": "item_category", "item_category": "item_category", "category": "item_category",
    "unit": "unit", "uom": "unit", "u o m": "unit",
    "reorder level": "reorder_level", "reorder_level": "reorder_level", "reorder": "reorder_level", "min stock": "reorder_level",
}

TEMPLATE_COLUMNS = [
    "SL NO", "MODEL", "PART NO", "OLD PART NO", "NEW PART NO", "MAKE PART NO",
    "DESCRIPTION 1", "DESCRIPTION 2", "OEM", "REMARKS",
    "MAKE", "ITEM CATEGORY", "UNIT", "REORDER LEVEL"
]


def _normalize_col(c: str) -> str:
    return " ".join(str(c).strip().lower().split())


# -------------------- IMAGE UPLOAD / SERVE (Object Storage) --------------------
_ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


@api_router.post("/uploads/image")
async def upload_image(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Upload a single image to object storage. Returns {path, content_type, size}."""
    ct = (file.content_type or "").lower()
    if ct not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {ct or 'unknown'}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="Image too large (max 10MB)")
    ext = _ALLOWED_IMAGE_TYPES[ct]
    path = build_path(user["id"], ext)
    try:
        result = put_object(path, data, ct)
    except Exception as e:
        logger.error(f"Object storage upload failed: {e}")
        raise HTTPException(status_code=502, detail="Image upload failed")
    # Track in DB so we can soft-delete / audit later
    await db.uploads.insert_one({
        "id": str(uuid.uuid4()),
        "storage_path": result["path"],
        "content_type": ct,
        "size": result.get("size", len(data)),
        "uploaded_by": user["id"],
        "uploaded_by_email": user.get("email"),
        "is_deleted": False,
        "created_at": now_iso(),
    })
    return {"path": result["path"], "content_type": ct, "size": result.get("size", len(data))}


@api_router.get("/files/{file_path:path}")
async def serve_file(
    file_path: str,
    authorization: Optional[str] = Header(None),
    auth: Optional[str] = Query(None),
):
    """Serve an image stored in object storage. Auth via Bearer header OR ?auth=<token> query param.

    The query-param fallback is required because <img src="..."> cannot send headers.
    """
    # Resolve auth header — fall back to ?auth= for <img> tags
    auth_header = authorization or (f"Bearer {auth}" if auth else None)
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing token")
    token = auth_header.split(" ", 1)[1]
    try:
        decoded = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
    u = await db.users.find_one({"id": decoded.get("sub")}, {"_id": 0, "password": 0})
    if not u or u.get("is_active") is False:
        raise HTTPException(status_code=401, detail="User not found / disabled")

    # DB lookup — only serve files we know about
    record = await db.uploads.find_one({"storage_path": file_path, "is_deleted": False})
    if not record:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        data, content_type = get_object(file_path)
    except Exception as e:
        logger.error(f"Object storage download failed: {e}")
        raise HTTPException(status_code=502, detail="Image download failed")
    return Response(content=data, media_type=record.get("content_type", content_type))


@api_router.post("/stock-master/bulk-preview")
async def bulk_preview(file: UploadFile = File(...), user=Depends(get_current_user)):
    content = await file.read()
    file_name = file.filename or "unknown"

    try:
        if file_name.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")

    col_map = {}
    for col in df.columns:
        key = _normalize_col(col)
        if key in COLUMN_ALIASES and COLUMN_ALIASES[key]:
            col_map[col] = COLUMN_ALIASES[key]

    mapped_fields = set(col_map.values())
    if "part_no" not in mapped_fields or "make" not in mapped_fields:
        raise HTTPException(
            status_code=400,
            detail="File must contain PART NO and MAKE columns. Download the template for the correct format.",
        )

    pairs_in_file = []
    skipped_rows = 0
    for _, row in df.iterrows():
        part_no = ""
        make = ""
        for orig_col, field in col_map.items():
            val = str(row.get(orig_col, "") or "").strip()
            if field == "part_no":
                part_no = val
            elif field == "make":
                make = val
        if not part_no or not make:
            skipped_rows += 1
            continue
        pairs_in_file.append((part_no, make))

    total_items = len(pairs_in_file)

    if total_items == 0:
        return {
            "file_name": file_name,
            "total_items": 0,
            "new_items": 0,
            "duplicate_items": 0,
            "skipped_rows": skipped_rows,
        }

    or_query = [{"part_no": pn, "make": mk} for pn, mk in pairs_in_file]
    existing_set = set()
    async for doc in db.stock_master.find(
        {"$or": or_query},
        {"_id": 0, "part_no": 1, "make": 1},
    ):
        existing_set.add((doc["part_no"], doc["make"]))

    duplicate_count = sum(1 for p in pairs_in_file if p in existing_set)
    new_count = total_items - duplicate_count

    return {
        "file_name": file_name,
        "total_items": total_items,
        "new_items": new_count,
        "duplicate_items": duplicate_count,
        "skipped_rows": skipped_rows,
    }

@api_router.post("/stock-master/bulk-upload")
async def bulk_upload(
    file: UploadFile = File(...),
    mode: str = Query("skip", regex="^(skip|overwrite)$"),
    user=Depends(get_current_user),
):
    content = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")

    col_map = {}
    for col in df.columns:
        key = _normalize_col(col)
        if key in COLUMN_ALIASES and COLUMN_ALIASES[key]:
            col_map[col] = COLUMN_ALIASES[key]

    mapped_fields = set(col_map.values())
    if "part_no" not in mapped_fields or "make" not in mapped_fields:
        raise HTTPException(
            status_code=400,
            detail="File must contain PART NO and MAKE columns. Download the template for the correct format.",
        )

    inserted, skipped, overwritten = 0, 0, 0
    for idx, row in df.iterrows():
        data = {
            "model": "", "part_no": "", "old_part_no": "", "new_part_no": "", "make_part_no": "",
            "description_1": "", "description_2": "",
            "remarks_oem": "", "remarks_others": "",
            "make": "", "item_category": "", "unit": "", "reorder_level": 0, "image": "",
        }
        for orig_col, field in col_map.items():
            val = row.get(orig_col, "")
            data[field] = str(val).strip() if val is not None else ""
        try:
            data["reorder_level"] = int(float(str(data.get("reorder_level") or 0)))
        except Exception:
            data["reorder_level"] = 0

        part_no = data["part_no"]
        make = data["make"]
        if not part_no or not make:
            skipped += 1
            continue

        existing = await db.stock_master.find_one({"part_no": part_no, "make": make})

        if existing:
            if mode == "overwrite":
                update_data = {k: v for k, v in data.items() if k not in ("id", "created_at")}
                await db.stock_master.update_one(
                    {"part_no": part_no, "make": make},
                    {"$set": update_data},
                )
                overwritten += 1
            else:
                skipped += 1
            continue

        doc = {"id": str(uuid.uuid4()), **data, "created_at": now_iso()}
        await db.stock_master.insert_one(doc)
        inserted += 1

    return {
        "inserted": inserted,
        "skipped": skipped,
        "overwritten": overwritten,
        "total_rows": len(df),
        "mode": mode,
    }

# -------------------- GODOWN / RACK / BOX --------------------
def _csv_response(rows: list, header: list, filename: str) -> StreamingResponse:
    buf = io.StringIO()
    import csv
    writer = csv.writer(buf)
    writer.writerow(header)
    for r in rows:
        writer.writerow(r)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _read_file_to_df(file: UploadFile):
    content = await file.read()
    try:
        if file.filename.endswith(".csv"):
            return pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        return pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")


def _find_col(df, aliases):
    """Return the first column in df that matches any normalized alias."""
    for col in df.columns:
        if _normalize_col(col) in aliases:
            return col
    return None


# ---------- GODOWNS: template + bulk upload ----------
@api_router.get("/godowns/download/template")
async def godowns_template():
    return _csv_response(
        [["Main Warehouse"], ["Spare Parts Store"]],
        ["GODOWN NAME"],
        "godowns_template.csv",
    )


@api_router.post("/godowns/bulk-upload")
async def godowns_bulk_upload(file: UploadFile = File(...), user=Depends(get_current_user)):
    df = await _read_file_to_df(file)
    name_col = _find_col(df, {"godown name", "godown_name", "godown", "name"})
    if not name_col:
        raise HTTPException(status_code=400, detail="File must contain a GODOWN NAME column")
    inserted, skipped = 0, 0
    for _, row in df.iterrows():
        name = str(row.get(name_col, "")).strip()
        if not name:
            skipped += 1; continue
        if await db.godowns.find_one({"godown_name": name}):
            skipped += 1; continue
        await db.godowns.insert_one({
            "id": str(uuid.uuid4()),
            "godown_name": name,
            "created_at": now_iso(),
        })
        inserted += 1
    return {"inserted": inserted, "skipped": skipped, "total_rows": len(df)}


# ---------- RACKS: template + bulk upload ----------
@api_router.get("/racks/download/template")
async def racks_template():
    return _csv_response(
        [["Main Warehouse", "1", "12"], ["Main Warehouse", "2", "12"], ["Spare Parts Store", "A1", "8"]],
        ["GODOWN NAME", "RACK NO", "TOTAL BOXES"],
        "racks_template.csv",
    )


@api_router.post("/racks/bulk-upload")
async def racks_bulk_upload(file: UploadFile = File(...), user=Depends(get_current_user)):
    df = await _read_file_to_df(file)
    gcol = _find_col(df, {"godown name", "godown_name", "godown"})
    rcol = _find_col(df, {"rack no", "rack_no", "rack", "rack number"})
    tcol = _find_col(df, {"total boxes", "total_boxes", "total", "boxes"})
    if not gcol or not rcol:
        raise HTTPException(status_code=400, detail="File must contain GODOWN NAME and RACK NO columns")
    inserted, skipped, missing_godowns = 0, 0, set()
    for _, row in df.iterrows():
        gname = str(row.get(gcol, "")).strip()
        rack_no = str(row.get(rcol, "")).strip()
        try:
            total_boxes = int(str(row.get(tcol, 0) or 0).strip()) if tcol else 0
        except Exception:
            total_boxes = 0
        if not gname or not rack_no:
            skipped += 1; continue
        godown = await db.godowns.find_one({"godown_name": gname})
        if not godown:
            missing_godowns.add(gname); skipped += 1; continue
        if await db.racks.find_one({"godown_id": godown["id"], "rack_no": rack_no}):
            skipped += 1; continue
        await db.racks.insert_one({
            "id": str(uuid.uuid4()),
            "godown_id": godown["id"],
            "rack_no": rack_no,
            "total_boxes": total_boxes,
            "created_at": now_iso(),
        })
        inserted += 1
    return {
        "inserted": inserted, "skipped": skipped, "total_rows": len(df),
        "missing_godowns": sorted(missing_godowns),
    }


# ---------- BOXES: template + bulk upload ----------
@api_router.get("/boxes/download/template")
async def boxes_template():
    return _csv_response(
        [
            ["Main Warehouse", "1", "1", "Filters"],
            ["Main Warehouse", "1", "2", "Belts"],
            ["Main Warehouse", "2", "1", "Bearings"],
        ],
        ["GODOWN NAME", "RACK NO", "BOX NO", "CATEGORY"],
        "boxes_template.csv",
    )


@api_router.post("/boxes/bulk-upload")
async def boxes_bulk_upload(file: UploadFile = File(...), user=Depends(get_current_user)):
    df = await _read_file_to_df(file)
    gcol = _find_col(df, {"godown name", "godown_name", "godown"})
    rcol = _find_col(df, {"rack no", "rack_no", "rack"})
    bcol = _find_col(df, {"box no", "box_no", "box"})
    ccol = _find_col(df, {"category", "box category", "box_category"})
    if not gcol or not rcol or not bcol:
        raise HTTPException(status_code=400, detail="File must contain GODOWN NAME, RACK NO and BOX NO columns")
    inserted, skipped, missing = 0, 0, set()
    for _, row in df.iterrows():
        gname = str(row.get(gcol, "")).strip()
        rack_no = str(row.get(rcol, "")).strip()
        box_no = str(row.get(bcol, "")).strip()
        category = str(row.get(ccol, "") or "").strip() if ccol else ""
        if not gname or not rack_no or not box_no:
            skipped += 1; continue
        godown = await db.godowns.find_one({"godown_name": gname})
        if not godown:
            missing.add(f"godown:{gname}"); skipped += 1; continue
        rack = await db.racks.find_one({"godown_id": godown["id"], "rack_no": rack_no})
        if not rack:
            missing.add(f"rack:{gname}/Rack {rack_no}"); skipped += 1; continue
        if await db.boxes.find_one({"rack_id": rack["id"], "box_no": box_no}):
            skipped += 1; continue
        await db.boxes.insert_one({
            "id": str(uuid.uuid4()),
            "rack_id": rack["id"],
            "box_no": box_no,
            "box_category": category,
            "created_at": now_iso(),
        })
        inserted += 1
    return {
        "inserted": inserted, "skipped": skipped, "total_rows": len(df),
        "missing_parents": sorted(missing),
    }


class BulkDeleteRequest(BaseModel):
    ids: List[str]


@api_router.post("/godowns/bulk-delete")
async def godowns_bulk_delete(payload: BulkDeleteRequest, user=Depends(get_current_user)):
    if not payload.ids:
        return {"deleted": 0, "blocked": 0}
    used = set(await db.transactions.distinct("godown_id", {"godown_id": {"$in": payload.ids}}))
    deletable = [i for i in payload.ids if i not in used]
    res = await db.godowns.delete_many({"id": {"$in": deletable}})
    return {"deleted": res.deleted_count, "blocked": len(payload.ids) - len(deletable)}


@api_router.post("/racks/bulk-delete")
async def racks_bulk_delete(payload: BulkDeleteRequest, user=Depends(get_current_user)):
    if not payload.ids:
        return {"deleted": 0, "blocked": 0}
    used = set(await db.transactions.distinct("rack_id", {"rack_id": {"$in": payload.ids}}))
    deletable = [i for i in payload.ids if i not in used]
    res = await db.racks.delete_many({"id": {"$in": deletable}})
    return {"deleted": res.deleted_count, "blocked": len(payload.ids) - len(deletable)}


@api_router.post("/boxes/bulk-delete")
async def boxes_bulk_delete(payload: BulkDeleteRequest, user=Depends(get_current_user)):
    if not payload.ids:
        return {"deleted": 0, "blocked": 0}
    used = set(await db.transactions.distinct("box_id", {"box_id": {"$in": payload.ids}}))
    deletable = [i for i in payload.ids if i not in used]
    res = await db.boxes.delete_many({"id": {"$in": deletable}})
    return {"deleted": res.deleted_count, "blocked": len(payload.ids) - len(deletable)}


class RackRangeRequest(BaseModel):
    godown_id: str
    start: int
    end: int
    total_boxes: int = 0
    prefix: Optional[str] = ""  # e.g., "R" → R1, R2, ...


@api_router.post("/racks/range")
async def create_rack_range(payload: RackRangeRequest, user=Depends(get_current_user)):
    godown = await db.godowns.find_one({"id": payload.godown_id})
    if not godown:
        raise HTTPException(status_code=400, detail="Godown not found")
    if payload.end < payload.start:
        raise HTTPException(status_code=400, detail="End must be >= Start")
    if payload.end - payload.start > 999:
        raise HTTPException(status_code=400, detail="Range too large (max 1000)")
    inserted, skipped = 0, 0
    for n in range(payload.start, payload.end + 1):
        rack_no = f"{payload.prefix or ''}{n}"
        if await db.racks.find_one({"godown_id": payload.godown_id, "rack_no": rack_no}):
            skipped += 1
            continue
        await db.racks.insert_one({
            "id": str(uuid.uuid4()),
            "godown_id": payload.godown_id,
            "rack_no": rack_no,
            "total_boxes": payload.total_boxes,
            "created_at": now_iso(),
        })
        inserted += 1
    return {"inserted": inserted, "skipped": skipped}


class BoxRangeRequest(BaseModel):
    rack_id: str
    start: int
    end: int
    box_category: Optional[str] = ""
    prefix: Optional[str] = ""


@api_router.post("/boxes/range")
async def create_box_range(payload: BoxRangeRequest, user=Depends(get_current_user)):
    rack = await db.racks.find_one({"id": payload.rack_id})
    if not rack:
        raise HTTPException(status_code=400, detail="Rack not found")
    if payload.end < payload.start:
        raise HTTPException(status_code=400, detail="End must be >= Start")
    if payload.end - payload.start > 999:
        raise HTTPException(status_code=400, detail="Range too large (max 1000)")
    inserted, skipped = 0, 0
    for n in range(payload.start, payload.end + 1):
        box_no = f"{payload.prefix or ''}{n}"
        if await db.boxes.find_one({"rack_id": payload.rack_id, "box_no": box_no}):
            skipped += 1
            continue
        await db.boxes.insert_one({
            "id": str(uuid.uuid4()),
            "rack_id": payload.rack_id,
            "box_no": box_no,
            "box_category": payload.box_category or "",
            "created_at": now_iso(),
        })
        inserted += 1
    return {"inserted": inserted, "skipped": skipped}


@api_router.post("/godowns", response_model=Godown)
async def create_godown(payload: GodownCreate, user=Depends(get_current_user)):
    doc = {"id": str(uuid.uuid4()), "godown_name": payload.godown_name, "created_at": now_iso()}
    await db.godowns.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/godowns")
async def list_godowns(user=Depends(get_current_user)):
    godowns = await db.godowns.find({}, {"_id": 0}).sort("created_at", 1).to_list(500)
    used = set(await db.transactions.distinct("godown_id"))
    for g in godowns:
        g["in_use"] = g["id"] in used
    return godowns


@api_router.put("/godowns/{godown_id}", response_model=Godown)
async def update_godown(godown_id: str, payload: GodownCreate, user=Depends(get_current_user)):
    res = await db.godowns.update_one({"id": godown_id}, {"$set": {"godown_name": payload.godown_name}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Godown not found")
    godown = await db.godowns.find_one({"id": godown_id}, {"_id": 0})
    return godown


@api_router.delete("/godowns/{godown_id}")
async def delete_godown(godown_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"godown_id": godown_id}):
        raise HTTPException(status_code=400, detail="Godown is in use by stock entries")
    await db.godowns.delete_one({"id": godown_id})
    return {"ok": True}


@api_router.post("/racks", response_model=Rack)
async def create_rack(payload: RackCreate, user=Depends(get_current_user)):
    godown = await db.godowns.find_one({"id": payload.godown_id})
    if not godown:
        raise HTTPException(status_code=400, detail="Godown not found")
    doc = {"id": str(uuid.uuid4()), **payload.model_dump(), "created_at": now_iso()}
    await db.racks.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/racks")
async def list_racks(godown_id: Optional[str] = None, user=Depends(get_current_user)):
    query = {"godown_id": godown_id} if godown_id else {}
    racks = await db.racks.find(query, {"_id": 0}).sort("created_at", 1).to_list(1000)
    used = set(await db.transactions.distinct("rack_id"))
    for r in racks:
        r["in_use"] = r["id"] in used
    return racks


class RackUpdate(BaseModel):
    rack_no: str
    total_boxes: int = 0


@api_router.put("/racks/{rack_id}", response_model=Rack)
async def update_rack(rack_id: str, payload: RackUpdate, user=Depends(get_current_user)):
    res = await db.racks.update_one(
        {"id": rack_id},
        {"$set": {"rack_no": payload.rack_no, "total_boxes": payload.total_boxes}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Rack not found")
    rack = await db.racks.find_one({"id": rack_id}, {"_id": 0})
    return rack


@api_router.delete("/racks/{rack_id}")
async def delete_rack(rack_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"rack_id": rack_id}):
        raise HTTPException(status_code=400, detail="Rack is in use by stock entries")
    await db.racks.delete_one({"id": rack_id})
    return {"ok": True}


@api_router.post("/boxes", response_model=Box)
async def create_box(payload: BoxCreate, user=Depends(get_current_user)):
    rack = await db.racks.find_one({"id": payload.rack_id})
    if not rack:
        raise HTTPException(status_code=400, detail="Rack not found")
    doc = {"id": str(uuid.uuid4()), **payload.model_dump(), "created_at": now_iso()}
    await db.boxes.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/boxes")
async def list_boxes(rack_id: Optional[str] = None, user=Depends(get_current_user)):
    query = {"rack_id": rack_id} if rack_id else {}
    boxes = await db.boxes.find(query, {"_id": 0}).sort("created_at", 1).to_list(1000)
    used = set(await db.transactions.distinct("box_id"))
    for b in boxes:
        b["in_use"] = b["id"] in used
    return boxes


class BoxUpdate(BaseModel):
    box_no: str
    box_category: Optional[str] = ""


@api_router.put("/boxes/{box_id}", response_model=Box)
async def update_box(box_id: str, payload: BoxUpdate, user=Depends(get_current_user)):
    res = await db.boxes.update_one(
        {"id": box_id},
        {"$set": {"box_no": payload.box_no, "box_category": payload.box_category or ""}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Box not found")
    box = await db.boxes.find_one({"id": box_id}, {"_id": 0})
    return box


@api_router.delete("/boxes/{box_id}")
async def delete_box(box_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"box_id": box_id}):
        raise HTTPException(status_code=400, detail="Box is in use by stock entries")
    await db.boxes.delete_one({"id": box_id})
    return {"ok": True}


# -------------------- STOCK IN/OUT --------------------
async def _validate_txn(p):
    item = await db.stock_master.find_one({"part_no": p.part_no, "make": p.make}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=400, detail="No matching item in Stock Master")
    godown = await db.godowns.find_one({"id": p.godown_id})
    rack = await db.racks.find_one({"id": p.rack_id})
    box = await db.boxes.find_one({"id": p.box_id})
    if not godown or not rack or not box:
        raise HTTPException(status_code=400, detail="Invalid location")
    if p.quantity <= 0:
        raise HTTPException(status_code=400, detail="Quantity must be > 0")
    return item, godown, rack, box


class StockInLookupEntry(BaseModel):
    part_no: str
    make: Optional[str] = None


class StockInLookupRequest(BaseModel):
    # Accept either explicit entries (part_no + optional make) or just part_nos for backward compat
    entries: Optional[List[StockInLookupEntry]] = None
    part_nos: Optional[List[str]] = None


@api_router.post("/stock-in/lookup")
async def stock_in_lookup(req: StockInLookupRequest, user=Depends(get_current_user)):
    """Given entries of (part_no, make?), return stock master details + current locations with qty.
    One entry per (part_no, make). Items with <=1 location first, multi-location items last."""
    # Normalize input
    lookups = []  # list of (part_no, make_or_None)
    if req.entries:
        for e in req.entries:
            pn = (e.part_no or "").strip()
            mk = (e.make or "").strip() or None
            if pn:
                lookups.append((pn, mk))
    elif req.part_nos:
        for pn in req.part_nos:
            pn = (pn or "").strip()
            if pn:
                lookups.append((pn, None))

    results = []
    seen_keys = set()
    for part_no, make_filter in lookups:
        query = {"part_no": part_no}
        if make_filter:
            query["make"] = make_filter
        items = await db.stock_master.find(query, {"_id": 0}).to_list(100)
        if not items:
            key = f"{part_no}|{make_filter or ''}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            results.append({"part_no": part_no, "make": make_filter or "", "not_found": True, "locations": []})
            continue
        for item in items:
            key = f"{part_no}|{item.get('make','')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            pipeline = [
                {"$match": {"part_no": part_no, "make": item.get("make", "")}},
                {"$group": {
                    "_id": {
                        "godown_id": "$godown_id", "godown_name": "$godown_name",
                        "rack_id": "$rack_id", "rack_no": "$rack_no",
                        "box_id": "$box_id", "box_no": "$box_no",
                    },
                    "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
                }},
                {"$match": {"quantity": {"$gt": 0}}},
                {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
            ]
            raw_locs = await db.transactions.aggregate(pipeline).to_list(1000)
            locations = [{**r["_id"], "quantity": r["quantity"]} for r in raw_locs]
            results.append({
                "not_found": False,
                "part_no": part_no,
                "make": item.get("make", ""),
                "model": item.get("model", ""),
                "old_part_no": item.get("old_part_no", ""),
                "make_part_no": item.get("make_part_no", ""),
                "oem": item.get("oem", ""),
                "description_1": item.get("description_1", ""),
                "description_2": item.get("description_2", ""),
                "remarks_oem": item.get("remarks_oem", ""),
                "remarks_others": item.get("remarks_others", ""),
                "item_category": item.get("item_category", ""),
                "image": item.get("image", ""),
                "locations": locations,
            })
    results.sort(key=lambda r: (1 if len(r.get("locations", [])) > 1 else 0, len(r.get("locations", []))))
    return results


@api_router.post("/stock-in")
async def stock_in(payload: StockInCreate, user=Depends(get_current_user)):
    item, godown, rack, box = await _validate_txn(payload)
    doc = {
        "id": str(uuid.uuid4()),
        "type": "IN",
        "part_no": payload.part_no,
        "make": payload.make,
        "model": item.get("model", ""),
        "old_part_no": item.get("old_part_no", ""),
        "make_part_no": item.get("make_part_no", ""),
        "description_1": item.get("description_1", ""),
        "description_2": item.get("description_2", ""),
        "remarks_oem": item.get("remarks_oem", ""),
        "remarks_others": item.get("remarks_others", ""),
        "item_category": item.get("item_category", ""),
        "image": item.get("image", ""),
        "quantity": payload.quantity,
        "godown_id": payload.godown_id,
        "godown_name": godown["godown_name"],
        "rack_id": payload.rack_id,
        "rack_no": rack["rack_no"],
        "box_id": payload.box_id,
        "box_no": box["box_no"],
        "box_category": box.get("box_category", ""),
        "created_at": now_iso(),
        "created_by": user.get("email"),
    }
    await db.transactions.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.post("/stock-out")
async def stock_out(payload: StockOutCreate, user=Depends(get_current_user)):
    item, godown, rack, box = await _validate_txn(payload)
    # Check available balance
    balance = await _get_balance(payload.part_no, payload.make, payload.godown_id, payload.rack_id, payload.box_id)
    if balance < payload.quantity:
        raise HTTPException(status_code=400, detail=f"Insufficient stock. Available: {balance}")
    doc = {
        "id": str(uuid.uuid4()),
        "type": "OUT",
        "part_no": payload.part_no,
        "make": payload.make,
        "model": item.get("model", ""),
        "old_part_no": item.get("old_part_no", ""),
        "make_part_no": item.get("make_part_no", ""),
        "description_1": item.get("description_1", ""),
        "description_2": item.get("description_2", ""),
        "remarks_oem": item.get("remarks_oem", ""),
        "remarks_others": item.get("remarks_others", ""),
        "item_category": item.get("item_category", ""),
        "image": item.get("image", ""),
        "quantity": payload.quantity,
        "godown_id": payload.godown_id,
        "godown_name": godown["godown_name"],
        "rack_id": payload.rack_id,
        "rack_no": rack["rack_no"],
        "box_id": payload.box_id,
        "box_no": box["box_no"],
        "box_category": box.get("box_category", ""),
        "created_at": now_iso(),
        "created_by": user.get("email"),
    }
    await db.transactions.insert_one(doc)
    doc.pop("_id", None)
    return doc


async def _get_balance(part_no, make, godown_id, rack_id, box_id) -> int:
    pipeline = [
        {"$match": {"part_no": part_no, "make": make, "godown_id": godown_id, "rack_id": rack_id, "box_id": box_id}},
        {"$group": {"_id": None, "qty": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}}
    ]
    result = await db.transactions.aggregate(pipeline).to_list(1)
    return result[0]["qty"] if result else 0


@api_router.get("/transactions")
async def list_transactions(
    response: Response,
    limit: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(10000, ge=1, le=10000),
    type: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if type:
        query["type"] = type.upper()
    total = await db.transactions.count_documents(query)
    # Backward compat: if `limit` query param is provided, return first `limit` rows (no pagination headers consumer needed)
    if limit is not None and limit > 0:
        rows = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
        await _enrich_items(rows)
        response.headers["X-Total-Count"] = str(total)
        response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
        return rows
    skip = (page - 1) * page_size
    rows = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


# -------------------- RECEIPT NOTES (Stock In) --------------------
def current_fy_label(d: datetime) -> str:
    """Indian financial year label, e.g. 2026-04-15 -> '26-27'."""
    if d.month >= 4:
        start, end = d.year, d.year + 1
    else:
        start, end = d.year - 1, d.year
    return f"{start % 100:02d}-{end % 100:02d}"


@api_router.get("/receipt-notes/next-no")
async def next_receipt_note_no(user=Depends(get_current_user)):
    """Preview the next receipt-note number for the current FY (max existing serial + 1)."""
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.receipt_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_rn_no": f"RN/{fy}/{next_serial:03d}",
        "rn_date": today.date().isoformat(),
    }


@api_router.post("/receipt-notes", response_model=ReceiptNote)
async def create_receipt_note(payload: ReceiptNoteCreate, user=Depends(get_current_user)):
    """Create a Receipt Note. Always lands as DRAFT — Final Save happens via the
    /finalize endpoint after received_qty is filled for every row."""
    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")

    # Date validation
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")

    # Per-row validation (DRAFT-level — received_qty optional, invoice_qty required)
    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.invoice_qty is None or it.invoice_qty <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Invoice Qty must be greater than 0")
        if it.received_qty is not None and it.received_qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("rn", fy)
        rn_no = f"RN/{fy}/{serial:03d}"
        items_out = []
        for it in payload.items:
            rec = it.received_qty if it.received_qty is not None else None
            # Legacy `quantity` mirror — equals received_qty when set, else invoice_qty.
            qty_legacy = float(rec) if rec is not None else float(it.invoice_qty)
            items_out.append({
                "part_no": it.part_no.strip(),
                "make": it.make.strip(),
                "invoice_qty": float(it.invoice_qty),
                "received_qty": float(rec) if rec is not None else None,
                "quantity": qty_legacy,
            })

        doc = {
            "id": str(uuid.uuid4()),
            "rn_no": rn_no,
            "rn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "stock_in_type": payload.stock_in_type,
            "invoice_no": (payload.invoice_no or "").strip(),
            "invoice_date": (payload.invoice_date or "").strip(),
            "goods_received_date": (payload.goods_received_date or "").strip(),
            "items": items_out,
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.receipt_notes.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="receipt_note.created", module="stock_in",
                title=f"Receipt Note {rn_no} (Draft)",
                message=f"{user.get('email')} created draft {rn_no} with {len(doc['items'])} item(s).",
                audience="module", ref_collection="receipt_notes", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="receipt_note.assigned", module="stock_in",
                    title=f"Assigned to you: {rn_no}",
                    message=f"{user.get('email')} assigned Receipt Note {rn_no} to you.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="receipt_notes", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"Could not allocate receipt-note number: {last_err}")

@api_router.get("/receipt-notes")
async def list_receipt_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    search: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if search:
        s = search.strip()
        query["$or"] = [
            {"rn_no": {"$regex": s, "$options": "i"}},
            {"invoice_no": {"$regex": s, "$options": "i"}},
            {"rn_date": {"$regex": s, "$options": "i"}},
            {"invoice_date": {"$regex": s, "$options": "i"}},
            {"goods_received_date": {"$regex": s, "$options": "i"}},
            {"items.part_no": {"$regex": s, "$options": "i"}},
        ]
    # Allow comma-separated lists for both filters
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.receipt_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.receipt_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    # Annotate `has_racking_note`: any RKN (DRAFT or RECORDED) referencing the RN blocks edit/delete.
    if rows:
        ids_with_rkn = await db.racking_notes.distinct("receipt_note_id", {"receipt_note_id": {"$in": [r["id"] for r in rows]}})
        id_set = set(ids_with_rkn or [])
        for r in rows:
            r["has_racking_note"] = r["id"] in id_set
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/receipt-notes/{rn_id}")
async def get_receipt_note(rn_id: str, user=Depends(get_current_user)):
    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    await _enrich_note_items([doc])
    doc["has_racking_note"] = bool(await db.racking_notes.find_one({"receipt_note_id": rn_id}, {"_id": 1}))
    return doc


@api_router.put("/receipt-notes/{rn_id}", response_model=ReceiptNote)
async def update_receipt_note(rn_id: str, payload: ReceiptNoteCreate, user=Depends(get_current_user)):
    """Edit a Receipt Note.
       - Editable regardless of status AS LONG AS no Racking Note exists against it.
       - Once ANY Racking Note (DRAFT or RECORDED) exists, edits are locked.
       - Assignee enforcement still applies on non-DRAFT RNs so non-owners cannot
         hijack someone else's finalized note.
       - Re-finalization logic (SRN/ERN auto-create) remains unchanged on next finalize."""
    existing = await db.receipt_notes.find_one({"id": rn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")

    is_draft = existing.get("status") == "DRAFT"

    # Assignee enforcement: skip for DRAFT (anyone with module access can edit drafts).
    if not is_draft:
        _enforce_assignee(existing, user, "edit this receipt note")

    # Single gate: ANY racking note against this RN locks further edits.
    if await db.racking_notes.find_one({"receipt_note_id": rn_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — racking notes exist for this receipt note. Delete those first.")

    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")
    _no_future_date(payload.invoice_date, "Invoice Date")
    _no_future_date(payload.goods_received_date, "Goods Received Date")

    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.invoice_qty is None or it.invoice_qty <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Invoice Qty must be greater than 0")
        if it.received_qty is not None and it.received_qty < 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")

    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_in")

    items_out = []
    for it in payload.items:
        rec = it.received_qty if it.received_qty is not None else None
        qty_legacy = float(rec) if rec is not None else float(it.invoice_qty)
        items_out.append({
            "part_no": it.part_no.strip(),
            "make": it.make.strip(),
            "invoice_qty": float(it.invoice_qty),
            "received_qty": float(rec) if rec is not None else None,
            "quantity": qty_legacy,
        })

    update = {
        "stock_in_type": payload.stock_in_type,
        "invoice_no": (payload.invoice_no or "").strip(),
        "invoice_date": (payload.invoice_date or "").strip(),
        "goods_received_date": (payload.goods_received_date or "").strip(),
        "items": items_out,
        "updated_at": now_iso(),
        **assignee,
    }
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})

    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="receipt_note.assigned", module="stock_in",
            title=f"Assigned to you: {existing.get('rn_no', '')}",
            message=f"{user.get('email')} assigned Receipt Note {existing.get('rn_no', '')} to you.",
            audience="user", target_user_id=new_aid,
            ref_collection="receipt_notes", ref_id=rn_id,
        )

    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    return doc

@api_router.post("/receipt-notes/{rn_id}/finalize", response_model=ReceiptNote)
async def finalize_receipt_note(rn_id: str, user=Depends(get_current_user)):
    """Promote a DRAFT receipt note to FINAL.

    Requires: received_qty is a non-negative number for every row (0 is allowed
    and means "nothing received against this row yet"). invoice_date and
    goods_received_date are optional; only a future-date check is applied
    when they are provided.

    Side effects: if any row has received_qty < invoice_qty, a Short Received Note
    is auto-created in DRAFT for the shortfall. If any row has received_qty >
    invoice_qty, an Extra Received Note is auto-created in DRAFT for the overage.
    Both can occur on the same RN (one SRN + one ERN, both linked).
    """
    rn = await db.receipt_notes.find_one({"id": rn_id})
    if not rn:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    if rn.get("status") != "DRAFT":
        raise HTTPException(status_code=409, detail=f"Only DRAFT receipt notes can be finalized (current status: {rn.get('status')})")

    # Header validation — invoice_no/invoice_date/goods_received_date are OPTIONAL.
    # Only future-date sanity check if supplied.
    _no_future_date(rn.get("invoice_date"), "Invoice Date")
    _no_future_date(rn.get("goods_received_date"), "Goods Received Date")
    stock_in_type = (rn.get("stock_in_type") or "INVOICE").upper()

    items = rn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    # Received Qty may be 0 (or null -> treated as 0). Only negative values are rejected.
    for idx, it in enumerate(items, start=1):
        rq = it.get("received_qty")
        if rq is None or rq == "":
            continue
        try:
            if float(rq) < 0:
                raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty cannot be negative")
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Received Qty must be a number")

    # Update status + sync legacy `quantity` field with received_qty for racking compat
    items_out = []
    short_rows, extra_rows = [], []
    for it in items:
        inv = float(it.get("invoice_qty") or 0)
        rec = float(it.get("received_qty") or 0)
        out = {**it, "quantity": rec, "invoice_qty": inv, "received_qty": rec}
        items_out.append(out)
        diff = rec - inv
        if diff < 0:
            short_rows.append({**out, "short_qty": abs(diff)})
        elif diff > 0:
            extra_rows.append({**out, "extra_qty": diff})

    now = now_iso()
    await db.receipt_notes.update_one(
        {"id": rn_id},
        {"$set": {"items": items_out, "status": "FINAL", "finalized_at": now}},
    )

    await _recompute_rn_status(rn_id)
    
    # Auto-create child notes (these land as PENDING — user finalizes them later).
    # GENERAL stock-in never produces SRN/ERN (invoice_qty == received_qty -> qty_diff = 0).
    srn_no, ern_no = None, None
    if stock_in_type != "GENERAL":
        if short_rows:
            srn_no = await _auto_create_srn_for_rn(rn, short_rows, user)
        if extra_rows:
            ern_no = await _auto_create_ern_for_rn(rn, extra_rows, user)

    msg = f"{user.get('email')} finalized {rn['rn_no']} with {len(items_out)} item(s)."
    if srn_no:
        msg += f" Auto-created {srn_no} for shortfall."
    if ern_no:
        msg += f" Auto-created {ern_no} for overage."
    await _notify(
        actor=user, type="receipt_note.finalized", module="stock_in",
        title=f"Receipt Note finalized — {rn['rn_no']}",
        message=msg, audience="module",
        ref_collection="receipt_notes", ref_id=rn_id,
    )

    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    return doc

@api_router.delete("/receipt-notes/{rn_id}")
async def delete_receipt_note(rn_id: str, user=Depends(get_current_user)):
    existing = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    _enforce_assignee(existing, user, "delete this receipt note")
    # Block delete if any racking note (DRAFT or RECORDED) references it
    if await db.racking_notes.find_one({"receipt_note_id": rn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this receipt note. Delete them first.")
    await db.receipt_notes.delete_one({"id": rn_id})
    return {"ok": True}


# -------------------- RACKING NOTES --------------------
@api_router.get("/racking-notes/next-no")
async def next_racking_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.racking_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_rkn_no": f"RKN/{fy}/{next_serial:03d}",
        "rkn_date": today.date().isoformat(),
    }


def _no_future_date(value: str, field_label: str):
    """Raise 400 if the ISO date string is after today (UTC). Empty/None passes."""
    if not value:
        return
    try:
        d = datetime.fromisoformat(value).date()
    except Exception:
        raise HTTPException(status_code=400, detail=f"{field_label}: invalid date format")
    today = datetime.now(timezone.utc).date()
    if d > today:
        raise HTTPException(status_code=400, detail=f"{field_label} cannot be in the future")


def _qty_diff(it: dict) -> float:
    """received_qty - invoice_qty. Positive = extra, negative = short, 0 = exact."""
    inv = float(it.get("invoice_qty") or 0)
    rec = float(it.get("received_qty") or 0)
    return rec - inv


def _rn_items_have_all_received(items: list) -> bool:
    """True iff every row has a numeric, > 0 received_qty."""
    if not items:
        return False
    for it in items:
        rq = it.get("received_qty")
        if rq is None or rq == "":
            return False
        try:
            if float(rq) <= 0:
                return False
        except Exception:
            return False
    return True


async def _alloc_serial(series: str, fy: str) -> int:
    """Atomically allocate the next serial number for a given series + FY.

    Uses a `counters` collection where each (series, fy) pair has a single
    document. `find_one_and_update` with $inc and upsert=True is atomic at the
    document level — concurrent callers get distinct, monotonically increasing
    serials with no retry loop and no race window.

    `series` is one of: rn, rkn, srn, ern, in, pn, str, stn
    """
    key = f"{series}:{fy}"
    res = await db.counters.find_one_and_update(
        {"_id": key},
        {"$inc": {"value": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    return int(res["value"])
    


def _validate_racking_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.godown_id or "").strip() or not (it.rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown and Rack are required")
        # box_id is required only when the rack actually has boxes


async def _box_id_required_for_rack(rack_id: str) -> bool:
    """A box must be picked only if the selected rack has at least one box defined."""
    return await db.boxes.count_documents({"rack_id": rack_id}) > 0


def _key(p, m):
    return f"{(p or '').strip()}||{(m or '').strip()}"


# ----------- Live-join helper for consistent master / location data -----------
_MASTER_FIELDS = (
    "model", "old_part_no", "new_part_no", "make_part_no",
    "description_1", "description_2",
    "remarks_oem", "remarks_others",
    "item_category", "unit", "image", "reorder_level",
)


async def _enrich_items(items: list):
    """In-place: overwrite snapshotted master & location fields on each dict
    with the LATEST values from stock_master / godowns / racks / boxes.
    Items that don't have a corresponding live master are left untouched.
    Accepts a list of dicts that have part_no/make and/or godown_id/rack_id/box_id.
    """
    if not items:
        return
    # 1. Build pair sets to query
    sm_pairs = list({(it.get("part_no", ""), it.get("make", "")) for it in items if it.get("part_no")})
    g_ids = list({it.get("godown_id") for it in items if it.get("godown_id")})
    r_ids = list({it.get("rack_id") for it in items if it.get("rack_id")})
    b_ids = list({it.get("box_id") for it in items if it.get("box_id")})
    sm_map, g_map, r_map, b_map = {}, {}, {}, {}
    if sm_pairs:
        or_q = [{"part_no": p, "make": m} for p, m in sm_pairs]
        async for sm in db.stock_master.find({"$or": or_q}, {"_id": 0}):
            sm_map[(sm.get("part_no"), sm.get("make"))] = sm
    if g_ids:
        async for g in db.godowns.find({"id": {"$in": g_ids}}, {"_id": 0}):
            g_map[g["id"]] = g
    if r_ids:
        async for r in db.racks.find({"id": {"$in": r_ids}}, {"_id": 0}):
            r_map[r["id"]] = r
    if b_ids:
        async for b in db.boxes.find({"id": {"$in": b_ids}}, {"_id": 0}):
            b_map[b["id"]] = b
    # 2. Overwrite each item's snapshot fields with live values where available
    for it in items:
        sm = sm_map.get((it.get("part_no"), it.get("make")))
        if sm:
            for f in _MASTER_FIELDS:
                if f in sm:
                    it[f] = sm.get(f) or ("" if f != "reorder_level" else 0)
        g = g_map.get(it.get("godown_id"))
        if g and g.get("godown_name") is not None:
            it["godown_name"] = g["godown_name"]
        rk = r_map.get(it.get("rack_id"))
        if rk and rk.get("rack_no") is not None:
            it["rack_no"] = rk["rack_no"]
        bx = b_map.get(it.get("box_id"))
        if bx:
            if bx.get("box_no") is not None:
                it["box_no"] = bx["box_no"]
            it["box_category"] = bx.get("box_category", it.get("box_category", ""))


async def _enrich_note_items(notes: list):
    """For documents that contain nested `items[]`, enrich each item."""
    flat = []
    for n in notes:
        for it in (n.get("items") or []):
            flat.append(it)
    await _enrich_items(flat)
    return notes


async def _enrich_with_parent_assignee(rows: list, parent_collection: str, parent_id_field: str):
    """Add parent_assigned_to_user_id / _name / _email onto each row by joining against a parent collection."""
    if not rows:
        return rows
    parent_ids = list({r.get(parent_id_field) for r in rows if r.get(parent_id_field)})
    if not parent_ids:
        return rows
    coll = getattr(db, parent_collection)
    pmap = {}
    async for p in coll.find(
        {"id": {"$in": parent_ids}},
        {"_id": 0, "id": 1, "assigned_to_user_id": 1, "assigned_to_name": 1, "assigned_to_email": 1},
    ):
        pmap[p["id"]] = p
    for r in rows:
        p = pmap.get(r.get(parent_id_field), {})
        r["parent_assigned_to_user_id"] = p.get("assigned_to_user_id")
        r["parent_assigned_to_name"] = p.get("assigned_to_name", "") or ""
        r["parent_assigned_to_email"] = p.get("assigned_to_email", "") or ""
    return rows


async def _aggregate_other_rkn_qty(rn_id: str, exclude_rkn_id: Optional[str] = None) -> dict:
    """Sum the qty per (part_no, make) across all OTHER racking notes for an RN."""
    q = {"receipt_note_id": rn_id}
    if exclude_rkn_id:
        q["id"] = {"$ne": exclude_rkn_id}
    sums = {}
    async for rkn in db.racking_notes.find(q, {"_id": 0, "items": 1}):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _validate_cumulative_qty(rn_id: str, items, exclude_rkn_id: Optional[str] = None):
    """Cumulative racked qty per (part_no, make) across all RKNs for this RN must not exceed received qty.
    `items` is the new-payload list (Pydantic models)."""
    rn = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not rn:
        raise HTTPException(status_code=400, detail="Receipt note not found")
    received = {}
    for it in rn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        received[k] = received.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _aggregate_other_rkn_qty(rn_id, exclude_rkn_id)
    new_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        if k not in received:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked receipt note")
    for k, new_q in new_sums.items():
        recv = received.get(k, 0)
        used = other_sums.get(k, 0)
        total = used + new_q
        if total > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Quantity exceeds receipt note for {part} / {make}: "
                    f"received {recv}, already racked elsewhere {used}, this note {new_q} "
                    f"(total {total} > {recv})"
                ),
            )


async def _recompute_rn_status(rn_id: str):
    """Recompute racking-progress status. DRAFT receipts stay at DRAFT.

    Status precedence (highest to lowest):
      DRAFT                : manual; never auto-promoted
      RACKING_NOTE_DRAFT   : at least one DRAFT racking note exists against the RN OR
                             any of its SRN / ERN descendants
      FULLY_RACKED         : all rackable qty (RN.received + SRN.fulfilled + ERN.accepted
                             across descendants) is covered by RECORDED racking notes
      PARTIALLY_RACKED     : some RECORDED racking exists but not yet fully covered
      FINAL                : finalized RN with no racking activity yet
    """
    rn = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not rn:
        return
    cur = rn.get("status")
    # Drafts never get auto-promoted.
    if cur == "DRAFT":
        return

    # Walk SRN + ERN descendant tree starting from this RN.
    srn_ids: list = []
    ern_ids: list = []
    # Direct SRNs / ERNs under the RN
    seed_srns = await db.short_received_notes.find({"parent_rn_id": rn_id}, {"_id": 0, "id": 1}).to_list(None)
    seed_erns = await db.extra_received_notes.find({"parent_rn_id": rn_id}, {"_id": 0, "id": 1}).to_list(None)
    pending_srn = [s["id"] for s in seed_srns]
    pending_ern = [e["id"] for e in seed_erns]
    while pending_srn:
        sid = pending_srn.pop()
        if sid in srn_ids:
            continue
        srn_ids.append(sid)
        children = await db.short_received_notes.find({"parent_srn_id": sid}, {"_id": 0, "id": 1}).to_list(None)
        for c in children:
            if c["id"] not in srn_ids:
                pending_srn.append(c["id"])
    while pending_ern:
        eid = pending_ern.pop()
        if eid in ern_ids:
            continue
        ern_ids.append(eid)
        children = await db.extra_received_notes.find({"parent_ern_id": eid}, {"_id": 0, "id": 1}).to_list(None)
        for c in children:
            if c["id"] not in ern_ids:
                pending_ern.append(c["id"])

    # Build the set of (source_type, source_id) pairs that count toward this RN's racking.
    source_pairs = [("RN", rn_id)] + [("SRN", sid) for sid in srn_ids] + [("ERN", eid) for eid in ern_ids]

    # Check for any DRAFT racking note against any of these sources -> RACKING_NOTE_DRAFT
    or_clauses = [{"source_type": st, "source_id": sid} for (st, sid) in source_pairs]
    has_draft_rkn = await db.racking_notes.find_one(
        {"status": "DRAFT", "$or": or_clauses}, {"_id": 0, "id": 1}
    )
    if has_draft_rkn:
        new_status = "RACKING_NOTE_DRAFT"
        update: dict = {"status": new_status}
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
        await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})
        return

    # Total rackable qty = RN.received + each SRN.fulfilled + each ERN.accepted
    rackable: dict = {}
    for it in rn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        q = it.get("received_qty")
        if q is None:
            q = it.get("quantity") or 0
        rackable[k] = rackable.get(k, 0) + (q or 0)
    if srn_ids:
        async for srn in db.short_received_notes.find({"id": {"$in": srn_ids}}, {"_id": 0, "items": 1}):
            for it in srn.get("items") or []:
                k = _key(it.get("part_no"), it.get("make"))
                children = it.get("children") or []
                if children:
                    rackable[k] = rackable.get(k, 0) + sum(
                        float(c.get("received_qty") or 0) for c in children
                    )
                else:
                    rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    if ern_ids:
        async for ern in db.extra_received_notes.find({"id": {"$in": ern_ids}}, {"_id": 0, "items": 1}):
            for it in ern.get("items") or []:
                k = _key(it.get("part_no"), it.get("make"))
                children = it.get("children") or []
                if children:
                    rackable[k] = rackable.get(k, 0) + sum(
                        float(c.get("accepted_qty") or 0) for c in children
                    )
                else:
                    rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)

    # Total racked qty across RECORDED RKNs against any of these sources.
    racked: dict = {}
    async for rkn in db.racking_notes.find(
        {"status": "RECORDED", "$or": or_clauses}, {"_id": 0, "items": 1}
    ):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            racked[k] = racked.get(k, 0) + (it.get("quantity") or 0)

    if not rackable or sum(rackable.values()) == 0 or sum(racked.values()) == 0:
        new_status = "FINAL"
    else:
        all_full = all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)
        new_status = "FULLY_RACKED" if all_full else "PARTIALLY_RACKED"

    update = {"status": new_status}
    if new_status == "FULLY_RACKED":
        update["racked_at"] = rn.get("racked_at") or now_iso()
    else:
        if rn.get("racked_at"):
            await db.receipt_notes.update_one({"id": rn_id}, {"$unset": {"racked_at": ""}})
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})

# --- SRN / ERN auto-creation -------------------------------------------------

async def _build_master_snapshot(part_no: str, make: str) -> dict:
    """Pull denormalized master fields for an SRN/ERN item row."""
    sm = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
    return {
        "model": sm.get("model", ""),
        "old_part_no": sm.get("old_part_no", ""),
        "make_part_no": sm.get("make_part_no", ""),
        "description_1": sm.get("description_1", ""),
        "description_2": sm.get("description_2", ""),
        "remarks_oem": sm.get("remarks_oem", ""),
        "remarks_others": sm.get("remarks_others", ""),
        "item_category": sm.get("item_category", ""),
    }


async def _auto_create_srn_for_rn(rn: dict, short_rows: list, actor: dict, parent_srn: dict = None) -> str:
    """Create a PENDING Short Received Note for the given short rows.

    If `parent_srn` is provided, this is a CHILD SRN auto-created from the residual
    shortfall of an ancestor SRN whose user-entered fulfilled_qty was less than its
    short_qty. The chain links back to the original parent RN through parent_rn_id.

    Items consolidate duplicates by (part_no, make) so racking sees one row per pair.
    """
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    for _ in range(5):
        serial = await _alloc_serial("srn", fy)
        srn_no = f"SRN/{fy}/{serial:03d}"
        # Consolidate duplicates — sum short_qty for the same (part_no, make).
        merged = {}
        for r in short_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            sh_q  = float(r.get("short_qty") or 0)
            if key in merged:
                merged[key]["short_qty"]  += sh_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "short_qty": sh_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"])
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "short_qty": m["short_qty"],
                "fulfilled_qty": None,
                "quantity": None,
                **snap,
            })
        if parent_srn:
            chain = f"Auto-generated from {parent_srn['srn_no']} — residual shortfall on {len(items)} item(s)."
            parent_srn_id = parent_srn["id"]
            parent_srn_no = parent_srn["srn_no"]
        else:
            chain = f"Auto-generated from {rn['rn_no']} — short on {len(items)} item(s)."
            parent_srn_id = None
            parent_srn_no = ""
        doc = {
            "id": str(uuid.uuid4()),
            "srn_no": srn_no, "srn_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_srn_id": parent_srn_id,
            "parent_srn_no": parent_srn_no,
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "fulfillment_date": "",
            "items": items,
            "status": "PENDING",
            "racking_status": "RACKING_PENDING",
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.short_received_notes.insert_one(doc)
            # Track child SRN reference on each parent item that contributed residual.
            if parent_srn:
                child_keys = {(it["part_no"], it["make"]): float(it.get("short_qty") or 0) for it in items}
                new_parent_items = []
                for p_it in parent_srn.get("items", []):
                    new_p = dict(p_it)
                    k = (p_it.get("part_no"), p_it.get("make"))
                    if k in child_keys:
                        children = list(new_p.get("children") or [])
                        children.append({
                            "child_srn_id": doc["id"],
                            "child_srn_no": srn_no,
                            "short_qty": child_keys[k],
                            "created_at": doc["created_at"],
                        })
                        new_p["children"] = children
                    new_parent_items.append(new_p)
                await db.short_received_notes.update_one(
                    {"id": parent_srn["id"]}, {"$set": {"items": new_parent_items}}
                )
            return srn_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate SRN number after 5 attempts")
    return ""


async def _auto_create_ern_for_rn(rn: dict, extra_rows: list, actor: dict, parent_ern: dict = None) -> str:
    """Create a PENDING Extra Received Note for the given overage rows.

    If `parent_ern` is provided, this is a CHILD ERN auto-created from the
    residual undecided extra of an ancestor ERN (where accepted+rejected < extra).
    Items consolidate duplicates by (part_no, make).
    """
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    for _ in range(5):
        serial = await _alloc_serial("ern", fy)
        ern_no = f"ERN/{fy}/{serial:03d}"
        merged = {}
        for r in extra_rows:
            key = (r["part_no"], r["make"])
            inv_q = float(r.get("invoice_qty") or 0)
            rec_q = float(r.get("received_qty") or 0)
            ex_q  = float(r.get("extra_qty") or 0)
            if key in merged:
                merged[key]["extra_qty"]   += ex_q
                merged[key]["invoice_qty"] += inv_q
                merged[key]["received_qty"] += rec_q
            else:
                merged[key] = {
                    "part_no": r["part_no"], "make": r["make"],
                    "invoice_qty": inv_q,
                    "received_qty": rec_q,
                    "extra_qty": ex_q,
                }
        items = []
        for m in merged.values():
            snap = await _build_master_snapshot(m["part_no"], m["make"])
            items.append({
                "part_no": m["part_no"], "make": m["make"],
                "invoice_qty": m["invoice_qty"],
                "received_qty": m["received_qty"],
                "extra_qty": m["extra_qty"],
                "accepted_qty": None,
                "rejected_qty": None,
                "quantity": None,
                **snap,
            })
        if parent_ern:
            chain = f"Auto-generated from {parent_ern['ern_no']} — residual extra on {len(items)} item(s)."
            parent_ern_id = parent_ern["id"]
            parent_ern_no = parent_ern["ern_no"]
        else:
            chain = f"Auto-generated from {rn['rn_no']} — extra on {len(items)} item(s)."
            parent_ern_id = None
            parent_ern_no = ""
        doc = {
            "id": str(uuid.uuid4()),
            "ern_no": ern_no, "ern_date": today.date().isoformat(),
            "fy": fy, "serial": serial,
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "parent_ern_id": parent_ern_id,
            "parent_ern_no": parent_ern_no,
            "chain_remarks": chain,
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "goods_received_date": rn.get("goods_received_date", ""),
            "items": items,
            "status": "PENDING",
            "racking_status": "RACKING_PENDING",
            "created_at": now_iso(),
            "created_by": actor.get("email", "system"),
            "assigned_to_user_id": rn.get("assigned_to_user_id"),
            "assigned_to_name": rn.get("assigned_to_name", ""),
            "assigned_to_email": rn.get("assigned_to_email", ""),
        }
        try:
            await db.extra_received_notes.insert_one(doc)
            # Track child ERN reference on each parent item that contributed residual.
            if parent_ern:
                child_keys = {(it["part_no"], it["make"]): float(it.get("extra_qty") or 0) for it in items}
                new_parent_items = []
                for p_it in parent_ern.get("items", []):
                    new_p = dict(p_it)
                    k = (p_it.get("part_no"), p_it.get("make"))
                    if k in child_keys:
                        children = list(new_p.get("children") or [])
                        children.append({
                            "child_ern_id": doc["id"],
                            "child_ern_no": ern_no,
                            "extra_qty": child_keys[k],
                            "created_at": doc["created_at"],
                        })
                        new_p["children"] = children
                    new_parent_items.append(new_p)
                await db.extra_received_notes.update_one(
                    {"id": parent_ern["id"]}, {"$set": {"items": new_parent_items}}
                )
            return ern_no
        except DuplicateKeyError:
            continue
    logger.warning("Could not allocate ERN number after 5 attempts")
    return ""

# ===================== RACKING NOTES — polymorphic source (Phase 2) =====================

async def _resolve_racking_source(payload_or_existing: dict) -> tuple:
    """Given a payload dict or existing rkn doc, normalise (source_type, source_id) and
    fetch the parent doc + ultimate parent RN. Returns (source_type, source_id, parent_doc, ultimate_rn)."""
    source_type = (payload_or_existing.get("source_type") or "").upper()
    source_id = payload_or_existing.get("source_id") or ""
    if not source_type and not source_id:
        # Legacy clients send only receipt_note_id.
        rni = payload_or_existing.get("receipt_note_id")
        if rni:
            source_type = "RN"
            source_id = rni
    if source_type not in ("RN", "SRN", "ERN"):
        raise HTTPException(status_code=400, detail="source_type must be RN, SRN, or ERN")
    if not source_id:
        raise HTTPException(status_code=400, detail="source_id is required")

    if source_type == "RN":
        rn = await db.receipt_notes.find_one({"id": source_id}, {"_id": 0})
        if not rn:
            raise HTTPException(status_code=400, detail="Receipt note not found")
        return "RN", source_id, rn, rn
    if source_type == "SRN":
        srn = await db.short_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not srn:
            raise HTTPException(status_code=400, detail="Short Received Note not found")
        rn = await db.receipt_notes.find_one({"id": srn.get("parent_rn_id")}, {"_id": 0}) or {}
        return "SRN", source_id, srn, rn
    # ERN
    ern = await db.extra_received_notes.find_one({"id": source_id}, {"_id": 0})
    if not ern:
        raise HTTPException(status_code=400, detail="Extra Received Note not found")
    rn = await db.receipt_notes.find_one({"id": ern.get("parent_rn_id")}, {"_id": 0}) or {}
    return "ERN", source_id, ern, rn


async def _validate_cumulative_qty_polymorphic(source_type: str, source_id: str, parent_doc: dict, items, exclude_rkn_id: Optional[str] = None):
    """Cumulative racked qty per (part_no, make) across all RKNs for this source must
    not exceed the rackable qty (received_qty for RN, fulfilled_qty for SRN, accepted_qty for ERN)."""
    rackable = {}
    if source_type == "RN":
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            q = it.get("received_qty")
            if q is None:
                q = it.get("quantity") or 0
            rackable[k] = rackable.get(k, 0) + (q or 0)
    elif source_type == "SRN":
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("received_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    else:  # ERN
        for it in parent_doc.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            children = it.get("children") or []
            if children:
                rackable[k] = rackable.get(k, 0) + sum(
                    float(c.get("accepted_qty") or 0) for c in children
                )
            else:
                rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)

    other_sums = await _aggregate_other_rkn_qty_by_source(source_type, source_id, exclude_rkn_id)
    new_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        if k not in rackable:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked source")
    for k, new_q in new_sums.items():
        avail = rackable.get(k, 0)
        used = other_sums.get(k, 0)
        total = used + new_q
        if total > avail + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Quantity exceeds rackable for {part} / {make}: "
                    f"rackable {avail}, already racked elsewhere {used}, this note {new_q} "
                    f"(total {total} > {avail})"
                ),
            )


async def _recompute_source_status_after_rkn(source_type: str, source_id: str, ultimate_rn_id: Optional[str]):
    """After a racking note is created/edited/deleted, recompute the source's racking status,
    and always recompute the ultimate parent RN's status (it now considers SRN/ERN qty)."""
    if source_type == "RN":
        if source_id:
            await _recompute_rn_status(source_id)
    elif source_type == "SRN":
        await _recompute_srn_racking_status(source_id)
    elif source_type == "ERN":
        await _recompute_ern_racking_status(source_id)
    # The RN's FULLY_RACKED state depends on rackable qty across all SRN/ERN descendants,
    # so always re-run RN status recompute when the ultimate RN is known.
    if ultimate_rn_id and source_type != "RN":
        await _recompute_rn_status(ultimate_rn_id)


# Legacy /racking-notes/prepare/{rn_id} kept for back-compat — delegates to the polymorphic version.
@api_router.get("/racking-notes/prepare/{rn_id}")
async def prepare_racking_note(rn_id: str, exclude_rkn_id: Optional[str] = None, user=Depends(_module_dep("stock_in"))):
    """LEGACY: prepare for racking against an RN. Modern clients should use /racking-notes/prepare-source."""
    res = await prepare_racking_for_source(source_type="RN", source_id=rn_id, exclude_rkn_id=exclude_rkn_id, user=user)
    # Reshape header to the legacy contract for old frontend code paths
    src = res["source"]
    return {
        "receipt_note": {
            "id": src["id"], "rn_no": src["no"], "rn_date": src["date"],
            "invoice_no": src.get("invoice_no", ""), "invoice_date": src.get("invoice_date", ""),
            "status": src.get("status"),
        },
        "items": res["items"],
    }


@api_router.post("/racking-notes", response_model=RackingNote)
async def create_racking_note(payload: RackingNoteCreate, user=Depends(_module_dep("stock_in"))):
    src_type, src_id, parent_doc, ultimate_rn = await _resolve_racking_source(payload.model_dump())
    _enforce_assignee(parent_doc, user, "create a racking note for this source")
    # Disallow if source is fully racked
    if src_type == "RN" and parent_doc.get("status") == "FULLY_RACKED":
        raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
    if src_type == "SRN" and parent_doc.get("racking_status") == "FULLY_RACKED":
        raise HTTPException(status_code=409, detail="This Short Received Note is already fully racked")
    if src_type == "ERN" and parent_doc.get("racking_status") == "FULLY_RACKED":
        raise HTTPException(status_code=409, detail="This Extra Received Note is already fully racked")

    _validate_racking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, payload.items, exclude_rkn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last_err = None

    # Resolve display strings for the source
    if src_type == "RN":
        source_no = parent_doc.get("rn_no", "")
        source_date = parent_doc.get("rn_date", "")
    elif src_type == "SRN":
        source_no = parent_doc.get("srn_no", "")
        source_date = parent_doc.get("srn_date", "")
    else:
        source_no = parent_doc.get("ern_no", "")
        source_date = parent_doc.get("ern_date", "")

    ult_rn_id = (ultimate_rn or {}).get("id", "")
    ult_rn_no = (ultimate_rn or {}).get("rn_no", "")
    ult_rn_date = (ultimate_rn or {}).get("rn_date", "")

    for _ in range(5):
        serial = await _alloc_serial("rkn", fy)
        rkn_no = f"RKN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rkn_no": rkn_no,
            "rkn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            # Polymorphic
            "source_type": src_type,
            "source_id": src_id,
            "source_no": source_no,
            "source_date": source_date,
            # Legacy fields — receipt_note_* always points to the ULTIMATE parent RN.
            "receipt_note_id": ult_rn_id,
            "receipt_note_no": ult_rn_no,
            "receipt_note_date": ult_rn_date,
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.racking_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_source_status_after_rkn(src_type, src_id, ult_rn_id)
            return doc
        except DuplicateKeyError as e:
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"Could not allocate racking-note number: {last_err}")


@api_router.get("/racking-notes")
async def list_racking_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.racking_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.racking_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "receipt_notes", "receipt_note_id")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/racking-notes/sources")
async def list_racking_sources(user=Depends(_module_dep("stock_in"))):
    """Return all rackable sources (RN + SRN-with-fulfilled + ERN-with-accepted),
    grouped by their ultimate parent RN."""
    # 1. RNs eligible: FINAL or PARTIALLY_RACKED (DRAFT and FULLY_RACKED are excluded).
    rn_rows = await db.receipt_notes.find(
        {"status": {"$in": ["FINAL", "PARTIALLY_RACKED"]}},
        {"_id": 0, "id": 1, "rn_no": 1, "rn_date": 1, "stock_in_type": 1,
         "invoice_no": 1, "invoice_date": 1, "status": 1,
         "assigned_to_user_id": 1, "assigned_to_name": 1, "assigned_to_email": 1},
    ).sort("created_at", -1).to_list(5000)

    # 2. SRNs eligible: any with sum(fulfilled_qty) > 0 AND racking_status != FULLY_RACKED.
    srn_rows = await db.short_received_notes.find(
        {"racking_status": {"$ne": "FULLY_RACKED"}},
        {"_id": 0},
    ).sort("created_at", -1).to_list(5000)
    eligible_srns = []
    for s in srn_rows:
        # Inline-child model: rackable = sum(children.received_qty); fall back to fulfilled_qty
        total_rcv = 0.0
        for it in s.get("items") or []:
            children = it.get("children") or []
            if children:
                total_rcv += sum(float(c.get("received_qty") or 0) for c in children)
            else:
                total_rcv += float(it.get("fulfilled_qty") or 0)
        if total_rcv > 0:
            eligible_srns.append(s)

    # 3. ERNs eligible: any with sum(accepted_qty) > 0 AND racking_status != FULLY_RACKED.
    ern_rows = await db.extra_received_notes.find(
        {"racking_status": {"$ne": "FULLY_RACKED"}},
        {"_id": 0},
    ).sort("created_at", -1).to_list(5000)
    eligible_erns = []
    for e in ern_rows:
        total_acc = 0.0
        for it in e.get("items") or []:
            children = it.get("children") or []
            if children:
                total_acc += sum(float(c.get("accepted_qty") or 0) for c in children)
            else:
                total_acc += float(it.get("accepted_qty") or 0)
        if total_acc > 0:
            eligible_erns.append(e)

    # Group everything by parent_rn_id.
    groups = {}
    for rn in rn_rows:
        groups[rn["id"]] = {
            "parent_rn_id": rn["id"],
            "parent_rn_no": rn.get("rn_no", ""),
            "parent_rn_date": rn.get("rn_date", ""),
            "stock_in_type": rn.get("stock_in_type", "INVOICE"),
            "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": rn.get("invoice_date", ""),
            "sources": [{
                "source_type": "RN",
                "source_id": rn["id"],
                "source_no": rn.get("rn_no", ""),
                "source_date": rn.get("rn_date", ""),
                "status": rn.get("status", ""),
                "assigned_to_user_id": rn.get("assigned_to_user_id"),
                "assigned_to_name": rn.get("assigned_to_name", ""),
                "assigned_to_email": rn.get("assigned_to_email", ""),
            }],
        }
    for s in eligible_srns:
        prn_id = s.get("parent_rn_id")
        if prn_id not in groups:
            # Parent RN already fully racked; create a stub group so the SRN/ERN are still selectable.
            groups[prn_id] = {
                "parent_rn_id": prn_id,
                "parent_rn_no": s.get("parent_rn_no", ""),
                "parent_rn_date": s.get("parent_rn_date", ""),
                "stock_in_type": "INVOICE",
                "invoice_no": s.get("invoice_no", ""),
                "invoice_date": s.get("invoice_date", ""),
                "sources": [],
            }
        groups[prn_id]["sources"].append({
            "source_type": "SRN",
            "source_id": s["id"],
            "source_no": s.get("srn_no", ""),
            "source_date": s.get("srn_date", ""),
            "status": s.get("status", ""),
            "racking_status": s.get("racking_status", ""),
            "assigned_to_user_id": s.get("assigned_to_user_id"),
            "assigned_to_name": s.get("assigned_to_name", ""),
            "assigned_to_email": s.get("assigned_to_email", ""),
        })
    for e in eligible_erns:
        prn_id = e.get("parent_rn_id")
        if prn_id not in groups:
            groups[prn_id] = {
                "parent_rn_id": prn_id,
                "parent_rn_no": e.get("parent_rn_no", ""),
                "parent_rn_date": e.get("parent_rn_date", ""),
                "stock_in_type": "INVOICE",
                "invoice_no": e.get("invoice_no", ""),
                "invoice_date": e.get("invoice_date", ""),
                "sources": [],
            }
        groups[prn_id]["sources"].append({
            "source_type": "ERN",
            "source_id": e["id"],
            "source_no": e.get("ern_no", ""),
            "source_date": e.get("ern_date", ""),
            "status": e.get("status", ""),
            "racking_status": e.get("racking_status", ""),
            "assigned_to_user_id": e.get("assigned_to_user_id"),
            "assigned_to_name": e.get("assigned_to_name", ""),
            "assigned_to_email": e.get("assigned_to_email", ""),
        })

    # Filter out empty groups (parent RN fully racked AND no eligible SRN/ERN under it).
    return [g for g in groups.values() if g.get("sources")]



@api_router.get("/racking-notes/prepare-source")
async def prepare_racking_for_source(
    source_type: str,
    source_id: str,
    exclude_rkn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    """Polymorphic prepare for racking: builds the items list from RN, SRN, or ERN."""
    source_type = (source_type or "").upper()
    if source_type not in ("RN", "SRN", "ERN"):
        raise HTTPException(status_code=400, detail="source_type must be RN, SRN, or ERN")

    if source_type == "RN":
        rn = await db.receipt_notes.find_one({"id": source_id}, {"_id": 0})
        if not rn:
            raise HTTPException(status_code=404, detail="Receipt note not found")
        if rn.get("status") == "FULLY_RACKED" and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This receipt note is already fully racked")
        # The qty available per (part,make) is received_qty.
        rackable = []
        for it in rn.get("items", []):
            rec = it.get("received_qty")
            if rec is None:
                rec = it.get("quantity") or 0
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": float(rec or 0),
            })
        header = {
            "id": rn["id"], "no": rn["rn_no"], "date": rn["rn_date"],
            "type": "RN",
            "parent_rn_id": rn["id"], "parent_rn_no": rn["rn_no"], "parent_rn_date": rn["rn_date"],
            "invoice_no": rn.get("invoice_no", ""), "invoice_date": rn.get("invoice_date", ""),
            "status": rn.get("status"),
        }

    elif source_type == "SRN":
        srn = await db.short_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not srn:
            raise HTTPException(status_code=404, detail="Short Received Note not found")
        if srn.get("racking_status") == "FULLY_RACKED" and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This SRN is already fully racked")
        rackable = []
        for it in srn.get("items", []):
            children = it.get("children") or []
            if children:
                rqty = sum(float(c.get("received_qty") or 0) for c in children)
            else:
                rqty = float(it.get("fulfilled_qty") or 0)
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": rqty,
            })
        header = {
            "id": srn["id"], "no": srn["srn_no"], "date": srn["srn_date"],
            "type": "SRN",
            "parent_rn_id": srn.get("parent_rn_id"),
            "parent_rn_no": srn.get("parent_rn_no", ""),
            "parent_rn_date": srn.get("parent_rn_date", ""),
            "invoice_no": srn.get("invoice_no", ""), "invoice_date": srn.get("invoice_date", ""),
            "status": srn.get("status"),
        }

    else:  # ERN
        ern = await db.extra_received_notes.find_one({"id": source_id}, {"_id": 0})
        if not ern:
            raise HTTPException(status_code=404, detail="Extra Received Note not found")
        if ern.get("racking_status") == "FULLY_RACKED" and not exclude_rkn_id:
            raise HTTPException(status_code=409, detail="This ERN is already fully racked")
        rackable = []
        for it in ern.get("items", []):
            children = it.get("children") or []
            if children:
                rqty = sum(float(c.get("accepted_qty") or 0) for c in children)
            else:
                rqty = float(it.get("accepted_qty") or 0)
            rackable.append({
                "part_no": it.get("part_no", ""),
                "make": it.get("make", ""),
                "rackable_qty": rqty,
            })
        header = {
            "id": ern["id"], "no": ern["ern_no"], "date": ern["ern_date"],
            "type": "ERN",
            "parent_rn_id": ern.get("parent_rn_id"),
            "parent_rn_no": ern.get("parent_rn_no", ""),
            "parent_rn_date": ern.get("parent_rn_date", ""),
            "invoice_no": ern.get("invoice_no", ""), "invoice_date": ern.get("invoice_date", ""),
            "status": ern.get("status"),
        }

    # How much has already been racked from this same source?
    other_sums = await _aggregate_other_rkn_qty_by_source(source_type, source_id, exclude_rkn_id)

    items_out = []
    for r in rackable:
        part_no = r["part_no"]
        make = r["make"]
        avail = r["rackable_qty"]
        if avail <= 0:
            continue
        already = other_sums.get(_key(part_no, make), 0)
        pending = avail - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        # Existing locations
        pipeline = [
            {"$match": {"part_no": part_no, "make": make}},
            {"$group": {
                "_id": {
                    "godown_id": "$godown_id", "godown_name": "$godown_name",
                    "rack_id": "$rack_id", "rack_no": "$rack_no",
                    "box_id": "$box_id", "box_no": "$box_no", "box_category": "$box_category",
                },
                "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
            }},
            {"$match": {"quantity": {"$gt": 0}}},
            {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
        ]
        raw_locs = await db.transactions.aggregate(pipeline).to_list(1000)
        existing_locations = [{**rr["_id"], "current_qty": rr["quantity"]} for rr in raw_locs]
        prefill = existing_locations[0] if len(existing_locations) == 1 else None
        items_out.append({
            "part_no": part_no, "make": make,
            "rackable_qty": avail,
            "already_racked_qty": already,
            "pending_qty": pending,
            "quantity": pending,
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            "godown_id": prefill["godown_id"] if prefill else "",
            "godown_name": prefill["godown_name"] if prefill else "",
            "rack_id": prefill["rack_id"] if prefill else "",
            "rack_no": prefill["rack_no"] if prefill else "",
            "box_id": prefill["box_id"] if prefill else "",
            "box_no": prefill["box_no"] if prefill else "",
            "box_category": prefill.get("box_category", "") if prefill else "",
            "existing_locations": existing_locations,
        })

    return {"source": header, "items": items_out}


@api_router.get("/racking-notes/{rkn_id}")
async def get_racking_note(rkn_id: str, user=Depends(get_current_user)):
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Racking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "receipt_notes", "receipt_note_id")
    return doc


@api_router.put("/racking-notes/{rkn_id}", response_model=RackingNote)
async def update_racking_note(rkn_id: str, payload: RackingNoteCreate, user=Depends(_module_dep("stock_in"))):
    existing = await db.racking_notes.find_one({"id": rkn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — this racking note has already been recorded as Stock In")

    # Use the existing rkn's source as the source of truth for editing.
    src_type = existing.get("source_type") or "RN"
    src_id = existing.get("source_id") or existing.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "edit this racking note")

    _validate_racking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_cumulative_qty_polymorphic(src_type, src_id, parent_doc, payload.items, exclude_rkn_id=rkn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.racking_notes.update_one({"id": rkn_id}, {"$set": update})
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    return doc


@api_router.delete("/racking-notes/{rkn_id}")
async def delete_racking_note(rkn_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock In")
    src_type = existing.get("source_type") or "RN"
    src_id = existing.get("source_id") or existing.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "delete this racking note")
    await db.racking_notes.delete_one({"id": rkn_id})
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    return {"ok": True}


@api_router.post("/racking-notes/{rkn_id}/record")
async def record_racking_note(rkn_id: str, user=Depends(_module_dep("stock_in"))):
    rkn = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not rkn:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if rkn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    src_type = rkn.get("source_type") or "RN"
    src_id = rkn.get("source_id") or rkn.get("receipt_note_id")
    _, _, parent_doc, ultimate_rn = await _resolve_racking_source({"source_type": src_type, "source_id": src_id})
    _enforce_assignee(parent_doc, user, "record this racking note")
    items = rkn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    for idx, it in enumerate(items, start=1):
        if not it.get("godown_id") or not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown/Rack missing — edit racking note before recording")
        if not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing — edit racking note before recording")
        if (it.get("quantity") or 0) <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: quantity must be > 0")

    now = now_iso()
    tx_docs = []
    for it in items:
        master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
        tx_docs.append({
            "id": str(uuid.uuid4()),
            "type": "IN",
            "part_no": it["part_no"],
            "make": it["make"],
            "model": master.get("model", it.get("model", "")),
            "old_part_no": master.get("old_part_no", it.get("old_part_no", "")),
            "make_part_no": master.get("make_part_no", it.get("make_part_no", "")),
            "description_1": master.get("description_1", it.get("description_1", "")),
            "description_2": master.get("description_2", it.get("description_2", "")),
            "remarks_oem": master.get("remarks_oem", it.get("remarks_oem", "")),
            "remarks_others": master.get("remarks_others", it.get("remarks_others", "")),
            "item_category": master.get("item_category", it.get("item_category", "")),
            "image": master.get("image", ""),
            "quantity": it["quantity"],
            "godown_id": it["godown_id"],
            "godown_name": it.get("godown_name", ""),
            "rack_id": it["rack_id"],
            "rack_no": it.get("rack_no", ""),
            "box_id": it["box_id"],
            "box_no": it.get("box_no", ""),
            "box_category": it.get("box_category", ""),
            "racking_note_id": rkn["id"],
            "racking_note_no": rkn["rkn_no"],
            "source_type": src_type,
            "source_id": src_id,
            "source_no": rkn.get("source_no", ""),
            "receipt_note_id": rkn.get("receipt_note_id", ""),
            "receipt_note_no": rkn.get("receipt_note_no", ""),
            "created_at": now,
            "created_by": user.get("email"),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.racking_notes.update_one(
        {"id": rkn_id},
        {"$set": {"status": "RECORDED", "recorded_at": now}},
    )
    await _recompute_source_status_after_rkn(src_type, src_id, (ultimate_rn or {}).get("id"))
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_in.recorded", module="stock_in",
        title=f"Stock In recorded ({rkn['rkn_no']})",
        message=f"{user.get('email')} recorded {len(tx_docs)} item(s), total qty {total_qty} into stock from {rkn.get('source_no') or rkn.get('receipt_note_no') or 'source'}.",
        audience="module", ref_collection="racking_notes", ref_id=rkn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs)}

# ===================== SHORT RECEIVED NOTES — read-only endpoints (Phase 1) =====================

# ===================== SRN / ERN STATUS HELPERS (Phase 2) =====================

def _compute_srn_status(srn: dict) -> str:
    """Inline-child model status:
       sum(short_qty) == 0                                   -> PENDING
       no children                                            -> PENDING
       sum(received + not_receivable) < sum(short_qty)        -> PARTIALLY_RECEIVED
       sum(received + not_receivable) >= sum(short_qty)       -> COMPLETE
    """
    items = srn.get("items") or []
    total_short = 0.0
    total_decided = 0.0
    has_children = False
    for it in items:
        total_short += float(it.get("short_qty") or 0)
        for c in (it.get("children") or []):
            has_children = True
            total_decided += float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
    if total_short <= 0:
        return "PENDING"
    if not has_children or total_decided <= 0:
        return "PENDING"
    if total_decided + 1e-6 >= total_short:
        return "COMPLETE"
    return "PARTIALLY_RECEIVED"


def _compute_ern_status(ern: dict) -> str:
    """Inline-child model status:
       Each child entry has accepted_qty + rejected_qty.

         total_decided = sum(accepted+rejected) across all children
         no children                            -> PENDING
         total_decided >= sum(extra_qty)        -> COMPLETE
         any accepted > 0 AND pending > 0       -> PARTIALLY_ACCEPTED
         only rejected > 0 AND pending > 0      -> PARTIALLY_REJECTED
    """
    items = ern.get("items") or []
    total_extra = 0.0
    total_acc = 0.0
    total_rej = 0.0
    has_children = False
    for it in items:
        total_extra += float(it.get("extra_qty") or 0)
        for c in (it.get("children") or []):
            has_children = True
            total_acc += float(c.get("accepted_qty") or 0)
            total_rej += float(c.get("rejected_qty") or 0)
    if total_extra <= 0:
        return "PENDING"
    decided = total_acc + total_rej
    if not has_children or decided <= 0:
        return "PENDING"
    if decided + 1e-6 >= total_extra:
        return "COMPLETE"
    if total_acc > 0:
        return "PARTIALLY_ACCEPTED"
    if total_rej > 0:
        return "PARTIALLY_REJECTED"
    return "PENDING"


async def _aggregate_other_rkn_qty_by_source(source_type: str, source_id: str, exclude_rkn_id: Optional[str] = None) -> dict:
    """Sum qty per (part_no, make) across all OTHER racking notes for a given (source_type, source_id)."""
    q = {"source_type": source_type, "source_id": source_id}
    if exclude_rkn_id:
        q["id"] = {"$ne": exclude_rkn_id}
    sums = {}
    async for rkn in db.racking_notes.find(q, {"_id": 0, "items": 1}):
        for it in rkn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _recompute_srn_racking_status(srn_id: str):
    """Look at how much has been racked vs how much is rackable on this SRN, set racking_status."""
    srn = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not srn:
        return
    rackable = {}
    for it in srn.get("items") or []:
        k = _key(it.get("part_no"), it.get("make"))
        # Inline-child model: rackable = sum of children.received_qty
        # (not_receivable_qty is recorded but NOT rackable). Falls back to legacy
        # items[].fulfilled_qty if no children present (back-compat).
        children = it.get("children") or []
        if children:
            rackable[k] = rackable.get(k, 0) + sum(
                float(c.get("received_qty") or 0) for c in children
            )
        else:
            rackable[k] = rackable.get(k, 0) + float(it.get("fulfilled_qty") or 0)
    racked = await _aggregate_other_rkn_qty_by_source("SRN", srn_id, exclude_rkn_id=None)
    if not rackable or sum(rackable.values()) == 0:
        new_status = "RACKING_PENDING"
    else:
        all_full = all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)
        new_status = "FULLY_RACKED" if all_full else ("PARTIALLY_RACKED" if sum(racked.values()) > 0 else "RACKING_PENDING")
    update = {"racking_status": new_status}
    if new_status == "FULLY_RACKED":
        update["racked_at"] = srn.get("racked_at") or now_iso()
    elif srn.get("racked_at"):
        await db.short_received_notes.update_one({"id": srn_id}, {"$unset": {"racked_at": ""}})
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": update})


async def _recompute_ern_racking_status(ern_id: str):
    """For ERN, the rackable qty is accepted_qty per item. Rejected qty is NOT rackable."""
    ern = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not ern:
        return
    rackable = {}
    for it in ern.get("items") or []:
        k = _key(it.get("part_no"), it.get("make"))
        # Inline-child model: rackable = sum(children.accepted_qty); rejected NOT rackable.
        children = it.get("children") or []
        if children:
            rackable[k] = rackable.get(k, 0) + sum(
                float(c.get("accepted_qty") or 0) for c in children
            )
        else:
            rackable[k] = rackable.get(k, 0) + float(it.get("accepted_qty") or 0)
    racked = await _aggregate_other_rkn_qty_by_source("ERN", ern_id, exclude_rkn_id=None)
    if not rackable or sum(rackable.values()) == 0:
        new_status = "RACKING_PENDING"
    else:
        all_full = all(racked.get(k, 0) + 1e-6 >= q for k, q in rackable.items() if q > 0)
        new_status = "FULLY_RACKED" if all_full else ("PARTIALLY_RACKED" if sum(racked.values()) > 0 else "RACKING_PENDING")
    update = {"racking_status": new_status}
    if new_status == "FULLY_RACKED":
        update["racked_at"] = ern.get("racked_at") or now_iso()
    elif ern.get("racked_at"):
        await db.extra_received_notes.update_one({"id": ern_id}, {"$unset": {"racked_at": ""}})
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": update})


# ===================== SHORT RECEIVED NOTES — full CRUD =====================

class ShortReceivedNoteUpdate(BaseModel):
    """Used for editing fulfilled_qty + fulfillment_date on an SRN that is still PENDING/PARTIALLY_RECEIVED."""
    fulfillment_date: Optional[str] = ""
    items: List[dict] = []   # accept dicts so frontend can send {part_no, make, fulfilled_qty}


@api_router.get("/short-received-notes/next-no")
async def next_srn_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.short_received_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_srn_no": f"SRN/{fy}/{next_serial:03d}",
        "srn_date": today.date().isoformat(),
    }


@api_router.get("/short-received-notes")
async def list_short_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.short_received_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.short_received_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/short-received-notes/{srn_id}")
async def get_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/short-received-notes/{srn_id}", response_model=ShortReceivedNote)
async def update_short_received_note(srn_id: str, payload: ShortReceivedNoteUpdate, user=Depends(_module_dep("stock_in"))):
    """Edit fulfilled_qty / fulfillment_date on an SRN that hasn't been fully received yet.
    Also recompute status. Cannot edit if SRN is COMPLETE already."""
    existing = await db.short_received_notes.find_one({"id": srn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(existing, user, "edit this Short Received Note")
    if existing.get("status") in ("COMPLETE", "FULLY_RECEIVED"):
        raise HTTPException(status_code=409, detail="Cannot edit — this SRN is already fully received")

    _no_future_date(payload.fulfillment_date, "Fulfillment Date")

    # Build a lookup from payload by (part_no, make)
    payload_map = {}
    for r in (payload.items or []):
        if not r.get("part_no") or not r.get("make"):
            continue
        key = (r["part_no"], r["make"])
        payload_map[key] = r

    items_out = []
    for it in existing.get("items", []):
        new_it = dict(it)
        key = (it.get("part_no"), it.get("make"))
        if key in payload_map:
            ful = payload_map[key].get("fulfilled_qty")
            if ful is None or ful == "":
                new_it["fulfilled_qty"] = None
                new_it["quantity"] = None
            else:
                try:
                    f = float(ful)
                except Exception:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty must be a number")
                if f < 0:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty cannot be negative")
                short_q = float(it.get("short_qty") or 0)
                if f > short_q + 1e-6:
                    raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty ({f}) cannot exceed short_qty ({short_q})")
                new_it["fulfilled_qty"] = f
                new_it["quantity"] = f   # legacy mirror for racking
        items_out.append(new_it)

    update = {
        "items": items_out,
        "fulfillment_date": (payload.fulfillment_date or "").strip(),
        "updated_at": now_iso(),
    }
    new_status = _compute_srn_status({"items": items_out})
    update["status"] = new_status
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": update})
    await _recompute_srn_racking_status(srn_id)
    # Bubble up to the ultimate RN: its FULLY_RACKED check considers SRN fulfilled qty.
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


@api_router.post("/short-received-notes/{srn_id}/finalize", response_model=ShortReceivedNote)
async def finalize_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    """Finalize an SRN. If fulfilled_qty < short_qty for any item, a CHILD SRN is auto-created
    for the residual shortfall, linked back to the same parent_rn_id."""
    srn = await db.short_received_notes.find_one({"id": srn_id})
    if not srn:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(srn, user, "finalize this Short Received Note")
    if srn.get("status") in ("COMPLETE", "FULLY_RECEIVED"):
        raise HTTPException(status_code=409, detail="This SRN is already fully received")

    items = srn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="SRN has no items")

    # All items must have fulfilled_qty filled (>= 0). 0 is allowed -> the item rolls fully into the child SRN.
    residual_rows = []
    for it in items:
        f = it.get("fulfilled_qty")
        if f is None:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: enter Fulfilled Qty before Final Save")
        try:
            f = float(f)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: fulfilled_qty must be a number")
        short_q = float(it.get("short_qty") or 0)
        residual = short_q - f
        if residual > 1e-6:
            residual_rows.append({
                "part_no": it.get("part_no"), "make": it.get("make"),
                "invoice_qty": float(it.get("invoice_qty") or 0),
                "received_qty": float(it.get("received_qty") or 0),
                "short_qty": residual,
            })

    now = now_iso()
    new_status = _compute_srn_status({"items": items})
    update = {
        "status": new_status,
        "finalized_at": now,
    }
    if not srn.get("fulfillment_date") and any((it.get("fulfilled_qty") or 0) > 0 for it in items):
        update["fulfillment_date"] = datetime.now(timezone.utc).date().isoformat()
    await db.short_received_notes.update_one({"id": srn_id}, {"$set": update})
    await _recompute_srn_racking_status(srn_id)
    # Bubble up to the ultimate RN: its FULLY_RACKED check considers SRN fulfilled qty.
    if srn.get("parent_rn_id"):
        await _recompute_rn_status(srn["parent_rn_id"])

    # Create child SRN for the residual.
    child_srn_no = None
    if residual_rows:
        rn = await db.receipt_notes.find_one({"id": srn.get("parent_rn_id")}, {"_id": 0}) or {}
        child_srn_no = await _auto_create_srn_for_rn(rn, residual_rows, user, parent_srn=srn)

    msg = f"{user.get('email')} finalized {srn['srn_no']} ({new_status})."
    if child_srn_no:
        msg += f" Auto-created child {child_srn_no} for residual shortfall."
    await _notify(
        actor=user, type="srn.finalized", module="stock_in",
        title=f"SRN finalized — {srn['srn_no']}",
        message=msg, audience="module",
        ref_collection="short_received_notes", ref_id=srn_id,
    )

    doc = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    return doc


# ===================== SRN slice (per-batch fulfillment) — DEPRECATED =====================
# The slice-as-separate-doc endpoints below have been REMOVED in favour of the
# inline-child model defined further down. Helpers + body class kept for legacy
# imports.

class SrnFulfillSliceBody(BaseModel):
    part_no: str
    make: str
    fulfilled_qty: float
    fulfillment_date: str          # ISO YYYY-MM-DD


# ===================== SRN child rows (inline batches per item) =====================
#
# In the inline-child model, each parent SRN.items[i].children[] entry is a
# fulfillment record (NOT a separate SRN document). Each entry has:
#   {child_srn_no, received_qty, not_receivable_qty, created_at, status}
# where `child_srn_no` is the parent SRN no suffixed with an alphabetical letter
# (e.g. "SRN/26-27/001-A"). Racking happens against the parent SRN; the rackable
# qty per item is sum(children.received_qty).

class SrnChildBody(BaseModel):
    part_no: str
    make: str
    received_qty: float = 0
    not_receivable_qty: float = 0


def _next_letter_suffix(used: set[str]) -> str:
    """Return the next alphabetical suffix not in `used` (A..Z, AA..AZ, BA.. ZZ)."""
    import string
    letters = string.ascii_uppercase
    for ch in letters:
        if ch not in used:
            return ch
    for a in letters:
        for b in letters:
            cand = a + b
            if cand not in used:
                return cand
    raise HTTPException(status_code=409, detail="Cannot allocate child suffix — too many children")


@api_router.post("/short-received-notes/{srn_id}/children", response_model=ShortReceivedNote)
async def add_srn_child_row(srn_id: str, body: SrnChildBody,
                            user=Depends(_module_dep("stock_in"))):
    """Append a new fulfillment row to the matching parent SRN item. Auto-allocates
    a letter-suffixed child_srn_no (PARENT-A, PARENT-B, ...). Recomputes status."""
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(parent, user, "add a fulfillment row on this Short Received Note")

    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found on this SRN")

    p_item = parent["items"][item_idx]
    short_qty = float(p_item.get("short_qty") or 0)
    children = list(p_item.get("children") or [])
    used_total = sum(float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
                     for c in children)
    if used_total + rcv + nrcv > short_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Pending Qty ({short_qty - used_total:.2f})")

    parent_no = parent.get("srn_no", "")
    used_suffixes = {(c.get("child_srn_no") or "").rsplit("-", 1)[-1] for c in children}
    suffix = _next_letter_suffix(used_suffixes)
    child = {
        "child_srn_no": f"{parent_no}-{suffix}",
        "received_qty": rcv,
        "not_receivable_qty": nrcv,
        "created_at": now_iso(),
        "status": "RECEIVED" if rcv > 0 else "NOT_RECEIVABLE",
    }
    children.append(child)

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = children
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})


@api_router.put("/short-received-notes/{srn_id}/children/{child_srn_no:path}", response_model=ShortReceivedNote)
async def edit_srn_child_row(srn_id: str, child_srn_no: str, body: SrnChildBody,
                             user=Depends(_module_dep("stock_in"))):
    """Edit a child row (received_qty / not_receivable_qty). Allowed only if the
    parent SRN's racking_status isn't FULLY_RACKED AND the new totals don't drop
    below the qty already racked against the parent SRN."""
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent SRN not found")
    _enforce_assignee(parent, user, "edit a row on this Short Received Note")

    rcv = float(body.received_qty or 0)
    nrcv = float(body.not_receivable_qty or 0)
    if rcv < 0 or nrcv < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if rcv == 0 and nrcv == 0:
        raise HTTPException(status_code=400, detail="At least one of Received Qty or Not Receivable Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found")
    p_item = parent["items"][item_idx]
    short_qty = float(p_item.get("short_qty") or 0)
    children = list(p_item.get("children") or [])
    others_total = sum(
        float(c.get("received_qty") or 0) + float(c.get("not_receivable_qty") or 0)
        for c in children if c.get("child_srn_no") != child_srn_no
    )
    if others_total + rcv + nrcv > short_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Short Qty ({short_qty - others_total:.2f})")

    # If the parent's items[].children received qty already racked > new total received,
    # block (would create negative racking inventory).
    racked = await _aggregate_other_rkn_qty_by_source("SRN", srn_id, exclude_rkn_id=None)
    racked_for_item = float(racked.get(_key(body.part_no, body.make), 0))
    new_total_rcv = sum(
        float(c.get("received_qty") or 0)
        for c in children if c.get("child_srn_no") != child_srn_no
    ) + rcv
    if racked_for_item > new_total_rcv + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot reduce — {racked_for_item:.2f} already racked")

    found = False
    new_children = []
    for c in children:
        if c.get("child_srn_no") == child_srn_no:
            new_children.append({
                **c, "received_qty": rcv, "not_receivable_qty": nrcv,
                "status": "RECEIVED" if rcv > 0 else "NOT_RECEIVABLE",
            })
            found = True
        else:
            new_children.append(c)
    if not found:
        raise HTTPException(status_code=404, detail="Child row not found")

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = new_children
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})


@api_router.delete("/short-received-notes/{srn_id}/children/{child_srn_no:path}")
async def delete_srn_child_row(srn_id: str, child_srn_no: str,
                               user=Depends(_module_dep("stock_in"))):
    parent = await db.short_received_notes.find_one({"id": srn_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent SRN not found")
    _enforce_assignee(parent, user, "delete a row on this Short Received Note")

    target = None
    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        for c in (it.get("children") or []):
            if c.get("child_srn_no") == child_srn_no:
                target = c
                item_idx = i
                break
        if target:
            break
    if not target:
        raise HTTPException(status_code=404, detail="Child row not found")

    # Block deletion if dropping qty would go below already-racked.
    racked = await _aggregate_other_rkn_qty_by_source("SRN", srn_id, exclude_rkn_id=None)
    p_item = parent["items"][item_idx]
    racked_for_item = float(racked.get(_key(p_item.get("part_no"), p_item.get("make")), 0))
    remaining_rcv = sum(
        float(c.get("received_qty") or 0)
        for c in (p_item.get("children") or [])
        if c.get("child_srn_no") != child_srn_no
    )
    if racked_for_item > remaining_rcv + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot delete — {racked_for_item:.2f} already racked")

    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = [c for c in (new_it.get("children") or [])
                                  if c.get("child_srn_no") != child_srn_no]
        new_items.append(new_it)
    new_status = _compute_srn_status({**parent, "items": new_items})
    await db.short_received_notes.update_one(
        {"id": srn_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_srn_racking_status(srn_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return {"ok": True}


# Legacy slice endpoints (kept for back-compat; route to the new model).
@api_router.delete("/short-received-notes/{srn_id}")
async def delete_short_received_note(srn_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.short_received_notes.find_one({"id": srn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Short Received Note not found")
    _enforce_assignee(existing, user, "delete this Short Received Note")
    if await db.racking_notes.find_one({"source_type": "SRN", "source_id": srn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this SRN. Delete them first.")
    if await db.short_received_notes.find_one({"parent_srn_id": srn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — a child SRN was generated from this SRN. Delete the child first.")
    await db.short_received_notes.delete_one({"id": srn_id})
    return {"ok": True}


# ===================== EXTRA RECEIVED NOTES — full CRUD =====================

class ExtraReceivedNoteUpdate(BaseModel):
    """Used for editing accepted_qty / rejected_qty per item."""
    items: List[dict] = []


@api_router.get("/extra-received-notes/next-no")
async def next_ern_no(user=Depends(_module_dep("stock_in"))):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.extra_received_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_ern_no": f"ERN/{fy}/{next_serial:03d}",
        "ern_date": today.date().isoformat(),
    }


@api_router.get("/extra-received-notes")
async def list_extra_received_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    parent_rn_id: Optional[str] = None,
    user=Depends(_module_dep("stock_in")),
):
    query = {}
    if parent_rn_id:
        query["parent_rn_id"] = parent_rn_id
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.extra_received_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.extra_received_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/extra-received-notes/{ern_id}")
async def get_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/extra-received-notes/{ern_id}", response_model=ExtraReceivedNote)
async def update_extra_received_note(ern_id: str, payload: ExtraReceivedNoteUpdate, user=Depends(_module_dep("stock_in"))):
    existing = await db.extra_received_notes.find_one({"id": ern_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(existing, user, "edit this Extra Received Note")
    if existing.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="Cannot edit — this ERN is already complete")

    payload_map = {}
    for r in (payload.items or []):
        if not r.get("part_no") or not r.get("make"):
            continue
        key = (r["part_no"], r["make"])
        payload_map[key] = r

    items_out = []
    for it in existing.get("items", []):
        new_it = dict(it)
        key = (it.get("part_no"), it.get("make"))
        if key in payload_map:
            extra_q = float(it.get("extra_qty") or 0)
            for fld in ("accepted_qty", "rejected_qty"):
                v = payload_map[key].get(fld)
                if v is None or v == "":
                    new_it[fld] = None
                else:
                    try:
                        f = float(v)
                    except Exception:
                        raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: {fld} must be a number")
                    if f < 0:
                        raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: {fld} cannot be negative")
                    new_it[fld] = f
            acc = float(new_it.get("accepted_qty") or 0)
            rej = float(new_it.get("rejected_qty") or 0)
            if acc + rej > extra_q + 1e-6:
                raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted+rejected ({acc + rej}) cannot exceed extra_qty ({extra_q})")
            new_it["quantity"] = acc   # legacy mirror — racking only sees accepted
        items_out.append(new_it)

    update = {
        "items": items_out,
        "updated_at": now_iso(),
        "status": _compute_ern_status({"items": items_out}),
    }
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": update})
    await _recompute_ern_racking_status(ern_id)
    if existing.get("parent_rn_id"):
        await _recompute_rn_status(existing["parent_rn_id"])
    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    return doc


@api_router.post("/extra-received-notes/{ern_id}/finalize", response_model=ExtraReceivedNote)
async def finalize_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    """Finalize an ERN. accepted_qty + rejected_qty must be present (per row).
    accepted_qty is mandatory (>= 0); rejected_qty is optional (defaults to 0).
    If accepted+rejected < extra_qty, a CHILD ERN is auto-created for the residual."""
    ern = await db.extra_received_notes.find_one({"id": ern_id})
    if not ern:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(ern, user, "finalize this Extra Received Note")
    if ern.get("status") == "COMPLETE":
        raise HTTPException(status_code=409, detail="This ERN is already complete")

    items = ern.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="ERN has no items")

    residual_rows = []
    for it in items:
        acc = it.get("accepted_qty")
        if acc is None:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: enter Accepted Qty before Final Save")
        try:
            acc = float(acc)
        except Exception:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted_qty must be a number")
        rej = it.get("rejected_qty")
        rej = float(rej or 0)
        extra_q = float(it.get("extra_qty") or 0)
        if acc + rej > extra_q + 1e-6:
            raise HTTPException(status_code=400, detail=f"{it.get('part_no')}/{it.get('make')}: accepted+rejected ({acc + rej}) cannot exceed extra_qty ({extra_q})")
        residual = extra_q - acc - rej
        if residual > 1e-6:
            residual_rows.append({
                "part_no": it.get("part_no"), "make": it.get("make"),
                "invoice_qty": float(it.get("invoice_qty") or 0),
                "received_qty": float(it.get("received_qty") or 0),
                "extra_qty": residual,
            })

    now = now_iso()
    new_status = _compute_ern_status({"items": items})
    await db.extra_received_notes.update_one({"id": ern_id}, {"$set": {
        "status": new_status,
        "finalized_at": now,
    }})
    await _recompute_ern_racking_status(ern_id)
    if ern.get("parent_rn_id"):
        await _recompute_rn_status(ern["parent_rn_id"])

    child_ern_no = None
    if residual_rows:
        rn = await db.receipt_notes.find_one({"id": ern.get("parent_rn_id")}, {"_id": 0}) or {}
        child_ern_no = await _auto_create_ern_for_rn(rn, residual_rows, user, parent_ern=ern)

    msg = f"{user.get('email')} finalized {ern['ern_no']} ({new_status})."
    if child_ern_no:
        msg += f" Auto-created child {child_ern_no} for residual extra."
    await _notify(
        actor=user, type="ern.finalized", module="stock_in",
        title=f"ERN finalized — {ern['ern_no']}",
        message=msg, audience="module",
        ref_collection="extra_received_notes", ref_id=ern_id,
    )

    doc = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    return doc



# ===================== ERN child rows (inline batches per item) =====================
# Same model as SRN: each parent ERN.items[i].children[] entry is a decision
# record with {child_ern_no, accepted_qty, rejected_qty, created_at, status}.
# child_ern_no is "PARENT-LETTER" (e.g. "ERN/26-27/001-A"). Racking pulls from
# sum(children.accepted_qty); rejected qty is NOT rackable.

class ErnChildBody(BaseModel):
    part_no: str
    make: str
    accepted_qty: float = 0
    rejected_qty: float = 0


@api_router.post("/extra-received-notes/{ern_id}/children", response_model=ExtraReceivedNote)
async def add_ern_child_row(ern_id: str, body: ErnChildBody,
                            user=Depends(_module_dep("stock_in"))):
    """Append a decision row (accepted + rejected) to a parent ERN item.
    Auto-allocates a letter-suffixed child_ern_no (PARENT-A, PARENT-B, ...)."""
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(parent, user, "add a row on this Extra Received Note")
    acc = float(body.accepted_qty or 0)
    rej = float(body.rejected_qty or 0)
    if acc < 0 or rej < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if acc == 0 and rej == 0:
        raise HTTPException(status_code=400, detail="At least one of Accepted Qty or Rejected Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found on this ERN")
    p_item = parent["items"][item_idx]
    extra_qty = float(p_item.get("extra_qty") or 0)
    children = list(p_item.get("children") or [])
    used = sum(float(c.get("accepted_qty") or 0) + float(c.get("rejected_qty") or 0)
               for c in children)
    if used + acc + rej > extra_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Pending Qty ({extra_qty - used:.2f})")

    parent_no = parent.get("ern_no", "")
    used_suffixes = {(c.get("child_ern_no") or "").rsplit("-", 1)[-1] for c in children}
    suffix = _next_letter_suffix(used_suffixes)
    children.append({
        "child_ern_no": f"{parent_no}-{suffix}",
        "accepted_qty": acc,
        "rejected_qty": rej,
        "created_at": now_iso(),
        "status": "COMPLETE",
    })
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = children
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@api_router.put("/extra-received-notes/{ern_id}/children/{child_ern_no:path}", response_model=ExtraReceivedNote)
async def edit_ern_child_row(ern_id: str, child_ern_no: str, body: ErnChildBody,
                             user=Depends(_module_dep("stock_in"))):
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent ERN not found")
    _enforce_assignee(parent, user, "edit a row on this Extra Received Note")
    acc = float(body.accepted_qty or 0)
    rej = float(body.rejected_qty or 0)
    if acc < 0 or rej < 0:
        raise HTTPException(status_code=400, detail="Quantities cannot be negative")
    if acc == 0 and rej == 0:
        raise HTTPException(status_code=400, detail="At least one of Accepted Qty or Rejected Qty must be > 0")

    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        if it.get("part_no") == body.part_no and it.get("make") == body.make:
            item_idx = i
            break
    if item_idx is None:
        raise HTTPException(status_code=400, detail="Item not found")
    p_item = parent["items"][item_idx]
    extra_qty = float(p_item.get("extra_qty") or 0)
    children = list(p_item.get("children") or [])
    others = sum(float(c.get("accepted_qty") or 0) + float(c.get("rejected_qty") or 0)
                 for c in children if c.get("child_ern_no") != child_ern_no)
    if others + acc + rej > extra_qty + 1e-6:
        raise HTTPException(status_code=400,
                            detail=f"Exceeds Extra Qty ({extra_qty - others:.2f})")
    racked = await _aggregate_other_rkn_qty_by_source("ERN", ern_id, exclude_rkn_id=None)
    racked_for_item = float(racked.get(_key(body.part_no, body.make), 0))
    new_total_acc = sum(float(c.get("accepted_qty") or 0)
                        for c in children if c.get("child_ern_no") != child_ern_no) + acc
    if racked_for_item > new_total_acc + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot reduce — {racked_for_item:.2f} already racked")
    found = False
    new_children = []
    for c in children:
        if c.get("child_ern_no") == child_ern_no:
            new_children.append({**c, "accepted_qty": acc, "rejected_qty": rej})
            found = True
        else:
            new_children.append(c)
    if not found:
        raise HTTPException(status_code=404, detail="Child row not found")
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = new_children
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})


@api_router.delete("/extra-received-notes/{ern_id}/children/{child_ern_no:path}")
async def delete_ern_child_row(ern_id: str, child_ern_no: str,
                               user=Depends(_module_dep("stock_in"))):
    parent = await db.extra_received_notes.find_one({"id": ern_id})
    if not parent:
        raise HTTPException(status_code=404, detail="Parent ERN not found")
    _enforce_assignee(parent, user, "delete a row on this Extra Received Note")
    target = None
    item_idx = None
    for i, it in enumerate(parent.get("items") or []):
        for c in (it.get("children") or []):
            if c.get("child_ern_no") == child_ern_no:
                target = c
                item_idx = i
                break
        if target:
            break
    if not target:
        raise HTTPException(status_code=404, detail="Child row not found")
    racked = await _aggregate_other_rkn_qty_by_source("ERN", ern_id, exclude_rkn_id=None)
    p_item = parent["items"][item_idx]
    racked_for_item = float(racked.get(_key(p_item.get("part_no"), p_item.get("make")), 0))
    remaining_acc = sum(
        float(c.get("accepted_qty") or 0)
        for c in (p_item.get("children") or [])
        if c.get("child_ern_no") != child_ern_no
    )
    if racked_for_item > remaining_acc + 1e-6:
        raise HTTPException(status_code=409,
                            detail=f"Cannot delete — {racked_for_item:.2f} already racked")
    new_items = []
    for i, it in enumerate(parent["items"]):
        new_it = dict(it)
        if i == item_idx:
            new_it["children"] = [c for c in (new_it.get("children") or [])
                                  if c.get("child_ern_no") != child_ern_no]
        new_items.append(new_it)
    new_status = _compute_ern_status({**parent, "items": new_items})
    await db.extra_received_notes.update_one(
        {"id": ern_id},
        {"$set": {"items": new_items, "status": new_status}},
    )
    await _recompute_ern_racking_status(ern_id)
    if parent.get("parent_rn_id"):
        await _recompute_rn_status(parent["parent_rn_id"])
    return {"ok": True}


@api_router.delete("/extra-received-notes/{ern_id}")
async def delete_extra_received_note(ern_id: str, user=Depends(_module_dep("stock_in"))):
    existing = await db.extra_received_notes.find_one({"id": ern_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Extra Received Note not found")
    _enforce_assignee(existing, user, "delete this Extra Received Note")
    if await db.racking_notes.find_one({"source_type": "ERN", "source_id": ern_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — racking notes exist for this ERN. Delete them first.")
    if await db.extra_received_notes.find_one({"parent_ern_id": ern_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — a child ERN was generated from this ERN. Delete the child first.")
    await db.extra_received_notes.delete_one({"id": ern_id})
    return {"ok": True}


# ===================== RACKING SOURCES (polymorphic) =====================

# ===================== ISSUE NOTES (Stock Out) =====================
async def _stock_total_for(part_no: str, make: str) -> float:
    """Total available qty for a part/make across all locations (sum of IN - OUT)."""
    rows = await db.transactions.aggregate([
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
    ]).to_list(1)
    return rows[0]["q"] if rows else 0


@api_router.get("/issue-notes/lookup/{part_no}")
async def issue_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """For Issue Note flow: list makes that have positive stock for this part_no, with available qty."""
    # Pull every (part_no, make) combination that has transactions, then filter to those with positive total
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    return {"makes": [{"make": p["_id"]["make"], "available_qty": p["q"]} for p in pairs]}


@api_router.get("/issue-notes/next-no")
async def next_issue_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.issue_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_in_no": f"IN/{fy}/{next_serial:03d}",
        "in_date": today.date().isoformat(),
    }


def _validate_issue_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")


async def _validate_issue_qty_against_stock(items, exclude_in_id: Optional[str] = None):
    """Block requesting more than current stock total for any (part_no, make)."""
    # Sum requested qty in this payload per (part_no, make)
    req = {}
    for it in items:
        k = _key(it.part_no, it.make)
        req[k] = req.get(k, 0) + (it.quantity or 0)
    for k, q in req.items():
        part_no, make = k.split("||", 1)
        avail = await _stock_total_for(part_no, make)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot issue {q} — only {avail} in stock",
            )


@api_router.post("/issue-notes", response_model=IssueNote)
async def create_issue_note(payload: IssueNoteCreate, user=Depends(get_current_user)):
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("in", fy)
        in_no = f"IN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "in_no": in_no,
            "in_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issued_to": (payload.issued_to or "").strip(),
            "items": [it.model_dump() for it in payload.items],
            "status": "PICKING_PENDING",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.issue_notes.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="issue_note.created", module="stock_out",
                title=f"Issue Note {in_no}",
                message=f"{user.get('email')} created {in_no} for '{doc['issued_to'] or '—'}' with {len(doc['items'])} item(s) — picking pending.",
                audience="module", ref_collection="issue_notes", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="issue_note.assigned", module="stock_out",
                    title=f"Assigned to you: {in_no}",
                    message=f"{user.get('email')} assigned Issue Note {in_no} to you for picking.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="issue_notes", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate issue-note number: {last_err}")


@api_router.get("/issue-notes")
async def list_issue_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.issue_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.issue_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/issue-notes/{in_id}")
async def get_issue_note(in_id: str, user=Depends(get_current_user)):
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Issue note not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/issue-notes/{in_id}", response_model=IssueNote)
async def update_issue_note(in_id: str, payload: IssueNoteCreate, user=Depends(get_current_user)):
    existing = await db.issue_notes.find_one({"id": in_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue note not found")
    _enforce_assignee(existing, user, "edit this issue note")
    if await db.picking_notes.find_one({"issue_note_id": in_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — picking notes have been created. Delete those first.")
    _validate_issue_items(payload.items)
    await _validate_issue_qty_against_stock(payload.items, exclude_in_id=in_id)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_out")
    update = {
        "issued_to": (payload.issued_to or "").strip(),
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
        **assignee,
    }
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="issue_note.assigned", module="stock_out",
            title=f"Assigned to you: {existing.get('in_no', '')}",
            message=f"{user.get('email')} assigned Issue Note {existing.get('in_no', '')} to you for picking.",
            audience="user", target_user_id=new_aid,
            ref_collection="issue_notes", ref_id=in_id,
        )
    doc = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    return doc


@api_router.delete("/issue-notes/{in_id}")
async def delete_issue_note(in_id: str, user=Depends(get_current_user)):
    existing = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Issue note not found")
    _enforce_assignee(existing, user, "delete this issue note")
    if await db.picking_notes.find_one({"issue_note_id": in_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — picking notes exist for this issue note. Delete them first.")
    await db.issue_notes.delete_one({"id": in_id})
    return {"ok": True}


# -------------------- PICKING NOTES --------------------
async def _pick_aggregate_other(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Sum picking-note qty per (part,make,box_id) across other PNs for an Issue Note (DRAFT + RECORDED)."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1}):
        for it in pn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _pick_aggregate_other_by_loc(in_id: str, exclude_pn_id: Optional[str] = None) -> dict:
    """Per-location sum across other PNs (DRAFT + RECORDED). Key = part||make||box_id."""
    q = {"issue_note_id": in_id}
    if exclude_pn_id:
        q["id"] = {"$ne": exclude_pn_id}
    sums = {}
    async for pn in db.picking_notes.find(q, {"_id": 0, "items": 1, "status": 1}):
        # Only DRAFT picks reserve at the location level (RECORDED already debited the balance).
        if pn.get("status") != "DRAFT":
            continue
        for it in pn.get("items", []):
            loc_key = f"{it.get('part_no','')}||{it.get('make','')}||{it.get('box_id','')}"
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


async def _recompute_in_status(in_id: str):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        return
    requested = {}
    for it in inn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    picked = await _pick_aggregate_other(in_id)
    if not requested:
        new_status = "PICKING_PENDING"
    elif sum(picked.values()) == 0:
        new_status = "PICKING_PENDING"
    else:
        all_full = all(picked.get(k, 0) + 1e-6 >= q for k, q in requested.items())
        new_status = "FULLY_PICKED" if all_full else "PARTIALLY_PICKED"
    update = {"status": new_status}
    if new_status == "FULLY_PICKED":
        update["picked_at"] = inn.get("picked_at") or now_iso()
    else:
        if inn.get("picked_at"):
            await db.issue_notes.update_one({"id": in_id}, {"$unset": {"picked_at": ""}})
    await db.issue_notes.update_one({"id": in_id}, {"$set": update})


@api_router.get("/picking-notes/next-no")
async def next_picking_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.picking_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_pn_no": f"PN/{fy}/{next_serial:03d}",
        "pn_date": today.date().isoformat(),
    }


async def _stock_locations_for(part_no: str, make: str) -> List[dict]:
    """Aggregate current balance per location (positive only) for a part/make."""
    pipeline = [
        {"$match": {"part_no": part_no, "make": make}},
        {"$group": {
            "_id": {
                "godown_id": "$godown_id", "godown_name": "$godown_name",
                "rack_id": "$rack_id", "rack_no": "$rack_no",
                "box_id": "$box_id", "box_no": "$box_no", "box_category": "$box_category",
            },
            "quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"quantity": {"$gt": 0}}},
        {"$sort": {"_id.godown_name": 1, "_id.rack_no": 1, "_id.box_no": 1}},
    ]
    rows = await db.transactions.aggregate(pipeline).to_list(1000)
    return [{**r["_id"], "current_qty": r["quantity"]} for r in rows]


@api_router.get("/picking-notes/prepare/{in_id}")
async def prepare_picking_note(in_id: str, exclude_pn_id: Optional[str] = None, user=Depends(get_current_user)):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=404, detail="Issue note not found")
    if inn.get("status") == "FULLY_PICKED" and not exclude_pn_id:
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    other_sums = await _pick_aggregate_other(in_id, exclude_pn_id)
    other_loc_sums = await _pick_aggregate_other_by_loc(in_id, exclude_pn_id)

    items_out = []
    for it in inn.get("items", []):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        requested_qty = it.get("quantity", 0) or 0
        already = other_sums.get(_key(part_no, make), 0)
        pending = requested_qty - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        locs = await _stock_locations_for(part_no, make)
        # subtract pending DRAFT picks per location to produce "available_for_pick"
        for L in locs:
            reserved = other_loc_sums.get(f"{part_no}||{make}||{L['box_id']}", 0)
            L["available_qty"] = max(0, L["current_qty"] - reserved)
        # Pre-pick if exactly 1 location has enough
        pickable = [L for L in locs if L["available_qty"] > 0]
        prefill = pickable[0] if len(pickable) == 1 and pickable[0]["available_qty"] >= pending else None

        items_out.append({
            "part_no": part_no, "make": make,
            "requested_qty": requested_qty,
            "already_picked_qty": already,
            "pending_qty": pending,
            "quantity": prefill["available_qty"] if prefill else min(pending, pickable[0]["available_qty"]) if pickable else 0,
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            "godown_id": prefill["godown_id"] if prefill else "",
            "godown_name": prefill["godown_name"] if prefill else "",
            "rack_id": prefill["rack_id"] if prefill else "",
            "rack_no": prefill["rack_no"] if prefill else "",
            "box_id": prefill["box_id"] if prefill else "",
            "box_no": prefill["box_no"] if prefill else "",
            "box_category": prefill.get("box_category", "") if prefill else "",
            "available_locations": locs,
        })

    return {
        "issue_note": {
            "id": inn["id"], "in_no": inn["in_no"], "in_date": inn["in_date"],
            "issued_to": inn.get("issued_to", ""), "status": inn.get("status"),
        },
        "items": items_out,
    }


def _validate_picking_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.godown_id or "").strip() or not (it.rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown and Rack are required")


async def _validate_picking_constraints(in_id: str, items, exclude_pn_id: Optional[str] = None):
    inn = await db.issue_notes.find_one({"id": in_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    requested = {}
    for it in inn.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _pick_aggregate_other(in_id, exclude_pn_id)
    other_loc_sums = await _pick_aggregate_other_by_loc(in_id, exclude_pn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.box_id or ''}"
        new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked issue note")
    # 1. cumulative qty
    for k, new_q in new_sums.items():
        recv = requested.get(k, 0)
        used = other_sums.get(k, 0)
        if used + new_q > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(status_code=400, detail=(
                f"Quantity exceeds issue note for {part} / {make}: "
                f"requested {recv}, already picked elsewhere {used}, this note {new_q} "
                f"(total {used + new_q} > {recv})"
            ))
    # 2. per-location stock availability (after subtracting other DRAFT picks at same loc)
    # Group by part||make to fetch locations once
    loc_cache = {}
    for k_full, new_q in new_loc_sums.items():
        part_no, make, box_id = k_full.split("||", 2)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        # box_id might be empty for racks with no boxes — match accordingly
        loc = next((L for L in locs if (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen location")
        already_pending_here = other_loc_sums.get(k_full, 0)
        available = (loc.get("current_qty") or 0) - already_pending_here
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to pick {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))


@api_router.post("/picking-notes", response_model=PickingNote)
async def create_picking_note(payload: PickingNoteCreate, user=Depends(get_current_user)):
    inn = await db.issue_notes.find_one({"id": payload.issue_note_id}, {"_id": 0})
    if not inn:
        raise HTTPException(status_code=400, detail="Issue note not found")
    _enforce_assignee(inn, user, "create a picking note for this issue")
    if inn.get("status") == "FULLY_PICKED":
        raise HTTPException(status_code=409, detail="This issue note is already fully picked")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_picking_constraints(inn["id"], payload.items, exclude_pn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("pn", fy)
        pn_no = f"PN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "pn_no": pn_no,
            "pn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "issue_note_id": inn["id"],
            "issue_note_no": inn["in_no"],
            "issue_note_date": inn["in_date"],
            "issued_to": inn.get("issued_to", ""),
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.picking_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_in_status(inn["id"])
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate picking-note number: {last_err}")


@api_router.get("/picking-notes")
async def list_picking_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.picking_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.picking_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "issue_notes", "issue_note_id")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/picking-notes/{pn_id}")
async def get_picking_note(pn_id: str, user=Depends(get_current_user)):
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Picking note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "issue_notes", "issue_note_id")
    return doc


@api_router.put("/picking-notes/{pn_id}", response_model=PickingNote)
async def update_picking_note(pn_id: str, payload: PickingNoteCreate, user=Depends(get_current_user)):
    existing = await db.picking_notes.find_one({"id": pn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Out")
    in_parent = await db.issue_notes.find_one({"id": existing.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "edit this picking note")
    _validate_picking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    await _validate_picking_constraints(existing.get("issue_note_id"), payload.items, exclude_pn_id=pn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.picking_notes.update_one({"id": pn_id}, {"$set": update})
    await _recompute_in_status(existing.get("issue_note_id"))
    doc = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    return doc


@api_router.delete("/picking-notes/{pn_id}")
async def delete_picking_note(pn_id: str, user=Depends(get_current_user)):
    existing = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Out")
    in_parent = await db.issue_notes.find_one({"id": existing.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "delete this picking note")
    await db.picking_notes.delete_one({"id": pn_id})
    if existing.get("issue_note_id"):
        await _recompute_in_status(existing["issue_note_id"])
    return {"ok": True}


@api_router.post("/picking-notes/{pn_id}/record")
async def record_picking_note(pn_id: str, user=Depends(get_current_user)):
    pn = await db.picking_notes.find_one({"id": pn_id}, {"_id": 0})
    if not pn:
        raise HTTPException(status_code=404, detail="Picking note not found")
    if pn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    in_parent = await db.issue_notes.find_one({"id": pn.get("issue_note_id")}, {"_id": 0}) or {}
    _enforce_assignee(in_parent, user, "record this picking note")
    items = pn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    # Final availability check (real balance, not the DRAFT-pending-aware one)
    for idx, it in enumerate(items, start=1):
        if not it.get("godown_id") or not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown/Rack missing")
        if not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing")
        # Real balance at the box (sum of all IN-OUT for this part/make/box)
        bal = await db.transactions.aggregate([
            {"$match": {"part_no": it["part_no"], "make": it["make"], "box_id": it.get("box_id", "")}},
            {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        ]).to_list(1)
        avail = (bal[0]["q"] if bal else 0)
        if avail < it["quantity"] - 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at "
                f"{it.get('godown_name')}/{it.get('rack_no')}/{it.get('box_no') or '—'}: have {avail}, need {it['quantity']}"
            ))

    now = now_iso()
    tx_docs = []
    for it in items:
        master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
        tx_docs.append({
            "id": str(uuid.uuid4()),
            "type": "OUT",
            "part_no": it["part_no"], "make": it["make"],
            "model": master.get("model", it.get("model", "")),
            "old_part_no": master.get("old_part_no", it.get("old_part_no", "")),
            "make_part_no": master.get("make_part_no", it.get("make_part_no", "")),
            "description_1": master.get("description_1", it.get("description_1", "")),
            "description_2": master.get("description_2", it.get("description_2", "")),
            "remarks_oem": master.get("remarks_oem", it.get("remarks_oem", "")),
            "remarks_others": master.get("remarks_others", it.get("remarks_others", "")),
            "item_category": master.get("item_category", it.get("item_category", "")),
            "image": master.get("image", ""),
            "quantity": it["quantity"],
            "godown_id": it["godown_id"], "godown_name": it.get("godown_name", ""),
            "rack_id": it["rack_id"], "rack_no": it.get("rack_no", ""),
            "box_id": it["box_id"], "box_no": it.get("box_no", ""), "box_category": it.get("box_category", ""),
            "picking_note_id": pn["id"], "picking_note_no": pn["pn_no"],
            "issue_note_id": pn.get("issue_note_id", ""), "issue_note_no": pn.get("issue_note_no", ""),
            "issued_to": pn.get("issued_to", ""),
            "created_at": now, "created_by": user.get("email"),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.picking_notes.update_one({"id": pn_id}, {"$set": {"status": "RECORDED", "recorded_at": now}})
    if pn.get("issue_note_id"):
        await _recompute_in_status(pn["issue_note_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_out.recorded", module="stock_out",
        title=f"Stock Out recorded ({pn['pn_no']})",
        message=f"{user.get('email')} issued {len(tx_docs)} item(s), total qty {total_qty} to '{pn.get('issued_to') or '—'}' from {pn.get('issue_note_no') or 'IN'}.",
        audience="module", ref_collection="picking_notes", ref_id=pn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs)}


# ===================== STOCK TRANSFER (Request + Note) =====================
async def _transfer_other_qty(str_id: str, exclude_stn_id: Optional[str] = None) -> dict:
    """Sum qty per (part,make) across other STNs (DRAFT + RECORDED) for a given STR."""
    q = {"transfer_request_id": str_id}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            k = _key(it.get("part_no"), it.get("make"))
            sums[k] = sums.get(k, 0) + (it.get("quantity") or 0)
    return sums


async def _transfer_other_src_loc_qty(exclude_stn_id: Optional[str] = None) -> dict:
    """Per-source-location sum across DRAFT STNs (used to reserve source qty so two drafts can't double-book)."""
    q = {"status": "DRAFT"}
    if exclude_stn_id:
        q["id"] = {"$ne": exclude_stn_id}
    sums = {}
    async for stn in db.transfer_notes.find(q, {"_id": 0, "items": 1}):
        for it in stn.get("items", []):
            loc_key = f"{it.get('part_no','')}||{it.get('make','')}||{it.get('src_box_id','') or ''}"
            sums[loc_key] = sums.get(loc_key, 0) + (it.get("quantity") or 0)
    return sums


async def _recompute_str_status(str_id: str):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        return
    requested = {}
    for it in s.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    transferred = await _transfer_other_qty(str_id)
    if not requested or sum(transferred.values()) == 0:
        new_status = "PENDING"
    else:
        all_full = all(transferred.get(k, 0) + 1e-6 >= q for k, q in requested.items())
        new_status = "FULLY_TRANSFERRED" if all_full else "PARTIALLY_TRANSFERRED"
    update = {"status": new_status}
    if new_status == "FULLY_TRANSFERRED":
        update["transferred_at"] = s.get("transferred_at") or now_iso()
    else:
        if s.get("transferred_at"):
            await db.transfer_requests.update_one({"id": str_id}, {"$unset": {"transferred_at": ""}})
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})


def _validate_transfer_request_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")


async def _validate_transfer_request_qty(items, exclude_str_id: Optional[str] = None):
    """Block requesting more than current stock total for any (part,make)."""
    req = {}
    for it in items:
        k = _key(it.part_no, it.make)
        req[k] = req.get(k, 0) + (it.quantity or 0)
    for k, q in req.items():
        part_no, make = k.split("||", 1)
        avail = await _stock_total_for(part_no, make)
        if q > avail + 1e-6:
            raise HTTPException(
                status_code=400,
                detail=f"{part_no} / {make}: cannot transfer {q} — only {avail} in stock",
            )


# ---------- Transfer Request ----------
@api_router.get("/transfer-requests/lookup/{part_no}")
async def transfer_lookup_makes(part_no: str, user=Depends(get_current_user)):
    """Reuse the issue-note lookup: makes with positive stock for this part_no."""
    pairs = await db.transactions.aggregate([
        {"$match": {"part_no": part_no}},
        {"$group": {"_id": {"make": "$make"}, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        {"$match": {"q": {"$gt": 0}}},
        {"$sort": {"_id.make": 1}},
    ]).to_list(1000)
    return {"makes": [{"make": p["_id"]["make"], "available_qty": p["q"]} for p in pairs]}


@api_router.get("/transfer-requests/next-no")
async def next_transfer_request_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.transfer_requests.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_str_no": f"STR/{fy}/{next_serial:03d}",
        "str_date": today.date().isoformat(),
    }


@api_router.post("/transfer-requests", response_model=TransferRequest)
async def create_transfer_request(payload: TransferRequestCreate, user=Depends(get_current_user)):
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("str", fy)
        str_no = f"STR/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "str_no": str_no,
            "str_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "purpose": (payload.purpose or "").strip(),
            "items": [it.model_dump() for it in payload.items],
            "status": "PENDING",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
            **assignee,
        }
        try:
            await db.transfer_requests.insert_one(doc)
            doc.pop("_id", None)
            await _notify(
                actor=user, type="transfer_request.created", module="stock_transfer",
                title=f"Transfer Request {str_no}",
                message=f"{user.get('email')} created {str_no} with {len(doc['items'])} item(s) — transfer pending.",
                audience="module", ref_collection="transfer_requests", ref_id=doc["id"],
            )
            if assignee.get("assigned_to_user_id"):
                await _notify(
                    actor=user, type="transfer_request.assigned", module="stock_transfer",
                    title=f"Assigned to you: {str_no}",
                    message=f"{user.get('email')} assigned Transfer Request {str_no} to you.",
                    audience="user", target_user_id=assignee["assigned_to_user_id"],
                    ref_collection="transfer_requests", ref_id=doc["id"],
                )
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-request number: {last_err}")


@api_router.get("/transfer-requests")
async def list_transfer_requests(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.transfer_requests.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_requests.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/transfer-requests/{str_id}")
async def get_transfer_request(str_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    await _enrich_note_items([doc])
    return doc


@api_router.put("/transfer-requests/{str_id}", response_model=TransferRequest)
async def update_transfer_request(str_id: str, payload: TransferRequestCreate, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "edit this transfer request")
    if await db.transfer_notes.find_one({"transfer_request_id": str_id}):
        raise HTTPException(status_code=409, detail="Cannot edit — transfer notes have been created. Delete those first.")
    _validate_transfer_request_items(payload.items)
    await _validate_transfer_request_qty(payload.items, exclude_str_id=str_id)
    assignee = await _resolve_assignee(payload.assigned_to_user_id, "stock_transfer")
    update = {
        "purpose": (payload.purpose or "").strip(),
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
        **assignee,
    }
    await db.transfer_requests.update_one({"id": str_id}, {"$set": update})
    new_aid = assignee.get("assigned_to_user_id")
    if new_aid and new_aid != existing.get("assigned_to_user_id"):
        await _notify(
            actor=user, type="transfer_request.assigned", module="stock_transfer",
            title=f"Assigned to you: {existing.get('str_no', '')}",
            message=f"{user.get('email')} assigned Transfer Request {existing.get('str_no', '')} to you.",
            audience="user", target_user_id=new_aid,
            ref_collection="transfer_requests", ref_id=str_id,
        )
    doc = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    return doc


@api_router.delete("/transfer-requests/{str_id}")
async def delete_transfer_request(str_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    _enforce_assignee(existing, user, "delete this transfer request")
    if await db.transfer_notes.find_one({"transfer_request_id": str_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — transfer notes exist. Delete them first.")
    await db.transfer_requests.delete_one({"id": str_id})
    return {"ok": True}


# ---------- Transfer Note ----------
@api_router.get("/transfer-notes/next-no")
async def next_transfer_note_no(user=Depends(get_current_user)):
    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    last = await db.transfer_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
    next_serial = (last[0]["serial"] if last else 0) + 1
    return {
        "fy": fy,
        "next_serial": next_serial,
        "next_stn_no": f"STN/{fy}/{next_serial:03d}",
        "stn_date": today.date().isoformat(),
    }


@api_router.get("/transfer-notes/prepare/{str_id}")
async def prepare_transfer_note(str_id: str, exclude_stn_id: Optional[str] = None, user=Depends(get_current_user)):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=404, detail="Transfer request not found")
    if s.get("status") == "FULLY_TRANSFERRED" and not exclude_stn_id:
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")

    other_sums = await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    items_out = []
    for it in s.get("items", []):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        requested_qty = it.get("quantity", 0) or 0
        already = other_sums.get(_key(part_no, make), 0)
        pending = requested_qty - already
        if pending <= 0:
            continue
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        locs = await _stock_locations_for(part_no, make)
        for L in locs:
            reserved = other_loc_sums.get(f"{part_no}||{make}||{L['box_id']}", 0)
            L["available_qty"] = max(0, L["current_qty"] - reserved)
        pickable = [L for L in locs if L["available_qty"] > 0]
        prefill = pickable[0] if len(pickable) == 1 and pickable[0]["available_qty"] >= pending else None

        items_out.append({
            "part_no": part_no, "make": make,
            "requested_qty": requested_qty,
            "already_transferred_qty": already,
            "pending_qty": pending,
            "quantity": prefill["available_qty"] if prefill else (min(pending, pickable[0]["available_qty"]) if pickable else 0),
            "model": master.get("model", ""),
            "old_part_no": master.get("old_part_no", ""),
            "make_part_no": master.get("make_part_no", ""),
            "description_1": master.get("description_1", ""),
            "description_2": master.get("description_2", ""),
            "remarks_oem": master.get("remarks_oem", ""),
            "remarks_others": master.get("remarks_others", ""),
            "item_category": master.get("item_category", ""),
            # Source prefill
            "src_godown_id": prefill["godown_id"] if prefill else "",
            "src_godown_name": prefill["godown_name"] if prefill else "",
            "src_rack_id": prefill["rack_id"] if prefill else "",
            "src_rack_no": prefill["rack_no"] if prefill else "",
            "src_box_id": prefill["box_id"] if prefill else "",
            "src_box_no": prefill["box_no"] if prefill else "",
            "src_box_category": prefill.get("box_category", "") if prefill else "",
            # Destination from request
            "dest_godown_id": it.get("dest_godown_id", "") or "",
            "dest_godown_name": it.get("dest_godown_name", "") or "",
            "dest_rack_id": it.get("dest_rack_id", "") or "",
            "dest_rack_no": it.get("dest_rack_no", "") or "",
            "dest_box_id": it.get("dest_box_id", "") or "",
            "dest_box_no": it.get("dest_box_no", "") or "",
            "dest_box_category": it.get("dest_box_category", "") or "",
            "available_locations": locs,
        })

    return {
        "transfer_request": {
            "id": s["id"], "str_no": s["str_no"], "str_date": s["str_date"],
            "purpose": s.get("purpose", ""), "status": s.get("status"),
        },
        "items": items_out,
    }


def _validate_transfer_note_items(items):
    if not items:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be > 0")
        if not (it.src_godown_id or "").strip() or not (it.src_rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Godown and Rack are required")
        if not (it.dest_godown_id or "").strip() or not (it.dest_rack_id or "").strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Godown and Rack are required")
        # Disallow source == destination
        if (
            it.src_godown_id == it.dest_godown_id
            and it.src_rack_id == it.dest_rack_id
            and (it.src_box_id or "") == (it.dest_box_id or "")
        ):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source and destination locations must differ")


async def _validate_transfer_note_constraints(str_id: str, items, exclude_stn_id: Optional[str] = None):
    s = await db.transfer_requests.find_one({"id": str_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    requested = {}
    for it in s.get("items", []):
        k = _key(it.get("part_no"), it.get("make"))
        requested[k] = requested.get(k, 0) + (it.get("quantity") or 0)
    other_sums = await _transfer_other_qty(str_id, exclude_stn_id)
    other_loc_sums = await _transfer_other_src_loc_qty(exclude_stn_id)

    new_sums = {}
    new_loc_sums = {}
    for it in items:
        k = _key(it.part_no, it.make)
        new_sums[k] = new_sums.get(k, 0) + (it.quantity or 0)
        loc_key = f"{it.part_no}||{it.make}||{it.src_box_id or ''}"
        new_loc_sums[loc_key] = new_loc_sums.get(loc_key, 0) + (it.quantity or 0)
        if k not in requested:
            raise HTTPException(status_code=400, detail=f"{it.part_no} / {it.make} is not on the linked transfer request")

    # Cumulative qty cap vs request
    for k, new_q in new_sums.items():
        recv = requested.get(k, 0)
        used = other_sums.get(k, 0)
        if used + new_q > recv + 1e-6:
            part, make = k.split("||", 1)
            raise HTTPException(status_code=400, detail=(
                f"Quantity exceeds transfer request for {part} / {make}: "
                f"requested {recv}, already transferred elsewhere {used}, this note {new_q} "
                f"(total {used + new_q} > {recv})"
            ))

    # Per-source-location stock check
    loc_cache = {}
    for k_full, new_q in new_loc_sums.items():
        part_no, make, box_id = k_full.split("||", 2)
        if (part_no, make) not in loc_cache:
            loc_cache[(part_no, make)] = await _stock_locations_for(part_no, make)
        locs = loc_cache[(part_no, make)]
        loc = next((L for L in locs if (L.get("box_id") or "") == box_id), None)
        if not loc:
            raise HTTPException(status_code=400, detail=f"{part_no} / {make}: no stock at the chosen source location")
        already_pending_here = other_loc_sums.get(k_full, 0)
        available = (loc.get("current_qty") or 0) - already_pending_here
        if new_q > available + 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"{part_no} / {make}: trying to transfer {new_q} but only {available} available at "
                f"{loc.get('godown_name')}/{loc.get('rack_no')}/{loc.get('box_no') or '—'}"
            ))


@api_router.post("/transfer-notes", response_model=TransferNote)
async def create_transfer_note(payload: TransferNoteCreate, user=Depends(get_current_user)):
    s = await db.transfer_requests.find_one({"id": payload.transfer_request_id}, {"_id": 0})
    if not s:
        raise HTTPException(status_code=400, detail="Transfer request not found")
    _enforce_assignee(s, user, "create a transfer note for this request")
    if s.get("status") == "FULLY_TRANSFERRED":
        raise HTTPException(status_code=409, detail="This transfer request is already fully transferred")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    await _validate_transfer_note_constraints(s["id"], payload.items, exclude_stn_id=None)

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        serial = await _alloc_serial("stn", fy)
        stn_no = f"STN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "stn_no": stn_no,
            "stn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "transfer_request_id": s["id"],
            "transfer_request_no": s["str_no"],
            "transfer_request_date": s["str_date"],
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.transfer_notes.insert_one(doc)
            doc.pop("_id", None)
            await _recompute_str_status(s["id"])
            return doc
        except DuplicateKeyError as e:
            last_err = e
    raise HTTPException(status_code=500, detail=f"Could not allocate transfer-note number: {last_err}")


@api_router.get("/transfer-notes")
async def list_transfer_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    not_status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        vals = [s.strip().upper() for s in status.split(",") if s.strip()]
        query["status"] = {"$in": vals} if len(vals) > 1 else vals[0]
    if not_status:
        nvals = [s.strip().upper() for s in not_status.split(",") if s.strip()]
        query["status"] = {"$nin": nvals} if not query.get("status") else {**query["status"], "$nin": nvals}
    total = await db.transfer_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.transfer_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    await _enrich_note_items(rows)
    await _enrich_with_parent_assignee(rows, "transfer_requests", "transfer_request_id")
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/transfer-notes/{stn_id}")
async def get_transfer_note(stn_id: str, user=Depends(get_current_user)):
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    await _enrich_note_items([doc])
    await _enrich_with_parent_assignee([doc], "transfer_requests", "transfer_request_id")
    return doc


@api_router.put("/transfer-notes/{stn_id}", response_model=TransferNote)
async def update_transfer_note(stn_id: str, payload: TransferNoteCreate, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "edit this transfer note")
    _validate_transfer_note_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.src_box_id or "").strip() and await _box_id_required_for_rack(it.src_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Source Box is required for this rack")
        if not (it.dest_box_id or "").strip() and await _box_id_required_for_rack(it.dest_rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Destination Box is required for this rack")
    await _validate_transfer_note_constraints(existing.get("transfer_request_id"), payload.items, exclude_stn_id=stn_id)
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": update})
    await _recompute_str_status(existing.get("transfer_request_id"))
    doc = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    return doc


@api_router.delete("/transfer-notes/{stn_id}")
async def delete_transfer_note(stn_id: str, user=Depends(get_current_user)):
    existing = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock Transfer")
    parent = await db.transfer_requests.find_one({"id": existing.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "delete this transfer note")
    await db.transfer_notes.delete_one({"id": stn_id})
    if existing.get("transfer_request_id"):
        await _recompute_str_status(existing["transfer_request_id"])
    return {"ok": True}


@api_router.post("/transfer-notes/{stn_id}/record")
async def record_transfer_note(stn_id: str, user=Depends(get_current_user)):
    stn = await db.transfer_notes.find_one({"id": stn_id}, {"_id": 0})
    if not stn:
        raise HTTPException(status_code=404, detail="Transfer note not found")
    if stn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    parent = await db.transfer_requests.find_one({"id": stn.get("transfer_request_id")}, {"_id": 0}) or {}
    _enforce_assignee(parent, user, "record this transfer note")
    items = stn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    # Final source-balance check (real balance, not DRAFT-aware)
    for idx, it in enumerate(items, start=1):
        bal = await db.transactions.aggregate([
            {"$match": {"part_no": it["part_no"], "make": it["make"], "box_id": it.get("src_box_id", "")}},
            {"$group": {"_id": None, "q": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}},
        ]).to_list(1)
        avail = (bal[0]["q"] if bal else 0)
        if avail < it["quantity"] - 1e-6:
            raise HTTPException(status_code=400, detail=(
                f"Row {idx}: insufficient stock for {it['part_no']} / {it['make']} at source "
                f"{it.get('src_godown_name')}/{it.get('src_rack_no')}/{it.get('src_box_no') or '—'}: have {avail}, need {it['quantity']}"
            ))

    now = now_iso()
    tx_docs = []
    for it in items:
        master = await db.stock_master.find_one({"part_no": it["part_no"], "make": it["make"]}, {"_id": 0}) or {}
        common = {
            "part_no": it["part_no"], "make": it["make"],
            "model": master.get("model", it.get("model", "")),
            "old_part_no": master.get("old_part_no", it.get("old_part_no", "")),
            "make_part_no": master.get("make_part_no", it.get("make_part_no", "")),
            "description_1": master.get("description_1", it.get("description_1", "")),
            "description_2": master.get("description_2", it.get("description_2", "")),
            "remarks_oem": master.get("remarks_oem", it.get("remarks_oem", "")),
            "remarks_others": master.get("remarks_others", it.get("remarks_others", "")),
            "item_category": master.get("item_category", it.get("item_category", "")),
            "image": master.get("image", ""),
            "quantity": it["quantity"],
            "transfer_note_id": stn["id"], "transfer_note_no": stn["stn_no"],
            "transfer_request_id": stn.get("transfer_request_id", ""),
            "transfer_request_no": stn.get("transfer_request_no", ""),
            "created_at": now, "created_by": user.get("email"),
        }
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "OUT",
            "godown_id": it["src_godown_id"], "godown_name": it.get("src_godown_name", ""),
            "rack_id": it["src_rack_id"], "rack_no": it.get("src_rack_no", ""),
            "box_id": it.get("src_box_id", ""), "box_no": it.get("src_box_no", ""), "box_category": it.get("src_box_category", ""),
        })
        tx_docs.append({
            **common,
            "id": str(uuid.uuid4()),
            "type": "IN",
            "godown_id": it["dest_godown_id"], "godown_name": it.get("dest_godown_name", ""),
            "rack_id": it["dest_rack_id"], "rack_no": it.get("dest_rack_no", ""),
            "box_id": it.get("dest_box_id", ""), "box_no": it.get("dest_box_no", ""), "box_category": it.get("dest_box_category", ""),
        })
    if tx_docs:
        await db.transactions.insert_many(tx_docs)
    await db.transfer_notes.update_one({"id": stn_id}, {"$set": {"status": "RECORDED", "recorded_at": now}})
    if stn.get("transfer_request_id"):
        await _recompute_str_status(stn["transfer_request_id"])
    total_qty = sum(int(it.get("quantity") or 0) for it in items)
    await _notify(
        actor=user, type="stock_transfer.recorded", module="stock_transfer",
        title=f"Stock Transfer recorded ({stn['stn_no']})",
        message=f"{user.get('email')} transferred {len(items)} item(s), total qty {total_qty}, from {stn.get('transfer_request_no') or 'STR'}.",
        audience="module", ref_collection="transfer_notes", ref_id=stn_id,
    )
    return {"ok": True, "transactions_created": len(tx_docs)}


# -------------------- STOCK BALANCE --------------------
@api_router.get("/stock-balance")
async def stock_balance(search: Optional[str] = None, user=Depends(get_current_user)):
    # 1. Aggregate transactions by (part_no, make, godown_id, rack_id, box_id)
    pipeline = [
        {"$group": {
            "_id": {
                "part_no": "$part_no",
                "make": "$make",
                "godown_id": "$godown_id",
                "rack_id": "$rack_id",
                "box_id": "$box_id",
            },
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
        {"$match": {"total_quantity": {"$gt": 0}}},
    ]
    raw = await db.transactions.aggregate(pipeline).to_list(20000)

    # 2. Build lookup caches with FRESH data
    sm_pairs = list({(r["_id"]["part_no"], r["_id"]["make"]) for r in raw})
    sm_map = {}
    if sm_pairs:
        or_q = [{"part_no": pn, "make": mk} for pn, mk in sm_pairs]
        async for sm in db.stock_master.find({"$or": or_q}, {"_id": 0}):
            sm_map[(sm["part_no"], sm["make"])] = sm

    godown_ids = list({r["_id"]["godown_id"] for r in raw if r["_id"].get("godown_id")})
    rack_ids = list({r["_id"]["rack_id"] for r in raw if r["_id"].get("rack_id")})
    box_ids = list({r["_id"]["box_id"] for r in raw if r["_id"].get("box_id")})

    g_map, r_map, b_map = {}, {}, {}
    if godown_ids:
        async for g in db.godowns.find({"id": {"$in": godown_ids}}, {"_id": 0}):
            g_map[g["id"]] = g
    if rack_ids:
        async for rk in db.racks.find({"id": {"$in": rack_ids}}, {"_id": 0}):
            r_map[rk["id"]] = rk
    if box_ids:
        async for bx in db.boxes.find({"id": {"$in": box_ids}}, {"_id": 0}):
            b_map[bx["id"]] = bx

    # 3. Build flat rows with fresh data joined in
    out = []
    for r in raw:
        k = r["_id"]
        sm = sm_map.get((k["part_no"], k["make"]), {})
        g = g_map.get(k.get("godown_id"), {})
        rk = r_map.get(k.get("rack_id"), {})
        bx = b_map.get(k.get("box_id"), {})
        out.append({
            "part_no": k["part_no"],
            "make": k["make"],
            "model": sm.get("model", ""),
            "old_part_no": sm.get("old_part_no", ""),
            "make_part_no": sm.get("make_part_no", ""),
            "description_1": sm.get("description_1", ""),
            "description_2": sm.get("description_2", ""),
            "remarks_oem": sm.get("remarks_oem", ""),
            "remarks_others": sm.get("remarks_others", ""),
            "item_category": sm.get("item_category", ""),
            "reorder_level": sm.get("reorder_level", 0) or 0,
            "image": sm.get("image", ""),
            "images": sm.get("images", []) or [],
            "godown_id": k.get("godown_id", ""),
            "godown_name": g.get("godown_name", ""),
            "rack_id": k.get("rack_id", ""),
            "rack_no": rk.get("rack_no", ""),
            "box_id": k.get("box_id", ""),
            "box_no": bx.get("box_no", ""),
            "box_category": bx.get("box_category", ""),
            "total_quantity": r["total_quantity"],
        })

    # 4. Server-side search across all listed fields
    if search:
        s = search.lower().strip()
        search_fields = [
            "part_no", "old_part_no", "make_part_no",
            "description_1", "description_2",
            "remarks_oem", "remarks_others",
            "make", "item_category",
        ]
        out = [
            row for row in out
            if any(s in str(row.get(f, "") or "").lower() for f in search_fields)
        ]

    out.sort(key=lambda r: (r.get("part_no", ""), r.get("make", "")))
    return out


@api_router.get("/low-stock")
async def low_stock(user=Depends(get_current_user)):
    """Items where current stock <= reorder_level (per-item from Stock Master)."""
    items = await db.stock_master.find({"reorder_level": {"$gt": 0}}, {"_id": 0}).to_list(50000)
    if not items:
        return []
    pairs = [{"part_no": i["part_no"], "make": i["make"]} for i in items]
    pipeline = [
        {"$match": {"$or": pairs}},
        {"$group": {
            "_id": {"part_no": "$part_no", "make": "$make"},
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
        }},
    ]
    qty_map = {}
    async for r in db.transactions.aggregate(pipeline):
        qty_map[(r["_id"]["part_no"], r["_id"]["make"])] = r["total_quantity"]
    out = []
    for item in items:
        rl = int(item.get("reorder_level") or 0)
        qty = qty_map.get((item["part_no"], item["make"]), 0)
        if qty <= rl:
            out.append({
                "part_no": item["part_no"],
                "make": item["make"],
                "model": item.get("model", ""),
                "description_1": item.get("description_1", ""),
                "item_category": item.get("item_category", ""),
                "reorder_level": rl,
                "total_quantity": qty,
            })
    out.sort(key=lambda x: x["total_quantity"])
    return out


@api_router.get("/dashboard/stats")
async def dashboard_stats(user=Depends(get_current_user)):
    total_items = await db.stock_master.count_documents({})
    total_godowns = await db.godowns.count_documents({})
    total_racks = await db.racks.count_documents({})
    total_boxes = await db.boxes.count_documents({})
    total_txn = await db.transactions.count_documents({})

    # Total stock qty
    pipeline = [
        {"$group": {"_id": None, "qty": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}}}}
    ]
    result = await db.transactions.aggregate(pipeline).to_list(1)
    total_stock = result[0]["qty"] if result else 0

    low = await low_stock(user=user)
    return {
        "total_items": total_items,
        "total_godowns": total_godowns,
        "total_racks": total_racks,
        "total_boxes": total_boxes,
        "total_transactions": total_txn,
        "total_stock_qty": total_stock,
        "low_stock_count": len(low),
    }


# -------------------- STARTUP --------------------
@app.on_event("startup")
async def startup():
    # Initialise object storage (best-effort — log only, do not fail boot)
    try:
        init_storage()
    except Exception as e:
        logger.error(f"Object storage init failed: {e}")
    await db.users.create_index("email", unique=True)
    await db.stock_master.create_index([("part_no", 1), ("make", 1)], unique=True)
    await db.stock_master.create_index("id", unique=True)
    await db.godowns.create_index("id", unique=True)
    await db.racks.create_index("id", unique=True)
    await db.boxes.create_index("id", unique=True)
    await db.transactions.create_index("id", unique=True)
    await db.transactions.create_index([("part_no", 1), ("make", 1)])
    await db.receipt_notes.create_index("id", unique=True)
    await db.receipt_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.receipt_notes.create_index("created_at")
    await db.receipt_notes.create_index("status")
    await db.racking_notes.create_index("id", unique=True)
    await db.racking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.racking_notes.create_index("created_at")
    await db.racking_notes.create_index("status")
    await db.racking_notes.create_index("receipt_note_id")
    await db.issue_notes.create_index("id", unique=True)
    await db.issue_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.issue_notes.create_index("created_at")
    await db.issue_notes.create_index("status")
    await db.picking_notes.create_index("id", unique=True)
    await db.picking_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.picking_notes.create_index("created_at")
    await db.picking_notes.create_index("status")
    await db.picking_notes.create_index("issue_note_id")
    await db.transfer_requests.create_index("id", unique=True)
    await db.transfer_requests.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_requests.create_index("created_at")
    await db.transfer_requests.create_index("status")
    await db.transfer_notes.create_index("id", unique=True)
    await db.transfer_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.transfer_notes.create_index("created_at")
    await db.transfer_notes.create_index("status")
    await db.transfer_notes.create_index("transfer_request_id")
   # ---- Receipt-note status migration (Phase 1) ----
    # Default missing status to FINAL (the new equivalent of legacy RACKING_PENDING).
    await db.receipt_notes.update_many({"status": {"$exists": False}}, {"$set": {"status": "FINAL"}})
    # Legacy values -> new names
    await db.receipt_notes.update_many({"status": "RACKED"}, {"$set": {"status": "FULLY_RACKED"}})
    await db.receipt_notes.update_many({"status": "RACKING_PENDING"}, {"$set": {"status": "FINAL"}})

    # ---- Receipt-note item-shape migration (Phase 1) ----
    # Older items had a single `quantity`. New items split it into invoice_qty + received_qty.
    # Migration policy: invoice_qty = received_qty = legacy quantity (no implied shortfall).
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1, "items": 1}):
        items = rn.get("items") or []
        if not items:
            continue
        changed = False
        new_items = []
        for it in items:
            new_it = dict(it)
            if "invoice_qty" not in new_it or new_it.get("invoice_qty") is None:
                q = float(new_it.get("quantity") or 0)
                new_it["invoice_qty"] = q
                changed = True
            if "received_qty" not in new_it:
                # Legacy rows had no draft concept — treat as fully received.
                new_it["received_qty"] = float(new_it.get("quantity") or 0)
                changed = True
            # Ensure legacy `quantity` mirrors received_qty so racking still works.
            if new_it.get("quantity") in (None, 0) and new_it.get("received_qty") is not None:
                new_it["quantity"] = float(new_it["received_qty"])
                changed = True
            new_items.append(new_it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # Recompute every RN's status off saved racking notes (idempotent — skips DRAFT)
    async for rn in db.receipt_notes.find({}, {"_id": 0, "id": 1}):
        try:
            await _recompute_rn_status(rn["id"])
        except Exception:
            pass

    # ---- SRN / ERN collection indexes (Phase 1 + Phase 2) ----
    await db.short_received_notes.create_index("id", unique=True)
    await db.short_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.short_received_notes.create_index("created_at")
    await db.short_received_notes.create_index("status")
    await db.short_received_notes.create_index("racking_status")
    await db.short_received_notes.create_index("parent_rn_id")
    await db.short_received_notes.create_index("parent_srn_id")
    await db.extra_received_notes.create_index("id", unique=True)
    await db.extra_received_notes.create_index([("fy", 1), ("serial", 1)], unique=True)
    await db.extra_received_notes.create_index("created_at")
    await db.extra_received_notes.create_index("status")
    await db.extra_received_notes.create_index("racking_status")
    await db.extra_received_notes.create_index("parent_rn_id")
    await db.extra_received_notes.create_index("parent_ern_id")

    # ---- Stock Master column settings (admin-editable order/widths) ----
    await db.column_settings.create_index("page", unique=True)

    # ---- Phase 2: counters self-heal ----
    # `_alloc_serial` reads/writes `db.counters` keyed by "{series}:{fy}". On first deploy after
    # the switch from `_next_serial`, scan each FY-numbered collection for max(serial) per fy
    # and seed the counter to that value (so subsequent allocations don't collide with existing
    # serials). Idempotent and safe to run on every startup.
    # Note: db.counters uses _id as the key — MongoDB auto-creates a unique index on _id.
    SERIES_TO_COLL = {
        "rn":  db.receipt_notes,
        "rkn": db.racking_notes,
        "srn": db.short_received_notes,
        "ern": db.extra_received_notes,
        "in":  db.issue_notes,
        "pn":  db.picking_notes,
        "str": db.transfer_requests,
        "stn": db.transfer_notes,
    }
    for series, coll in SERIES_TO_COLL.items():
        async for row in coll.aggregate([
            {"$group": {"_id": "$fy", "max_serial": {"$max": "$serial"}}},
        ]):
            fy = row["_id"]
            if not fy:
                continue
            max_serial = int(row.get("max_serial") or 0)
            counter_id = f"{series}:{fy}"
            existing = await db.counters.find_one({"_id": counter_id})
            if existing is None:
                await db.counters.insert_one({"_id": counter_id, "value": max_serial})
            elif int(existing.get("value", 0)) < max_serial:
                await db.counters.update_one({"_id": counter_id}, {"$set": {"value": max_serial}})

    # ---- Phase 2: RN stock_in_type backfill ----
    # Older receipt notes have no stock_in_type field. Default existing rows to "INVOICE"
    # (the prior behaviour was always invoice-based).
    await db.receipt_notes.update_many({"stock_in_type": {"$exists": False}}, {"$set": {"stock_in_type": "INVOICE"}})

    # ---- Phase 2: RN item.description_1 backfill (denormalize from stock_master) ----
    # New items carry description_1 inline (read-only display). Backfill from stock_master
    # for any item that doesn't already have it.
    async for rn in db.receipt_notes.find(
        {"items.description_1": {"$exists": False}},
        {"_id": 0, "id": 1, "items": 1},
    ):
        items = rn.get("items") or []
        new_items = []
        changed = False
        for it in items:
            if it.get("description_1") is None or "description_1" not in it:
                sm = await db.stock_master.find_one(
                    {"part_no": it.get("part_no"), "make": it.get("make")},
                    {"_id": 0, "description_1": 1},
                )
                it = dict(it)
                it["description_1"] = (sm or {}).get("description_1", "") or ""
                changed = True
            new_items.append(it)
        if changed:
            await db.receipt_notes.update_one({"id": rn["id"]}, {"$set": {"items": new_items}})

    # ---- Phase 2: racking_notes polymorphic source backfill ----
    # Existing racking_notes rows have only receipt_note_id. Set source_type="RN" + source_id=receipt_note_id
    # so the new polymorphic endpoints work uniformly.
    async for rkn in db.racking_notes.find({"source_type": {"$exists": False}}, {"_id": 0, "id": 1, "receipt_note_id": 1, "receipt_note_no": 1, "receipt_note_date": 1}):
        await db.racking_notes.update_one(
            {"id": rkn["id"]},
            {"$set": {
                "source_type": "RN",
                "source_id": rkn.get("receipt_note_id", ""),
                "source_no": rkn.get("receipt_note_no", ""),
                "source_date": rkn.get("receipt_note_date", ""),
            }},
        )
    await db.racking_notes.create_index([("source_type", 1), ("source_id", 1)])

    # ---- Phase 2: SRN/ERN status migration (Phase 1 used DRAFT/FINAL/PARTIALLY_RACKED/FULLY_RACKED) ----
    # Phase 2 splits status semantics into two fields: status (PENDING/PARTIALLY_RECEIVED/FULLY_RECEIVED for SRN,
    # PENDING/PARTIALLY_*/COMPLETE for ERN) and racking_status (RACKING_PENDING/PARTIALLY_RACKED/FULLY_RACKED).
    # Map any legacy values across.
    await db.short_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.short_received_notes.update_many({"racking_status": {"$exists": False}}, {"$set": {"racking_status": "RACKING_PENDING"}})
    await db.extra_received_notes.update_many({"status": "DRAFT"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"status": "FINAL"}, {"$set": {"status": "PENDING"}})
    await db.extra_received_notes.update_many({"racking_status": {"$exists": False}}, {"$set": {"racking_status": "RACKING_PENDING"}})

    # Phase 3 rename: SRN status FULLY_RECEIVED -> COMPLETE
    await db.short_received_notes.update_many({"status": "FULLY_RECEIVED"}, {"$set": {"status": "COMPLETE"}})

    # Recompute SRN/ERN derived statuses on startup so any data loaded with old shapes is consistent.
    async for srn in db.short_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_srn_status(srn)
            if srn.get("status") != new_status:
                await db.short_received_notes.update_one({"id": srn["id"]}, {"$set": {"status": new_status}})
            await _recompute_srn_racking_status(srn["id"])
        except Exception:
            pass
    async for ern in db.extra_received_notes.find({}, {"_id": 0}):
        try:
            new_status = _compute_ern_status(ern)
            if ern.get("status") != new_status:
                await db.extra_received_notes.update_one({"id": ern["id"]}, {"$set": {"status": new_status}})
            await _recompute_ern_racking_status(ern["id"])
        except Exception:
            pass
    # Migrate Stock Master schema: oem→remarks_oem, remarks→remarks_others
    cursor = db.stock_master.find({"$or": [{"oem": {"$exists": True}}, {"remarks": {"$exists": True}}]})
    migrated = 0
    async for doc in cursor:
        upd, unset = {}, {}
        if "oem" in doc:
            if not doc.get("remarks_oem"):
                upd["remarks_oem"] = doc.get("oem", "") or ""
            unset["oem"] = ""
        if "remarks" in doc:
            if not doc.get("remarks_others"):
                upd["remarks_others"] = doc.get("remarks", "") or ""
            unset["remarks"] = ""
        if upd or unset:
            op = {}
            if upd: op["$set"] = upd
            if unset: op["$unset"] = unset
            await db.stock_master.update_one({"_id": doc["_id"]}, op)
            migrated += 1
    if migrated:
        logger.info(f"Migrated {migrated} stock_master docs to new schema")

    # Seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@stockmgmt.com").lower()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": admin_email,
            "name": "Admin",
            "password_hash": hash_password(admin_password),
            "role": "admin",
            "is_active": True,
            "module_access": {m: True for m in APP_MODULES},
            "force_password_reset": False,
            "failed_login_attempts": 0,
            "created_at": now_iso(),
        })
        logger.info(f"Seeded admin user: {admin_email}")
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password)}})
    # Backfill new fields on every user doc
    await db.users.update_many({"is_active": {"$exists": False}}, {"$set": {"is_active": True}})
    await db.users.update_many({"role": "user"}, {"$set": {"role": "staff"}})
    await db.users.update_many({"module_access": {"$exists": False}}, {"$set": {"module_access": {m: True for m in APP_MODULES}}})
    # Backfill any newly-added module key onto existing user docs (default-allow)
    for _m in APP_MODULES:
        await db.users.update_many(
            {f"module_access.{_m}": {"$exists": False}},
            {"$set": {f"module_access.{_m}": True}},
        )
    await db.users.update_many({"force_password_reset": {"$exists": False}}, {"$set": {"force_password_reset": False}})
    await db.users.update_many({"failed_login_attempts": {"$exists": False}}, {"$set": {"failed_login_attempts": 0}})
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email", unique=True)


@app.on_event("shutdown")
async def shutdown():
    client.close()


# ============================================================================
# ITEM DETAILS — single endpoint that returns 360° history for a (part_no, make).
# Read-only aggregation across stock_master + every note collection + ledger +
# balance. Used by the dedicated "Item Details" tab in the UI.
# ============================================================================
@api_router.get("/item-details/search")
async def item_details_search(q: str = Query("", min_length=0, max_length=64),
                              limit: int = Query(20, ge=1, le=50),
                              user=Depends(get_current_user)):
    """Autocomplete: top `limit` (part_no, make) combos that match q (case-insensitive).
    Searches across part_no, old_part_no, new_part_no, make_part_no,
    description_1, description_2, remarks_oem, remarks_others, make, item_category."""
    qs = (q or "").strip()
    flt = {}
    if qs:
        escaped = __import__('re').escape(qs)
        flt = {"$or": [
            {"part_no": {"$regex": escaped, "$options": "i"}},
            {"old_part_no": {"$regex": escaped, "$options": "i"}},
            {"new_part_no": {"$regex": escaped, "$options": "i"}},
            {"make_part_no": {"$regex": escaped, "$options": "i"}},
            {"description_1": {"$regex": escaped, "$options": "i"}},
            {"description_2": {"$regex": escaped, "$options": "i"}},
            {"remarks_oem": {"$regex": escaped, "$options": "i"}},
            {"remarks_others": {"$regex": escaped, "$options": "i"}},
            {"make": {"$regex": escaped, "$options": "i"}},
            {"item_category": {"$regex": escaped, "$options": "i"}},
        ]}
    rows = await db.stock_master.find(
        flt,
        {"_id": 0, "id": 1, "part_no": 1, "make": 1, "description_1": 1,
         "description_2": 1, "model": 1, "item_category": 1}
    ).limit(limit).to_list(limit)
    return rows


@api_router.get("/item-details")
async def item_details(part_no: str, make: str, user=Depends(get_current_user)):
    """Aggregate every transactional record that touches the given (part_no, make).

    Returns a tree:
      {
        master: {...stock_master fields...} | None,
        stock_balance: [...per-location rows...],
        receipt_notes:        [{header + matched item rows}],
        short_received_notes: [{...}],
        extra_received_notes: [{...}],
        racking_notes:        [{...}],
        issue_notes:          [{...}],
        picking_notes:        [{...}],
        transfer_requests:    [{...}],
        transfer_notes:       [{...}],
        transactions:         [...ledger rows for this part/make...],
        totals: {received, racked, issued, transferred_in, transferred_out, current_stock},
      }

    Item rows are filtered server-side so the payload stays compact even when
    the same RN has 50 items but only 1 matches our (part_no, make).
    """
    pn = (part_no or "").strip()
    mk = (make or "").strip()
    if not pn or not mk:
        raise HTTPException(status_code=400, detail="part_no and make are required")

    master = await db.stock_master.find_one(
        {"part_no": pn, "make": mk}, {"_id": 0}
    )

    # Per-location balance for this part/make
    balance = await db.stock_balance.find(
        {"part_no": pn, "make": mk}, {"_id": 0}
    ).to_list(2000)

    # Helper: pull docs from a notes collection where any item row matches the part/make,
    # then trim the items array down to just the matching rows.
    async def _notes(coll, header_fields, item_part_field="part_no", item_make_field="make"):
        rows = await coll.find(
            {"items": {"$elemMatch": {item_part_field: pn, item_make_field: mk}}},
            {"_id": 0}
        ).sort("created_at", -1).to_list(5000)
        out = []
        for r in rows:
            items_match = [it for it in (r.get("items") or [])
                           if (it.get(item_part_field) or "").strip() == pn
                           and (it.get(item_make_field) or "").strip() == mk]
            r["items"] = items_match
            out.append(r)
        return out

    receipt_notes        = await _notes(db.receipt_notes,        None)
    short_received_notes = await _notes(db.short_received_notes, None)
    extra_received_notes = await _notes(db.extra_received_notes, None)
    racking_notes        = await _notes(db.racking_notes,        None)
    issue_notes          = await _notes(db.issue_notes,          None)
    picking_notes        = await _notes(db.picking_notes,        None)
    transfer_requests    = await _notes(db.transfer_requests,    None)
    transfer_notes       = await _notes(db.transfer_notes,       None)

    # Stock ledger entries for this part
    txns = await db.transactions.find(
        {"part_no": pn, "make": mk}, {"_id": 0}
    ).sort("created_at", -1).limit(2000).to_list(2000)

    # Totals (best-effort from ledger; current_stock from balance sum)
    def _sum(rows, key):
        return float(sum((r.get(key) or 0) for r in rows))

    totals = {
        "current_stock":   _sum(balance, "quantity"),
        "received_qty":    sum((float(it.get("received_qty") or 0)
                                for r in receipt_notes for it in r.get("items", []))),
        "racked_qty":      sum((float(it.get("quantity") or 0)
                                for r in racking_notes if r.get("status") == "RECORDED"
                                for it in r.get("items", []))),
        "issued_qty":      sum((float(it.get("issued_qty") or it.get("quantity") or 0)
                                for r in issue_notes for it in r.get("items", []))),
        "picked_qty":      sum((float(it.get("quantity") or 0)
                                for r in picking_notes if r.get("status") == "RECORDED"
                                for it in r.get("items", []))),
        "transferred_qty": sum((float(it.get("quantity") or 0)
                                for r in transfer_notes if r.get("status") == "RECORDED"
                                for it in r.get("items", []))),
        "txn_count":       len(txns),
    }

    return {
        "master":               master,
        "stock_balance":        balance,
        "receipt_notes":        receipt_notes,
        "short_received_notes": short_received_notes,
        "extra_received_notes": extra_received_notes,
        "racking_notes":        racking_notes,
        "issue_notes":          issue_notes,
        "picking_notes":        picking_notes,
        "transfer_requests":    transfer_requests,
        "transfer_notes":       transfer_notes,
        "transactions":         txns,
        "totals":               totals,
    }


app.include_router(api_router)


# Module access middleware (URL-prefix based) — enforces staff per-module ACL.
# Admin always passes. Auth/profile/users routes bypass since their dep already enforces auth/admin.
PATH_TO_MODULE = [
    ("/api/stock-master", "stock_master"),
    ("/api/godowns", "locations"),
    ("/api/racks", "locations"),
    ("/api/boxes", "locations"),
    ("/api/stock-in", "stock_in"),
    ("/api/receipt-notes", "stock_in"),
    ("/api/racking-notes", "stock_in"),
    ("/api/stock-out", "stock_out"),
    ("/api/issue-notes", "stock_out"),
    ("/api/picking-notes", "stock_out"),
    ("/api/transfer-requests", "stock_transfer"),
    ("/api/transfer-notes", "stock_transfer"),
    ("/api/stock-balance", "stock_summary"),
    ("/api/low-stock", "low_stock"),
    ("/api/item-details", "item_details"),
    ("/api/transactions", "transactions"),
    ("/api/short-received-notes", "stock_in"),
    ("/api/extra-received-notes", "stock_in"),
]


@app.middleware("http")
async def module_access_middleware(request, call_next):
    path = request.url.path
    matched = next((m for prefix, m in PATH_TO_MODULE if path.startswith(prefix)), None)
    if matched:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            try:
                payload = jwt.decode(auth.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALGORITHM])
                u = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0, "role": 1, "module_access": 1, "is_active": 1})
                if u and u.get("is_active") is not False and u.get("role") != "admin":
                    access = u.get("module_access") or {}
                    if access.get(matched, True) is False:
                        from starlette.responses import JSONResponse as _JSON
                        return _JSON(status_code=403, content={"detail": f"Access denied: '{matched}' module is disabled for your account"})
            except Exception:
                pass  # let the route's own auth dep return the appropriate error
    return await call_next(request)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)