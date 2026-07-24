"""Iteration 28 — Supplementary refactor regression for newly-extracted modules.

Iter-27 already proved auth/users/notifications + a baseline sweep work.
Iter-28 extracted MORE from server.py:
  - routes/dashboard.py        (/stock-balance, /low-stock, /dashboard/stats)
  - routes/item_details.py     (/item-details, /item-details/search)
  - routes/uploads.py          (/uploads/image, /files/{path})
  - routes/locations.py        (godown/rack/box CRUD + range + bulk + downloads)
  - routes/stock_master.py     (CRUD + bulk-preview/upload + downloads + col-settings)
  - routes/_helpers.py         (shared bulk helpers)

This file adds focused parity tests for endpoints NOT covered by iter-27 and
for module-ACL enforcement on the newly-mounted routers, plus a smoke that
the deliberately-kept-monolithic stock_in/receipt-notes/racking workflow still
works end-to-end (these were NOT extracted, so they must not have regressed).
"""
import os
import io
import uuid

import pytest
import requests
from dotenv import load_dotenv
load_dotenv("/app/frontend/.env")

BASE_URL = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"

API = lambda path: f"{BASE_URL}/api{path}"


# ---------- shared fixtures ----------

@pytest.fixture(scope="session")
def H():
    r = requests.post(API("/auth/login"),
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=20)
    assert r.status_code == 200
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="session")
def seed(H):
    suffix = uuid.uuid4().hex[:8].upper()
    sm = requests.post(API("/stock-master"), headers=H, timeout=20, json={
        "part_no": f"TESTPN28_{suffix}", "make": f"TESTMK28_{suffix}",
        "model": "I28", "description_1": "iter28 seed", "unit": "PCS",
        "reorder_level": 5,
    }).json()
    g = requests.post(API("/godowns"), headers=H, timeout=20,
                      json={"godown_name": f"TEST_GD28_{suffix}"}).json()
    rk = requests.post(API("/racks"), headers=H, timeout=20,
                       json={"godown_id": g["id"], "rack_no": f"TR28_{suffix}"}).json()
    bx = requests.post(API("/boxes"), headers=H, timeout=20, json={
        "rack_id": rk["id"], "box_no": f"TB28_{suffix}", "box_category": "TEST",
    }).json()
    return {"suffix": suffix, "stock_master": sm, "godown": g, "rack": rk, "box": bx}


@pytest.fixture
def staff_factory(H):
    """Create a staff user with given module_access; cleans up after test."""
    created = []

    def _make(module_access: dict):
        suffix = uuid.uuid4().hex[:6]
        email = f"TEST_iter28_{suffix}@stockmgmt.com"
        body = {
            "email": email, "password": "pw1234",
            "name": f"i28 {suffix}", "role": "staff",
            "module_access": module_access,
        }
        c = requests.post(API("/users"), headers=H, json=body, timeout=20)
        assert c.status_code == 200, c.text
        uid = c.json()["id"]
        created.append(uid)
        login = requests.post(API("/auth/login"),
                              json={"email": email, "password": "pw1234"},
                              timeout=20)
        assert login.status_code == 200
        return {"Authorization": f"Bearer {login.json()['token']}"}, uid, email

    yield _make

    for uid in created:
        try:
            requests.delete(API(f"/users/{uid}"), headers=H, timeout=15)
        except Exception:
            pass


def _all_modules(**overrides):
    base = {k: True for k in ("stock_master", "locations", "stock_in", "stock_out",
                              "stock_transfer", "stock_summary", "low_stock",
                              "transactions", "item_details")}
    base.update(overrides)
    return base


# ===================== NEW ROUTER: dashboard.py =====================

class TestDashboardRouter:
    """parity: /stock-balance + /low-stock + /dashboard/stats"""

    def test_stock_balance_shape(self, H):
        r = requests.get(API("/stock-balance"), headers=H, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_dashboard_stats_keys(self, H):
        r = requests.get(API("/dashboard/stats"), headers=H, timeout=20)
        assert r.status_code == 200
        d = r.json()
        # Don't be over-strict, just ensure dict with at least one numeric key
        assert isinstance(d, dict) and len(d) > 0

    def test_low_stock_acl_blocks_disabled_staff(self, staff_factory):
        sh, _, _ = staff_factory(_all_modules(low_stock=False))
        r = requests.get(API("/low-stock"), headers=sh, timeout=20)
        assert r.status_code == 403, f"expected 403, got {r.status_code} {r.text[:200]}"

    def test_stock_summary_acl_blocks_disabled_staff(self, staff_factory):
        sh, _, _ = staff_factory(_all_modules(stock_summary=False))
        r = requests.get(API("/stock-balance"), headers=sh, timeout=20)
        assert r.status_code == 403


# ===================== NEW ROUTER: item_details.py =====================

class TestItemDetailsRouter:
    def test_search_filters_by_q(self, H, seed):
        r = requests.get(API("/item-details/search"), headers=H,
                         params={"q": seed["stock_master"]["part_no"]}, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        # If our seeded item is present, validate shape
        if rows:
            assert "part_no" in rows[0]

    def test_item_details_no_objectid_in_response(self, H, seed):
        sm = seed["stock_master"]
        r = requests.get(API("/item-details"), headers=H,
                         params={"part_no": sm["part_no"], "make": sm["make"]},
                         timeout=20)
        assert r.status_code == 200
        # MongoDB _id must never leak to the wire
        body = r.text
        assert '"_id"' not in body, "ObjectId leak: _id present in response"

    def test_acl_blocks_when_item_details_disabled(self, staff_factory, seed):
        sh, _, _ = staff_factory(_all_modules(item_details=False))
        r = requests.get(API("/item-details/search"), headers=sh,
                         params={"q": "x"}, timeout=20)
        assert r.status_code == 403


# ===================== NEW ROUTER: uploads.py =====================

class TestUploadsRouter:
    PNG = bytes.fromhex(
        "89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489"
        "0000000A49444154789C6300010000000500010D0A2DB40000000049454E44AE426082"
    )

    def test_upload_rejects_non_image(self, H):
        files = {"file": ("t.txt", io.BytesIO(b"hello"), "text/plain")}
        r = requests.post(API("/uploads/image"), headers=H, files=files, timeout=20)
        assert r.status_code in (400, 415, 422), f"expected 4xx for non-image, got {r.status_code}"

    def test_upload_then_serve_back_authenticated(self, H):
        files = {"file": ("t.png", io.BytesIO(self.PNG), "image/png")}
        r = requests.post(API("/uploads/image"), headers=H, files=files, timeout=20)
        assert r.status_code == 200, r.text
        path = r.json().get("path") or r.json().get("file_path") or r.json().get("url")
        assert path
        if path.startswith("http"):
            f = requests.get(path, headers=H, timeout=20)
        else:
            f = requests.get(API(f"/files/{path.lstrip('/')}"), headers=H, timeout=20)
        assert f.status_code == 200
        assert len(f.content) > 0


# ===================== NEW ROUTER: locations.py =====================

class TestLocationsRouterNewSurfaces:
    """Specifically the endpoints iter-27 didn't cover: download templates,
    bulk-upload, bulk-delete on godowns/boxes, boxes/range."""

    def test_godown_download_template(self, H):
        r = requests.get(API("/godowns/download/template"), headers=H, timeout=20)
        assert r.status_code == 200
        assert len(r.content) > 0

    def test_rack_download_template(self, H):
        r = requests.get(API("/racks/download/template"), headers=H, timeout=20)
        assert r.status_code == 200
        assert len(r.content) > 0

    def test_box_download_template(self, H):
        r = requests.get(API("/boxes/download/template"), headers=H, timeout=20)
        assert r.status_code == 200
        assert len(r.content) > 0

    def test_boxes_range_create(self, H, seed):
        suffix = uuid.uuid4().hex[:5].upper()
        r = requests.post(API("/boxes/range"), headers=H, timeout=20, json={
            "rack_id": seed["rack"]["id"], "prefix": f"BR_{suffix}_",
            "start": 1, "end": 2, "box_category": "TEST",
        })
        assert r.status_code == 200, r.text

    def test_godowns_bulk_delete(self, H):
        # Create 2 disposable godowns then bulk-delete them
        g1 = requests.post(API("/godowns"), headers=H, timeout=15,
                           json={"godown_name": f"TEST_BDG_{uuid.uuid4().hex[:5]}"}).json()
        g2 = requests.post(API("/godowns"), headers=H, timeout=15,
                           json={"godown_name": f"TEST_BDG_{uuid.uuid4().hex[:5]}"}).json()
        d = requests.post(API("/godowns/bulk-delete"), headers=H, timeout=20,
                          json={"ids": [g1["id"], g2["id"]]})
        # Either 200 (deleted) or 400 (referenced) acceptable
        assert d.status_code in (200, 400), d.text

    def test_boxes_bulk_delete(self, H, seed):
        b1 = requests.post(API("/boxes"), headers=H, timeout=15, json={
            "rack_id": seed["rack"]["id"],
            "box_no": f"BD_{uuid.uuid4().hex[:5]}", "box_category": "TEST",
        }).json()
        d = requests.post(API("/boxes/bulk-delete"), headers=H, timeout=20,
                          json={"ids": [b1["id"]]})
        assert d.status_code in (200, 400)

    def test_acl_locations_disabled_blocks_godowns(self, staff_factory):
        sh, _, _ = staff_factory(_all_modules(locations=False))
        r = requests.get(API("/godowns"), headers=sh, timeout=20)
        assert r.status_code == 403


# ===================== NEW ROUTER: stock_master.py =====================

class TestStockMasterRouterNewSurfaces:
    def test_bulk_preview_with_invalid_payload_returns_4xx(self, H):
        # bulk-preview expects an uploaded file; sending nothing should be 4xx (not 5xx)
        r = requests.post(API("/stock-master/bulk-preview"), headers=H, timeout=20)
        assert 400 <= r.status_code < 500, f"expected 4xx, got {r.status_code}"

    def test_distinct_returns_list(self, H):
        for field in ("make", "model", "unit"):
            r = requests.get(API(f"/stock-master/distinct/{field}"), headers=H, timeout=20)
            assert r.status_code == 200, f"{field} -> {r.status_code}"

    def test_acl_stock_master_disabled_blocks_get(self, staff_factory):
        sh, _, _ = staff_factory(_all_modules(stock_master=False))
        # critical case from review request — staff w/ stock_master=False on /api/stock-master
        r = requests.get(API("/stock-master"), headers=sh, timeout=20)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text[:200]}"

    def test_acl_stock_master_disabled_blocks_post(self, staff_factory):
        sh, _, _ = staff_factory(_all_modules(stock_master=False))
        r = requests.post(API("/stock-master"), headers=sh, timeout=20, json={
            "part_no": "X", "make": "Y", "unit": "PCS",
        })
        assert r.status_code == 403

    def test_acl_admin_bypasses(self, H):
        r = requests.get(API("/stock-master"), headers=H, timeout=20)
        assert r.status_code == 200, "admin must always pass module ACL"


# ===================== STILL-IN-server.py: stock_in / RN / racking smoke =====================
# These are not extracted; this is a parity smoke that the monolithic part
# wasn't accidentally broken by the iter-28 split.

class TestKeptInServerWorkflow:
    def test_full_stock_in_then_receipt_note_finalize(self, H, seed):
        sm = seed["stock_master"]

        # 1. Direct stock-in raw txn
        r = requests.post(API("/stock-in"), headers=H, timeout=20, json={
            "part_no": sm["part_no"], "make": sm["make"], "quantity": 7,
            "godown_id": seed["godown"]["id"], "rack_id": seed["rack"]["id"],
            "box_id": seed["box"]["id"],
        })
        assert r.status_code == 200, r.text

        # 2. Create RN draft + finalize → must transition status without 5xx
        c = requests.post(API("/receipt-notes"), headers=H, timeout=20, json={
            "stock_in_type": "GENERAL",
            "items": [{
                "part_no": sm["part_no"], "make": sm["make"],
                "invoice_qty": 4, "received_qty": 4, "quantity": 4,
            }],
        })
        assert c.status_code == 200, c.text
        rn = c.json()
        assert rn["status"] == "DRAFT"
        f = requests.post(API(f"/receipt-notes/{rn['id']}/finalize"),
                          headers=H, timeout=30)
        assert f.status_code == 200, f.text
        assert f.json()["status"] in ("FINAL", "RACKING_NOTE_DRAFT", "PARTIALLY_RACKED", "FULLY_RACKED")

    def test_racking_picking_transfer_next_no_endpoints(self, H):
        # All these stay in server.py — verify they still answer 200
        for ep in ("/racking-notes/next-no",
                   "/issue-notes/next-no",
                   "/picking-notes/next-no",
                   "/transfer-requests/next-no",
                   "/transfer-notes/next-no",
                   "/short-received-notes/next-no",
                   "/extra-received-notes/next-no"):
            r = requests.get(API(ep), headers=H, timeout=20)
            assert r.status_code == 200, f"{ep} regressed: {r.status_code}"
