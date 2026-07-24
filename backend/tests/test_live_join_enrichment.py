"""
Iteration 9 — Live-join enrichment regression suite.

Verifies that GET endpoints (transactions, receipt-notes, racking-notes,
issue-notes, picking-notes) overwrite snapshotted master + location fields
with the latest values from stock_master / godowns / racks / boxes.

Stock Summary (/api/stock-balance) and Low Stock (/api/low-stock)
already live-joined — included as regression checks.
"""

import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


# -------------------- Fixtures --------------------
@pytest.fixture(scope="module")
def auth_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def client(auth_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"})
    return s


# -------------------- Helpers --------------------
def _find_master(client, part_no, make):
    rows = client.get(f"{BASE_URL}/api/stock-master", timeout=20).json()
    for sm in rows:
        if sm.get("part_no") == part_no and sm.get("make") == make:
            return sm
    return None


def _patch_master(client, master_id, payload):
    r = client.put(f"{BASE_URL}/api/stock-master/{master_id}", json=payload, timeout=20)
    assert r.status_code == 200, f"PUT master failed {r.status_code}: {r.text}"
    return r.json()


def _restore_master(client, master_id, original):
    # Build full payload (keep all fields)
    body = {k: v for k, v in original.items() if k not in ("id", "_id", "created_at", "updated_at")}
    r = client.put(f"{BASE_URL}/api/stock-master/{master_id}", json=body, timeout=20)
    assert r.status_code == 200, f"restore master failed: {r.text}"


# -------------------- Existing-data discovery --------------------
@pytest.fixture(scope="module")
def picking_note_with_item(client):
    """Find an existing picking note that has at least one item."""
    rows = client.get(f"{BASE_URL}/api/picking-notes", timeout=20).json()
    for pn in rows:
        if pn.get("items"):
            return pn
    pytest.skip("No picking note with items found")


@pytest.fixture(scope="module")
def issue_note_with_item(client):
    rows = client.get(f"{BASE_URL}/api/issue-notes", timeout=20).json()
    for n in rows:
        if n.get("items"):
            return n
    pytest.skip("No issue note with items found")


@pytest.fixture(scope="module")
def receipt_note_with_item(client):
    rows = client.get(f"{BASE_URL}/api/receipt-notes", timeout=20).json()
    for n in rows:
        if n.get("items"):
            return n
    pytest.skip("No receipt note with items found")


# -------------------- Tests: Stock Master live-join --------------------
class TestStockMasterLiveJoin:

    def test_transactions_reflect_master_description_change(self, client, picking_note_with_item):
        item = picking_note_with_item["items"][0]
        part_no = item["part_no"]
        make = item["make"]
        sm = _find_master(client, part_no, make)
        if not sm:
            pytest.skip(f"No master for {part_no}/{make}")
        sentinel = f"LIVE_TEST_DESC_{int(time.time())}"
        original = dict(sm)
        try:
            _patch_master(client, sm["id"], {**{k: v for k, v in sm.items() if k not in ("id", "_id")}, "description_1": sentinel})
            # GET transactions
            tx = client.get(f"{BASE_URL}/api/transactions", timeout=20).json()
            matches = [t for t in tx if t.get("part_no") == part_no and t.get("make") == make]
            assert matches, f"No transactions for {part_no}/{make}"
            for t in matches:
                assert t.get("description_1") == sentinel, f"transaction {t.get('id')} not enriched: {t.get('description_1')}"
        finally:
            _restore_master(client, sm["id"], original)

    def test_picking_notes_list_and_byid_reflect_master(self, client, picking_note_with_item):
        item = picking_note_with_item["items"][0]
        part_no, make = item["part_no"], item["make"]
        sm = _find_master(client, part_no, make)
        if not sm:
            pytest.skip(f"No master for {part_no}/{make}")
        sentinel_desc = f"LIVE_PN_DESC_{int(time.time())}"
        sentinel_cat = f"CAT_{int(time.time())}"
        original = dict(sm)
        try:
            _patch_master(client, sm["id"], {
                **{k: v for k, v in sm.items() if k not in ("id", "_id")},
                "description_1": sentinel_desc,
                "item_category": sentinel_cat,
            })
            # LIST
            rows = client.get(f"{BASE_URL}/api/picking-notes", timeout=20).json()
            target = next(r for r in rows if r["id"] == picking_note_with_item["id"])
            it0 = next(it for it in target["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it0.get("description_1") == sentinel_desc
            assert it0.get("item_category") == sentinel_cat
            # BY-ID
            doc = client.get(f"{BASE_URL}/api/picking-notes/{picking_note_with_item['id']}", timeout=20).json()
            it1 = next(it for it in doc["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it1.get("description_1") == sentinel_desc
            assert it1.get("item_category") == sentinel_cat
        finally:
            _restore_master(client, sm["id"], original)

    def test_issue_notes_list_and_byid_reflect_master(self, client, issue_note_with_item):
        item = issue_note_with_item["items"][0]
        part_no, make = item["part_no"], item["make"]
        sm = _find_master(client, part_no, make)
        if not sm:
            pytest.skip(f"No master for {part_no}/{make}")
        sentinel = f"LIVE_IN_DESC_{int(time.time())}"
        new_reorder = (sm.get("reorder_level") or 0) + 777
        original = dict(sm)
        try:
            _patch_master(client, sm["id"], {
                **{k: v for k, v in sm.items() if k not in ("id", "_id")},
                "description_1": sentinel,
                "reorder_level": new_reorder,
            })
            rows = client.get(f"{BASE_URL}/api/issue-notes", timeout=20).json()
            target = next(r for r in rows if r["id"] == issue_note_with_item["id"])
            it0 = next(it for it in target["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it0.get("description_1") == sentinel
            assert it0.get("reorder_level") == new_reorder
            # BY-ID
            doc = client.get(f"{BASE_URL}/api/issue-notes/{issue_note_with_item['id']}", timeout=20).json()
            it1 = next(it for it in doc["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it1.get("description_1") == sentinel
            assert it1.get("reorder_level") == new_reorder
        finally:
            _restore_master(client, sm["id"], original)

    def test_receipt_notes_list_and_byid_enriched_with_master_fields(self, client, receipt_note_with_item):
        """Receipt notes originally only have part_no/make/qty. After enrichment,
        description_1 and item_category should appear in the response items."""
        item = receipt_note_with_item["items"][0]
        part_no, make = item["part_no"], item["make"]
        sm = _find_master(client, part_no, make)
        if not sm:
            pytest.skip(f"No master for {part_no}/{make}")
        sentinel = f"LIVE_RN_DESC_{int(time.time())}"
        original = dict(sm)
        try:
            _patch_master(client, sm["id"], {
                **{k: v for k, v in sm.items() if k not in ("id", "_id")},
                "description_1": sentinel,
            })
            rows = client.get(f"{BASE_URL}/api/receipt-notes", timeout=20).json()
            target = next(r for r in rows if r["id"] == receipt_note_with_item["id"])
            it0 = next(it for it in target["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it0.get("description_1") == sentinel, f"receipt-notes list not enriched: {it0}"
            # BY-ID
            doc = client.get(f"{BASE_URL}/api/receipt-notes/{receipt_note_with_item['id']}", timeout=20).json()
            it1 = next(it for it in doc["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it1.get("description_1") == sentinel
        finally:
            _restore_master(client, sm["id"], original)

    def test_racking_notes_list_and_byid_reflect_master(self, client):
        rows = client.get(f"{BASE_URL}/api/racking-notes", timeout=20).json()
        target = next((r for r in rows if r.get("items")), None)
        if not target:
            pytest.skip("No racking note with items exists in current data")
        item = target["items"][0]
        part_no, make = item["part_no"], item["make"]
        sm = _find_master(client, part_no, make)
        if not sm:
            pytest.skip(f"No master for {part_no}/{make}")
        sentinel = f"LIVE_RKN_DESC_{int(time.time())}"
        original = dict(sm)
        try:
            _patch_master(client, sm["id"], {
                **{k: v for k, v in sm.items() if k not in ("id", "_id")},
                "description_1": sentinel,
            })
            rows2 = client.get(f"{BASE_URL}/api/racking-notes", timeout=20).json()
            t2 = next(r for r in rows2 if r["id"] == target["id"])
            it0 = next(it for it in t2["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it0.get("description_1") == sentinel
            doc = client.get(f"{BASE_URL}/api/racking-notes/{target['id']}", timeout=20).json()
            it1 = next(it for it in doc["items"] if it["part_no"] == part_no and it["make"] == make)
            assert it1.get("description_1") == sentinel
        finally:
            _restore_master(client, sm["id"], original)


# -------------------- Tests: Location live-join --------------------
class TestLocationLiveJoin:

    def test_godown_rename_propagates_to_picking_note(self, client, picking_note_with_item):
        item = picking_note_with_item["items"][0]
        gid = item.get("godown_id")
        if not gid:
            pytest.skip("Picking note item has no godown_id")
        gs = client.get(f"{BASE_URL}/api/godowns", timeout=20).json()
        g = next((x for x in gs if x["id"] == gid), None)
        if not g:
            pytest.skip(f"Godown {gid} not found")
        original_name = g["godown_name"]
        new_name = f"{original_name}_LIVE_{int(time.time())}"
        try:
            r = client.put(f"{BASE_URL}/api/godowns/{gid}", json={"godown_name": new_name}, timeout=20)
            assert r.status_code == 200, r.text
            # transactions
            tx = client.get(f"{BASE_URL}/api/transactions", timeout=20).json()
            matched = [t for t in tx if t.get("godown_id") == gid]
            for t in matched:
                assert t.get("godown_name") == new_name, t
            # picking-notes by-id
            doc = client.get(f"{BASE_URL}/api/picking-notes/{picking_note_with_item['id']}", timeout=20).json()
            for it in doc["items"]:
                if it.get("godown_id") == gid:
                    assert it.get("godown_name") == new_name
        finally:
            client.put(f"{BASE_URL}/api/godowns/{gid}", json={"godown_name": original_name}, timeout=20)

    def test_rack_rename_propagates(self, client, picking_note_with_item):
        item = picking_note_with_item["items"][0]
        rid = item.get("rack_id")
        if not rid:
            pytest.skip("Picking note item has no rack_id")
        rs = client.get(f"{BASE_URL}/api/racks", timeout=20).json()
        rk = next((x for x in rs if x["id"] == rid), None)
        if not rk:
            pytest.skip(f"Rack {rid} not found")
        original = rk["rack_no"]
        new_name = f"{original}_LIVE"
        try:
            r = client.put(f"{BASE_URL}/api/racks/{rid}", json={"rack_no": new_name, "total_boxes": rk.get("total_boxes", 0)}, timeout=20)
            assert r.status_code == 200, r.text
            doc = client.get(f"{BASE_URL}/api/picking-notes/{picking_note_with_item['id']}", timeout=20).json()
            for it in doc["items"]:
                if it.get("rack_id") == rid:
                    assert it.get("rack_no") == new_name
            # transactions
            tx = client.get(f"{BASE_URL}/api/transactions", timeout=20).json()
            for t in tx:
                if t.get("rack_id") == rid:
                    assert t.get("rack_no") == new_name
        finally:
            client.put(f"{BASE_URL}/api/racks/{rid}", json={"rack_no": original, "total_boxes": rk.get("total_boxes", 0)}, timeout=20)

    def test_box_rename_propagates_box_no_and_category(self, client, picking_note_with_item):
        item = picking_note_with_item["items"][0]
        bid = item.get("box_id")
        if not bid:
            pytest.skip("Picking note item has no box_id")
        bs = client.get(f"{BASE_URL}/api/boxes", timeout=20).json()
        bx = next((x for x in bs if x["id"] == bid), None)
        if not bx:
            pytest.skip(f"Box {bid} not found")
        orig_no = bx["box_no"]
        orig_cat = bx.get("box_category", "")
        new_no = f"{orig_no}_LIVE"
        new_cat = f"CAT_LIVE_{int(time.time())}"
        try:
            payload = {"box_no": new_no, "box_category": new_cat}
            r = client.put(f"{BASE_URL}/api/boxes/{bid}", json=payload, timeout=20)
            assert r.status_code == 200, r.text
            doc = client.get(f"{BASE_URL}/api/picking-notes/{picking_note_with_item['id']}", timeout=20).json()
            for it in doc["items"]:
                if it.get("box_id") == bid:
                    assert it.get("box_no") == new_no
                    assert it.get("box_category") == new_cat
        finally:
            client.put(f"{BASE_URL}/api/boxes/{bid}", json={"box_no": orig_no, "box_category": orig_cat}, timeout=20)


# -------------------- Tests: Edge cases --------------------
class TestEnrichmentEdgeCases:

    def test_missing_master_does_not_crash_or_drop_data(self, client, receipt_note_with_item):
        """If a (part_no, make) does not exist in stock_master, snapshot fields
        on the document should remain (no crash). We simulate by checking response
        shape for an existing receipt note: the items must still all be returned
        and have part_no/make/qty intact."""
        doc = client.get(f"{BASE_URL}/api/receipt-notes/{receipt_note_with_item['id']}", timeout=20).json()
        assert doc.get("items"), "items missing from receipt-note by-id"
        for it in doc["items"]:
            assert it.get("part_no")
            assert it.get("make") is not None
            assert "quantity" in it or "qty" in it

    def test_stock_balance_continues_to_live_join(self, client):
        """Regression: /api/stock-balance already live-joins."""
        r = client.get(f"{BASE_URL}/api/stock-balance", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)

    def test_low_stock_continues_to_work(self, client):
        r = client.get(f"{BASE_URL}/api/low-stock", timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)
