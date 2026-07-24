"""Backend API tests for Stock Management System."""
import io
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://inventory-ops-dash.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"

RUN_TAG = uuid.uuid4().hex[:6]


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and data["user"]["email"] == ADMIN_EMAIL
    return data["token"]


@pytest.fixture(scope="session")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- AUTH ----------
class TestAuth:
    def test_register_new_user(self):
        email = f"test_{RUN_TAG}@example.com"
        r = requests.post(f"{BASE_URL}/api/auth/register", json={"email": email, "password": "pw123456", "name": "T"}, timeout=30)
        assert r.status_code == 200
        j = r.json()
        assert j["user"]["email"] == email
        assert j["token"]

    def test_me_requires_auth(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", timeout=30)
        assert r.status_code in (401, 403)

    def test_me_with_token(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        assert r.json()["email"] == ADMIN_EMAIL

    def test_login_invalid(self):
        r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"}, timeout=30)
        assert r.status_code == 401

    def test_protected_endpoint_no_token(self):
        r = requests.get(f"{BASE_URL}/api/stock-master", timeout=30)
        assert r.status_code in (401, 403)


# ---------- STOCK MASTER ----------
class TestStockMaster:
    _created = {}

    def test_create_item(self, auth_headers):
        pn = f"PN_{RUN_TAG}_A"
        payload = {"part_no": pn, "make": "ACME", "description_1": "Gear", "item_category": "Mech", "model": "M1"}
        r = requests.post(f"{BASE_URL}/api/stock-master", json=payload, headers=auth_headers, timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["part_no"] == pn and d["make"] == "ACME" and d["id"]
        TestStockMaster._created["id"] = d["id"]
        TestStockMaster._created["part_no"] = pn

    def test_duplicate_part_make_rejected(self, auth_headers):
        pn = TestStockMaster._created["part_no"]
        r = requests.post(f"{BASE_URL}/api/stock-master", json={"part_no": pn, "make": "ACME"}, headers=auth_headers, timeout=30)
        assert r.status_code == 400

    def test_same_part_diff_make_allowed(self, auth_headers):
        pn = TestStockMaster._created["part_no"]
        r = requests.post(f"{BASE_URL}/api/stock-master", json={"part_no": pn, "make": "BOSCH", "description_1": "Gear v2"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200

    def test_get_by_id_and_search(self, auth_headers):
        iid = TestStockMaster._created["id"]
        r = requests.get(f"{BASE_URL}/api/stock-master/{iid}", headers=auth_headers, timeout=30)
        assert r.status_code == 200 and r.json()["id"] == iid
        r = requests.get(f"{BASE_URL}/api/stock-master", params={"search": TestStockMaster._created["part_no"]}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and any(i["id"] == iid for i in r.json())

    def test_lookup_makes(self, auth_headers):
        pn = TestStockMaster._created["part_no"]
        r = requests.get(f"{BASE_URL}/api/stock-master/lookup/makes", params={"part_no": pn}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        makes = r.json()["makes"]
        assert "ACME" in makes and "BOSCH" in makes

    def test_lookup_item(self, auth_headers):
        pn = TestStockMaster._created["part_no"]
        r = requests.get(f"{BASE_URL}/api/stock-master/lookup/item", params={"part_no": pn, "make": "ACME"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and r.json()["description_1"] == "Gear"

    def test_update_item(self, auth_headers):
        iid = TestStockMaster._created["id"]
        pn = TestStockMaster._created["part_no"]
        r = requests.put(f"{BASE_URL}/api/stock-master/{iid}", json={"part_no": pn, "make": "ACME", "description_1": "Gear Updated"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and r.json()["description_1"] == "Gear Updated"
        # verify persisted
        r = requests.get(f"{BASE_URL}/api/stock-master/{iid}", headers=auth_headers, timeout=30)
        assert r.json()["description_1"] == "Gear Updated"

    def test_bulk_upload(self, auth_headers):
        csv = f"part_no,make,description_1,item_category\nPN_{RUN_TAG}_B,ACME,Bolt,Hw\nPN_{RUN_TAG}_C,ACME,Nut,Hw\n"
        files = {"file": ("items.csv", io.BytesIO(csv.encode()), "text/csv")}
        r = requests.post(f"{BASE_URL}/api/stock-master/bulk-upload", files=files, headers=auth_headers, timeout=60)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["inserted"] >= 2


# ---------- LOCATIONS + TXN ----------
class TestLocationsAndTransactions:
    _ids = {}

    def test_create_hierarchy(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"G_{RUN_TAG}"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        gid = r.json()["id"]
        TestLocationsAndTransactions._ids["g"] = gid

        r = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": gid, "rack_no": f"R_{RUN_TAG}", "total_boxes": 3}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        rid = r.json()["id"]
        TestLocationsAndTransactions._ids["r"] = rid

        r = requests.post(f"{BASE_URL}/api/boxes", json={"rack_id": rid, "box_no": f"B_{RUN_TAG}", "box_category": "Small"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        TestLocationsAndTransactions._ids["b"] = r.json()["id"]

    def test_rack_invalid_godown(self, auth_headers):
        r = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": "nope", "rack_no": "X"}, headers=auth_headers, timeout=30)
        assert r.status_code == 400

    def test_list_filters(self, auth_headers):
        gid = TestLocationsAndTransactions._ids["g"]
        r = requests.get(f"{BASE_URL}/api/racks", params={"godown_id": gid}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and all(x["godown_id"] == gid for x in r.json())
        rid = TestLocationsAndTransactions._ids["r"]
        r = requests.get(f"{BASE_URL}/api/boxes", params={"rack_id": rid}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and all(x["rack_id"] == rid for x in r.json())

    def test_direct_stock_in_disabled(self, auth_headers):
        pn = f"PN_{RUN_TAG}_A"
        body = {"part_no": pn, "make": "ACME", "quantity": 10, "godown_id": TestLocationsAndTransactions._ids["g"], "rack_id": TestLocationsAndTransactions._ids["r"], "box_id": TestLocationsAndTransactions._ids["b"]}
        r = requests.post(f"{BASE_URL}/api/stock-in", json=body, headers=auth_headers, timeout=30)
        assert r.status_code == 410, r.text

    def test_stock_in_invalid_item(self, auth_headers):
        body = {"part_no": "NONE_X", "make": "NONE", "quantity": 1, "godown_id": TestLocationsAndTransactions._ids["g"], "rack_id": TestLocationsAndTransactions._ids["r"], "box_id": TestLocationsAndTransactions._ids["b"]}
        r = requests.post(f"{BASE_URL}/api/stock-in", json=body, headers=auth_headers, timeout=30)
        assert r.status_code == 410

    def test_stock_in_bad_qty(self, auth_headers):
        body = {"part_no": f"PN_{RUN_TAG}_A", "make": "ACME", "quantity": 0, "godown_id": TestLocationsAndTransactions._ids["g"], "rack_id": TestLocationsAndTransactions._ids["r"], "box_id": TestLocationsAndTransactions._ids["b"]}
        r = requests.post(f"{BASE_URL}/api/stock-in", json=body, headers=auth_headers, timeout=30)
        assert r.status_code == 410

    def test_stock_out_insufficient(self, auth_headers):
        body = {"part_no": f"PN_{RUN_TAG}_A", "make": "ACME", "quantity": 9999, "godown_id": TestLocationsAndTransactions._ids["g"], "rack_id": TestLocationsAndTransactions._ids["r"], "box_id": TestLocationsAndTransactions._ids["b"]}
        r = requests.post(f"{BASE_URL}/api/stock-out", json=body, headers=auth_headers, timeout=30)
        assert r.status_code == 400

    def test_stock_out_without_racked_stock_is_blocked(self, auth_headers):
        body = {"part_no": f"PN_{RUN_TAG}_A", "make": "ACME", "quantity": 3, "godown_id": TestLocationsAndTransactions._ids["g"], "rack_id": TestLocationsAndTransactions._ids["r"], "box_id": TestLocationsAndTransactions._ids["b"]}
        r = requests.post(f"{BASE_URL}/api/stock-out", json=body, headers=auth_headers, timeout=30)
        assert r.status_code == 400

    def test_balance(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/stock-balance", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        pn = f"PN_{RUN_TAG}_A"
        rows = [x for x in r.json() if x["part_no"] == pn and x["make"] == "ACME"]
        assert rows and rows[0]["total_quantity"] == 7

    def test_low_stock(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/low-stock", params={"threshold": 10}, headers=auth_headers, timeout=30)
        assert r.status_code == 200
        pn = f"PN_{RUN_TAG}_A"
        assert any(x["part_no"] == pn and x["total_quantity"] == 7 for x in r.json())

    def test_transactions_list(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/transactions", params={"type": "IN"}, headers=auth_headers, timeout=30)
        assert r.status_code == 200 and all(t["type"] == "IN" for t in r.json())

    def test_dashboard_stats(self, auth_headers):
        r = requests.get(f"{BASE_URL}/api/dashboard/stats", headers=auth_headers, timeout=30)
        assert r.status_code == 200
        s = r.json()
        for k in ["total_items", "total_godowns", "total_racks", "total_boxes", "total_transactions", "total_stock_qty", "low_stock_count"]:
            assert k in s
