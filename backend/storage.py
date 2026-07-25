"""Cloudflare R2 (S3-compatible) storage helper.

Talks to R2 directly via boto3's S3 client — no third-party proxy. Credentials
and bucket/endpoint come from R2_* env vars (backend-only; never exposed to
the frontend). Exposes put_object / get_object / delete_object used by the
upload + serve routes, plus build_path for collision-free object naming.
"""
import logging
import os
import uuid as _uuid
from functools import lru_cache
from urllib.parse import urlparse

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

APP_NAME = "stock-management"


def _endpoint_url() -> str:
    """R2_ENDPOINT may include a trailing bucket path (as pasted from the R2
    dashboard) — boto3 wants just the scheme+host, bucket is passed per-call."""
    raw = os.environ.get("R2_ENDPOINT", "")
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError("R2_ENDPOINT is not set / invalid in environment")
    return f"{parsed.scheme}://{parsed.netloc}"


def _bucket() -> str:
    bucket = os.environ.get("R2_BUCKET")
    if not bucket:
        raise RuntimeError("R2_BUCKET is not set in environment")
    return bucket


@lru_cache(maxsize=1)
def _client():
    """Lazily build a boto3 S3 client bound to the R2 endpoint (cached — boto3
    clients are thread-safe and cheap to reuse across requests)."""
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    if not (access_key and secret_key):
        raise RuntimeError("R2 credentials are not fully set in environment")
    return boto3.client(
        "s3",
        endpoint_url=_endpoint_url(),
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(
            signature_version="s3v4",
            retries={"max_attempts": 3, "mode": "standard"},
            connect_timeout=10,
            read_timeout=60,
        ),
    )


def init_storage() -> None:
    """Validate R2 connectivity at boot. Safe to call multiple times."""
    _client().head_bucket(Bucket=_bucket())
    logger.info("R2 object storage initialised (bucket=%s)", _bucket())


def put_object(path: str, data: bytes, content_type: str) -> dict:
    """Upload bytes to R2. Returns {path, size, etag}."""
    resp = _client().put_object(
        Bucket=_bucket(),
        Key=path,
        Body=data,
        ContentType=content_type,
    )
    return {"path": path, "size": len(data), "etag": (resp.get("ETag") or "").strip('"')}


def get_object(path: str):
    """Download bytes from R2. Returns (bytes, content_type). Raises FileNotFoundError if missing."""
    try:
        resp = _client().get_object(Bucket=_bucket(), Key=path)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            raise FileNotFoundError(path) from e
        raise
    return resp["Body"].read(), resp.get("ContentType", "application/octet-stream")


def delete_object(path: str) -> None:
    """Delete an object from R2. Deleting a missing key is a no-op in S3-compatible APIs."""
    _client().delete_object(Bucket=_bucket(), Key=path)


def build_path(user_id: str, ext: str, folder: str = "uploads") -> str:
    """Convention: stock-management/{folder}/{user_id}/{uuid}.{ext} — UUID naming
    guarantees no collisions/overwrites across concurrent or repeated uploads."""
    safe_ext = (ext or "bin").lower().lstrip(".")
    safe_folder = (folder or "uploads").strip("/") or "uploads"
    return f"{APP_NAME}/{safe_folder}/{user_id}/{_uuid.uuid4()}.{safe_ext}"
