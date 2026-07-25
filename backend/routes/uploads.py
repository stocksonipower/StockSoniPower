"""Image Upload / Serve routes — backed by Cloudflare R2 object storage."""
import uuid
from typing import List, Optional

import jwt
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from PIL import Image, UnidentifiedImageError
import io

from deps import (
    db, logger,
    JWT_SECRET, JWT_ALGORITHM,
    get_current_user, now_iso,
)
from storage import put_object, get_object, delete_object, build_path

router = APIRouter()


# -------------------- IMAGE UPLOAD / SERVE (Cloudflare R2) --------------------
_ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB
_MAX_FILES_PER_REQUEST = 10


def _validate_image_bytes(data: bytes, declared_ct: str) -> None:
    """Verify the payload is actually a decodable image, not just a spoofed
    Content-Type header wrapping arbitrary bytes."""
    try:
        with Image.open(io.BytesIO(data)) as img:
            img.verify()
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=400, detail="File is not a valid image")


async def _store_one_image(file: UploadFile, user: dict) -> dict:
    ct = (file.content_type or "").lower()
    if ct not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {ct or 'unknown'} ({file.filename})")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"Empty file: {file.filename}")
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail=f"Image too large (max 10MB): {file.filename}")
    _validate_image_bytes(data, ct)
    ext = _ALLOWED_IMAGE_TYPES[ct]
    path = build_path(user["id"], ext)
    try:
        # boto3 is synchronous — run off the event loop so one slow R2 call
        # doesn't stall every other concurrent request.
        result = await run_in_threadpool(put_object, path, data, ct)
    except Exception as e:
        logger.error(f"R2 upload failed for {file.filename}: {e}")
        raise HTTPException(status_code=502, detail=f"Image upload failed: {file.filename}")
    await db.uploads.insert_one({
        "id": str(uuid.uuid4()),
        "storage_path": result["path"],
        "content_type": ct,
        "size": result.get("size", len(data)),
        "original_filename": file.filename,
        "uploaded_by": user["id"],
        "uploaded_by_email": user.get("email"),
        "is_deleted": False,
        "created_at": now_iso(),
    })
    return {"path": result["path"], "content_type": ct, "size": result.get("size", len(data))}


@router.post("/uploads/image")
async def upload_image(file: UploadFile = File(...), user=Depends(get_current_user)):
    """Upload a single image to R2. Returns {path, content_type, size}."""
    return await _store_one_image(file, user)


@router.post("/uploads/images")
async def upload_images(files: List[UploadFile] = File(...), user=Depends(get_current_user)):
    """Upload multiple images to R2 in one request. Each file is validated and
    stored independently; a failure on one file does not abort the others.
    Returns {"results": [...], "errors": [...]}."""
    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    if len(files) > _MAX_FILES_PER_REQUEST:
        raise HTTPException(status_code=400, detail=f"A maximum of {_MAX_FILES_PER_REQUEST} files per request is allowed")
    results, errors = [], []
    for f in files:
        try:
            results.append(await _store_one_image(f, user))
        except HTTPException as e:
            errors.append({"filename": f.filename, "detail": e.detail})
    return {"results": results, "errors": errors}


@router.delete("/uploads/image")
async def delete_image(path: str = Query(...), user=Depends(get_current_user)):
    """Soft-delete an upload record and remove the object from R2. Idempotent —
    deleting an already-deleted or unknown path returns ok so replace/remove
    flows never fail on a stale reference."""
    record = await db.uploads.find_one({"storage_path": path})
    if record and record.get("uploaded_by") != user["id"] and user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Not authorized to delete this file")
    try:
        await run_in_threadpool(delete_object, path)
    except Exception as e:
        logger.error(f"R2 delete failed for {path}: {e}")
        raise HTTPException(status_code=502, detail="Image delete failed")
    if record:
        await db.uploads.update_one({"storage_path": path}, {"$set": {"is_deleted": True, "deleted_at": now_iso()}})
    return {"ok": True}


@router.get("/files/{file_path:path}")
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
    u = await db.users.find_one({"id": decoded.get("sub")}, {"_id": 0, "password_hash": 0})
    if not u or u.get("is_active") is False:
        raise HTTPException(status_code=401, detail="User not found / disabled")

    # DB lookup — only serve files we know about
    record = await db.uploads.find_one({"storage_path": file_path, "is_deleted": False})
    if not record:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        data, content_type = await run_in_threadpool(get_object, file_path)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="File not found")
    except Exception as e:
        logger.error(f"R2 download failed for {file_path}: {e}")
        raise HTTPException(status_code=502, detail="Image download failed")
    return Response(content=data, media_type=record.get("content_type", content_type))
