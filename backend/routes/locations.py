"""Godown / Rack / Box routes — extracted from server.py with zero logic changes."""
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from deps import db, get_current_user, now_iso
from models import GodownCreate, Godown, RackCreate, Rack, BoxCreate, Box
from routes._helpers import _csv_response, _read_file_to_df, _find_col

router = APIRouter()


# ---------- GODOWNS: template + bulk upload ----------
@router.get("/godowns/download/template")
async def godowns_template():
    return _csv_response(
        [["Main Warehouse"], ["Spare Parts Store"]],
        ["GODOWN NAME"],
        "godowns_template.csv",
    )


@router.post("/godowns/bulk-upload")
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
@router.get("/racks/download/template")
async def racks_template():
    return _csv_response(
        [["Main Warehouse", "1", "12"], ["Main Warehouse", "2", "12"], ["Spare Parts Store", "A1", "8"]],
        ["GODOWN NAME", "RACK NO", "TOTAL BOXES"],
        "racks_template.csv",
    )


@router.post("/racks/bulk-upload")
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
@router.get("/boxes/download/template")
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


@router.post("/boxes/bulk-upload")
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


@router.post("/godowns/bulk-delete")
async def godowns_bulk_delete(payload: BulkDeleteRequest, user=Depends(get_current_user)):
    if not payload.ids:
        return {"deleted": 0, "blocked": 0}
    used = set(await db.transactions.distinct("godown_id", {"godown_id": {"$in": payload.ids}}))
    deletable = [i for i in payload.ids if i not in used]
    res = await db.godowns.delete_many({"id": {"$in": deletable}})
    return {"deleted": res.deleted_count, "blocked": len(payload.ids) - len(deletable)}


@router.post("/racks/bulk-delete")
async def racks_bulk_delete(payload: BulkDeleteRequest, user=Depends(get_current_user)):
    if not payload.ids:
        return {"deleted": 0, "blocked": 0}
    used = set(await db.transactions.distinct("rack_id", {"rack_id": {"$in": payload.ids}}))
    deletable = [i for i in payload.ids if i not in used]
    res = await db.racks.delete_many({"id": {"$in": deletable}})
    return {"deleted": res.deleted_count, "blocked": len(payload.ids) - len(deletable)}


@router.post("/boxes/bulk-delete")
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


@router.post("/racks/range")
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


@router.post("/boxes/range")
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


@router.post("/godowns", response_model=Godown)
async def create_godown(payload: GodownCreate, user=Depends(get_current_user)):
    doc = {"id": str(uuid.uuid4()), "godown_name": payload.godown_name, "created_at": now_iso()}
    await db.godowns.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/godowns")
async def list_godowns(user=Depends(get_current_user)):
    godowns = await db.godowns.find({}, {"_id": 0}).sort("created_at", 1).to_list(500)
    used = set(await db.transactions.distinct("godown_id"))
    for g in godowns:
        g["in_use"] = g["id"] in used
    return godowns


@router.put("/godowns/{godown_id}", response_model=Godown)
async def update_godown(godown_id: str, payload: GodownCreate, user=Depends(get_current_user)):
    res = await db.godowns.update_one({"id": godown_id}, {"$set": {"godown_name": payload.godown_name}})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Godown not found")
    godown = await db.godowns.find_one({"id": godown_id}, {"_id": 0})
    return godown


@router.delete("/godowns/{godown_id}")
async def delete_godown(godown_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"godown_id": godown_id}):
        raise HTTPException(status_code=400, detail="Godown is in use by stock entries")
    await db.godowns.delete_one({"id": godown_id})
    return {"ok": True}


@router.post("/racks", response_model=Rack)
async def create_rack(payload: RackCreate, user=Depends(get_current_user)):
    godown = await db.godowns.find_one({"id": payload.godown_id})
    if not godown:
        raise HTTPException(status_code=400, detail="Godown not found")
    doc = {"id": str(uuid.uuid4()), **payload.model_dump(), "created_at": now_iso()}
    await db.racks.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/racks")
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


@router.put("/racks/{rack_id}", response_model=Rack)
async def update_rack(rack_id: str, payload: RackUpdate, user=Depends(get_current_user)):
    res = await db.racks.update_one(
        {"id": rack_id},
        {"$set": {"rack_no": payload.rack_no, "total_boxes": payload.total_boxes}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Rack not found")
    rack = await db.racks.find_one({"id": rack_id}, {"_id": 0})
    return rack


@router.delete("/racks/{rack_id}")
async def delete_rack(rack_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"rack_id": rack_id}):
        raise HTTPException(status_code=400, detail="Rack is in use by stock entries")
    await db.racks.delete_one({"id": rack_id})
    return {"ok": True}


@router.post("/boxes", response_model=Box)
async def create_box(payload: BoxCreate, user=Depends(get_current_user)):
    rack = await db.racks.find_one({"id": payload.rack_id})
    if not rack:
        raise HTTPException(status_code=400, detail="Rack not found")
    doc = {"id": str(uuid.uuid4()), **payload.model_dump(), "created_at": now_iso()}
    await db.boxes.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.get("/boxes")
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


@router.put("/boxes/{box_id}", response_model=Box)
async def update_box(box_id: str, payload: BoxUpdate, user=Depends(get_current_user)):
    res = await db.boxes.update_one(
        {"id": box_id},
        {"$set": {"box_no": payload.box_no, "box_category": payload.box_category or ""}},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Box not found")
    box = await db.boxes.find_one({"id": box_id}, {"_id": 0})
    return box


@router.delete("/boxes/{box_id}")
async def delete_box(box_id: str, user=Depends(get_current_user)):
    if await db.transactions.find_one({"box_id": box_id}):
        raise HTTPException(status_code=400, detail="Box is in use by stock entries")
    await db.boxes.delete_one({"id": box_id})
    return {"ok": True}
