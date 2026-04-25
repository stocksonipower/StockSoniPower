"""Backend tests for Receipt Notes (Stock In) API."""
import os
import re
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://godown-stock-tracker.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    if r.status_code != 200:
        pytest.skip(f"Auth failed: {r.status_code} {r.text}")
    return r.json().get("token")


@pytest.fixture(scope="module")
def client(auth_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"})
    return s


def _fy_label_now():
    d = datetime.now(timezone.utc)
    if d.month >= 4:
        a, b = d.year, d.year + 1
    else:
        a, b = d.year - 1, d.year
    return f"{a % 100:02d}-{b % 100:02d}"


# -------------------- next-no --------------------
class TestNextNo:
    def test_next_no_smoke(self, client):
        r = client.get(f"{BASE_URL}/api/receipt-notes/next-no")
        assert r.status_code == 200, r.text
        data = r.json()
        for k in ("fy", "next_serial", "next_rn_no", "rn_date"):
            assert k in data
        assert data["fy"] == _fy_label_now()
        assert re.match(rf"^RN/{re.escape(data['fy'])}/\d{{3}}$", data["next_rn_no"])
        assert isinstance(data["next_serial"], int) and data["next_serial"] >= 1
        # rn_date YYYY-MM-DD
        datetime.strptime(data["rn_date"], "%Y-%m-%d")


# -------------------- POST validation --------------------
class TestPostValidation:
    def test_empty_items_rejected(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={"invoice_no": "X", "invoice_date": "2026-04-25", "items": []})
        assert r.status_code == 400, r.text

    def test_qty_zero_rejected(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_INV_QTYZERO",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": 0}],
        })
        assert r.status_code == 400, r.text

    def test_qty_negative_rejected(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_INV_NEG",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": -1}],
        })
        assert r.status_code in (400, 422), r.text

    def test_empty_part_no_rejected(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_INV_EMP",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "   ", "make": "CSP", "quantity": 5}],
        })
        assert r.status_code == 400, r.text

    def test_empty_make_rejected(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_INV_NOMAKE",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "4093678", "make": "  ", "quantity": 5}],
        })
        assert r.status_code == 400, r.text


# -------------------- POST happy-path & GET round-trip --------------------
class TestCreateAndFetch:
    created_id = None
    created_rn_no = None

    def test_create_and_increment(self, client):
        # Get current preview
        prev = client.get(f"{BASE_URL}/api/receipt-notes/next-no").json()
        expected_serial = prev["next_serial"]
        expected_rn_no = prev["next_rn_no"]

        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_INV_001",
            "invoice_date": "2026-04-25",
            "items": [
                {"part_no": "4093678", "make": "CSP", "quantity": 2},
                {"part_no": "3922900", "make": "TATA", "quantity": 7},
            ],
        })
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["rn_no"] == expected_rn_no
        assert doc["fy"] == prev["fy"]
        assert doc["serial"] == expected_serial
        assert doc["invoice_no"] == "TEST_INV_001"
        assert doc["invoice_date"] == "2026-04-25"
        assert len(doc["items"]) == 2
        assert "id" in doc and "_id" not in doc
        TestCreateAndFetch.created_id = doc["id"]
        TestCreateAndFetch.created_rn_no = doc["rn_no"]

        # Next preview must increment
        prev2 = client.get(f"{BASE_URL}/api/receipt-notes/next-no").json()
        assert prev2["next_serial"] == expected_serial + 1

    def test_get_by_id(self, client):
        assert TestCreateAndFetch.created_id, "previous test did not create RN"
        r = client.get(f"{BASE_URL}/api/receipt-notes/{TestCreateAndFetch.created_id}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["rn_no"] == TestCreateAndFetch.created_rn_no
        assert d["invoice_no"] == "TEST_INV_001"
        assert "_id" not in d

    def test_list_contains_created(self, client):
        r = client.get(f"{BASE_URL}/api/receipt-notes", params={"page": 1, "page_size": 5000})
        assert r.status_code == 200
        rows = r.json()
        assert any(row["id"] == TestCreateAndFetch.created_id for row in rows)
        # newest first
        assert rows[0]["id"] == TestCreateAndFetch.created_id
        # No mongo _id
        assert all("_id" not in row for row in rows)
        # X-Total-Count header
        assert "x-total-count" in {k.lower() for k in r.headers.keys()}

    def test_get_unknown_id_404(self, client):
        r = client.get(f"{BASE_URL}/api/receipt-notes/does-not-exist-uuid-999")
        assert r.status_code == 404


# -------------------- stock-master lookup makes (3 conditions) --------------------
class TestMakeLookup:
    def test_single_make(self, client):
        r = client.get(f"{BASE_URL}/api/stock-master/lookup/makes", params={"part_no": "4093678"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert "makes" in d
        assert "CSP" in d["makes"]
        assert len(d["makes"]) == 1

    def test_multiple_makes(self, client):
        r = client.get(f"{BASE_URL}/api/stock-master/lookup/makes", params={"part_no": "3922900"})
        assert r.status_code == 200, r.text
        d = r.json()
        makes = set(d.get("makes", []))
        assert {"CSP", "TATA"}.issubset(makes), f"got {makes}"

    def test_no_make(self, client):
        r = client.get(f"{BASE_URL}/api/stock-master/lookup/makes", params={"part_no": "NEWPART_XYZ_NOTEXIST"})
        assert r.status_code == 200
        d = r.json()
        assert d.get("makes", []) == []


# -------------------- Auth required --------------------
class TestAuthRequired:
    def test_no_auth_blocked(self):
        r = requests.get(f"{BASE_URL}/api/receipt-notes/next-no", timeout=10)
        assert r.status_code in (401, 403), r.status_code
