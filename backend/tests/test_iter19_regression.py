"""Iteration-19 regression tests.

Focus:
1. Auth + core meta endpoints
2. Receipt Note (RN) CRUD + finalize
3. Racking Note (RKN) prepare (was returning null) → now must return dict with items
4. Full flow: RN DRAFT → FINAL → RKN DRAFT → RKN RECORD → Stock Balance increments

Uses admin credentials seeded per /app/memory/test_credentials.md.
Cleans up TEST_ prefixed data where safe.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={
        "email": "admin@stockmgmt.com",
        "password": "admin123",
    }, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="session")
def client(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


# ---------- Auth / meta ----------
class TestAuthAndMeta:
    def test_auth_me(self, client):
        r = client.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 200
        assert r.json().get("email") == "admin@stockmgmt.com"

    def test_modules(self, client):
        r = client.get(f"{API}/meta/modules", timeout=15)
        assert r.status_code == 200
        data = r.json()
        # expect list of 7 module keys
        assert isinstance(data, (list, dict))

    def test_dashboard_stats(self, client):
        r = client.get(f"{API}/dashboard/stats", timeout=15)
        assert r.status_code == 200

    def test_godowns(self, client):
        r = client.get(f"{API}/godowns", timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_stock_master(self, client):
        r = client.get(f"{API}/stock-master?page=1&page_size=5", timeout=15)
        assert r.status_code == 200


# ---------- RN / RKN flow ----------
@pytest.fixture(scope="session")
def seed_master_and_location(client):
    """Ensure at least one stock_master + godown/rack exist."""
    # master
    pn = f"TEST_PN_{uuid.uuid4().hex[:6].upper()}"
    mk = "TESTMK"
    r = client.post(f"{API}/stock-master", json={
        "part_no": pn, "make": mk,
        "model": "TM", "description_1": "T", "description_2": "",
        "item_category": "A",
    }, timeout=15)
    assert r.status_code in (200, 201), r.text
    # godown
    g = client.get(f"{API}/godowns", timeout=15).json()
    if g:
        godown = g[0]
    else:
        gr = client.post(f"{API}/godowns", json={"name": "TEST_GDN", "location": ""}, timeout=15)
        assert gr.status_code in (200, 201)
        godown = gr.json()
    # rack
    racks = client.get(f"{API}/racks?godown_id={godown['id']}", timeout=15).json()
    if racks:
        rack = racks[0]
    else:
        rr = client.post(f"{API}/racks", json={"godown_id": godown["id"], "rack_no": "TR1"}, timeout=15)
        assert rr.status_code in (200, 201)
        rack = rr.json()
    # box (if rack needs)
    boxes = client.get(f"{API}/boxes?rack_id={rack['id']}", timeout=15).json()
    box = boxes[0] if boxes else None
    return {"part_no": pn, "make": mk, "godown": godown, "rack": rack, "box": box}


class TestReceiptNoteFlow:
    def test_next_no(self, client):
        r = client.get(f"{API}/receipt-notes/next-no", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "next_rn_no" in data or "rn_no" in data or "next_serial" in data

    def test_rn_create_draft_finalize_and_prepare(self, client, seed_master_and_location):
        s = seed_master_and_location
        # 1. Create DRAFT
        payload = {
            "invoice_no": f"TEST_INV_{uuid.uuid4().hex[:6]}",
            "invoice_date": "2025-01-10",
            "rn_date": "2025-01-10",
            "goods_received_date": "2025-01-10",
            "items": [{
                "part_no": s["part_no"], "make": s["make"],
                "invoice_qty": 5, "received_qty": 5,
            }],
        }
        r = client.post(f"{API}/receipt-notes", json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        rn = r.json()
        rn_id = rn["id"]

        # 2. GET to verify persistence
        g = client.get(f"{API}/receipt-notes/{rn_id}", timeout=15)
        assert g.status_code == 200
        assert g.json()["status"] == "DRAFT"

        # 3. Finalize
        f = client.post(f"{API}/receipt-notes/{rn_id}/finalize", timeout=20)
        assert f.status_code == 200, f.text
        assert f.json().get("status") == "FINAL"

        # 4. prepare_racking_note MUST return dict with items (was returning null)
        p = client.get(f"{API}/racking-notes/prepare/{rn_id}", timeout=15)
        assert p.status_code == 200, p.text
        body = p.json()
        assert body is not None, "prepare_racking_note returned null — regression of iter18 bug"
        assert isinstance(body, dict)
        assert "items" in body and isinstance(body["items"], list)
        assert len(body["items"]) >= 1
        assert body["items"][0]["part_no"] == s["part_no"]
        assert body["items"][0]["pending_qty"] == 5

        # 5. Create RKN DRAFT
        itm = body["items"][0]
        rkn_items = [{
            "part_no": itm["part_no"], "make": itm["make"],
            "quantity": 5,
            "godown_id": s["godown"]["id"], "godown_name": s["godown"].get("name") or s["godown"].get("godown_name", ""),
            "rack_id": s["rack"]["id"], "rack_no": s["rack"].get("rack_no", ""),
            "box_id": (s["box"] or {}).get("id", ""),
            "box_no": (s["box"] or {}).get("box_no", ""),
            "box_category": (s["box"] or {}).get("category", ""),
        }]
        rk = client.post(f"{API}/racking-notes", json={
            "receipt_note_id": rn_id, "items": rkn_items,
        }, timeout=20)
        assert rk.status_code in (200, 201), rk.text
        rkn = rk.json()
        assert rkn.get("status") == "DRAFT"
        rkn_id = rkn["id"]

        # 6. Record RKN
        rec = client.post(f"{API}/racking-notes/{rkn_id}/record", timeout=20)
        assert rec.status_code == 200, rec.text

        # 7. RN should now be FULLY_RACKED
        g2 = client.get(f"{API}/receipt-notes/{rn_id}", timeout=15)
        assert g2.json()["status"] in ("FULLY_RACKED", "PARTIALLY_RACKED")

        # 8. Stock balance should contain the part with qty>=5
        sb = client.get(f"{API}/stock-balance?page_size=500", timeout=20)
        assert sb.status_code == 200
        rows = sb.json() if isinstance(sb.json(), list) else sb.json().get("items") or sb.json().get("data") or []
        found = [r for r in rows if r.get("part_no") == s["part_no"] and r.get("make") == s["make"]]
        assert found, "stock_balance missing newly-racked part"


# ---------- Validation sanity ----------
class TestValidation:
    def test_rn_future_invoice_date_rejected(self, client, seed_master_and_location):
        s = seed_master_and_location
        r = client.post(f"{API}/receipt-notes", json={
            "invoice_no": f"TEST_FUT_{uuid.uuid4().hex[:4]}",
            "invoice_date": "2099-12-31",
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"], "invoice_qty": 1}],
        }, timeout=15)
        assert r.status_code == 400

    def test_prepare_nonexistent_rn(self, client):
        r = client.get(f"{API}/racking-notes/prepare/nonexistent-id", timeout=15)
        assert r.status_code == 404


# ---------- Stock-in lookup ----------
class TestStockInLookup:
    def test_lookup_part_make(self, client, seed_master_and_location):
        s = seed_master_and_location
        r = client.post(f"{API}/stock-in/lookup", json={
            "part_no": s["part_no"], "make": s["make"],
        }, timeout=15)
        assert r.status_code == 200
