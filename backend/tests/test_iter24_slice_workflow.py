"""
iter-24 regression: per-batch SRN/ERN slice mechanism.

Each fulfillment/acceptance batch creates its OWN child SRN/ERN holding the
fulfilled/accepted portion (the child IS the rackable artifact).
Pending qty = parent.short_qty - sum(children.fulfilled_qty).
Status COMPLETE only when all parent items have pending=0.
Rejection on ERN stays as a top-level field on parent.items[i].rejected_qty
(no child created for rejection).

Endpoints under test (NEW):
  POST   /api/short-received-notes/{id}/fulfill
  PUT    /api/short-received-notes/{id}/children/{child_id}
  DELETE /api/short-received-notes/{id}/children/{child_id}
  POST   /api/extra-received-notes/{id}/accept
  PUT    /api/extra-received-notes/{id}/children/{child_id}
  DELETE /api/extra-received-notes/{id}/children/{child_id}
  PUT    /api/extra-received-notes/{id}/reject
"""

import os
import uuid
import datetime as _dt
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"
TODAY = _dt.date.today().isoformat()


# ---------- shared fixtures ---------------------------------------------------

@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def token(session):
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    body = r.json()
    assert "token" in body and len(body["token"]) > 0
    return body["token"]


@pytest.fixture(scope="session")
def auth(session, token):
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


@pytest.fixture(scope="session")
def location(auth):
    g = auth.post(
        f"{BASE_URL}/api/godowns",
        json={"godown_name": f"TEST_GD_{uuid.uuid4().hex[:6]}"},
    ).json()
    r = auth.post(
        f"{BASE_URL}/api/racks",
        json={"godown_id": g["id"], "rack_no": f"TR{uuid.uuid4().hex[:4]}", "total_boxes": 2},
    ).json()
    b = auth.post(
        f"{BASE_URL}/api/boxes",
        json={"rack_id": r["id"], "box_no": f"TB{uuid.uuid4().hex[:4]}", "box_category": "STD"},
    ).json()
    return {"godown": g, "rack": r, "box": b}


# ---------- helpers ----------------------------------------------------------

def _new_part(auth):
    pn = f"TESTPN_{uuid.uuid4().hex[:8]}"
    mk = "TESTMK"
    r = auth.post(
        f"{BASE_URL}/api/stock-master",
        json={"part_no": pn, "make": mk, "unit": "PCS"},
    )
    assert r.status_code in (200, 201), r.text
    return pn, mk


def _create_rn(auth, *, invoice_qty, received_qty):
    pn, mk = _new_part(auth)
    payload = {
        "stock_in_type": "INVOICE",
        "invoice_no": f"INV{uuid.uuid4().hex[:6]}",
        "items": [{"part_no": pn, "make": mk,
                   "invoice_qty": invoice_qty, "received_qty": received_qty}],
    }
    r = auth.post(f"{BASE_URL}/api/receipt-notes", json=payload)
    assert r.status_code == 200, r.text
    return r.json(), pn, mk


def _finalize_rn(auth, rn_id):
    r = auth.post(f"{BASE_URL}/api/receipt-notes/{rn_id}/finalize")
    assert r.status_code == 200, r.text
    return r.json()


def _get_rn(auth, rn_id):
    return auth.get(f"{BASE_URL}/api/receipt-notes/{rn_id}").json()


def _get_srn(auth, srn_id):
    return auth.get(f"{BASE_URL}/api/short-received-notes/{srn_id}").json()


def _get_ern(auth, ern_id):
    return auth.get(f"{BASE_URL}/api/extra-received-notes/{ern_id}").json()


def _find_parent_srn(auth, rn_id):
    rows = auth.get(f"{BASE_URL}/api/short-received-notes").json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    for s in rows:
        if s.get("parent_rn_id") == rn_id and not s.get("parent_srn_id"):
            return s
    return None


def _find_parent_ern(auth, rn_id):
    rows = auth.get(f"{BASE_URL}/api/extra-received-notes").json()
    rows = rows if isinstance(rows, list) else rows.get("items", [])
    for e in rows:
        if e.get("parent_rn_id") == rn_id and not e.get("parent_ern_id"):
            return e
    return None


def _rkn_payload(src_id, pn, mk, qty, location, source_type):
    return {
        "source_type": source_type,
        "source_id": src_id,
        "items": [{
            "part_no": pn, "make": mk, "quantity": qty,
            "godown_id": location["godown"]["id"],
            "godown_name": location["godown"]["godown_name"],
            "rack_id": location["rack"]["id"],
            "rack_no": location["rack"]["rack_no"],
            "box_id": location["box"]["id"],
            "box_no": location["box"]["box_no"],
        }],
    }


# ============================================================================
# TC1 — Simple RN -> Racking
# ============================================================================
class TestTC1SimpleRnRacking:
    def test_finalize_then_record_rkn(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=100)
        finalized = _finalize_rn(auth, rn["id"])
        assert finalized["status"] == "FINAL"

        rkn = auth.post(f"{BASE_URL}/api/racking-notes",
                        json=_rkn_payload(rn["id"], pn, mk, 100, location, "RN")).json()
        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200, r.text

        rkn_after = auth.get(f"{BASE_URL}/api/racking-notes/{rkn['id']}").json()
        assert rkn_after["status"] == "RECORDED"

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "FULLY_RACKED", rn_after["status"]


# ============================================================================
# TC2 — SRN slice flow (single fulfillment)
# ============================================================================
class TestTC2SrnSliceSingle:
    def test_first_fulfill_creates_child_srn(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short=6
        _finalize_rn(auth, rn["id"])

        parent = _find_parent_srn(auth, rn["id"])
        assert parent is not None
        assert parent["status"] == "PENDING"

        body = {"part_no": pn, "make": mk, "fulfilled_qty": 2,
                "fulfillment_date": TODAY}
        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
                      json=body)
        assert r.status_code == 200, r.text
        parent_after = _get_srn(auth, parent["id"])
        assert parent_after["status"] == "PARTIALLY_RECEIVED"

        item = parent_after["items"][0]
        children = item.get("children") or []
        assert len(children) == 1, children
        ch = children[0]
        assert ch.get("fulfilled_qty") == 2
        assert ch.get("child_srn_id") and ch.get("child_srn_no")

        child = _get_srn(auth, ch["child_srn_id"])
        assert child["status"] == "COMPLETE"
        assert child["parent_srn_id"] == parent["id"]
        assert float(child["items"][0]["fulfilled_qty"]) == 2
        assert float(child["items"][0]["short_qty"]) == 2


# ============================================================================
# TC3 — SRN multi-slice (3 slices summing to short_qty)
# ============================================================================
class TestTC3SrnMultiSlice:
    def test_three_slices_complete_parent(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short=6
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # Slice 1: 2
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "PARTIALLY_RECEIVED"

        # Slice 2: 3 -> total 5, still PARTIAL
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 3, "fulfillment_date": TODAY})
        assert r.status_code == 200, r.text
        body = _get_srn(auth, parent["id"])
        assert body["status"] == "PARTIALLY_RECEIVED"
        assert len(body["items"][0]["children"]) == 2

        # Slice 3: 1 -> total 6 == short -> COMPLETE
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 1, "fulfillment_date": TODAY})
        assert r.status_code == 200, r.text
        body = _get_srn(auth, parent["id"])
        assert body["status"] == "COMPLETE", body["status"]
        assert len(body["items"][0]["children"]) == 3
        total = sum(float(c["fulfilled_qty"]) for c in body["items"][0]["children"])
        assert total == 6.0


# ============================================================================
# TC4 — Slice over-fulfillment rejected
# ============================================================================
class TestTC4OverFulfillmentRejected:
    def test_exceeds_remaining_short(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=5)  # short=5
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 3, "fulfillment_date": TODAY})
        assert r.status_code == 200, r.text

        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 10, "fulfillment_date": TODAY})
        assert r.status_code == 400, r.text
        assert "exceeds remaining short" in r.text.lower() or "exceeds" in r.text.lower()


# ============================================================================
# TC5 — Edit child slice; blocked once RKN exists
# ============================================================================
class TestTC5EditChildSlice:
    def test_edit_then_block_after_rkn(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short=6
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # Slice qty=2
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200
        body = _get_srn(auth, parent["id"])
        child_id = body["items"][0]["children"][0]["child_srn_id"]

        # Edit slice qty=4
        r = auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{child_id}",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 4, "fulfillment_date": TODAY})
        assert r.status_code == 200, r.text
        child = _get_srn(auth, child_id)
        assert float(child["items"][0]["fulfilled_qty"]) == 4
        parent_after = _get_srn(auth, parent["id"])
        assert float(parent_after["items"][0]["children"][0]["fulfilled_qty"]) == 4

        # Create + record RKN against the child SRN
        rkn = auth.post(f"{BASE_URL}/api/racking-notes",
                        json=_rkn_payload(child_id, pn, mk, 4, location, "SRN")).json()
        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200, r.text

        # Try edit again -> 409
        r = auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{child_id}",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 3, "fulfillment_date": TODAY})
        assert r.status_code == 409, f"expected 409 got {r.status_code} {r.text}"
        assert "racking note" in r.text.lower()


# ============================================================================
# TC6 — Delete child slice; blocked once RKN exists
# ============================================================================
class TestTC6DeleteChildSlice:
    def test_delete_then_block_after_rkn(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # Slice qty=2
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200
        body = _get_srn(auth, parent["id"])
        child_id = body["items"][0]["children"][0]["child_srn_id"]

        # DELETE the child
        r = auth.delete(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{child_id}")
        assert r.status_code == 200, r.text

        # Verify child doc gone
        r = auth.get(f"{BASE_URL}/api/short-received-notes/{child_id}")
        assert r.status_code == 404
        # parent children empty, status PENDING
        parent_after = _get_srn(auth, parent["id"])
        assert (parent_after["items"][0].get("children") or []) == []
        assert parent_after["status"] == "PENDING"

        # Now create new slice + record RKN -> DELETE blocked
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200
        body = _get_srn(auth, parent["id"])
        child_id2 = body["items"][0]["children"][0]["child_srn_id"]
        rkn = auth.post(f"{BASE_URL}/api/racking-notes",
                        json=_rkn_payload(child_id2, pn, mk, 2, location, "SRN")).json()
        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200

        r = auth.delete(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{child_id2}")
        assert r.status_code == 409, f"expected 409 got {r.status_code} {r.text}"


# ============================================================================
# TC7 — ERN slice flow (mirror of TC2)
# ============================================================================
class TestTC7ErnSliceSingle:
    def test_accept_creates_child_ern(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=110)  # extra=10
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_ern(auth, rn["id"])
        assert parent is not None
        assert parent["status"] == "PENDING"

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/accept",
            json={"part_no": pn, "make": mk, "accepted_qty": 3, "accepted_date": TODAY})
        assert r.status_code == 200, r.text
        body = _get_ern(auth, parent["id"])
        assert body["status"] == "PARTIALLY_ACCEPTED", body["status"]
        item = body["items"][0]
        assert len(item["children"]) == 1
        ch = item["children"][0]
        assert ch["accepted_qty"] == 3
        assert ch.get("child_ern_id") and ch.get("child_ern_no")

        child = _get_ern(auth, ch["child_ern_id"])
        assert child["status"] == "COMPLETE"
        assert child["parent_ern_id"] == parent["id"]
        assert float(child["items"][0]["accepted_qty"]) == 3
        assert float(child["items"][0]["extra_qty"]) == 3


# ============================================================================
# TC8 — ERN reject (top-level on parent, no child)
# ============================================================================
class TestTC8ErnReject:
    def test_accept_then_reject_remainder_completes(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=110)  # extra=10
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_ern(auth, rn["id"])

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/accept",
            json={"part_no": pn, "make": mk, "accepted_qty": 3, "accepted_date": TODAY})
        assert r.status_code == 200, r.text

        r = auth.put(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/reject",
            json={"part_no": pn, "make": mk, "rejected_qty": 7})
        assert r.status_code == 200, r.text
        body = _get_ern(auth, parent["id"])
        item = body["items"][0]
        assert float(item.get("rejected_qty") or 0) == 7
        # 3 + 7 = 10 = extra -> COMPLETE
        assert body["status"] == "COMPLETE", body["status"]
        # No new child created from rejection (still 1 child from accept)
        assert len(item["children"]) == 1


# ============================================================================
# TC9 — RN status transitions with new model
# ============================================================================
class TestTC9RnStatusWithSliceModel:
    def test_rn_status_after_slice_and_rkn(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short=6
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # Slice qty=2 -> child SRN created
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200
        body = _get_srn(auth, parent["id"])
        child_id = body["items"][0]["children"][0]["child_srn_id"]

        # No RKN yet -> RN should be FINAL or RACKING_PENDING (rackable & nothing racked)
        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] in ("FINAL", "RACKING_PENDING"), rn_after["status"]

        # Create DRAFT RKN against child SRN
        rkn = auth.post(f"{BASE_URL}/api/racking-notes",
                        json=_rkn_payload(child_id, pn, mk, 2, location, "SRN")).json()
        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "RACKING_NOTE_DRAFT", rn_after["status"]

        # Record the RKN -> rackable=4+2=6, racked=2 -> PARTIALLY_RACKED
        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200, r.text
        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "PARTIALLY_RACKED", rn_after["status"]


# ============================================================================
# TC11 — Racking sources includes child SRN, not parent
# ============================================================================
class TestTC11RackingSourcesIncludesChild:
    def test_child_srn_in_sources_and_parent_excluded(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
            json={"part_no": pn, "make": mk, "fulfilled_qty": 2, "fulfillment_date": TODAY})
        assert r.status_code == 200
        body = _get_srn(auth, parent["id"])
        child_id = body["items"][0]["children"][0]["child_srn_id"]
        child_no = body["items"][0]["children"][0]["child_srn_no"]

        sources = auth.get(f"{BASE_URL}/api/racking-notes/sources").json()
        # Find the group for our parent_rn_id
        group = next((g for g in sources if g.get("parent_rn_id") == rn["id"]), None)
        assert group is not None, "parent RN group not found in sources"

        types = [(s.get("source_type"), s.get("source_id"), s.get("source_no"))
                 for s in group["sources"]]
        # Child SRN should be present
        assert any(t == "SRN" and sid == child_id and sno == child_no
                   for (t, sid, sno) in types), \
            f"child SRN missing from sources: {types}"
        # Parent SRN should NOT be present (no fulfilled_qty on its own items)
        assert not any(t == "SRN" and sid == parent["id"] for (t, sid, sno) in types), \
            f"parent SRN unexpectedly in sources: {types}"
