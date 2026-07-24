"""Auth routes — extracted from server.py with zero logic changes."""
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException

from deps import (
    db,
    verify_password, hash_password, create_access_token,
    get_current_user, _notify, now_iso,
)
from models import UserLogin, AuthResponse, ProfileUpdate

router = APIRouter()


@router.post("/auth/login", response_model=AuthResponse)
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


@router.get("/auth/me")
async def me(user=Depends(get_current_user)):
    return user


@router.put("/auth/me")
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
