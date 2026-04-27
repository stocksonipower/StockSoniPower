"""Backend tests for Stock Transfer (Transfer Request + Transfer Note)."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://stock-control-mvp.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Auth failed: {r.status_code} {r.text}")
    return r.json()


def _h(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_h():
    return _h(_login(ADMIN_EMAIL, ADMIN_PASSWORD)["token"])


@pytest.fixture(scope="module")
def seed(admin_h):
    """Seed master + 2 godowns/racks with stock at the first source."""
    part = f"XFER-{uuid.uuid4().hex[:6]}"
    make = "XF"
    requests.post(f"{BASE_URL}/api/stock-master", json={"part_no": part, "make": make}, headers=admin_h, timeout=15)
    g1 = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"GA-{uuid.uuid4().hex[:4]}"}, headers=admin_h, timeout=15).json()
    g2 = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"GB-{uuid.uuid4().hex[:4]}"}, headers=admin_h, timeout=15).json()
    r1 = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g1["id"], "rack_no": "R1"}, headers=admin_h, timeout=15).json()
    r2 = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g2["id"], "rack_no": "R2"}, headers=admin_h, timeout=15).json()
    # Receive 50 units at G1/R1
    rn = requests.post(
        f"{BASE_URL}/api/receipt-notes",
        json={"items": [{"part_no": part, "make": make, "quantity": 50}]},
        headers=admin_h, timeout=15,
    ).json()
    rkn = requests.post(
        f"{BASE_URL}/api/racking-notes",
        json={
            "receipt_note_id": rn["id"],
            "items": [{
                "part_no": part, "make": make, "quantity": 50,
                "godown_id": g1["id"], "godown_name": g1["godown_name"],
                "rack_id": r1["id"], "rack_no": r1["rack_no"],
                "box_id": "", "box_no": "",
            }],
        },
        headers=admin_h, timeout=15,
    ).json()
    requests.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record", headers=admin_h, timeout=15)
    return {"part_no": part, "make": make, "g1": g1, "g2": g2, "r1": r1, "r2": r2}


def test_str_next_no(admin_h):
    r = requests.get(f"{BASE_URL}/api/transfer-requests/next-no", headers=admin_h, timeout=15)
    assert r.status_code == 200
    assert r.json()["next_str_no"].startswith("STR/")


def test_str_create_validates_qty_against_stock(admin_h, seed):
    """Cannot request more than available."""
    r = requests.post(
        f"{BASE_URL}/api/transfer-requests",
        json={"items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 9999}]},
        headers=admin_h, timeout=15,
    )
    assert r.status_code == 400
    assert "in stock" in r.json()["detail"].lower()


def test_full_transfer_flow_and_balance(admin_h, seed):
    """End-to-end: create STR, create+record STN, verify balance shifted, status FULLY_TRANSFERRED."""
    payload = {
        "purpose": "rebalance",
        "items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 20}],
    }
    str_doc = requests.post(f"{BASE_URL}/api/transfer-requests", json=payload, headers=admin_h, timeout=15).json()
    assert str_doc["status"] == "PENDING"

    # Prepare returns prefill from G1/R1
    prep = requests.get(f"{BASE_URL}/api/transfer-notes/prepare/{str_doc['id']}", headers=admin_h, timeout=15).json()
    assert len(prep["items"]) == 1
    src_loc = prep["items"][0]
    assert src_loc["src_godown_id"] == seed["g1"]["id"]
    assert src_loc["pending_qty"] == 20

    # Build STN: G1/R1 -> G2/R2
    stn_payload = {
        "transfer_request_id": str_doc["id"],
        "items": [{
            "part_no": seed["part_no"], "make": seed["make"], "quantity": 20,
            "src_godown_id": seed["g1"]["id"], "src_godown_name": seed["g1"]["godown_name"],
            "src_rack_id": seed["r1"]["id"], "src_rack_no": seed["r1"]["rack_no"],
            "src_box_id": "", "src_box_no": "",
            "dest_godown_id": seed["g2"]["id"], "dest_godown_name": seed["g2"]["godown_name"],
            "dest_rack_id": seed["r2"]["id"], "dest_rack_no": seed["r2"]["rack_no"],
            "dest_box_id": "", "dest_box_no": "",
        }],
    }
    stn = requests.post(f"{BASE_URL}/api/transfer-notes", json=stn_payload, headers=admin_h, timeout=15)
    assert stn.status_code == 200, stn.text
    stn_doc = stn.json()
    assert stn_doc["status"] == "DRAFT"

    # STR should now be PARTIALLY (20 of 20 -> actually FULLY since it's all of it)
    str_after = requests.get(f"{BASE_URL}/api/transfer-requests/{str_doc['id']}", headers=admin_h, timeout=15).json()
    assert str_after["status"] == "FULLY_TRANSFERRED"

    # Record
    rec = requests.post(f"{BASE_URL}/api/transfer-notes/{stn_doc['id']}/record", headers=admin_h, timeout=15)
    assert rec.status_code == 200, rec.text
    assert rec.json()["transactions_created"] == 2  # 1 OUT + 1 IN

    # Verify stock-balance now shows G2/R2 with 20 (and G1/R1 with 30 remaining)
    bal = requests.get(f"{BASE_URL}/api/stock-balance", params={"search": seed["part_no"]}, headers=admin_h, timeout=15).json()
    g1_qty = sum(b["total_quantity"] for b in bal if b["godown_id"] == seed["g1"]["id"])
    g2_qty = sum(b["total_quantity"] for b in bal if b["godown_id"] == seed["g2"]["id"])
    assert g1_qty == 30, f"expected 30 left at G1, got {g1_qty}"
    assert g2_qty == 20, f"expected 20 at G2, got {g2_qty}"


def test_stn_blocks_same_src_dest(admin_h, seed):
    str_doc = requests.post(
        f"{BASE_URL}/api/transfer-requests",
        json={"items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 5}]},
        headers=admin_h, timeout=15,
    ).json()
    stn_payload = {
        "transfer_request_id": str_doc["id"],
        "items": [{
            "part_no": seed["part_no"], "make": seed["make"], "quantity": 5,
            "src_godown_id": seed["g1"]["id"], "src_godown_name": seed["g1"]["godown_name"],
            "src_rack_id": seed["r1"]["id"], "src_rack_no": seed["r1"]["rack_no"],
            "src_box_id": "", "src_box_no": "",
            "dest_godown_id": seed["g1"]["id"], "dest_godown_name": seed["g1"]["godown_name"],
            "dest_rack_id": seed["r1"]["id"], "dest_rack_no": seed["r1"]["rack_no"],
            "dest_box_id": "", "dest_box_no": "",
        }],
    }
    r = requests.post(f"{BASE_URL}/api/transfer-notes", json=stn_payload, headers=admin_h, timeout=15)
    assert r.status_code == 400
    assert "differ" in r.json()["detail"].lower() or "same" in r.json()["detail"].lower() or "identical" in r.json()["detail"].lower()
    requests.delete(f"{BASE_URL}/api/transfer-requests/{str_doc['id']}", headers=admin_h, timeout=15)


def test_stn_assignment_blocks_other_staff(admin_h, seed):
    # Create staff users alice + bob
    aemail = f"al-{uuid.uuid4().hex[:6]}@xfertest.com"
    bemail = f"bo-{uuid.uuid4().hex[:6]}@xfertest.com"
    alice = requests.post(f"{BASE_URL}/api/users", json={"email": aemail, "password": "alice12345", "name": "Alice", "role": "staff"}, headers=admin_h, timeout=15).json()
    bob = requests.post(f"{BASE_URL}/api/users", json={"email": bemail, "password": "bob12345", "name": "Bob", "role": "staff"}, headers=admin_h, timeout=15).json()
    a_tok = _login(aemail, "alice12345")["token"]
    b_tok = _login(bemail, "bob12345")["token"]
    try:
        # STR assigned to Alice
        str_doc = requests.post(
            f"{BASE_URL}/api/transfer-requests",
            json={"items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 2}], "assigned_to_user_id": alice["id"]},
            headers=admin_h, timeout=15,
        ).json()
        assert str_doc["assigned_to_user_id"] == alice["id"]
        # Bob blocked from creating STN
        stn_payload = {
            "transfer_request_id": str_doc["id"],
            "items": [{
                "part_no": seed["part_no"], "make": seed["make"], "quantity": 2,
                "src_godown_id": seed["g1"]["id"], "src_godown_name": seed["g1"]["godown_name"],
                "src_rack_id": seed["r1"]["id"], "src_rack_no": seed["r1"]["rack_no"],
                "src_box_id": "", "src_box_no": "",
                "dest_godown_id": seed["g2"]["id"], "dest_godown_name": seed["g2"]["godown_name"],
                "dest_rack_id": seed["r2"]["id"], "dest_rack_no": seed["r2"]["rack_no"],
                "dest_box_id": "", "dest_box_no": "",
            }],
        }
        rb = requests.post(f"{BASE_URL}/api/transfer-notes", json=stn_payload, headers=_h(b_tok), timeout=15)
        assert rb.status_code == 403, rb.text
        ra = requests.post(f"{BASE_URL}/api/transfer-notes", json=stn_payload, headers=_h(a_tok), timeout=15)
        assert ra.status_code == 200, ra.text
        # GET enrichment
        lst = requests.get(f"{BASE_URL}/api/transfer-notes", headers=admin_h, timeout=15).json()
        row = next((x for x in lst if x["id"] == ra.json()["id"]), None)
        assert row is not None
        assert row["parent_assigned_to_user_id"] == alice["id"]
        assert row["parent_assigned_to_name"] == "Alice"
    finally:
        # cleanup
        for stn in requests.get(f"{BASE_URL}/api/transfer-notes", headers=admin_h, timeout=15).json():
            if stn.get("created_by") in (aemail, bemail, ADMIN_EMAIL) and stn.get("status") == "DRAFT":
                requests.delete(f"{BASE_URL}/api/transfer-notes/{stn['id']}", headers=admin_h, timeout=15)
        requests.delete(f"{BASE_URL}/api/users/{alice['id']}", headers=admin_h, timeout=15)
        requests.delete(f"{BASE_URL}/api/users/{bob['id']}", headers=admin_h, timeout=15)


def test_module_access_blocks_when_disabled(admin_h, seed):
    """Staff with stock_transfer=false get 403 from the middleware."""
    email = f"nm-{uuid.uuid4().hex[:6]}@xfertest.com"
    u = requests.post(f"{BASE_URL}/api/users",
                      json={"email": email, "password": "n12345", "name": "NoAccess", "role": "staff",
                            "module_access": {"stock_transfer": False}},
                      headers=admin_h, timeout=15).json()
    tok = _login(email, "n12345")["token"]
    try:
        r = requests.get(f"{BASE_URL}/api/transfer-requests", headers=_h(tok), timeout=15)
        assert r.status_code == 403, r.text
    finally:
        requests.delete(f"{BASE_URL}/api/users/{u['id']}", headers=admin_h, timeout=15)
