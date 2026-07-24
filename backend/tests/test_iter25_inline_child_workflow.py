"""
iter-25 regression: Inline-child SRN/ERN model.

Children are sub-rows on the parent SRN/ERN (NOT separate docs).
SRN child  : {child_srn_no='PARENT-A/B/...', received_qty, not_receivable_qty,
              created_at, status}
ERN child  : {child_ern_no='PARENT-A/B/...', accepted_qty, rejected_qty,
              created_at, status}

Endpoints under test (NEW):
  POST   /api/short-received-notes/{srn_id}/children
  PUT    /api/short-received-notes/{srn_id}/children/{child_srn_no}
  DELETE /api/short-received-notes/{srn_id}/children/{child_srn_no}
  POST   /api/extra-received-notes/{ern_id}/children
  PUT    /api/extra-received-notes/{ern_id}/children/{child_ern_no}
  DELETE /api/extra-received-notes/{ern_id}/children/{child_ern_no}

Old legacy /fulfill, /accept, /reject endpoints have been REMOVED.
"""

import os
import uuid
import datetime as _dt
from urllib.parse import quote

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
    return r.json()["token"]


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
        json={"godown_id": g["id"], "rack_no": f"TR{uuid.uuid4().hex[:4]}", "total_boxes": 4},
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


def _list_srns(auth, **params):
    r = auth.get(f"{BASE_URL}/api/short-received-notes", params=params)
    body = r.json()
    return body if isinstance(body, list) else body.get("items", [])


def _find_parent_srn(auth, rn_id):
    for s in _list_srns(auth):
        if s.get("parent_rn_id") == rn_id and not s.get("parent_srn_id"):
            return s
    return None


def _find_parent_ern(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/extra-received-notes")
    body = r.json()
    rows = body if isinstance(body, list) else body.get("items", [])
    for e in rows:
        if e.get("parent_rn_id") == rn_id and not e.get("parent_ern_id"):
            return e
    return None


def _enc(child_no: str) -> str:
    return quote(child_no, safe="")


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


def _create_and_record_rkn(auth, src_id, pn, mk, qty, location, source_type):
    r = auth.post(f"{BASE_URL}/api/racking-notes",
                  json=_rkn_payload(src_id, pn, mk, qty, location, source_type))
    assert r.status_code == 200, r.text
    rkn = r.json()
    rec = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
    assert rec.status_code == 200, rec.text
    return rkn


# ============================================================================
# TC1 — SRN inline-child happy path
# ============================================================================
class TestTC1SrnInlineChild:
    def test_first_child_appended_to_parent(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=80)  # short=20
        _finalize_rn(auth, rn["id"])

        before_srns = _list_srns(auth)
        before_count = len(before_srns)

        parent = _find_parent_srn(auth, rn["id"])
        assert parent is not None
        assert parent["status"] == "PENDING"

        body = {"part_no": pn, "make": mk,
                "received_qty": 5, "not_receivable_qty": 0}
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
            json=body)
        assert r.status_code == 200, r.text
        resp = r.json()
        # Verify parent updated, status PARTIALLY_RECEIVED
        assert resp["status"] == "PARTIALLY_RECEIVED"
        item = resp["items"][0]
        assert "children" in item, "response must include children[]"
        children = item.get("children") or []
        assert len(children) == 1
        ch = children[0]
        assert ch["child_srn_no"] == f"{parent['srn_no']}-A"
        assert float(ch["received_qty"]) == 5
        assert float(ch.get("not_receivable_qty") or 0) == 0
        assert ch["status"] == "RECEIVED"

        # NO new SRN docs created — count unchanged
        after_srns = _list_srns(auth)
        assert len(after_srns) == before_count, \
            f"expected SRN doc count unchanged ({before_count}), got {len(after_srns)}"


# ============================================================================
# TC2 — Multiple children + alphabet suffixing -> COMPLETE
# ============================================================================
class TestTC2MultiChildAlphabet:
    def test_three_children_complete_parent(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=80)  # short=20
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # A: rcv=5
        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 5, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text

        # B: rcv=3
        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 3, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        body = r.json()
        kids = body["items"][0]["children"]
        assert len(kids) == 2
        assert kids[1]["child_srn_no"] == f"{parent['srn_no']}-B"

        # C: rcv=0, nrcv=12 -> sum decided 5+3+12=20=short -> COMPLETE
        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 0, "not_receivable_qty": 12})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "COMPLETE", body["status"]
        kids = body["items"][0]["children"]
        assert [c["child_srn_no"] for c in kids] == [
            f"{parent['srn_no']}-A", f"{parent['srn_no']}-B", f"{parent['srn_no']}-C"]
        assert sum(float(c["received_qty"]) for c in kids) == 8
        assert sum(float(c["not_receivable_qty"]) for c in kids) == 12

        # store for TC10
        TestTC10RackingSources.parent_srn_id = parent["id"]
        TestTC10RackingSources.srn_part = (pn, mk)


# ============================================================================
# TC3 — Pending overflow rejected with 400
# ============================================================================
class TestTC3PendingOverflow:
    def test_overflow_400(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=5)  # short=5
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 3, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 10, "not_receivable_qty": 0})
        assert r.status_code == 400, r.text
        assert "exceeds" in r.text.lower()


# ============================================================================
# TC4 — Edit child row
# ============================================================================
class TestTC4EditChild:
    def test_edit_received_qty(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=20, received_qty=10)  # short=10
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 5, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        cid = f"{parent['srn_no']}-A"

        r = auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{_enc(cid)}",
            json={"part_no": pn, "make": mk,
                  "received_qty": 8, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        body = r.json()
        ch = body["items"][0]["children"][0]
        assert float(ch["received_qty"]) == 8


# ============================================================================
# TC5 — Edit / delete blocked by existing RKN
# ============================================================================
class TestTC5EditDeleteBlockedByRkn:
    def test_blocked_after_racked(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=20, received_qty=15)  # short=5
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 5, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        cid = f"{parent['srn_no']}-A"

        # Rack 5 against parent SRN
        _create_and_record_rkn(auth, parent["id"], pn, mk, 5, location, "SRN")

        # Edit reduce should fail 409
        r = auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{_enc(cid)}",
            json={"part_no": pn, "make": mk,
                  "received_qty": 2, "not_receivable_qty": 0})
        assert r.status_code == 409, r.text
        assert "racked" in r.text.lower()

        # Delete should fail 409
        r = auth.delete(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{_enc(cid)}")
        assert r.status_code == 409, r.text
        assert "racked" in r.text.lower()


# ============================================================================
# TC6 — Delete child row
# ============================================================================
class TestTC6DeleteChild:
    def test_delete_resets_status(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=7)  # short=3
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
                      json={"part_no": pn, "make": mk,
                            "received_qty": 3, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        cid = f"{parent['srn_no']}-A"

        r = auth.delete(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children/{_enc(cid)}")
        assert r.status_code == 200, r.text

        body = _get_srn(auth, parent["id"])
        assert (body["items"][0].get("children") or []) == []
        assert body["status"] == "PENDING"


# ============================================================================
# TC7 — ERN inline-child happy path
# ============================================================================
class TestTC7ErnInlineChild:
    def test_first_child_appended(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=110)  # extra=10
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_ern(auth, rn["id"])
        assert parent is not None
        assert parent["status"] == "PENDING"

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children",
            json={"part_no": pn, "make": mk,
                  "accepted_qty": 3, "rejected_qty": 2})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "PARTIALLY_ACCEPTED", body["status"]
        kids = body["items"][0]["children"]
        assert len(kids) == 1
        ch = kids[0]
        assert ch["child_ern_no"] == f"{parent['ern_no']}-A"
        assert float(ch["accepted_qty"]) == 3
        assert float(ch["rejected_qty"]) == 2


# ============================================================================
# TC8 — ERN multi-child completes
# ============================================================================
class TestTC8ErnMultiChild:
    def test_two_children_complete(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=110)  # extra=10
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_ern(auth, rn["id"])

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children",
            json={"part_no": pn, "make": mk,
                  "accepted_qty": 3, "rejected_qty": 2})
        assert r.status_code == 200, r.text

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children",
            json={"part_no": pn, "make": mk,
                  "accepted_qty": 5, "rejected_qty": 0})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "COMPLETE", body["status"]
        kids = body["items"][0]["children"]
        assert sum(float(c["accepted_qty"]) for c in kids) == 8
        assert sum(float(c["rejected_qty"]) for c in kids) == 2

        TestTC10RackingSources.parent_ern_id = parent["id"]
        TestTC10RackingSources.ern_part = (pn, mk)


# ============================================================================
# TC9 — ERN edit / delete blocked by RKN
# ============================================================================
class TestTC9ErnEditDeleteBlocked:
    def test_blocked_after_racked(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=15)  # extra=5
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_ern(auth, rn["id"])

        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children",
            json={"part_no": pn, "make": mk,
                  "accepted_qty": 5, "rejected_qty": 0})
        assert r.status_code == 200, r.text
        cid = f"{parent['ern_no']}-A"

        _create_and_record_rkn(auth, parent["id"], pn, mk, 5, location, "ERN")

        r = auth.put(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children/{_enc(cid)}",
            json={"part_no": pn, "make": mk,
                  "accepted_qty": 2, "rejected_qty": 0})
        assert r.status_code == 409, r.text

        r = auth.delete(
            f"{BASE_URL}/api/extra-received-notes/{parent['id']}/children/{_enc(cid)}")
        assert r.status_code == 409, r.text


# ============================================================================
# TC10 — Racking sources include parents with rackable=sum(received/accepted)
# ============================================================================
class TestTC10RackingSources:
    parent_srn_id = None
    parent_ern_id = None
    srn_part = None
    ern_part = None

    @staticmethod
    def _find_source_in_groups(groups, source_type, source_id):
        for g in groups:
            for s in g.get("sources") or []:
                if s.get("source_type") == source_type and s.get("source_id") == source_id:
                    return s
        return None

    def test_srn_source_rackable_only_received(self, auth):
        if not TestTC10RackingSources.parent_srn_id:
            pytest.skip("TC2 didn't run")
        sid = TestTC10RackingSources.parent_srn_id
        pn, mk = TestTC10RackingSources.srn_part
        r = auth.get(f"{BASE_URL}/api/racking-notes/sources")
        assert r.status_code == 200, r.text
        groups = r.json()
        assert self._find_source_in_groups(groups, "SRN", sid), \
            "parent SRN should appear in racking sources"
        # Use prepare-source to get rackable_qty per item
        r = auth.get(f"{BASE_URL}/api/racking-notes/prepare-source",
                     params={"source_type": "SRN", "source_id": sid})
        assert r.status_code == 200, r.text
        body = r.json()
        items = body.get("items") or []
        target = next((i for i in items
                       if i.get("part_no") == pn and i.get("make") == mk), None)
        assert target is not None, f"item missing on prepare-source: {items}"
        rackable = float(target.get("rackable_qty") or 0)
        assert rackable == 8.0, f"rackable should be 8 (received only), got {rackable}"

    def test_ern_source_rackable_only_accepted(self, auth):
        if not TestTC10RackingSources.parent_ern_id:
            pytest.skip("TC8 didn't run")
        eid = TestTC10RackingSources.parent_ern_id
        pn, mk = TestTC10RackingSources.ern_part
        r = auth.get(f"{BASE_URL}/api/racking-notes/sources")
        assert r.status_code == 200, r.text
        groups = r.json()
        assert self._find_source_in_groups(groups, "ERN", eid), \
            "parent ERN should appear in racking sources"
        r = auth.get(f"{BASE_URL}/api/racking-notes/prepare-source",
                     params={"source_type": "ERN", "source_id": eid})
        assert r.status_code == 200, r.text
        body = r.json()
        items = body.get("items") or []
        target = next((i for i in items
                       if i.get("part_no") == pn and i.get("make") == mk), None)
        assert target is not None
        rackable = float(target.get("rackable_qty") or 0)
        assert rackable == 8.0, f"rackable should be 8 (accepted only), got {rackable}"


# ============================================================================
# TC11 — RN.status=FULLY_RACKED when received + SRN children + ERN children racked
# ============================================================================
class TestTC11RnFullyRacked:
    def test_shortfall_with_child_then_full_racking(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short=6
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        # SRN child rcvd=6 (full short)
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent['id']}/children",
            json={"part_no": pn, "make": mk,
                  "received_qty": 6, "not_receivable_qty": 0})
        assert r.status_code == 200, r.text
        srn_after = _get_srn(auth, parent["id"])
        assert srn_after["status"] == "COMPLETE"

        # Rack RN(4)
        _create_and_record_rkn(auth, rn["id"], pn, mk, 4, location, "RN")
        # Rack SRN(6)
        _create_and_record_rkn(auth, parent["id"], pn, mk, 6, location, "SRN")

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "FULLY_RACKED", rn_after["status"]


# ============================================================================
# TC12 — Sanity: GET endpoints return 200 (no 500s)
# ============================================================================
class TestTC12Sanity:
    def test_health_and_lists(self, auth):
        # basic GET smoke tests
        r = auth.get(f"{BASE_URL}/api/receipt-notes")
        assert r.status_code == 200, r.text
        r = auth.get(f"{BASE_URL}/api/short-received-notes")
        assert r.status_code == 200, r.text
        r = auth.get(f"{BASE_URL}/api/extra-received-notes")
        assert r.status_code == 200, r.text
        r = auth.get(f"{BASE_URL}/api/racking-notes")
        assert r.status_code == 200, r.text
        r = auth.get(f"{BASE_URL}/api/racking-notes/sources")
        assert r.status_code == 200, r.text

    def test_old_legacy_endpoints_removed(self, auth):
        # Sanity: old /fulfill, /accept, /reject endpoints should return 404 or 405
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)
        _finalize_rn(auth, rn["id"])
        parent = _find_parent_srn(auth, rn["id"])

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{parent['id']}/fulfill",
                      json={"part_no": pn, "make": mk, "fulfilled_qty": 1})
        # Either 404 (endpoint removed) or 405 (wrong method); should NOT be 200
        assert r.status_code in (404, 405, 422), \
            f"legacy /fulfill should be removed, got {r.status_code}: {r.text}"
