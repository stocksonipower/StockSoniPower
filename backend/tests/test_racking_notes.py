"""Backend tests for Racking Notes (Stock In tab #2).

Covers: status backfill on receipt-notes, /racking-notes/next-no, /racking-notes/prepare/{rn_id},
POST/PUT/DELETE /racking-notes, POST /racking-notes/{id}/record, and on-record side-effects
(RN status -> RACKED, RN edit/delete blocked, RKN status -> RECORDED).
"""
import os
import re
import pytest
import requests
from datetime import datetime, timezone

BASE_URL = (os.environ.get("REACT_APP_BACKEND_URL") or
            "https://warehouse-ops-65.preview.emergentagent.com").rstrip("/")
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


# ------------------------------------------------------------------
# Receipt Notes status backfill + filter
# ------------------------------------------------------------------
class TestReceiptNoteStatus:
    def test_all_existing_rns_have_status(self, client):
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"page": 1, "page_size": 5000}).json()
        assert isinstance(rows, list)
        for r in rows:
            assert r.get("status") in ("RACKING_PENDING", "RACKED"), \
                f"RN {r.get('rn_no')} has unexpected status {r.get('status')}"

    def test_filter_by_status_racking_pending(self, client):
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"status": "RACKING_PENDING", "page_size": 5000}).json()
        assert isinstance(rows, list)
        for r in rows:
            assert r.get("status") == "RACKING_PENDING"


# ------------------------------------------------------------------
# Helper: pick or create a RACKING_PENDING receipt note
# ------------------------------------------------------------------
def _pick_loc_with_box(client):
    """Pick a (godown, rack, box) trio where rack has at least one box."""
    gds = client.get(f"{BASE_URL}/api/godowns").json()
    for g in gds:
        racks = client.get(f"{BASE_URL}/api/racks", params={"godown_id": g["id"]}).json()
        for rk in racks:
            boxes = client.get(f"{BASE_URL}/api/boxes", params={"rack_id": rk["id"]}).json()
            if boxes:
                return g, rk, boxes[0]
    raise AssertionError("No (godown, rack, box) combination found in DB to seed test")


def _pick_pending_rn(client):
    rows = client.get(f"{BASE_URL}/api/receipt-notes",
                      params={"status": "RACKING_PENDING", "page_size": 5000}).json()
    if rows:
        return rows[0]
    # Create one as fallback
    payload = {
        "invoice_no": "TEST_RKN_AUTO_INV",
        "invoice_date": "2026-04-25",
        "items": [{"part_no": "4093678", "make": "CSP", "quantity": 4}],
    }
    r = client.post(f"{BASE_URL}/api/receipt-notes", json=payload)
    assert r.status_code == 200, r.text
    return r.json()


# ------------------------------------------------------------------
# next-no for racking notes
# ------------------------------------------------------------------
class TestRackingNoteNextNo:
    def test_next_no_format_and_max_plus_one(self, client):
        fy = _fy_label_now()
        rows = client.get(f"{BASE_URL}/api/racking-notes",
                          params={"page_size": 5000}).json()
        same_fy = [r for r in rows if r.get("fy") == fy]
        max_serial = max([r.get("serial", 0) for r in same_fy], default=0)
        r = client.get(f"{BASE_URL}/api/racking-notes/next-no")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["fy"] == fy
        assert d["next_serial"] == max_serial + 1
        assert re.match(rf"^RKN/{re.escape(fy)}/\d{{3}}$", d["next_rkn_no"])


# ------------------------------------------------------------------
# prepare endpoint
# ------------------------------------------------------------------
class TestRackingNotePrepare:
    def test_prepare_returns_master_fields_and_locations(self, client):
        rn = _pick_pending_rn(client)
        r = client.get(f"{BASE_URL}/api/racking-notes/prepare/{rn['id']}")
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["receipt_note"]["id"] == rn["id"]
        assert d["receipt_note"]["rn_no"] == rn["rn_no"]
        assert isinstance(d["items"], list)
        assert len(d["items"]) == len(rn["items"])
        for it in d["items"]:
            for k in ("part_no", "make", "quantity", "model", "description_1",
                      "godown_id", "rack_id", "box_id", "existing_locations"):
                assert k in it, f"prepare item missing key: {k}"
            assert isinstance(it["existing_locations"], list)
            # Prefill rule: if exactly 1 location, godown_id must be set
            if len(it["existing_locations"]) == 1:
                assert it["godown_id"] == it["existing_locations"][0]["godown_id"]
                assert it["rack_id"] == it["existing_locations"][0]["rack_id"]
                assert it["box_id"] == it["existing_locations"][0]["box_id"]
            elif len(it["existing_locations"]) == 0:
                assert it["godown_id"] == "" and it["rack_id"] == "" and it["box_id"] == ""

    def test_prepare_404_for_unknown_rn(self, client):
        r = client.get(f"{BASE_URL}/api/racking-notes/prepare/does-not-exist-xyz")
        assert r.status_code == 404


# ------------------------------------------------------------------
# Full create -> validation -> record flow
# ------------------------------------------------------------------
class TestRackingNoteCRUDAndRecord:
    state = {}

    def _items_for_rn(self, client, rn):
        prep = client.get(f"{BASE_URL}/api/racking-notes/prepare/{rn['id']}").json()
        items = []
        for it in prep["items"]:
            payload_item = dict(it)
            payload_item.pop("existing_locations", None)
            # If location is empty (new part), we must pick a real godown/rack/box
            if not payload_item.get("godown_id"):
                g, rack, box = _pick_loc_with_box(client)
                payload_item.update({
                    "godown_id": g["id"], "godown_name": g.get("godown_name", ""),
                    "rack_id": rack["id"], "rack_no": rack.get("rack_no", ""),
                    "box_id": box["id"], "box_no": box.get("box_no", ""),
                    "box_category": box.get("box_category", ""),
                })
            items.append(payload_item)
        return items, prep["receipt_note"]

    def test_post_validation_missing_rn(self, client):
        r = client.post(f"{BASE_URL}/api/racking-notes", json={
            "receipt_note_id": "does-not-exist-rn", "items": []
        })
        # 400 either because RN not found or items empty
        assert r.status_code in (400, 422), r.text

    def test_post_validation_missing_location(self, client):
        rn = _pick_pending_rn(client)
        r = client.post(f"{BASE_URL}/api/racking-notes", json={
            "receipt_note_id": rn["id"],
            "items": [{
                "part_no": rn["items"][0]["part_no"],
                "make": rn["items"][0]["make"],
                "quantity": rn["items"][0]["quantity"],
                "godown_id": "", "rack_id": "", "box_id": "",
            }],
        })
        assert r.status_code == 400, r.text
        assert "Godown" in r.text or "location" in r.text.lower() or "required" in r.text.lower()

    def test_create_then_duplicate_blocked(self, client):
        rn = _pick_pending_rn(client)
        items, _ = self._items_for_rn(client, rn)

        # Cleanup any leftover RKN for this rn from a previous run
        existing = client.get(f"{BASE_URL}/api/racking-notes",
                              params={"page_size": 5000}).json()
        for e in existing:
            if e.get("receipt_note_id") == rn["id"] and e.get("status") == "DRAFT":
                client.delete(f"{BASE_URL}/api/racking-notes/{e['id']}")

        r = client.post(f"{BASE_URL}/api/racking-notes", json={
            "receipt_note_id": rn["id"], "items": items,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "DRAFT"
        assert d["receipt_note_id"] == rn["id"]
        assert d["receipt_note_no"] == rn["rn_no"]
        assert re.match(r"^RKN/\d{2}-\d{2}/\d{3}$", d["rkn_no"])
        assert len(d["items"]) == len(items)
        assert "_id" not in d
        TestRackingNoteCRUDAndRecord.state["rkn_id"] = d["id"]
        TestRackingNoteCRUDAndRecord.state["rkn_no"] = d["rkn_no"]
        TestRackingNoteCRUDAndRecord.state["rn_id"] = rn["id"]
        TestRackingNoteCRUDAndRecord.state["rn_no"] = rn["rn_no"]
        TestRackingNoteCRUDAndRecord.state["items_count"] = len(items)

        # Duplicate should be blocked with 409
        r2 = client.post(f"{BASE_URL}/api/racking-notes", json={
            "receipt_note_id": rn["id"], "items": items,
        })
        assert r2.status_code == 409, r2.text

    def test_get_list_and_detail(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        assert rkn_id
        rows = client.get(f"{BASE_URL}/api/racking-notes",
                          params={"page_size": 5000}).json()
        assert any(r["id"] == rkn_id for r in rows)
        d = client.get(f"{BASE_URL}/api/racking-notes/{rkn_id}").json()
        assert d["id"] == rkn_id
        assert "_id" not in d

    def test_put_updates_items(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        assert rkn_id
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        # Re-prepare to get fresh items
        prep = client.get(f"{BASE_URL}/api/racking-notes/prepare/{rn_id}").json()
        items = []
        for it in prep["items"]:
            it = dict(it); it.pop("existing_locations", None)
            if not it.get("godown_id"):
                g, rk, bx = _pick_loc_with_box(client)
                it.update({
                    "godown_id": g["id"], "godown_name": g.get("godown_name", ""),
                    "rack_id": rk["id"], "rack_no": rk.get("rack_no", ""),
                    "box_id": bx["id"], "box_no": bx.get("box_no", ""),
                    "box_category": bx.get("box_category", ""),
                })
            items.append(it)
        # Bump quantity on first item
        items[0]["quantity"] = items[0]["quantity"] + 1
        r = client.put(f"{BASE_URL}/api/racking-notes/{rkn_id}", json={
            "receipt_note_id": rn_id, "items": items,
        })
        assert r.status_code == 200, r.text
        assert r.json()["items"][0]["quantity"] == items[0]["quantity"]

    def test_record_creates_in_transactions_and_flips_statuses(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        assert rkn_id

        # Capture transaction count before
        before = client.get(f"{BASE_URL}/api/transactions",
                            params={"page_size": 5000}).json()
        before_count = len([t for t in before if t.get("racking_note_id") == rkn_id])

        r = client.post(f"{BASE_URL}/api/racking-notes/{rkn_id}/record")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["transactions_created"] == TestRackingNoteCRUDAndRecord.state["items_count"]

        # RKN status flipped
        rkn = client.get(f"{BASE_URL}/api/racking-notes/{rkn_id}").json()
        assert rkn["status"] == "RECORDED"
        assert rkn.get("recorded_at")

        # RN status flipped
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{rn_id}").json()
        assert rn["status"] == "RACKED"
        assert rn.get("racked_at")

        # Transactions exist
        after = client.get(f"{BASE_URL}/api/transactions", params={"page_size": 5000}).json()
        related = [t for t in after if t.get("racking_note_id") == rkn_id]
        assert len(related) == TestRackingNoteCRUDAndRecord.state["items_count"]
        for tx in related:
            assert tx["type"] == "IN"
            assert tx["receipt_note_id"] == rn_id
            assert tx.get("godown_id") and tx.get("rack_id") and tx.get("box_id")

    def test_record_again_blocked(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        r = client.post(f"{BASE_URL}/api/racking-notes/{rkn_id}/record")
        assert r.status_code == 409

    def test_put_blocked_after_record(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        # Doesn't matter what we send — should be 409
        r = client.put(f"{BASE_URL}/api/racking-notes/{rkn_id}", json={
            "receipt_note_id": rn_id, "items": [],
        })
        assert r.status_code == 409

    def test_delete_blocked_after_record(self, client):
        rkn_id = TestRackingNoteCRUDAndRecord.state.get("rkn_id")
        r = client.delete(f"{BASE_URL}/api/racking-notes/{rkn_id}")
        assert r.status_code == 409

    def test_rn_edit_blocked_after_record(self, client):
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        rn = client.get(f"{BASE_URL}/api/receipt-notes/{rn_id}").json()
        r = client.put(f"{BASE_URL}/api/receipt-notes/{rn_id}", json={
            "invoice_no": rn.get("invoice_no", "X"),
            "invoice_date": rn.get("invoice_date", "2026-04-25"),
            "items": rn.get("items", []),
        })
        assert r.status_code == 409, r.text

    def test_rn_delete_blocked_when_racked(self, client):
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        r = client.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}")
        assert r.status_code == 409, r.text

    def test_rn_no_longer_in_pending_filter(self, client):
        rn_id = TestRackingNoteCRUDAndRecord.state["rn_id"]
        rows = client.get(f"{BASE_URL}/api/receipt-notes",
                          params={"status": "RACKING_PENDING", "page_size": 5000}).json()
        assert all(r["id"] != rn_id for r in rows)


# ------------------------------------------------------------------
# Negative: deleting RN with RKN attached blocked
# ------------------------------------------------------------------
class TestRnDeleteBlockedByDraftRkn:
    def test_block_rn_delete_when_draft_rkn_exists(self, client):
        # create a brand-new RN, then a DRAFT RKN against it, then try to delete the RN
        rn_payload = {
            "invoice_no": "TEST_RKN_BLOCK_DEL",
            "invoice_date": "2026-04-25",
            "items": [{"part_no": "4093678", "make": "CSP", "quantity": 2}],
        }
        rn = client.post(f"{BASE_URL}/api/receipt-notes", json=rn_payload).json()
        rn_id = rn["id"]

        # Build RKN items with real location
        gd, rk, bx = _pick_loc_with_box(client)
        rkn_items = [{
            "part_no": "4093678", "make": "CSP", "quantity": 2,
            "godown_id": gd["id"], "godown_name": gd.get("godown_name", ""),
            "rack_id": rk["id"], "rack_no": rk.get("rack_no", ""),
            "box_id": bx["id"], "box_no": bx.get("box_no", ""),
            "box_category": bx.get("box_category", ""),
        }]
        rkn = client.post(f"{BASE_URL}/api/racking-notes", json={
            "receipt_note_id": rn_id, "items": rkn_items,
        })
        assert rkn.status_code == 200, rkn.text
        rkn_id = rkn.json()["id"]

        # RN delete must be blocked
        d = client.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}")
        assert d.status_code == 409, d.text

        # cleanup: delete RKN draft, then RN
        c1 = client.delete(f"{BASE_URL}/api/racking-notes/{rkn_id}")
        assert c1.status_code in (200, 204)
        c2 = client.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}")
        assert c2.status_code in (200, 204)
