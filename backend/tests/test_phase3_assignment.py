"""Backend tests for Phase 3 — Workflow Assignment Gating."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://asset-ledger-15.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


def _login(email, password):
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=15,
    )
    if r.status_code != 200:
        pytest.skip(f"Auth failed for {email}: {r.status_code} {r.text}")
    return r.json()


@pytest.fixture(scope="module")
def admin():
    return _login(ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def admin_h(admin):
    return {"Authorization": f"Bearer {admin['token']}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def alice(admin_h):
    """Provision a staff user 'alice'."""
    email = f"alice-{uuid.uuid4().hex[:6]}@phase3test.com"
    pw = "alice12345"
    r = requests.post(
        f"{BASE_URL}/api/users",
        json={"email": email, "password": pw, "name": "Alice", "role": "staff"},
        headers=admin_h,
        timeout=15,
    )
    assert r.status_code == 200, r.text
    user = r.json()
    login = _login(email, pw)
    yield {"user": user, "token": login["token"], "email": email, "password": pw, "id": user["id"]}
    # cleanup
    requests.delete(f"{BASE_URL}/api/users/{user['id']}", headers=admin_h, timeout=15)


@pytest.fixture(scope="module")
def bob(admin_h):
    email = f"bob-{uuid.uuid4().hex[:6]}@phase3test.com"
    pw = "bob12345"
    r = requests.post(
        f"{BASE_URL}/api/users",
        json={"email": email, "password": pw, "name": "Bob", "role": "staff"},
        headers=admin_h,
        timeout=15,
    )
    assert r.status_code == 200, r.text
    user = r.json()
    login = _login(email, pw)
    yield {"user": user, "token": login["token"], "id": user["id"]}
    requests.delete(f"{BASE_URL}/api/users/{user['id']}", headers=admin_h, timeout=15)


@pytest.fixture(scope="module")
def seed_master(admin_h):
    """Seed a stock master row & a single godown/rack so we have qty/locations to play with."""
    part = f"P3-{uuid.uuid4().hex[:6]}"
    make = "PHASE3"
    r = requests.post(
        f"{BASE_URL}/api/stock-master",
        json={"part_no": part, "make": make, "description_1": "phase3"},
        headers=admin_h,
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return {"part_no": part, "make": make, "id": r.json()["id"]}


def _h(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# --- Assignable list ---
def test_assignable_users_endpoint(admin_h, alice):
    r = requests.get(f"{BASE_URL}/api/users/assignable", headers=admin_h, timeout=15)
    assert r.status_code == 200
    ids = [u["id"] for u in r.json()]
    assert alice["id"] in ids


def test_assignable_users_module_filter(admin_h, alice):
    # Disable stock_in for alice
    requests.put(
        f"{BASE_URL}/api/users/{alice['id']}",
        json={"module_access": {"stock_in": False}},
        headers=admin_h, timeout=15,
    )
    try:
        r = requests.get(
            f"{BASE_URL}/api/users/assignable?module=stock_in",
            headers=admin_h, timeout=15,
        )
        assert r.status_code == 200
        ids = [u["id"] for u in r.json()]
        assert alice["id"] not in ids, "alice should be excluded from stock_in assignable list"
    finally:
        # Re-enable so subsequent tests work
        requests.put(
            f"{BASE_URL}/api/users/{alice['id']}",
            json={"module_access": {"stock_in": True, "stock_out": True}},
            headers=admin_h, timeout=15,
        )


# --- Receipt Note assignment ---
def test_receipt_note_create_with_assignee(admin_h, alice, seed_master):
    payload = {
        "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 5}],
        "assigned_to_user_id": alice["id"],
    }
    r = requests.post(f"{BASE_URL}/api/receipt-notes", json=payload, headers=admin_h, timeout=15)
    assert r.status_code == 200, r.text
    rn = r.json()
    assert rn["assigned_to_user_id"] == alice["id"]
    assert rn["assigned_to_name"] == "Alice"
    requests.delete(f"{BASE_URL}/api/receipt-notes/{rn['id']}", headers=admin_h, timeout=15)


def test_receipt_note_assignment_blocks_other_staff(admin_h, alice, bob, seed_master):
    payload = {
        "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 5}],
        "assigned_to_user_id": alice["id"],
    }
    r = requests.post(f"{BASE_URL}/api/receipt-notes", json=payload, headers=admin_h, timeout=15)
    rn_id = r.json()["id"]
    try:
        # Bob tries to update -> 403
        upd = requests.put(
            f"{BASE_URL}/api/receipt-notes/{rn_id}",
            json={
                "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 9}],
                "assigned_to_user_id": alice["id"],
            },
            headers=_h(bob["token"]), timeout=15,
        )
        assert upd.status_code == 403, upd.text
        assert "assigned" in upd.json()["detail"].lower()

        # Bob tries to delete -> 403
        d = requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=_h(bob["token"]), timeout=15)
        assert d.status_code == 403, d.text

        # Alice can edit
        upd2 = requests.put(
            f"{BASE_URL}/api/receipt-notes/{rn_id}",
            json={
                "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 7}],
                "assigned_to_user_id": alice["id"],
            },
            headers=_h(alice["token"]), timeout=15,
        )
        assert upd2.status_code == 200, upd2.text
    finally:
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=admin_h, timeout=15)


def test_receipt_note_unassigned_allows_anyone(admin_h, bob, seed_master):
    """When unassigned, any staff with module access can edit/delete."""
    payload = {
        "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 3}],
    }
    r = requests.post(f"{BASE_URL}/api/receipt-notes", json=payload, headers=admin_h, timeout=15)
    rn_id = r.json()["id"]
    try:
        upd = requests.put(
            f"{BASE_URL}/api/receipt-notes/{rn_id}",
            json={"items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 4}]},
            headers=_h(bob["token"]), timeout=15,
        )
        assert upd.status_code == 200, upd.text
    finally:
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=admin_h, timeout=15)


def test_receipt_note_admin_bypass(admin_h, alice, seed_master):
    """Admin can act on any note regardless of assignee."""
    payload = {
        "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 2}],
        "assigned_to_user_id": alice["id"],
    }
    r = requests.post(f"{BASE_URL}/api/receipt-notes", json=payload, headers=admin_h, timeout=15)
    rn_id = r.json()["id"]
    upd = requests.put(
        f"{BASE_URL}/api/receipt-notes/{rn_id}",
        json={
            "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 6}],
            "assigned_to_user_id": alice["id"],
        },
        headers=admin_h, timeout=15,
    )
    assert upd.status_code == 200, upd.text
    d = requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=admin_h, timeout=15)
    assert d.status_code == 200, d.text


def test_receipt_note_assignee_invalid_user(admin_h, seed_master):
    payload = {
        "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 1}],
        "assigned_to_user_id": "non-existent-user-id-xyz",
    }
    r = requests.post(f"{BASE_URL}/api/receipt-notes", json=payload, headers=admin_h, timeout=15)
    assert r.status_code == 400
    assert "not found" in r.json()["detail"].lower()


# --- Issue Note assignment ---
def test_issue_note_assignment_blocks_other_staff(admin_h, alice, bob, seed_master):
    # First seed some inventory so we can issue. Create RN + RKN flow under admin.
    rn = requests.post(
        f"{BASE_URL}/api/receipt-notes",
        json={"items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 20}]},
        headers=admin_h, timeout=15,
    ).json()
    g = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"G-{uuid.uuid4().hex[:4]}"}, headers=admin_h, timeout=15).json()
    rk = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g["id"], "rack_no": "R1"}, headers=admin_h, timeout=15).json()
    rkn = requests.post(
        f"{BASE_URL}/api/racking-notes",
        json={
            "receipt_note_id": rn["id"],
            "items": [{
                "part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 20,
                "godown_id": g["id"], "godown_name": g["godown_name"],
                "rack_id": rk["id"], "rack_no": rk["rack_no"],
                "box_id": "", "box_no": "",
            }],
        },
        headers=admin_h, timeout=15,
    )
    assert rkn.status_code == 200, rkn.text
    rec = requests.post(f"{BASE_URL}/api/racking-notes/{rkn.json()['id']}/record", headers=admin_h, timeout=15)
    assert rec.status_code == 200, rec.text

    # Now create issue note assigned to Alice
    inn = requests.post(
        f"{BASE_URL}/api/issue-notes",
        json={
            "issued_to": "Workshop",
            "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 5}],
            "assigned_to_user_id": alice["id"],
        },
        headers=admin_h, timeout=15,
    )
    assert inn.status_code == 200, inn.text
    inn_doc = inn.json()
    assert inn_doc["assigned_to_user_id"] == alice["id"]

    try:
        # Bob tries to delete -> 403
        d = requests.delete(f"{BASE_URL}/api/issue-notes/{inn_doc['id']}", headers=_h(bob["token"]), timeout=15)
        assert d.status_code == 403, d.text
        # Alice can edit
        upd = requests.put(
            f"{BASE_URL}/api/issue-notes/{inn_doc['id']}",
            json={
                "issued_to": "Workshop2",
                "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 6}],
                "assigned_to_user_id": alice["id"],
            },
            headers=_h(alice["token"]), timeout=15,
        )
        assert upd.status_code == 200, upd.text
    finally:
        requests.delete(f"{BASE_URL}/api/issue-notes/{inn_doc['id']}", headers=admin_h, timeout=15)


# --- Picking note enforcement (uses Issue Note assignment) ---
def test_picking_note_blocked_for_other_when_in_assigned(admin_h, alice, bob, seed_master):
    # Seed inventory (reuse pattern but isolated)
    rn = requests.post(
        f"{BASE_URL}/api/receipt-notes",
        json={"items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 30}]},
        headers=admin_h, timeout=15,
    ).json()
    g = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"G-{uuid.uuid4().hex[:4]}"}, headers=admin_h, timeout=15).json()
    rk = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g["id"], "rack_no": "R1"}, headers=admin_h, timeout=15).json()
    rkn = requests.post(
        f"{BASE_URL}/api/racking-notes",
        json={
            "receipt_note_id": rn["id"],
            "items": [{
                "part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 30,
                "godown_id": g["id"], "godown_name": g["godown_name"],
                "rack_id": rk["id"], "rack_no": rk["rack_no"],
                "box_id": "", "box_no": "",
            }],
        },
        headers=admin_h, timeout=15,
    ).json()
    requests.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record", headers=admin_h, timeout=15)

    # Issue Note assigned to alice
    inn = requests.post(
        f"{BASE_URL}/api/issue-notes",
        json={
            "issued_to": "Lab",
            "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 4}],
            "assigned_to_user_id": alice["id"],
        },
        headers=admin_h, timeout=15,
    ).json()

    pick_payload = {
        "issue_note_id": inn["id"],
        "items": [{
            "part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 4,
            "godown_id": g["id"], "godown_name": g["godown_name"],
            "rack_id": rk["id"], "rack_no": rk["rack_no"],
            "box_id": "", "box_no": "",
        }],
    }

    try:
        # Bob blocked
        rb = requests.post(f"{BASE_URL}/api/picking-notes", json=pick_payload, headers=_h(bob["token"]), timeout=15)
        assert rb.status_code == 403, rb.text

        # Alice succeeds
        ra = requests.post(f"{BASE_URL}/api/picking-notes", json=pick_payload, headers=_h(alice["token"]), timeout=15)
        assert ra.status_code == 200, ra.text
        pn_id = ra.json()["id"]

        # Bob can't record either
        rec_bob = requests.post(f"{BASE_URL}/api/picking-notes/{pn_id}/record", headers=_h(bob["token"]), timeout=15)
        assert rec_bob.status_code == 403, rec_bob.text

        # Alice records OK
        rec_alice = requests.post(f"{BASE_URL}/api/picking-notes/{pn_id}/record", headers=_h(alice["token"]), timeout=15)
        assert rec_alice.status_code == 200, rec_alice.text
    finally:
        requests.delete(f"{BASE_URL}/api/issue-notes/{inn['id']}", headers=admin_h, timeout=15)


# --- Racking note inherits Receipt Note assignment ---
def test_racking_note_blocked_for_other_when_rn_assigned(admin_h, alice, bob, seed_master):
    rn = requests.post(
        f"{BASE_URL}/api/receipt-notes",
        json={
            "items": [{"part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 10}],
            "assigned_to_user_id": alice["id"],
        },
        headers=admin_h, timeout=15,
    ).json()
    g = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"G-{uuid.uuid4().hex[:4]}"}, headers=admin_h, timeout=15).json()
    rk = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g["id"], "rack_no": "R1"}, headers=admin_h, timeout=15).json()

    payload = {
        "receipt_note_id": rn["id"],
        "items": [{
            "part_no": seed_master["part_no"], "make": seed_master["make"], "quantity": 10,
            "godown_id": g["id"], "godown_name": g["godown_name"],
            "rack_id": rk["id"], "rack_no": rk["rack_no"],
            "box_id": "", "box_no": "",
        }],
    }
    try:
        # Bob blocked
        rb = requests.post(f"{BASE_URL}/api/racking-notes", json=payload, headers=_h(bob["token"]), timeout=15)
        assert rb.status_code == 403, rb.text
        # Alice succeeds
        ra = requests.post(f"{BASE_URL}/api/racking-notes", json=payload, headers=_h(alice["token"]), timeout=15)
        assert ra.status_code == 200, ra.text
        rkn_id = ra.json()["id"]
        # Listing returns parent_assigned_to_*
        lst = requests.get(f"{BASE_URL}/api/racking-notes", headers=admin_h, timeout=15).json()
        row = next((x for x in lst if x["id"] == rkn_id), None)
        assert row is not None
        assert row.get("parent_assigned_to_user_id") == alice["id"]
        assert row.get("parent_assigned_to_name") == "Alice"
    finally:
        # Cleanup chain: must delete RKN before RN
        try:
            for rkn in requests.get(f"{BASE_URL}/api/racking-notes", headers=admin_h, timeout=15).json():
                if rkn.get("receipt_note_id") == rn["id"]:
                    requests.delete(f"{BASE_URL}/api/racking-notes/{rkn['id']}", headers=admin_h, timeout=15)
        except Exception:
            pass
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn['id']}", headers=admin_h, timeout=15)
