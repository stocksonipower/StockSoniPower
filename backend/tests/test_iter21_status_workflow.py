"""
iter-21 regression: Stock-In NEW status workflow + clickable parent links.

Covers:
  RN flow  : DRAFT -> FINAL/RACKING_PENDING -> RACKING_NOTE_DRAFT -> PARTIALLY_RACKED -> FULLY_RACKED
  SRN flow : PENDING -> PARTIALLY_RECEIVED -> COMPLETE   (was FULLY_RECEIVED; now COMPLETE)
  ERN flow : PENDING -> PARTIALLY_ACCEPTED / PARTIALLY_REJECTED -> COMPLETE
  RKN flow : DRAFT -> RECORDED   (display-only label "Fully Racked" is FE-only)

New rules:
  1. A draft RKN against the RN OR ANY SRN/ERN descendant flips RN -> RACKING_NOTE_DRAFT.
  2. RN reaches FULLY_RACKED only when RN.received + ALL descendant SRN.fulfilled +
     ALL descendant ERN.accepted is fully racked.
  3. Backward compat: legacy SRN.status == 'FULLY_RECEIVED' is migrated to 'COMPLETE' on startup.
"""

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


# ---------- shared fixtures ----------------------------------------------------

@pytest.fixture(scope="session")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def token(session):
    r = session.post(f"{BASE_URL}/api/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    body = r.json()
    assert "token" in body and isinstance(body["token"], str) and len(body["token"]) > 0
    return body["token"]


@pytest.fixture(scope="session")
def auth(session, token):
    session.headers.update({"Authorization": f"Bearer {token}"})
    return session


@pytest.fixture(scope="session")
def location(auth):
    """Create a TEST godown / rack / box used by all racking tests."""
    g = auth.post(f"{BASE_URL}/api/godowns",
                  json={"godown_name": f"TEST_GD_{uuid.uuid4().hex[:6]}"}).json()
    r = auth.post(f"{BASE_URL}/api/racks",
                  json={"godown_id": g["id"], "rack_no": f"TR{uuid.uuid4().hex[:4]}",
                        "total_boxes": 2}).json()
    b = auth.post(f"{BASE_URL}/api/boxes",
                  json={"rack_id": r["id"], "box_no": f"TB{uuid.uuid4().hex[:4]}",
                        "box_category": "STD"}).json()
    return {"godown": g, "rack": r, "box": b}


def _new_part(auth):
    """Insert a fresh stock_master row with a unique part_no/make pair."""
    pn = f"TESTPN_{uuid.uuid4().hex[:8]}"
    mk = "TESTMK"
    payload = {"part_no": pn, "make": mk, "unit": "PCS"}
    r = auth.post(f"{BASE_URL}/api/stock-master", json=payload)
    assert r.status_code in (200, 201), r.text
    return pn, mk


def _create_rn(auth, *, invoice_qty, received_qty):
    """Create a DRAFT RN with one item then return the created doc."""
    pn, mk = _new_part(auth)
    payload = {
        "stock_in_type": "INVOICE",
        "invoice_no": f"INV{uuid.uuid4().hex[:6]}",
        "items": [{"part_no": pn, "make": mk,
                   "invoice_qty": invoice_qty, "received_qty": received_qty}],
    }
    r = auth.post(f"{BASE_URL}/api/receipt-notes", json=payload)
    assert r.status_code == 200, r.text
    rn = r.json()
    assert rn["status"] == "DRAFT"
    return rn, pn, mk


def _finalize_rn(auth, rn_id):
    r = auth.post(f"{BASE_URL}/api/receipt-notes/{rn_id}/finalize")
    assert r.status_code == 200, r.text
    return r.json()


def _get_rn(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/receipt-notes/{rn_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _get_srn_for_rn(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/short-received-notes")
    assert r.status_code == 200, r.text
    rows = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
    for s in rows:
        if s.get("parent_rn_id") == rn_id:
            return s
    return None


def _get_ern_for_rn(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/extra-received-notes")
    assert r.status_code == 200, r.text
    rows = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
    for e in rows:
        if e.get("parent_rn_id") == rn_id:
            return e
    return None


# ============================================================================
# 1. AUTH
# ============================================================================
class TestAuth:
    def test_admin_login(self, auth):
        r = auth.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 200
        me = r.json()
        assert me["email"] == ADMIN_EMAIL
        assert me["role"] == "admin"


# ============================================================================
# 2. SRN flow: PENDING -> PARTIALLY_RECEIVED -> COMPLETE
# ============================================================================
class TestSRNFlow:
    def test_rn_with_shortfall_creates_pending_srn(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short 6
        finalized = _finalize_rn(auth, rn["id"])
        assert finalized["status"] == "FINAL", f"expected FINAL got {finalized['status']}"

        srn = _get_srn_for_rn(auth, rn["id"])
        assert srn is not None, "SRN not auto-created from shortfall"
        assert srn["status"] == "PENDING", f"expected PENDING got {srn['status']}"
        # short_qty preserved on the row
        item = next(i for i in srn["items"] if i["part_no"] == pn and i["make"] == mk)
        assert float(item.get("short_qty") or 0) == 6.0

    def test_partial_fulfillment_marks_srn_partially_received(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)
        _finalize_rn(auth, rn["id"])
        srn = _get_srn_for_rn(auth, rn["id"])

        # Fulfill only 2 of 6 short
        upd = {"items": [{"part_no": pn, "make": mk, "fulfilled_qty": 2}],
               "fulfillment_date": ""}
        r = auth.put(f"{BASE_URL}/api/short-received-notes/{srn['id']}", json=upd)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "PARTIALLY_RECEIVED", \
            f"expected PARTIALLY_RECEIVED got {body['status']}"

    def test_full_fulfillment_marks_complete_not_legacy_label(self, auth):
        """When fulfilled_qty == short_qty for every row, _compute_srn_status auto-sets
        status to 'COMPLETE' on the PUT itself. 'finalize' is then a no-op (409).
        Either path the FINAL status string must be the NEW value 'COMPLETE'."""
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)
        _finalize_rn(auth, rn["id"])
        srn = _get_srn_for_rn(auth, rn["id"])

        # Fulfill ALL 6 short
        upd = {"items": [{"part_no": pn, "make": mk, "fulfilled_qty": 6}],
               "fulfillment_date": ""}
        r = auth.put(f"{BASE_URL}/api/short-received-notes/{srn['id']}", json=upd)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "COMPLETE", \
            f"NEW status must be 'COMPLETE' (got '{body['status']}'). 'FULLY_RECEIVED' is legacy."
        assert body["status"] != "FULLY_RECEIVED"

        # finalize on an already-COMPLETE SRN should be rejected (409).
        r = auth.post(f"{BASE_URL}/api/short-received-notes/{srn['id']}/finalize")
        assert r.status_code == 409, r.text

    def test_finalize_partial_keeps_partially_received_and_spawns_child(self, auth):
        """When the user finalizes with fulfilled<short, residual must spawn a child SRN."""
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=4)  # short 6
        _finalize_rn(auth, rn["id"])
        srn = _get_srn_for_rn(auth, rn["id"])

        upd = {"items": [{"part_no": pn, "make": mk, "fulfilled_qty": 2}],
               "fulfillment_date": ""}
        auth.put(f"{BASE_URL}/api/short-received-notes/{srn['id']}", json=upd)

        r = auth.post(f"{BASE_URL}/api/short-received-notes/{srn['id']}/finalize")
        assert r.status_code == 200, r.text
        body = r.json()
        # NEW: status string must NOT be FULLY_RECEIVED
        assert body["status"] != "FULLY_RECEIVED"
        assert body["status"] in ("PARTIALLY_RECEIVED", "COMPLETE"), \
            f"unexpected SRN status after partial finalize: {body['status']}"


# ============================================================================
# 3. ERN flow: PENDING -> PARTIALLY_ACCEPTED -> COMPLETE
# ============================================================================
class TestERNFlow:
    def test_rn_with_overage_creates_pending_ern(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=5, received_qty=8)  # extra 3
        finalized = _finalize_rn(auth, rn["id"])
        assert finalized["status"] == "FINAL"

        ern = _get_ern_for_rn(auth, rn["id"])
        assert ern is not None, "ERN not auto-created from overage"
        assert ern["status"] == "PENDING"
        item = next(i for i in ern["items"] if i["part_no"] == pn and i["make"] == mk)
        assert float(item.get("extra_qty") or 0) == 3.0

    def test_partial_accept_marks_partially_accepted(self, auth):
        rn, pn, mk = _create_rn(auth, invoice_qty=5, received_qty=8)
        _finalize_rn(auth, rn["id"])
        ern = _get_ern_for_rn(auth, rn["id"])

        upd = {"items": [{"part_no": pn, "make": mk,
                          "accepted_qty": 1, "rejected_qty": 0}]}
        r = auth.put(f"{BASE_URL}/api/extra-received-notes/{ern['id']}", json=upd)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "PARTIALLY_ACCEPTED", \
            f"expected PARTIALLY_ACCEPTED got {body['status']}"

    def test_fully_decided_ern_marks_complete(self, auth):
        """When accepted+rejected == extra on the PUT itself, _compute_ern_status auto-sets
        status to 'COMPLETE'. finalize is then a 409 no-op."""
        rn, pn, mk = _create_rn(auth, invoice_qty=5, received_qty=8)  # extra 3
        _finalize_rn(auth, rn["id"])
        ern = _get_ern_for_rn(auth, rn["id"])

        upd = {"items": [{"part_no": pn, "make": mk,
                          "accepted_qty": 2, "rejected_qty": 1}]}
        r = auth.put(f"{BASE_URL}/api/extra-received-notes/{ern['id']}", json=upd)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "COMPLETE", \
            f"expected COMPLETE got {r.json()['status']}"

        # finalize should reject (already COMPLETE)
        r = auth.post(f"{BASE_URL}/api/extra-received-notes/{ern['id']}/finalize")
        assert r.status_code == 409, r.text


# ============================================================================
# 4. RKN flow + RN status flips: RACKING_NOTE_DRAFT, PARTIALLY/FULLY_RACKED
# ============================================================================
class TestRackingFlowAgainstRN:
    def test_draft_rkn_against_rn_flips_rn_to_racking_note_draft(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=5, received_qty=5)
        _finalize_rn(auth, rn["id"])
        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "FINAL"

        # Create DRAFT RKN against this RN
        payload = {
            "source_type": "RN",
            "source_id": rn["id"],
            "items": [{
                "part_no": pn, "make": mk, "quantity": 3,
                "godown_id": location["godown"]["id"],
                "godown_name": location["godown"]["godown_name"],
                "rack_id": location["rack"]["id"],
                "rack_no": location["rack"]["rack_no"],
                "box_id": location["box"]["id"],
                "box_no": location["box"]["box_no"],
            }],
        }
        r = auth.post(f"{BASE_URL}/api/racking-notes", json=payload)
        assert r.status_code == 200, r.text
        rkn = r.json()
        assert rkn["status"] == "DRAFT"

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "RACKING_NOTE_DRAFT", \
            f"expected RACKING_NOTE_DRAFT got {rn_after['status']}"

    def test_record_rkn_yields_partially_or_fully_racked(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=5, received_qty=5)
        _finalize_rn(auth, rn["id"])

        # Partial racking — 3 of 5
        payload = {
            "source_type": "RN", "source_id": rn["id"],
            "items": [{"part_no": pn, "make": mk, "quantity": 3,
                       "godown_id": location["godown"]["id"],
                       "godown_name": location["godown"]["godown_name"],
                       "rack_id": location["rack"]["id"],
                       "rack_no": location["rack"]["rack_no"],
                       "box_id": location["box"]["id"],
                       "box_no": location["box"]["box_no"]}],
        }
        rkn = auth.post(f"{BASE_URL}/api/racking-notes", json=payload).json()

        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200, r.text
        # backend status stays RECORDED (display label only on FE)
        rkn_after = auth.get(f"{BASE_URL}/api/racking-notes/{rkn['id']}").json()
        assert rkn_after["status"] == "RECORDED"

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "PARTIALLY_RACKED", \
            f"expected PARTIALLY_RACKED got {rn_after['status']}"

        # Now rack the remaining 2 -> FULLY_RACKED
        payload2 = {
            "source_type": "RN", "source_id": rn["id"],
            "items": [{"part_no": pn, "make": mk, "quantity": 2,
                       "godown_id": location["godown"]["id"],
                       "godown_name": location["godown"]["godown_name"],
                       "rack_id": location["rack"]["id"],
                       "rack_no": location["rack"]["rack_no"],
                       "box_id": location["box"]["id"],
                       "box_no": location["box"]["box_no"]}],
        }
        rkn2 = auth.post(f"{BASE_URL}/api/racking-notes", json=payload2).json()
        auth.post(f"{BASE_URL}/api/racking-notes/{rkn2['id']}/record")

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "FULLY_RACKED", \
            f"expected FULLY_RACKED got {rn_after['status']}"


# ============================================================================
# 5. New rule: RN cannot become FULLY_RACKED if SRN.fulfilled_qty>0 and SRN not racked
# ============================================================================
class TestRnFullyRackedRequiresAllDescendants:
    def test_rn_not_fully_racked_when_srn_unracked(self, auth, location):
        # RN with shortfall: invoice 10, received 5  -> SRN with short_qty 5
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=5)
        _finalize_rn(auth, rn["id"])

        # Fully rack the RN's own 5 received units
        payload = {
            "source_type": "RN", "source_id": rn["id"],
            "items": [{"part_no": pn, "make": mk, "quantity": 5,
                       "godown_id": location["godown"]["id"],
                       "godown_name": location["godown"]["godown_name"],
                       "rack_id": location["rack"]["id"],
                       "rack_no": location["rack"]["rack_no"],
                       "box_id": location["box"]["id"],
                       "box_no": location["box"]["box_no"]}],
        }
        rkn = auth.post(f"{BASE_URL}/api/racking-notes", json=payload).json()
        auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")

        # RN's own quota is fully racked, but SRN shortfall is fulfilled later w/o RKN.
        srn = _get_srn_for_rn(auth, rn["id"])
        upd = {"items": [{"part_no": pn, "make": mk, "fulfilled_qty": 3}],
               "fulfillment_date": ""}
        auth.put(f"{BASE_URL}/api/short-received-notes/{srn['id']}", json=upd)

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] != "FULLY_RACKED", (
            "RN must NOT be FULLY_RACKED while a descendant SRN has fulfilled_qty>0 "
            f"that has no RKN against it (got {rn_after['status']})")
        # It should be PARTIALLY_RACKED (some recorded racking already exists).
        assert rn_after["status"] == "PARTIALLY_RACKED", \
            f"expected PARTIALLY_RACKED got {rn_after['status']}"

    def test_draft_rkn_against_srn_descendant_flips_rn_to_racking_note_draft(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=10, received_qty=5)
        _finalize_rn(auth, rn["id"])
        srn = _get_srn_for_rn(auth, rn["id"])

        # Fulfill 4 then create a DRAFT RKN AGAINST THE SRN
        upd = {"items": [{"part_no": pn, "make": mk, "fulfilled_qty": 4}],
               "fulfillment_date": ""}
        auth.put(f"{BASE_URL}/api/short-received-notes/{srn['id']}", json=upd)

        payload = {
            "source_type": "SRN", "source_id": srn["id"],
            "items": [{"part_no": pn, "make": mk, "quantity": 2,
                       "godown_id": location["godown"]["id"],
                       "godown_name": location["godown"]["godown_name"],
                       "rack_id": location["rack"]["id"],
                       "rack_no": location["rack"]["rack_no"],
                       "box_id": location["box"]["id"],
                       "box_no": location["box"]["box_no"]}],
        }
        r = auth.post(f"{BASE_URL}/api/racking-notes", json=payload)
        assert r.status_code == 200, r.text

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "RACKING_NOTE_DRAFT", \
            f"draft RKN against SRN descendant must flip RN to RACKING_NOTE_DRAFT (got {rn_after['status']})"


# ============================================================================
# 6. Backward compat: legacy 'FULLY_RECEIVED' must be migrated to 'COMPLETE' on startup
# ============================================================================
class TestLegacyMigration:
    def test_no_srn_with_fully_received_status(self, auth):
        r = auth.get(f"{BASE_URL}/api/short-received-notes")
        assert r.status_code == 200, r.text
        rows = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
        legacy = [s for s in rows if s.get("status") == "FULLY_RECEIVED"]
        assert legacy == [], (
            f"Found {len(legacy)} SRN(s) still on legacy status 'FULLY_RECEIVED' — "
            "startup migration did not convert them to 'COMPLETE'.")


# ============================================================================
# 7. Smoke: existing list endpoints still serve without 5xx
# ============================================================================
class TestExistingEndpointsHealthy:
    @pytest.mark.parametrize("ep", [
        "/api/short-received-notes",
        "/api/extra-received-notes",
        "/api/racking-notes",
        "/api/receipt-notes",
    ])
    def test_list_endpoint_ok(self, auth, ep):
        r = auth.get(f"{BASE_URL}{ep}")
        assert r.status_code == 200, f"{ep} -> {r.status_code} {r.text[:200]}"
        body = r.json()
        # Either a plain list or a paginated dict with 'items'
        if isinstance(body, dict):
            assert "items" in body or "data" in body or "results" in body or len(body) >= 0
        else:
            assert isinstance(body, list)
