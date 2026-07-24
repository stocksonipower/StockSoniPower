"""Shared dependencies / infrastructure for the Stock Management API.

Extracted from server.py during the routes refactor — zero logic changes.
Anything imported here was previously module-level in server.py.
"""
from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import uuid
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from motor.motor_asyncio import AsyncIOMotorClient


# -------------------- DB --------------------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
bearer_scheme = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# -------------------- HELPERS --------------------
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
