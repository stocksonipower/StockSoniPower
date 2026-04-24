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
from fastapi import FastAPI, APIRouter, HTTPException, Depends, Request, UploadFile, File, Query
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
    oem: Optional[str] = ""
    description_1: Optional[str] = ""
    description_2: Optional[str] = ""
    remarks: Optional[str] = ""
    make: str
    item_category: Optional[str] = ""
    image: Optional[str] = ""  # base64 data URL


class StockMasterCreate(StockMasterBase):
    pass


class StockMaster(StockMasterBase):
    id: str
    created_at: str


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
async def list_stock_master(search: Optional[str] = None, user=Depends(get_current_user)):
    query = {}
    if search:
        s = search.strip()
        query = {"$or": [
            {"part_no": {"$regex": s, "$options": "i"}},
            {"make": {"$regex": s, "$options": "i"}},
            {"description_1": {"$regex": s, "$options": "i"}},
            {"description_2": {"$regex": s, "$options": "i"}},
            {"model": {"$regex": s, "$options": "i"}},
        ]}
    items = await db.stock_master.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
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
        ["1", "Model-X100", "3922900", "OPN-1001", "CUM-3922900", "OEM-88421",
         "Fuel Pump Assembly", "With gasket", "Qty per box 2", "Cummins", "Engine Parts", ""],
        ["2", "Model-X100", "3922900", "OPN-1001", "TATA-3922900", "OEM-88421",
         "Fuel Pump Assembly", "With gasket", "Qty per box 1", "Tata", "Engine Parts", ""],
    ]
    buf = io.StringIO()
    import csv
    writer = csv.writer(buf)
    writer.writerow(TEMPLATE_COLUMNS)
    for r in sample_rows:
        writer.writerow(r)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="stock_master_template.csv"'},
    )


@api_router.get("/stock-master/download/export")
async def export_stock_master(user=Depends(get_current_user)):
    """Export all Stock Master items to CSV in the standard column order."""
    items = await db.stock_master.find({}, {"_id": 0}).sort("created_at", 1).to_list(100000)
    buf = io.StringIO()
    import csv
    writer = csv.writer(buf)
    writer.writerow(TEMPLATE_COLUMNS)
    for idx, it in enumerate(items, start=1):
        writer.writerow([
            idx,
            it.get("model", ""),
            it.get("part_no", ""),
            it.get("old_part_no", ""),
            it.get("make_part_no", ""),
            it.get("oem", ""),
            it.get("description_1", ""),
            it.get("description_2", ""),
            it.get("remarks", ""),
            it.get("make", ""),
            it.get("item_category", ""),
            "",  # image (skip base64 data in export)
        ])
    buf.seek(0)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="stock_master_export_{ts}.csv"'},
    )


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
    res = await db.stock_master.delete_one({"id": item_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Not found")
    return {"ok": True}


# Column header → internal field mapping (case + space insensitive)
COLUMN_ALIASES = {
    "sl no": None, "sl.no": None, "slno": None, "s no": None, "sr no": None,
    "model": "model",
    "part no": "part_no", "part_no": "part_no", "partno": "part_no", "part number": "part_no",
    "old no": "old_part_no", "old part no": "old_part_no", "old_part_no": "old_part_no",
    "make part no": "make_part_no", "make_part_no": "make_part_no", "makepartno": "make_part_no",
    "oem": "oem", "oem no": "oem", "oem_no": "oem", "oem number": "oem",
    "description 1": "description_1", "description_1": "description_1", "description1": "description_1", "desc 1": "description_1",
    "description 2": "description_2", "description_2": "description_2", "description2": "description_2", "desc 2": "description_2",
    "remarks": "remarks", "remark": "remarks",
    "make": "make",
    "category": "item_category", "item category": "item_category", "item_category": "item_category",
    "image": "image",
}

TEMPLATE_COLUMNS = [
    "SL NO", "MODEL", "PART NO", "OLD NO", "MAKE PART NO", "OEM",
    "DESCRIPTION 1", "DESCRIPTION 2", "REMARKS", "MAKE", "CATEGORY", "IMAGE"
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
        data = {"model": "", "part_no": "", "old_part_no": "", "make_part_no": "", "oem": "",
                "description_1": "", "description_2": "", "remarks": "",
                "make": "", "item_category": "", "image": ""}
        for orig_col, field in col_map.items():
            val = row.get(orig_col, "")
            data[field] = str(val).strip() if val is not None else ""
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


@api_router.post("/godowns", response_model=Godown)
async def create_godown(payload: GodownCreate, user=Depends(get_current_user)):
    doc = {"id": str(uuid.uuid4()), "godown_name": payload.godown_name, "created_at": now_iso()}
    await db.godowns.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.get("/godowns", response_model=List[Godown])
async def list_godowns(user=Depends(get_current_user)):
    return await db.godowns.find({}, {"_id": 0}).sort("created_at", 1).to_list(500)


@api_router.put("/godowns/{godown_id}", response_model=Godown)
async def update_godown(godown_id: str, payload: GodownCreate, user=Depends(get_current_user)):
    res = await db.godowns.update_one({"id": godown_id}, {"$set": {"godown_name": payload.godown_name}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Godown not found")
    godown = await db.godowns.find_one({"id": godown_id}, {"_id": 0})
    return godown


@api_router.delete("/godowns/{godown_id}")
async def delete_godown(godown_id: str, user=Depends(get_current_user)):
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


@api_router.get("/racks", response_model=List[Rack])
async def list_racks(godown_id: Optional[str] = None, user=Depends(get_current_user)):
    query = {"godown_id": godown_id} if godown_id else {}
    return await db.racks.find(query, {"_id": 0}).sort("created_at", 1).to_list(1000)


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


@api_router.get("/boxes", response_model=List[Box])
async def list_boxes(rack_id: Optional[str] = None, user=Depends(get_current_user)):
    query = {"rack_id": rack_id} if rack_id else {}
    return await db.boxes.find(query, {"_id": 0}).sort("created_at", 1).to_list(1000)


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
        "oem": item.get("oem", ""),
        "description_1": item.get("description_1", ""),
        "description_2": item.get("description_2", ""),
        "remarks": item.get("remarks", ""),
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
        "oem": item.get("oem", ""),
        "description_1": item.get("description_1", ""),
        "description_2": item.get("description_2", ""),
        "remarks": item.get("remarks", ""),
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
async def list_transactions(limit: int = 100, type: Optional[str] = None, user=Depends(get_current_user)):
    query = {}
    if type:
        query["type"] = type.upper()
    return await db.transactions.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)


# -------------------- STOCK BALANCE --------------------
@api_router.get("/stock-balance")
async def stock_balance(search: Optional[str] = None, user=Depends(get_current_user)):
    pipeline = [
        {"$group": {
            "_id": {
                "part_no": "$part_no",
                "make": "$make",
                "godown_id": "$godown_id",
                "godown_name": "$godown_name",
                "rack_id": "$rack_id",
                "rack_no": "$rack_no",
                "box_id": "$box_id",
                "box_no": "$box_no",
            },
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
            "description_1": {"$last": "$description_1"},
            "item_category": {"$last": "$item_category"},
        }},
        {"$project": {
            "_id": 0,
            "part_no": "$_id.part_no",
            "make": "$_id.make",
            "godown_id": "$_id.godown_id",
            "godown_name": "$_id.godown_name",
            "rack_id": "$_id.rack_id",
            "rack_no": "$_id.rack_no",
            "box_id": "$_id.box_id",
            "box_no": "$_id.box_no",
            "total_quantity": 1,
            "description_1": 1,
            "item_category": 1,
        }},
        {"$sort": {"part_no": 1}}
    ]
    results = await db.transactions.aggregate(pipeline).to_list(5000)
    if search:
        s = search.lower()
        results = [r for r in results if s in (r.get("part_no", "") + r.get("make", "") + r.get("description_1", "")).lower()]
    return results


@api_router.get("/low-stock")
async def low_stock(threshold: int = 5, user=Depends(get_current_user)):
    pipeline = [
        {"$group": {
            "_id": {"part_no": "$part_no", "make": "$make"},
            "total_quantity": {"$sum": {"$cond": [{"$eq": ["$type", "IN"]}, "$quantity", {"$multiply": ["$quantity", -1]}]}},
            "description_1": {"$last": "$description_1"},
        }},
        {"$match": {"total_quantity": {"$lte": threshold, "$gte": 0}}},
        {"$project": {
            "_id": 0,
            "part_no": "$_id.part_no",
            "make": "$_id.make",
            "total_quantity": 1,
            "description_1": 1,
        }},
        {"$sort": {"total_quantity": 1}}
    ]
    return await db.transactions.aggregate(pipeline).to_list(500)


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

    low = await low_stock(threshold=5, user=user)
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
