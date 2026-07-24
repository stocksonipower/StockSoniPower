"""Image Upload / Serve routes — extracted from server.py with zero logic changes."""
import uuid
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, Response, UploadFile

from deps import (
    db, logger,
    JWT_SECRET, JWT_ALGORITHM,
    get_current_user, now_iso,
)
from storage import put_object, get_object, build_path

router = APIRouter()


# -------------------- IMAGE UPLOAD / SERVE (Object Storage) --------------------
_ALLOWED_IMAGE_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
}
_MAX_IMAGE_BYTES = 10 * 1024 * 1024  # 10 MB


@router.post("/uploads/image")
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
