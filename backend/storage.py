"""
Emergent Object Storage helper.

Initializes a session-scoped storage_key once at app startup and exposes
synchronous put_object / get_object helpers used by upload + download routes.
"""
import os
import logging
import requests

logger = logging.getLogger(__name__)

STORAGE_URL = "https://integrations.emergentagent.com/objstore/api/v1/storage"
APP_NAME = "stock-management"

_storage_key = None


def _emergent_key() -> str | None:
    """Read EMERGENT_LLM_KEY at call time so we don't get bitten by import-order
    issues with load_dotenv (server.py imports `storage` before `deps` calls load_dotenv)."""
    return os.environ.get("EMERGENT_LLM_KEY")


def init_storage() -> str:
    """Initialise (or return cached) storage key. Safe to call multiple times."""
    global _storage_key
    if _storage_key:
        return _storage_key
    key = _emergent_key()
    if not key:
        raise RuntimeError("EMERGENT_LLM_KEY is not set in environment")
    resp = requests.post(
        f"{STORAGE_URL}/init",
        json={"emergent_key": key},
        timeout=30,
    )
    resp.raise_for_status()
    _storage_key = resp.json()["storage_key"]
    logger.info("Emergent object storage initialised")
    return _storage_key


def put_object(path: str, data: bytes, content_type: str) -> dict:
    """Upload bytes to storage. Returns {path, size, etag}."""
    key = init_storage()
    resp = requests.put(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key, "Content-Type": content_type},
        data=data,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()


def get_object(path: str):
    """Download bytes from storage. Returns (bytes, content_type)."""
    key = init_storage()
    resp = requests.get(
        f"{STORAGE_URL}/objects/{path}",
        headers={"X-Storage-Key": key},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.content, resp.headers.get("Content-Type", "application/octet-stream")


def build_path(user_id: str, ext: str) -> str:
    """Convention: stock-management/uploads/{user_id}/{uuid}.{ext}"""
    import uuid as _uuid
    safe_ext = (ext or "bin").lower().lstrip(".")
    return f"{APP_NAME}/uploads/{user_id}/{_uuid.uuid4()}.{safe_ext}"
