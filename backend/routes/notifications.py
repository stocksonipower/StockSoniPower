"""Notifications API routes — extracted from server.py with zero logic changes."""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel

from deps import db, APP_MODULES, get_current_user

router = APIRouter()


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


@router.get("/notifications")
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


@router.get("/notifications/unread-count")
async def unread_count(user=Depends(get_current_user)):
    q = {**_notif_visibility_filter(user), "read_by": {"$nin": [user["id"]]}}
    n = await db.notifications.count_documents(q)
    return {"unread_count": n}


class MarkReadRequest(BaseModel):
    ids: Optional[List[str]] = None  # if None or empty → mark ALL visible as read


@router.post("/notifications/mark-read")
async def mark_read(payload: MarkReadRequest, user=Depends(get_current_user)):
    base = _notif_visibility_filter(user)
    if payload.ids:
        q = {**base, "id": {"$in": payload.ids}}
    else:
        q = base
    res = await db.notifications.update_many(q, {"$addToSet": {"read_by": user["id"]}})
    return {"updated": res.modified_count}
