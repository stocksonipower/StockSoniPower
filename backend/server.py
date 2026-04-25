from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import io
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional

import bcrypt
import jwt
import pandas as pd
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, Query, Response
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field, EmailStr, ConfigDict


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
    return user


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# -------------------- MODELS --------------------
class UserRegister(BaseModel):
    email: EmailStr
    password: str
    name: str


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
    make_part_no: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks_oem: Optional[str] = ""
    remarks_others: Optional[str] = ""
    make: str
    item_category: Optional[str] = ""
    reorder_level: int = 0
    image: Optional[str] = ""  # base64 data URL


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
    quantity: float


class ReceiptNoteCreate(BaseModel):
    invoice_no: Optional[str] = ""
    invoice_date: Optional[str] = ""  # ISO "YYYY-MM-DD"
    items: List[ReceiptNoteItem] = []


class ReceiptNote(BaseModel):
    id: str
    rn_no: str
    rn_date: str  # ISO "YYYY-MM-DD"
    fy: str
    serial: int
    invoice_no: str = ""
    invoice_date: str = ""
    items: List[ReceiptNoteItem] = []
    status: str = "RACKING_PENDING"  # RACKING_PENDING | RACKED
    racked_at: Optional[str] = None
    created_at: str
    created_by: str = ""


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
    receipt_note_id: str
    items: List[RackingNoteItem] = []


class RackingNote(BaseModel):
    id: str
    rkn_no: str
    rkn_date: str
    fy: str
    serial: int
    receipt_note_id: str
    receipt_note_no: str = ""
    receipt_note_date: str = ""
    items: List[RackingNoteItem] = []
    status: str = "DRAFT"  # DRAFT | RECORDED
    recorded_at: Optional[str] = None
    created_at: str
    created_by: str = ""


# -------------------- AUTH ROUTES --------------------
@api_router.post("/auth/register", response_model=AuthResponse)
async def register(payload: UserRegister):
    email = payload.email.lower()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "name": payload.name,
        "password_hash": hash_password(payload.password),
        "role": "user",
        "created_at": now_iso(),
    }
    await db.users.insert_one(doc)
    token = create_access_token(user_id, email)
    return {"token": token, "user": {"id": user_id, "email": email, "name": payload.name, "role": "user"}}


@api_router.post("/auth/login", response_model=AuthResponse)
async def login(payload: UserLogin):
    email = payload.email.lower()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user["id"], email)
    return {
        "token": token,
        "user": {"id": user["id"], "email": email, "name": user.get("name", ""), "role": user.get("role", "user")},
    }


@api_router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


# -------------------- STOCK MASTER --------------------
@api_router.post("/stock-master", response_model=StockMaster)
async def create_stock_master(payload: StockMasterCreate, user=Depends(get_current_user)):
    part_no = payload.part_no.strip()
    make = payload.make.strip()
    if not part_no or not make:
        raise HTTPException(status_code=400, detail="part_no and make are required")
    existing = await db.stock_master.find_one({"part_no": part_no, "make": make})
    if existing:
        raise HTTPException(status_code=400, detail="Item with this part_no + make already exists")
    doc = payload.model_dump()
    doc["id"] = str(uuid.uuid4())
    doc["created_at"] = now_iso()
    await db.stock_master.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/stock-master", response_model=List[StockMaster])
async def list_stock_master(
    response: Response,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    user=Depends(get_current_user),
):
    query = {}
    if search:
        s = search.strip()
        query = {"$or": [
            {"part_no": {"$regex": s, "$options": "i"}},
            {"old_part_no": {"$regex": s, "$options": "i"}},
            {"make_part_no": {"$regex": s, "$options": "i"}},
            {"description_1": {"$regex": s, "$options": "i"}},
            {"description_2": {"$regex": s, "$options": "i"}},
            {"remarks_oem": {"$regex": s, "$options": "i"}},
            {"remarks_others": {"$regex": s, "$options": "i"}},
            {"make": {"$regex": s, "$options": "i"}},
            {"item_category": {"$regex": s, "$options": "i"}},
        ]}
    total = await db.stock_master.count_documents(query)
    skip = (page - 1) * page_size
    items = await db.stock_master.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    # Mark which items have transactions recorded against them (part_no + make pair)
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
    sample_rows = [
        ["1", "Model-X100", "3922900", "OPN-1001", "CUM-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Other remark sample",
         "Cummins", "Engine Parts", "5", ""],
        ["2", "Model-X100", "3922900", "OPN-1001", "TATA-3922900",
         "Fuel Pump Assembly", "With gasket", "OEM remark sample", "Qty per box 1",
         "Tata", "Engine Parts", "10", ""],
    ]
    return _csv_response(sample_rows, TEMPLATE_COLUMNS, "stock_master_template.csv")


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
            it.get("make_part_no", ""),
            it.get("description_1", ""),
            it.get("description_2", ""),
            it.get("remarks_oem", ""),
            it.get("remarks_others", ""),
            it.get("make", ""),
            it.get("item_category", ""),
            it.get("reorder_level", 0) or 0,
            "",  # image (skip base64 data in export)
        ])
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return _csv_response(rows, TEMPLATE_COLUMNS, f"stock_master_export_{ts}.csv")


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
    return {"ok": True}


# Column header → internal field mapping (case + space insensitive)
COLUMN_ALIASES = {
    "sl no": None, "sl.no": None, "slno": None, "s no": None, "sr no": None,
    "model": "model",
    "part no": "part_no", "part_no": "part_no", "partno": "part_no", "part number": "part_no",
    "old no": "old_part_no", "old part no": "old_part_no", "old_part_no": "old_part_no",
    "make part no": "make_part_no", "make_part_no": "make_part_no", "makepartno": "make_part_no",
    "description 1": "description_1", "description_1": "description_1", "description1": "description_1", "desc 1": "description_1",
    "description 2": "description_2", "description_2": "description_2", "description2": "description_2", "desc 2": "description_2",
    "remarks oem": "remarks_oem", "remarks_oem": "remarks_oem", "oem": "remarks_oem", "oem no": "remarks_oem",
    "remarks others": "remarks_others", "remarks_others": "remarks_others", "remarks": "remarks_others", "remark": "remarks_others",
    "make": "make",
    "item category": "item_category", "item_category": "item_category", "category": "item_category",
    "reorder level": "reorder_level", "reorder_level": "reorder_level", "reorder": "reorder_level", "min stock": "reorder_level",
    "image": "image",
}

TEMPLATE_COLUMNS = [
    "SL NO", "MODEL", "PART NO", "OLD PART NO", "MAKE PART NO",
    "DESCRIPTION 1", "DESCRIPTION 2", "REMARKS OEM", "REMARKS OTHERS",
    "MAKE", "ITEM CATEGORY", "REORDER LEVEL", "IMAGE"
]


def _normalize_col(c: str) -> str:
    return " ".join(str(c).strip().lower().split())


@api_router.post("/stock-master/bulk-upload")
async def bulk_upload(file: UploadFile = File(...), user=Depends(get_current_user)):
    content = await file.read()
    try:
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False)
        else:
            df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"File parse error: {e}")

    # Map incoming columns to internal fields
    col_map = {}  # original column name -> internal field
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

    inserted, skipped, errors = 0, 0, []
    for idx, row in df.iterrows():
        data = {"model": "", "part_no": "", "old_part_no": "", "make_part_no": "",
                "description_1": "", "description_2": "",
                "remarks_oem": "", "remarks_others": "",
                "make": "", "item_category": "", "reorder_level": 0, "image": ""}
        for orig_col, field in col_map.items():
            val = row.get(orig_col, "")
            data[field] = str(val).strip() if val is not None else ""
        # Coerce reorder_level to int
        try:
            data["reorder_level"] = int(float(str(data.get("reorder_level") or 0)))
        except Exception:
            data["reorder_level"] = 0
        part_no = data["part_no"]
        make = data["make"]
        if not part_no or not make:
            skipped += 1
            continue
        if await db.stock_master.find_one({"part_no": part_no, "make": make}):
            skipped += 1
            continue
        doc = {"id": str(uuid.uuid4()), **data, "created_at": now_iso()}
        await db.stock_master.insert_one(doc)
        inserted += 1

    return {"inserted": inserted, "skipped": skipped, "total_rows": len(df)}


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
        response.headers["X-Total-Count"] = str(total)
        response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
        return rows
    skip = (page - 1) * page_size
    rows = await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
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
    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be greater than 0")

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)

    # Pick next serial = max(existing serial in this FY) + 1, with retry-on-conflict
    # so that deleted RNs free up their slots and the sequence stays tight.
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        last = await db.receipt_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
        serial = (last[0]["serial"] if last else 0) + 1
        rn_no = f"RN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rn_no": rn_no,
            "rn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "invoice_no": (payload.invoice_no or "").strip(),
            "invoice_date": (payload.invoice_date or "").strip(),
            "items": [it.model_dump() for it in payload.items],
            "status": "RACKING_PENDING",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.receipt_notes.insert_one(doc)
            doc.pop("_id", None)
            return doc
        except DuplicateKeyError as e:
            # Concurrent insert grabbed the same serial — retry with the next one
            last_err = e
            continue
    raise HTTPException(status_code=500, detail=f"Could not allocate receipt-note number: {last_err}")


@api_router.get("/receipt-notes")
async def list_receipt_notes(
    response: Response,
    page: int = Query(1, ge=1),
    page_size: int = Query(5000, ge=1, le=5000),
    status: Optional[str] = None,
    user=Depends(get_current_user),
):
    query = {}
    if status:
        query["status"] = status.upper()
    total = await db.receipt_notes.count_documents(query)
    skip = (page - 1) * page_size
    rows = await db.receipt_notes.find(query, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
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
    return doc


@api_router.put("/receipt-notes/{rn_id}", response_model=ReceiptNote)
async def update_receipt_note(rn_id: str, payload: ReceiptNoteCreate, user=Depends(get_current_user)):
    existing = await db.receipt_notes.find_one({"id": rn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    if existing.get("status") == "RACKED":
        raise HTTPException(status_code=409, detail="Cannot edit — this receipt note has already been racked. Delete the linked racking note first.")
    if not payload.items or len(payload.items) == 0:
        raise HTTPException(status_code=400, detail="At least one item is required")
    for idx, it in enumerate(payload.items, start=1):
        if not it.part_no.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Part No is required")
        if not it.make.strip():
            raise HTTPException(status_code=400, detail=f"Row {idx}: Make is required")
        if it.quantity is None or it.quantity <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: Quantity must be greater than 0")
    update = {
        "invoice_no": (payload.invoice_no or "").strip(),
        "invoice_date": (payload.invoice_date or "").strip(),
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.receipt_notes.update_one({"id": rn_id}, {"$set": update})
    doc = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    return doc


@api_router.delete("/receipt-notes/{rn_id}")
async def delete_receipt_note(rn_id: str, user=Depends(get_current_user)):
    existing = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    if existing.get("status") == "RACKED":
        raise HTTPException(status_code=409, detail="Cannot delete — this receipt note has already been racked. Delete the linked racking note first.")
    # Block delete if any racking note (DRAFT or RECORDED) references it
    if await db.racking_notes.find_one({"receipt_note_id": rn_id}):
        raise HTTPException(status_code=409, detail="Cannot delete — a racking note has been created against this receipt note. Delete the racking note first.")
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


@api_router.get("/racking-notes/prepare/{rn_id}")
async def prepare_racking_note(rn_id: str, user=Depends(get_current_user)):
    """Given a receipt-note id, return prefilled items (master fields + existing locations from balance)."""
    rn = await db.receipt_notes.find_one({"id": rn_id}, {"_id": 0})
    if not rn:
        raise HTTPException(status_code=404, detail="Receipt note not found")
    if rn.get("status") == "RACKED":
        raise HTTPException(status_code=409, detail="This receipt note is already racked")

    items_out = []
    for it in rn.get("items", []):
        part_no = it.get("part_no", "")
        make = it.get("make", "")
        master = await db.stock_master.find_one({"part_no": part_no, "make": make}, {"_id": 0}) or {}
        # Existing locations with positive qty
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
        existing_locations = [{**r["_id"], "current_qty": r["quantity"]} for r in raw_locs]

        # Pre-fill location: if exactly 1 existing, use it; else leave blank
        prefill = existing_locations[0] if len(existing_locations) == 1 else None

        items_out.append({
            "part_no": part_no,
            "make": make,
            "quantity": it.get("quantity", 0),
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
            "existing_locations": existing_locations,  # informational; UI shows as chips
        })

    return {
        "receipt_note": {
            "id": rn["id"], "rn_no": rn["rn_no"], "rn_date": rn["rn_date"],
            "invoice_no": rn.get("invoice_no", ""), "invoice_date": rn.get("invoice_date", ""),
        },
        "items": items_out,
    }


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


@api_router.post("/racking-notes", response_model=RackingNote)
async def create_racking_note(payload: RackingNoteCreate, user=Depends(get_current_user)):
    rn = await db.receipt_notes.find_one({"id": payload.receipt_note_id}, {"_id": 0})
    if not rn:
        raise HTTPException(status_code=400, detail="Receipt note not found")
    if rn.get("status") == "RACKED":
        raise HTTPException(status_code=409, detail="This receipt note is already racked")
    # Block creating a second draft against the same receipt note
    if await db.racking_notes.find_one({"receipt_note_id": payload.receipt_note_id}):
        raise HTTPException(status_code=409, detail="A racking note already exists for this receipt note")
    _validate_racking_items(payload.items)
    # Per-row: box_id required only if the chosen rack has boxes
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")

    today = datetime.now(timezone.utc)
    fy = current_fy_label(today)
    from pymongo.errors import DuplicateKeyError
    last_err = None
    for _ in range(5):
        last = await db.racking_notes.find({"fy": fy}, {"serial": 1, "_id": 0}).sort("serial", -1).limit(1).to_list(1)
        serial = (last[0]["serial"] if last else 0) + 1
        rkn_no = f"RKN/{fy}/{serial:03d}"
        doc = {
            "id": str(uuid.uuid4()),
            "rkn_no": rkn_no,
            "rkn_date": today.date().isoformat(),
            "fy": fy,
            "serial": serial,
            "receipt_note_id": rn["id"],
            "receipt_note_no": rn["rn_no"],
            "receipt_note_date": rn["rn_date"],
            "items": [it.model_dump() for it in payload.items],
            "status": "DRAFT",
            "created_at": now_iso(),
            "created_by": user.get("email", ""),
        }
        try:
            await db.racking_notes.insert_one(doc)
            doc.pop("_id", None)
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
    user=Depends(get_current_user),
):
    total = await db.racking_notes.count_documents({})
    skip = (page - 1) * page_size
    rows = await db.racking_notes.find({}, {"_id": 0}).sort("created_at", -1).skip(skip).limit(page_size).to_list(page_size)
    response.headers["X-Total-Count"] = str(total)
    response.headers["X-Page"] = str(page)
    response.headers["X-Page-Size"] = str(page_size)
    response.headers["Access-Control-Expose-Headers"] = "X-Total-Count, X-Page, X-Page-Size"
    return rows


@api_router.get("/racking-notes/{rkn_id}")
async def get_racking_note(rkn_id: str, user=Depends(get_current_user)):
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Racking note not found")
    return doc


@api_router.put("/racking-notes/{rkn_id}", response_model=RackingNote)
async def update_racking_note(rkn_id: str, payload: RackingNoteCreate, user=Depends(get_current_user)):
    existing = await db.racking_notes.find_one({"id": rkn_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot edit — this racking note has already been recorded as Stock In")
    _validate_racking_items(payload.items)
    for idx, it in enumerate(payload.items, start=1):
        if not (it.box_id or "").strip() and await _box_id_required_for_rack(it.rack_id):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box is required for this rack")
    update = {
        "items": [it.model_dump() for it in payload.items],
        "updated_at": now_iso(),
    }
    await db.racking_notes.update_one({"id": rkn_id}, {"$set": update})
    doc = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    return doc


@api_router.delete("/racking-notes/{rkn_id}")
async def delete_racking_note(rkn_id: str, user=Depends(get_current_user)):
    existing = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if existing.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Cannot delete — already recorded as Stock In")
    await db.racking_notes.delete_one({"id": rkn_id})
    return {"ok": True}


@api_router.post("/racking-notes/{rkn_id}/record")
async def record_racking_note(rkn_id: str, user=Depends(get_current_user)):
    rkn = await db.racking_notes.find_one({"id": rkn_id}, {"_id": 0})
    if not rkn:
        raise HTTPException(status_code=404, detail="Racking note not found")
    if rkn.get("status") == "RECORDED":
        raise HTTPException(status_code=409, detail="Already recorded")
    items = rkn.get("items", [])
    if not items:
        raise HTTPException(status_code=400, detail="No items to record")
    # Validate every item has a complete location & qty (defence in depth)
    for idx, it in enumerate(items, start=1):
        if not it.get("godown_id") or not it.get("rack_id"):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Godown/Rack missing — edit racking note before recording")
        if not it.get("box_id") and await _box_id_required_for_rack(it["rack_id"]):
            raise HTTPException(status_code=400, detail=f"Row {idx}: Box missing — edit racking note before recording")
        if (it.get("quantity") or 0) <= 0:
            raise HTTPException(status_code=400, detail=f"Row {idx}: quantity must be > 0")

    # Build & insert one IN transaction per item
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
    if rkn.get("receipt_note_id"):
        await db.receipt_notes.update_one(
            {"id": rkn["receipt_note_id"]},
            {"$set": {"status": "RACKED", "racked_at": now}},
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
    # Backfill: ensure every existing receipt note has a status
    await db.receipt_notes.update_many({"status": {"$exists": False}}, {"$set": {"status": "RACKING_PENDING"}})

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
            "created_at": now_iso(),
        })
        logger.info(f"Seeded admin user: {admin_email}")
    elif not verify_password(admin_password, existing["password_hash"]):
        await db.users.update_one({"email": admin_email}, {"$set": {"password_hash": hash_password(admin_password)}})


@app.on_event("shutdown")
async def shutdown():
    client.close()


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)
