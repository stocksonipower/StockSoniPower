"""Backend tests for Receipt Notes (Stock In) iteration 4 — max-serial+1, PUT, DELETE."""
import os
import re
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or "https://warehouse-ops-65.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Auth failed: {r.status_code}")
    return r.json().get("token")


@pytest.fixture(scope="module")
def client(auth_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"})
    return s


def _fy_label_now():
    d = datetime.now(timezone.utc)
    if d.month >= 4:
        return f"{d.year % 100:02d}-{(d.year + 1) % 100:02d}"
    return f"{(d.year - 1) % 100:02d}-{d.year % 100:02d}"


# --- max-serial+1 algorithm ---
class TestMaxSerialPlusOne:
    def test_next_no_is_max_plus_one(self, client):
        # List all RNs in current FY -> compute expected
        fy = _fy_label_now()
        rows = client.get(f"{BASE_URL}/api/receipt-notes", params={"page": 1, "page_size": 5000}).json()
        same_fy = [r for r in rows if r.get("fy") == fy]
        max_serial = max([r.get("serial", 0) for r in same_fy], default=0)
        r = client.get(f"{BASE_URL}/api/receipt-notes/next-no")
        assert r.status_code == 200
        data = r.json()
        assert data["fy"] == fy
        assert data["next_serial"] == max_serial + 1, \
            f"Expected next_serial={max_serial + 1} (max in DB={max_serial}), got {data['next_serial']}"
        assert re.match(rf"^RN/{re.escape(fy)}/\d{{3}}$", data["next_rn_no"])

    def test_create_then_delete_reverts_next_serial(self, client):
        prev_serial = client.get(f"{BASE_URL}/api/receipt-notes/next-no").json()["next_serial"]

        # Create one
        payload = {
            "invoice_no": "TEST_AGENT_INV_DEL",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": 1}],
        }
        r = client.post(f"{BASE_URL}/api/receipt-notes", json=payload)
        assert r.status_code == 200, r.text
        created = r.json()
        assert created["serial"] == prev_serial
        new_id = created["id"]

        # next-no should now bump
        bumped = client.get(f"{BASE_URL}/api/receipt-notes/next-no").json()
        assert bumped["next_serial"] == prev_serial + 1

        # delete
        d = client.delete(f"{BASE_URL}/api/receipt-notes/{new_id}")
        assert d.status_code in (200, 204), d.text

        # verify gone
        g = client.get(f"{BASE_URL}/api/receipt-notes/{new_id}")
        assert g.status_code == 404

        # next-no should drop back to prev_serial (max+1 algorithm)
        after = client.get(f"{BASE_URL}/api/receipt-notes/next-no").json()
        assert after["next_serial"] == prev_serial, \
            f"Expected next_serial back to {prev_serial}, got {after['next_serial']}"


# --- PUT (update) ---
class TestUpdate:
    created_id = None
    rn_no = None
    rn_date = None
    serial = None
    fy = None

    def test_setup_create(self, client):
        r = client.post(f"{BASE_URL}/api/receipt-notes", json={
            "invoice_no": "TEST_AGENT_INV_UPD",
            "invoice_date": "2026-04-20",
            "items": [
                {"part_no": "4093678", "make": "CSP", "quantity": 5},
                {"part_no": "3922900", "make": "TATA", "quantity": 3},
            ],
        })
        assert r.status_code == 200, r.text
        d = r.json()
        TestUpdate.created_id = d["id"]
        TestUpdate.rn_no = d["rn_no"]
        TestUpdate.rn_date = d["rn_date"]
        TestUpdate.serial = d["serial"]
        TestUpdate.fy = d["fy"]

    def test_put_updates_invoice_and_items(self, client):
        assert TestUpdate.created_id
        payload = {
            "invoice_no": "TEST_AGENT_INV_UPD_v2",
            "invoice_date": "2026-04-22",
            "items": [
                {"part_no": "4093678", "make": "CSP", "quantity": 10},
            ],
        }
        r = client.put(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}", json=payload)
        assert r.status_code == 200, r.text
        d = r.json()
        # Mutable fields changed
        assert d["invoice_no"] == "TEST_AGENT_INV_UPD_v2"
        assert d["invoice_date"] == "2026-04-22"
        assert len(d["items"]) == 1
        assert d["items"][0]["quantity"] == 10
        # Immutable fields preserved
        assert d["rn_no"] == TestUpdate.rn_no
        assert d["rn_date"] == TestUpdate.rn_date
        assert d["serial"] == TestUpdate.serial
        assert d["fy"] == TestUpdate.fy
        assert "_id" not in d

        # GET to verify persistence
        g = client.get(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}").json()
        assert g["invoice_no"] == "TEST_AGENT_INV_UPD_v2"
        assert g["invoice_date"] == "2026-04-22"
        assert len(g["items"]) == 1

    def test_put_validation_empty_items(self, client):
        r = client.put(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}", json={
            "invoice_no": "X", "invoice_date": "2026-04-22", "items": []
        })
        assert r.status_code == 400, r.text

    def test_put_validation_qty_zero(self, client):
        r = client.put(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}", json={
            "invoice_no": "X", "invoice_date": "2026-04-22",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": 0}],
        })
        assert r.status_code == 400, r.text

    def test_put_validation_empty_part(self, client):
        r = client.put(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}", json={
            "invoice_no": "X", "invoice_date": "2026-04-22",
            "items": [{"part_no": "  ", "make": "CSP", "quantity": 1}],
        })
        assert r.status_code == 400, r.text

    def test_put_validation_empty_make(self, client):
        r = client.put(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}", json={
            "invoice_no": "X", "invoice_date": "2026-04-22",
            "items": [{"part_no": "4093678", "make": "  ", "quantity": 1}],
        })
        assert r.status_code == 400, r.text

    def test_put_unknown_id_404(self, client):
        r = client.put(f"{BASE_URL}/api/receipt-notes/does-not-exist-uuid-xyz", json={
            "invoice_no": "X", "invoice_date": "2026-04-22",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": 1}],
        })
        assert r.status_code == 404, r.text

    def test_zzz_cleanup(self, client):
        if TestUpdate.created_id:
            client.delete(f"{BASE_URL}/api/receipt-notes/{TestUpdate.created_id}")


# --- DELETE ---
class TestDeleteUnknown:
    def test_delete_unknown_id_404(self, client):
        r = client.delete(f"{BASE_URL}/api/receipt-notes/this-id-does-not-exist-zzz")
        assert r.status_code == 404
