"""Backend tests for Partial / Multi-Location Racking on Receipt Notes.

Covers (iteration 6 spec):
- Status values: RACKING_PENDING / PARTIALLY_RACKED / FULLY_RACKED (no more RACKED)
- /api/receipt-notes?not_status=FULLY_RACKED filter
- /api/racking-notes/prepare/{rn_id}: pending_qty / already_racked_qty / received_qty;
  items with pending_qty=0 are skipped; ?exclude_rkn_id= for edit mode.
- POST cumulative validation (over-allocation -> 400)
- PUT cumulative validation excludes the RKN being edited
- DELETE frees qty -> RN status recomputes
- /record flips ONLY the RKN status; RN status independent (already PARTIAL or FULLY)
- Multiple RKNs allowed against one RN
- A single item split across multiple location rows in one RKN
- RN edit/delete blocked (409) when ANY RKN exists (DRAFT or RECORDED)
"""
import os
import pytest
import requests

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or
            "https://asset-ledger-15.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


@pytest.fixture(scope="module")
def client():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Auth failed: {r.status_code}")
    token = r.json()["token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


def _two_locs(client):
    """Return two distinct (godown, rack, box) trios."""
    locs = []
    gds = client.get(f"{BASE_URL}/api/godowns").json()
    for g in gds:
        racks = client.get(f"{BASE_URL}/api/racks", params={"godown_id": g["id"]}).json()
        for rk in racks:
            boxes = client.get(f"{BASE_URL}/api/boxes", params={"rack_id": rk["id"]}).json()
            for bx in boxes:
                locs.append((g, rk, bx))
                if len(locs) >= 2:
                    return locs
    if len(locs) < 2:
        pytest.skip("Need at least 2 distinct godown/rack/box combos in DB")
    return locs


def _mk_item(part, make, qty, gd, rk, bx):
    return {
        "part_no": part, "make": make, "quantity": qty,
        "godown_id": gd["id"], "godown_name": gd.get("godown_name", ""),
        "rack_id": rk["id"], "rack_no": rk.get("rack_no", ""),
        "box_id": bx["id"], "box_no": bx.get("box_no", ""),
        "box_category": bx.get("box_category", ""),
    }


@pytest.fixture(scope="module")
def fresh_rn(client):
    """Create a dedicated RN for these tests so we don't mutate seed RNs.
    3 items, qty=10 each — mirrors RN/26-27/004 pattern from the spec."""
    payload = {
        "invoice_no": "TEST_PARTIAL_RKN_INV",
        "invoice_date": "2026-04-25",
        "items": [
            {"part_no": "TEST_PR_A", "make": "CSP", "quantity": 10},
            {"part_no": "TEST_PR_B", "make": "CSP", "quantity": 10},
            {"part_no": "TEST_PR_C", "make": "CSP", "quantity": 10},
        ],
    }
    r = client.post(f"{BASE_URL}/api/receipt-notes", json=payload)
    assert r.status_code == 200, r.text
    rn = r.json()
    yield rn
    # teardown — delete any RKNs first, then RN
    rkns = client.get(f"{BASE_URL}/api/racking-notes", params={"page_size": 5000}).json()
    for r in rkns:
        if r.get("receipt_note_id") == rn["id"]:
            client.delete(f"{BASE_URL}/api/racking-notes/{r['id']}")
    client.delete(f"{BASE_URL}/api/receipt-notes/{rn['id']}")


# ---------------------------------------------------------------
# Status enum migration / filter
# ---------------------------------------------------------------
class TestStatusMigrationAndFilter:
    def test_no_legacy_RACKED_status(self, client):
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"page_size": 5000}).json()
        for r in rows:
            assert r.get("status") in ("RACKING_PENDING", "PARTIALLY_RACKED", "FULLY_RACKED"), \
                f"RN {r.get('rn_no')} has stale status {r.get('status')}"

    def test_not_status_filter(self, client):
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"not_status": "FULLY_RACKED", "page_size": 5000}).json()
        for r in rows:
            assert r.get("status") != "FULLY_RACKED"

    def test_not_status_csv(self, client):
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"not_status": "FULLY_RACKED,PARTIALLY_RACKED",
                                  "page_size": 5000}).json()
        for r in rows:
            assert r.get("status") not in ("FULLY_RACKED", "PARTIALLY_RACKED")


# ---------------------------------------------------------------
# Prepare endpoint pending_qty + skip-zero behavior
# ---------------------------------------------------------------
class TestPrepareEndpoint:
    def test_prepare_returns_pending_received_already_racked(self, client, fresh_rn):
        r = client.get(f"{BASE_URL}/api/racking-notes/prepare/{fresh_rn['id']}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["receipt_note"]["id"] == fresh_rn["id"]
        assert len(d["items"]) == 3
        for it in d["items"]:
            assert "received_qty" in it
            assert "already_racked_qty" in it
            assert "pending_qty" in it
            assert it["received_qty"] == 10
            assert it["already_racked_qty"] == 0
            assert it["pending_qty"] == 10
            # default qty should equal pending_qty
            assert it["quantity"] == it["pending_qty"]


# ---------------------------------------------------------------
# Cumulative POST/PUT/DELETE flow
# ---------------------------------------------------------------
class TestCumulativeRacking:
    state = {}

    def test_a_post_partial_5_of_first_item_flips_to_partial(self, client, fresh_rn):
        gd, rk, bx = _two_locs(client)[0]
        items = [_mk_item("TEST_PR_A", "CSP", 5, gd, rk, bx)]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 200, r.text
        TestCumulativeRacking.state["rkn1_id"] = r.json()["id"]
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        assert rn["status"] == "PARTIALLY_RACKED", rn

    def test_b_prepare_skips_fully_allocated_items(self, client, fresh_rn):
        # Allocate the rest of A (5 more) so A is fully done — should be skipped on prepare
        gd, rk, bx = _two_locs(client)[0]
        items = [_mk_item("TEST_PR_A", "CSP", 5, gd, rk, bx)]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 200, r.text
        TestCumulativeRacking.state["rkn_a_finisher"] = r.json()["id"]
        prep = client.get(f"{BASE_URL}/api/racking-notes/prepare/{fresh_rn['id']}").json()
        parts = [it["part_no"] for it in prep["items"]]
        assert "TEST_PR_A" not in parts, "Fully racked item should be skipped from prepare"
        # B and C must still appear, both pending=10
        for it in prep["items"]:
            assert it["pending_qty"] == 10
            assert it["already_racked_qty"] == 0

    def test_c_post_overallocation_returns_400(self, client, fresh_rn):
        # B already has 0 racked, try to post 11 — over
        gd, rk, bx = _two_locs(client)[0]
        items = [_mk_item("TEST_PR_B", "CSP", 11, gd, rk, bx)]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 400, r.text
        assert "TEST_PR_B" in r.text
        # A is fully racked (10 already used), 6 more triggers cumulative breach
        items = [_mk_item("TEST_PR_A", "CSP", 6, gd, rk, bx)]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 400, r.text
        assert "TEST_PR_A" in r.text

    def test_d_split_single_item_across_two_locations_in_one_rkn(self, client, fresh_rn):
        # B (10 pending) split as 6 + 4 across two distinct locations in ONE RKN
        locs = _two_locs(client)
        gd0, rk0, bx0 = locs[0]
        gd1, rk1, bx1 = locs[1]
        items = [
            _mk_item("TEST_PR_B", "CSP", 6, gd0, rk0, bx0),
            _mk_item("TEST_PR_B", "CSP", 4, gd1, rk1, bx1),
        ]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["items"]) == 2
        TestCumulativeRacking.state["rkn_split_id"] = body["id"]
        # B is now fully racked, A also full, C still pending -> RN PARTIALLY_RACKED
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        assert rn["status"] == "PARTIALLY_RACKED"

    def test_e_put_excludes_self_in_cumulative_validation(self, client, fresh_rn):
        rkn_id = TestCumulativeRacking.state["rkn1_id"]  # holds 5 of A
        gd, rk, bx = _two_locs(client)[0]
        # Other RKNs already used 5 of A (the rkn_a_finisher). Editing rkn1 to 8 -> 8+5>10 -> reject
        items = [_mk_item("TEST_PR_A", "CSP", 8, gd, rk, bx)]
        r = client.put(f"{BASE_URL}/api/racking-notes/{rkn_id}",
                       json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 400, r.text
        # Editing rkn1 to 4 -> 4+5=9 <=10 -> accept
        items = [_mk_item("TEST_PR_A", "CSP", 4, gd, rk, bx)]
        r = client.put(f"{BASE_URL}/api/racking-notes/{rkn_id}",
                       json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 200, r.text
        # Now A has 4+5=9 racked -> not fully -> RN partial
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        assert rn["status"] == "PARTIALLY_RACKED"

    def test_f_prepare_with_exclude_rkn_id(self, client, fresh_rn):
        # In edit mode, prepare must compute pending as if THIS rkn doesn't exist.
        rkn_id = TestCumulativeRacking.state["rkn1_id"]  # currently 4 of A
        prep = client.get(
            f"{BASE_URL}/api/racking-notes/prepare/{fresh_rn['id']}",
            params={"exclude_rkn_id": rkn_id},
        ).json()
        # Without rkn1, A has only 5 used (the finisher) -> pending=5
        a_item = next((it for it in prep["items"] if it["part_no"] == "TEST_PR_A"), None)
        assert a_item is not None, "A must reappear when its rkn is excluded"
        assert a_item["already_racked_qty"] == 5
        assert a_item["pending_qty"] == 5

    def test_g_record_flips_only_rkn_not_rn(self, client, fresh_rn):
        # Record the split RKN — RN should remain PARTIAL because C is still pending
        rkn_id = TestCumulativeRacking.state["rkn_split_id"]
        r = client.post(f"{BASE_URL}/api/racking-notes/{rkn_id}/record")
        assert r.status_code == 200, r.text
        rkn = client.get(f"{BASE_URL}/api/racking-notes/{rkn_id}").json()
        assert rkn["status"] == "RECORDED"
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        # C still has 10 pending -> RN must NOT be FULLY_RACKED on record
        assert rn["status"] == "PARTIALLY_RACKED", rn
        assert rn.get("status") != "RACKED"

    def test_h_rn_edit_delete_blocked_when_any_rkn(self, client, fresh_rn):
        # PUT
        r = client.put(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}", json={
            "invoice_no": "X", "invoice_date": "2026-04-25", "items": fresh_rn["items"],
        })
        assert r.status_code == 409, r.text
        # DELETE
        r = client.delete(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}")
        assert r.status_code == 409

    def test_i_delete_draft_rkn_recomputes_rn_status(self, client, fresh_rn):
        # Delete rkn1 (4 of A, DRAFT). After delete: A=5 used (still partial), B=10 done, C=0 -> RN partial
        rkn_id = TestCumulativeRacking.state["rkn1_id"]
        r = client.delete(f"{BASE_URL}/api/racking-notes/{rkn_id}")
        assert r.status_code in (200, 204)
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        assert rn["status"] == "PARTIALLY_RACKED"

    def test_j_finish_all_then_rn_fully_racked(self, client, fresh_rn):
        # Now fill A back to 5 + C completely (10) -> RN FULLY_RACKED
        gd, rk, bx = _two_locs(client)[0]
        items = [
            _mk_item("TEST_PR_A", "CSP", 5, gd, rk, bx),
            _mk_item("TEST_PR_C", "CSP", 10, gd, rk, bx),
        ]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 200, r.text
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{fresh_rn['id']}").json()
        assert rn["status"] == "FULLY_RACKED"
        assert rn.get("racked_at")
        # not_status filter must now exclude this RN
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"not_status": "FULLY_RACKED", "page_size": 5000}).json()
        assert all(r["id"] != fresh_rn["id"] for r in rows)
        # POST against fully-racked RN -> 409
        items = [_mk_item("TEST_PR_A", "CSP", 1, gd, rk, bx)]
        r = client.post(f"{BASE_URL}/api/racking-notes",
                        json={"receipt_note_id": fresh_rn["id"], "items": items})
        assert r.status_code == 409, r.text
