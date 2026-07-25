"""End-to-end backend tests for the new Stock Out flow (Issue Notes + Picking Notes).
Mirrors the receipt + racking notes pattern. Uses the live admin user and any existing
stock balances to create a fresh seed Issue Note then drives the full lifecycle:
  - validation (missing items, qty <=0)
  - cumulative & per-location picking constraints
  - prepare endpoint (pending_qty, available_qty, exclude_pn_id)
  - status transitions PICKING_PENDING -> PARTIALLY_PICKED -> FULLY_PICKED
  - delete reverts status, edit blocked when any PN exists, /record creates OUT txns
"""
import os
import pytest
import requests
import uuid

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://inventory-ops-dash.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    token = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {token}"})
    return s


@pytest.fixture(scope="module")
def seed(client):
    """Find an in-stock part with reasonable qty to drive the picking flow.
    Returns dict with part_no, make, total qty, and the first location dict.
    """
    # Use one part summary endpoint or transactions. _stock_locations_for is internal —
    # we query the public stock-summary endpoint which most stock-mgmt apps expose.
    # Fallback: use transactions list and aggregate client-side.
    tx = client.get(f"{API}/transactions?page=1&page_size=5000").json()
    if isinstance(tx, dict):
        tx = tx.get("items") or tx.get("data") or []
    bal = {}
    for t in tx:
        k = (t.get("part_no", ""), t.get("make", ""), t.get("box_id", ""))
        sign = 1 if t.get("type") == "IN" else -1
        bal[k] = bal.get(k, 0) + sign * (t.get("quantity") or 0)
        # capture loc context
        bal.setdefault(("__loc__", *k[:2], k[2]), {
            "godown_id": t.get("godown_id"), "godown_name": t.get("godown_name"),
            "rack_id": t.get("rack_id"), "rack_no": t.get("rack_no"),
            "box_id": t.get("box_id"), "box_no": t.get("box_no"),
        })
    # pick first part with at least 4 available at one location
    chosen = None
    for k, qty in bal.items():
        if k and isinstance(k, tuple) and k[0] != "__loc__" and qty >= 4:
            loc = bal.get(("__loc__", k[0], k[1], k[2]))
            if loc and loc.get("box_id"):
                chosen = {"part_no": k[0], "make": k[1], "qty": qty, "loc": loc}
                break
    assert chosen, "No suitable part with >=4 stock at a boxed location"
    return chosen


# ===================== ISSUE NOTE BASIC =====================
class TestIssueNoteCreate:
    def test_next_no_format(self, client):
        r = client.get(f"{API}/issue-notes/next-no")
        assert r.status_code == 200
        data = r.json()
        assert data["next_in_no"].startswith("IN/")
        assert data["next_in_no"].split("/")[2].isdigit()

    def test_post_requires_items(self, client):
        r = client.post(f"{API}/issue-notes", json={"items": []})
        assert r.status_code == 400

    def test_post_qty_must_be_positive(self, client, seed):
        r = client.post(f"{API}/issue-notes", json={
            "items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 0}],
        })
        assert r.status_code == 400


# ===================== FULL FLOW =====================
@pytest.fixture(scope="module")
def fresh_in(client, seed):
    # create IN with qty=4 (split-able into 2+2 across PNs)
    r = client.post(f"{API}/issue-notes", json={
        "items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 4}],
    })
    assert r.status_code == 200, r.text
    inn = r.json()
    assert inn["status"] == "PICKING_PENDING"
    assert inn["in_no"].startswith("IN/")
    yield inn
    # teardown — delete any PNs first then IN
    pns = client.get(f"{API}/picking-notes").json()
    for pn in pns:
        if pn.get("issue_note_id") == inn["id"] and pn.get("status") == "DRAFT":
            client.delete(f"{API}/picking-notes/{pn['id']}")
    client.delete(f"{API}/issue-notes/{inn['id']}")


class TestPrepareEndpoint:
    def test_prepare_returns_items(self, client, fresh_in, seed):
        r = client.get(f"{API}/picking-notes/prepare/{fresh_in['id']}")
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["issue_note"]["in_no"] == fresh_in["in_no"]
        assert len(data["items"]) >= 1
        item = next(i for i in data["items"] if i["part_no"] == seed["part_no"])
        assert item["requested_qty"] == 4
        assert item["already_picked_qty"] == 0
        assert item["pending_qty"] == 4
        assert any(L.get("available_qty", 0) > 0 for L in item["available_locations"])
        # available_qty <= current_qty
        for L in item["available_locations"]:
            assert L["available_qty"] <= L["current_qty"]


class TestPickingNoteFlow:
    def test_partial_pick_flips_in_to_partially_picked(self, client, fresh_in, seed):
        loc = seed["loc"]
        r = client.post(f"{API}/picking-notes", json={
            "issue_note_id": fresh_in["id"],
            "items": [{
                "part_no": seed["part_no"], "make": seed["make"], "quantity": 2,
                "godown_id": loc["godown_id"], "godown_name": loc["godown_name"],
                "rack_id": loc["rack_id"], "rack_no": loc["rack_no"],
                "box_id": loc["box_id"], "box_no": loc["box_no"],
            }],
        })
        assert r.status_code == 200, r.text
        pn1 = r.json()
        assert pn1["status"] == "DRAFT"
        # IN status flips
        inn = client.get(f"{API}/issue-notes/{fresh_in['id']}").json()
        assert inn["status"] == "PARTIALLY_PICKED"
        # store on fresh_in for downstream tests
        fresh_in["_pn1_id"] = pn1["id"]

    def test_cumulative_overalloc_blocked(self, client, fresh_in, seed):
        """Existing PN1 has 2 picked. Try a PN2 with qty=3 -> 2+3>4 should 400."""
        loc = seed["loc"]
        r = client.post(f"{API}/picking-notes", json={
            "issue_note_id": fresh_in["id"],
            "items": [{
                "part_no": seed["part_no"], "make": seed["make"], "quantity": 3,
                "godown_id": loc["godown_id"], "godown_name": loc["godown_name"],
                "rack_id": loc["rack_id"], "rack_no": loc["rack_no"],
                "box_id": loc["box_id"], "box_no": loc["box_no"],
            }],
        })
        assert r.status_code == 400, r.text
        assert seed["part_no"] in r.json().get("detail", "")

    def test_prepare_with_exclude_pn_id_restores_pending(self, client, fresh_in, seed):
        pn1_id = fresh_in["_pn1_id"]
        r = client.get(f"{API}/picking-notes/prepare/{fresh_in['id']}?exclude_pn_id={pn1_id}")
        assert r.status_code == 200
        item = next(i for i in r.json()["items"] if i["part_no"] == seed["part_no"])
        # pending should be 4 again because PN1's 2 is excluded
        assert item["pending_qty"] == 4
        assert item["already_picked_qty"] == 0

    def test_in_edit_blocked_when_pn_exists(self, client, fresh_in, seed):
        r = client.put(f"{API}/issue-notes/{fresh_in['id']}", json={
            "items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 5}],
        })
        assert r.status_code == 409

    def test_in_delete_blocked_when_pn_exists(self, client, fresh_in):
        r = client.delete(f"{API}/issue-notes/{fresh_in['id']}")
        assert r.status_code == 409

    def test_put_picking_note_excludes_self(self, client, fresh_in, seed):
        """Edit PN1 to qty=4 (full IN) — should succeed because self is excluded."""
        loc = seed["loc"]
        pn1_id = fresh_in["_pn1_id"]
        r = client.put(f"{API}/picking-notes/{pn1_id}", json={
            "issue_note_id": fresh_in["id"],
            "items": [{
                "part_no": seed["part_no"], "make": seed["make"], "quantity": 4,
                "godown_id": loc["godown_id"], "godown_name": loc["godown_name"],
                "rack_id": loc["rack_id"], "rack_no": loc["rack_no"],
                "box_id": loc["box_id"], "box_no": loc["box_no"],
            }],
        })
        assert r.status_code == 200, r.text
        # IN should now be FULLY_PICKED
        inn = client.get(f"{API}/issue-notes/{fresh_in['id']}").json()
        assert inn["status"] == "FULLY_PICKED"

    def test_post_blocked_after_fully_picked(self, client, fresh_in, seed):
        loc = seed["loc"]
        r = client.post(f"{API}/picking-notes", json={
            "issue_note_id": fresh_in["id"],
            "items": [{
                "part_no": seed["part_no"], "make": seed["make"], "quantity": 1,
                "godown_id": loc["godown_id"], "godown_name": loc["godown_name"],
                "rack_id": loc["rack_id"], "rack_no": loc["rack_no"],
                "box_id": loc["box_id"], "box_no": loc["box_no"],
            }],
        })
        assert r.status_code == 409

    def test_record_creates_out_transactions(self, client, fresh_in, seed):
        pn1_id = fresh_in["_pn1_id"]
        # baseline OUT count for this part
        before = client.get(f"{API}/transactions?page=1&page_size=5000").json()
        if isinstance(before, dict):
            before = before.get("items") or []
        before_out = sum(1 for t in before if t.get("type") == "OUT" and t.get("picking_note_id") == pn1_id)
        r = client.post(f"{API}/picking-notes/{pn1_id}/record")
        assert r.status_code == 200, r.text
        pn = client.get(f"{API}/picking-notes/{pn1_id}").json()
        assert pn["status"] == "RECORDED"
        # verify transaction created
        after = client.get(f"{API}/transactions?page=1&page_size=5000").json()
        if isinstance(after, dict):
            after = after.get("items") or []
        out_for_pn = [t for t in after if t.get("type") == "OUT" and t.get("picking_note_id") == pn1_id]
        assert len(out_for_pn) >= 1
        assert all(t.get("issue_note_no") == fresh_in["in_no"] for t in out_for_pn)
        # IN should remain FULLY_PICKED (record does NOT change IN status)
        inn = client.get(f"{API}/issue-notes/{fresh_in['id']}").json()
        assert inn["status"] == "FULLY_PICKED"

    def test_recorded_pn_cannot_be_deleted(self, client, fresh_in):
        pn1_id = fresh_in["_pn1_id"]
        r = client.delete(f"{API}/picking-notes/{pn1_id}")
        assert r.status_code == 409


# ===================== PER-LOCATION OVER-STOCK =====================
class TestPerLocationConstraint:
    def test_per_location_overpick_blocked(self, client, seed):
        """Try to pick more than available at the chosen location."""
        loc = seed["loc"]
        # find current_qty at this loc via prepare on a fresh IN
        r = client.post(f"{API}/issue-notes", json={
            "items": [{"part_no": seed["part_no"], "make": seed["make"], "quantity": 99999}],
        })
        # If quantity validation rejects we just skip
        if r.status_code != 200:
            pytest.skip("Cannot create huge-qty IN for test")
        in_id = r.json()["id"]
        try:
            prep = client.get(f"{API}/picking-notes/prepare/{in_id}").json()
            item = next(i for i in prep["items"] if i["part_no"] == seed["part_no"])
            target = next((L for L in item["available_locations"] if L.get("box_id") == loc["box_id"]), None)
            assert target, "loc not found in prepare"
            avail = target["available_qty"]
            # try to pick avail+1 at same loc
            r2 = client.post(f"{API}/picking-notes", json={
                "issue_note_id": in_id,
                "items": [{
                    "part_no": seed["part_no"], "make": seed["make"], "quantity": avail + 1,
                    "godown_id": target["godown_id"], "godown_name": target["godown_name"],
                    "rack_id": target["rack_id"], "rack_no": target["rack_no"],
                    "box_id": target["box_id"], "box_no": target["box_no"],
                }],
            })
            assert r2.status_code == 400, r2.text
        finally:
            # cleanup
            client.delete(f"{API}/issue-notes/{in_id}")


# ===================== STATUS FILTER =====================
class TestStatusFilter:
    def test_not_status_filter_excludes_fully_picked(self, client):
        r = client.get(f"{API}/issue-notes?not_status=FULLY_PICKED")
        assert r.status_code == 200
        for n in r.json():
            assert n["status"] != "FULLY_PICKED"
