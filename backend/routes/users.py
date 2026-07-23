"""User management routes (admin only) + assignable users list — extracted from server.py."""
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from deps import (
    db,
    APP_MODULES,
    hash_password, now_iso,
    get_current_user, require_admin, _notify,
)
from models import UserCreate, UserUpdate

router = APIRouter()


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


@router.get("/users")
async def list_users(admin=Depends(require_admin)):
    rows = await db.users.find({}, {"_id": 0, "password_hash": 0}).sort("created_at", -1).to_list(5000)
    return [_user_to_public(u) for u in rows]


@router.post("/users")
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


@router.put("/users/{user_id}")
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


@router.delete("/users/{user_id}")
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


@router.get("/meta/modules")
async def list_modules(user=Depends(get_current_user)):
    return {"modules": list(APP_MODULES)}


@router.get("/users/assignable")
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
