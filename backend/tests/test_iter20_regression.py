"""Iter-20 full regression after user's massive rewrite + startup-crash fix.

Covers:
- Auth, /auth/me, /meta/modules, /dashboard/stats, /godowns, /racks, /boxes
- Stock master CRUD
- Receipt Note: optional invoice_no/invoice_date/goods_received_date (NEW),
  finalize with blanks, list filters, next-no, /stock-in/lookup
- SRN/ERN auto-creation when received != invoice on finalize
- Racking Note prepare shape: {receipt_note, items} for legacy endpoint
- Stock balance
- /notifications
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def token():
    r = requests.post(f"{API}/auth/login", json={
        "email": "admin@stockmgmt.com", "password": "admin123",
    }, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="session")
def client(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


# ---------------- Auth + core meta ----------------
class TestAuthAndCore:
    def test_login_returns_token_and_user(self):
        r = requests.post(f"{API}/auth/login", json={
            "email": "admin@stockmgmt.com", "password": "admin123",
        }, timeout=15)
        assert r.status_code == 200
        b = r.json()
        assert "token" in b and isinstance(b["token"], str) and len(b["token"]) > 0
        assert b.get("user", {}).get("email") == "admin@stockmgmt.com"

    def test_login_bad_creds(self):
        r = requests.post(f"{API}/auth/login", json={
            "email": "admin@stockmgmt.com", "password": "wrong",
        }, timeout=15)
        assert r.status_code in (400, 401)

    def test_me(self, client):
        r = client.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 200
        assert r.json().get("email") == "admin@stockmgmt.com"

    def test_modules(self, client):
        r = client.get(f"{API}/meta/modules", timeout=15)
        assert r.status_code == 200

    def test_dashboard_stats(self, client):
        r = client.get(f"{API}/dashboard/stats", timeout=15)
        assert r.status_code == 200

    def test_godowns_racks_boxes(self, client):
        g = client.get(f"{API}/godowns", timeout=15)
        assert g.status_code == 200
        rk = client.get(f"{API}/racks", timeout=15)
        assert rk.status_code == 200
        bx = client.get(f"{API}/boxes", timeout=15)
        assert bx.status_code == 200

    def test_stock_balance(self, client):
        r = client.get(f"{API}/stock-balance", timeout=20)
        assert r.status_code == 200

    def test_notifications(self, client):
        r = client.get(f"{API}/notifications?limit=10", timeout=15)
        assert r.status_code == 200

    def test_users_list(self, client):
        r = client.get(f"{API}/users", timeout=15)
        assert r.status_code == 200


# ---------------- Stock Master ----------------
class TestStockMaster:
    def test_list(self, client):
        r = client.get(f"{API}/stock-master?page=1&page_size=5", timeout=15)
        assert r.status_code == 200

    def test_create_get_update(self, client):
        pn = f"TEST_PN_{uuid.uuid4().hex[:6].upper()}"
        mk = "TESTMK"
        c = client.post(f"{API}/stock-master", json={
            "part_no": pn, "make": mk, "model": "TM",
            "description_1": "T", "description_2": "",
            "item_category": "A",
        }, timeout=15)
        assert c.status_code in (200, 201), c.text
        sm = c.json()
        assert sm.get("part_no") == pn

        # Update
        u = client.put(f"{API}/stock-master/{sm['id']}", json={"description_1": "Updated"}, timeout=15)
        assert u.status_code == 200, u.text
        # GET by id (or filter list)
        lst = client.get(f"{API}/stock-master?search={pn}&page_size=5", timeout=15).json()
        items = lst if isinstance(lst, list) else lst.get("items") or lst.get("data") or []
        assert any(i.get("part_no") == pn for i in items)


# ---------------- Receipt Note ----------------
@pytest.fixture(scope="session")
def seed_loc(client):
    pn = f"TEST_PN_{uuid.uuid4().hex[:6].upper()}"
    mk = "TESTMK"
    client.post(f"{API}/stock-master", json={
        "part_no": pn, "make": mk, "model": "TM",
        "description_1": "T", "description_2": "", "item_category": "A",
    }, timeout=15)
    g = client.get(f"{API}/godowns", timeout=15).json()
    godown = g[0] if g else client.post(f"{API}/godowns", json={"name": "TEST_GDN", "location": ""}, timeout=15).json()
    racks = client.get(f"{API}/racks?godown_id={godown['id']}", timeout=15).json()
    rack = racks[0] if racks else client.post(f"{API}/racks", json={"godown_id": godown["id"], "rack_no": "TR1"}, timeout=15).json()
    boxes = client.get(f"{API}/boxes?rack_id={rack['id']}", timeout=15).json()
    box = boxes[0] if boxes else None
    return {"part_no": pn, "make": mk, "godown": godown, "rack": rack, "box": box}


class TestReceiptNoteOptionalFields:
    def test_next_no(self, client):
        r = client.get(f"{API}/receipt-notes/next-no", timeout=15)
        assert r.status_code == 200

    def test_create_draft_blank_invoice_fields(self, client, seed_loc):
        """NEW: invoice_no, invoice_date, goods_received_date are now ALL OPTIONAL."""
        s = seed_loc
        r = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            # invoice_no, invoice_date, goods_received_date all omitted
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 3, "received_qty": 3}],
        }, timeout=20)
        assert r.status_code in (200, 201), r.text
        rn = r.json()
        assert rn["status"] == "DRAFT"
        return rn

    def test_finalize_with_blank_invoice_fields(self, client, seed_loc):
        s = seed_loc
        c = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 2, "received_qty": 2}],
        }, timeout=20)
        assert c.status_code in (200, 201), c.text
        rn_id = c.json()["id"]
        f = client.post(f"{API}/receipt-notes/{rn_id}/finalize", timeout=20)
        assert f.status_code == 200, f.text
        body = f.json()
        assert body.get("status") == "FINAL", f"expected FINAL with blank invoice fields, got: {body}"

    def test_list_filters_and_pagination(self, client):
        r = client.get(f"{API}/receipt-notes?status=DRAFT&page=1&page_size=5", timeout=15)
        assert r.status_code == 200
        r2 = client.get(f"{API}/receipt-notes?not_status=FULLY_RACKED&page=1&page_size=5", timeout=15)
        assert r2.status_code == 200

    def test_stock_in_lookup(self, client, seed_loc):
        s = seed_loc
        r = client.post(f"{API}/stock-in/lookup", json={
            "part_no": s["part_no"], "make": s["make"],
        }, timeout=15)
        assert r.status_code == 200


class TestSRNERNAutoCreate:
    """When finalize RN with invoice_qty != received_qty, SRN/ERN should auto-create."""
    def test_short_received_creates_srn(self, client, seed_loc):
        s = seed_loc
        c = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 10, "received_qty": 7}],  # 3 short
        }, timeout=20)
        assert c.status_code in (200, 201), c.text
        rn_id = c.json()["id"]
        f = client.post(f"{API}/receipt-notes/{rn_id}/finalize", timeout=20)
        assert f.status_code == 200, f.text

        # Verify an SRN exists referencing this RN
        srn_list = client.get(f"{API}/short-received-notes?page_size=50", timeout=15)
        assert srn_list.status_code == 200
        rows = srn_list.json() if isinstance(srn_list.json(), list) else srn_list.json().get("items") or []
        assert any(r.get("parent_rn_id") == rn_id for r in rows), \
            f"No SRN auto-created for RN {rn_id}"

    def test_extra_received_creates_ern(self, client, seed_loc):
        s = seed_loc
        c = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 5, "received_qty": 8}],  # 3 extra
        }, timeout=20)
        assert c.status_code in (200, 201), c.text
        rn_id = c.json()["id"]
        f = client.post(f"{API}/receipt-notes/{rn_id}/finalize", timeout=20)
        assert f.status_code == 200, f.text

        ern_list = client.get(f"{API}/extra-received-notes?page_size=50", timeout=15)
        assert ern_list.status_code == 200
        rows = ern_list.json() if isinstance(ern_list.json(), list) else ern_list.json().get("items") or []
        assert any(r.get("parent_rn_id") == rn_id for r in rows), \
            f"No ERN auto-created for RN {rn_id}"


class TestRackingNotePrepareContract:
    """Verify legacy /racking-notes/prepare/{rn_id} returns {receipt_note, items}
    — RackingNoteTab.jsx (lines 359, 408) consumes this exact shape."""
    def test_prepare_shape(self, client, seed_loc):
        s = seed_loc
        c = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 4, "received_qty": 4}],
        }, timeout=20)
        rn_id = c.json()["id"]
        client.post(f"{API}/receipt-notes/{rn_id}/finalize", timeout=20)

        p = client.get(f"{API}/racking-notes/prepare/{rn_id}", timeout=15)
        assert p.status_code == 200, p.text
        body = p.json()
        assert isinstance(body, dict)
        assert "receipt_note" in body, "prepare must return 'receipt_note' for legacy frontend"
        assert "items" in body and isinstance(body["items"], list)
        assert len(body["items"]) >= 1
        rn = body["receipt_note"]
        # Required keys consumed by RackingNoteTab.jsx
        for k in ("id", "rn_no", "rn_date"):
            assert k in rn, f"missing {k} in receipt_note shape"

    def test_prepare_404_on_unknown(self, client):
        r = client.get(f"{API}/racking-notes/prepare/nonexistent_xyz", timeout=15)
        assert r.status_code == 404


class TestCountersSelfHeal:
    """Verify counter values are >= max(serial) per (series, fy) — i.e., self-heal works."""
    def test_can_create_after_startup(self, client, seed_loc):
        # If counter self-heal is broken, this would 500 with E11000.
        s = seed_loc
        r = client.post(f"{API}/receipt-notes", json={
            "rn_date": "2025-01-10",
            "items": [{"part_no": s["part_no"], "make": s["make"],
                       "invoice_qty": 1, "received_qty": 1}],
        }, timeout=20)
        assert r.status_code in (200, 201), r.text


class TestModuleACL:
    """Non-admin without stock_in module should get 403 on stock-in routes."""
    def test_non_admin_blocked(self, client):
        # create user without stock_in module
        em = f"TEST_NOACL_{uuid.uuid4().hex[:5]}@x.com"
        u = client.post(f"{API}/users", json={
            "email": em, "password": "Passw0rd!", "name": "noacl",
            "role": "user", "module_access": ["stock_master"],
        }, timeout=15)
        if u.status_code not in (200, 201):
            pytest.skip(f"could not create user: {u.text}")
        # login as that user
        lg = requests.post(f"{API}/auth/login", json={"email": em, "password": "Passw0rd!"}, timeout=15)
        assert lg.status_code == 200, lg.text
        tok = lg.json()["token"]
        s2 = requests.Session()
        s2.headers.update({"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
        # Should be blocked from receipt-notes (stock_in module)
        r = s2.get(f"{API}/receipt-notes?page_size=1", timeout=15)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"
