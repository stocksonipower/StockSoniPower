"""Backend tests for image upload/serve + stock-master 5-image cap."""
import io
import os
import struct
import zlib
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://asset-ledger-15.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASS = "admin123"


def _png_bytes(w=2, h=2):
    """Return a minimal valid PNG."""
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(typ, data):
        return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)  # 8-bit RGB
    raw = b""
    for _ in range(h):
        raw += b"\x00" + b"\xff\x00\x00" * w
    idat = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS})
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def png_bytes():
    return _png_bytes()


# -------------------- Upload tests --------------------

def test_upload_png(auth_headers, png_bytes):
    files = {"file": ("test.png", png_bytes, "image/png")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", headers=auth_headers, files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "path" in body and body["path"].startswith("stock-management/uploads/")
    assert body["content_type"] == "image/png"
    assert body["size"] > 0


def test_upload_jpg(auth_headers):
    # Minimal JPEG SOI+EOI is invalid but server only checks content_type, not magic.
    fake = b"\xff\xd8\xff\xe0" + b"\x00" * 64 + b"\xff\xd9"
    files = {"file": ("t.jpg", fake, "image/jpeg")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", headers=auth_headers, files=files)
    assert r.status_code == 200, r.text


def test_upload_unsupported_type(auth_headers):
    files = {"file": ("a.txt", b"hello", "text/plain")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", headers=auth_headers, files=files)
    assert r.status_code in (400, 415), r.text


def test_upload_too_large(auth_headers):
    big = b"\x00" * (10 * 1024 * 1024 + 100)
    files = {"file": ("big.png", big, "image/png")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", headers=auth_headers, files=files)
    assert r.status_code == 400


def test_upload_no_auth(png_bytes):
    files = {"file": ("t.png", png_bytes, "image/png")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", files=files)
    assert r.status_code in (401, 403)


# -------------------- Serve tests --------------------

@pytest.fixture(scope="module")
def uploaded_path(auth_headers, png_bytes):
    files = {"file": ("t.png", png_bytes, "image/png")}
    r = requests.post(f"{BASE_URL}/api/uploads/image", headers=auth_headers, files=files)
    assert r.status_code == 200
    return r.json()["path"]


def test_serve_with_bearer_header(auth_headers, uploaded_path):
    r = requests.get(f"{BASE_URL}/api/files/{uploaded_path}", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/")
    assert len(r.content) > 0


def test_serve_with_query_auth(token, uploaded_path):
    r = requests.get(f"{BASE_URL}/api/files/{uploaded_path}?auth={token}")
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("image/")


def test_serve_no_auth(uploaded_path):
    r = requests.get(f"{BASE_URL}/api/files/{uploaded_path}")
    assert r.status_code == 401


def test_serve_unknown_path(auth_headers):
    r = requests.get(f"{BASE_URL}/api/files/stock-management/uploads/does/not-exist.png", headers=auth_headers)
    assert r.status_code == 404


# -------------------- Stock master images cap --------------------

def _make_stock_payload(images):
    return {
        "item_code": f"TEST_IMG_{os.urandom(3).hex()}",
        "part_no": f"TESTPN_{os.urandom(3).hex()}",
        "make": "TEST_MAKE",
        "description": "TEST item for image cap",
        "uom": "PCS",
        "category": "Test",
        "reorder_level": 0,
        "images": images,
    }


def test_create_stock_master_with_5_images_ok(auth_headers, uploaded_path):
    payload = _make_stock_payload([uploaded_path] * 5)
    r = requests.post(f"{BASE_URL}/api/stock-master", headers=auth_headers, json=payload)
    assert r.status_code in (200, 201), r.text
    item = r.json()
    assert isinstance(item.get("images"), list)
    assert len(item["images"]) == 5
    # cleanup
    requests.delete(f"{BASE_URL}/api/stock-master/{item['id']}", headers=auth_headers)


def test_create_stock_master_with_6_images_rejected(auth_headers, uploaded_path):
    payload = _make_stock_payload([uploaded_path] * 6)
    r = requests.post(f"{BASE_URL}/api/stock-master", headers=auth_headers, json=payload)
    assert r.status_code == 400, r.text
    assert "5 images" in r.text or "maximum" in r.text.lower()


def test_update_stock_master_with_6_images_rejected(auth_headers, uploaded_path):
    payload = _make_stock_payload([uploaded_path])
    create = requests.post(f"{BASE_URL}/api/stock-master", headers=auth_headers, json=payload)
    assert create.status_code in (200, 201), create.text
    item_id = create.json()["id"]
    try:
        update_payload = dict(payload)
        update_payload["images"] = [uploaded_path] * 6
        r = requests.put(
            f"{BASE_URL}/api/stock-master/{item_id}",
            headers=auth_headers,
            json=update_payload,
        )
        assert r.status_code == 400, r.text
        assert "5 images" in r.text or "maximum" in r.text.lower()
    finally:
        requests.delete(f"{BASE_URL}/api/stock-master/{item_id}", headers=auth_headers)


def test_stock_balance_has_images_field(auth_headers):
    """stock-balance only contains items with transactions; verify schema includes 'images' list field."""
    r = requests.get(f"{BASE_URL}/api/stock-balance", headers=auth_headers)
    assert r.status_code == 200, r.text
    rows = r.json()
    if not rows:
        pytest.skip("No stock-balance rows present")
    sample = rows[0]
    assert "images" in sample, "stock-balance row missing 'images' field"
    assert isinstance(sample["images"], list)
