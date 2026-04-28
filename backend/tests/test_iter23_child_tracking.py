"""
iter-23 regression: child SRN/ERN tracking (`children: [...]`) on parent items.

When a parent SRN/ERN is partially fulfilled/decided and finalized, the backend
auto-creates a CHILD SRN/ERN for the residual qty AND now stamps a
`children: [{child_srn_id|child_ern_id, child_srn_no|child_ern_no, short_qty|extra_qty, created_at}]`
entry on every parent item that contributed residual.

Test cases:
  TC1 — simple RN -> Racking (no SRN/ERN spawn)
  TC2 — RN(short) -> SRN -> child SRN with children[] back-reference
  TC3 — RN(over)  -> ERN -> child ERN with children[] back-reference
  TC4 — 3-level SRN chain (parent -> child -> grandchild)
  TC5 — child IDs are resolvable via GET endpoints
"""

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


# ---------- shared fixtures (mirror iter21 suite) -----------------------------

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
        json={
            "godown_id": g["id"],
            "rack_no": f"TR{uuid.uuid4().hex[:4]}",
            "total_boxes": 2,
        },
    ).json()
    b = auth.post(
        f"{BASE_URL}/api/boxes",
        json={
            "rack_id": r["id"],
            "box_no": f"TB{uuid.uuid4().hex[:4]}",
            "box_category": "STD",
        },
    ).json()
    return {"godown": g, "rack": r, "box": b}


# ---------- helpers -----------------------------------------------------------

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
        "items": [
            {
                "part_no": pn,
                "make": mk,
                "invoice_qty": invoice_qty,
                "received_qty": received_qty,
            }
        ],
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


def _get_srn(auth, srn_id):
    r = auth.get(f"{BASE_URL}/api/short-received-notes/{srn_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _get_ern(auth, ern_id):
    r = auth.get(f"{BASE_URL}/api/extra-received-notes/{ern_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _get_srn_for_rn(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/short-received-notes")
    rows = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
    for s in rows:
        if s.get("parent_rn_id") == rn_id and not s.get("parent_srn_id"):
            return s
    return None


def _get_ern_for_rn(auth, rn_id):
    r = auth.get(f"{BASE_URL}/api/extra-received-notes")
    rows = r.json() if isinstance(r.json(), list) else r.json().get("items", [])
    for e in rows:
        if e.get("parent_rn_id") == rn_id and not e.get("parent_ern_id"):
            return e
    return None


def _rkn_payload(rn_id, pn, mk, qty, location, source_type="RN"):
    return {
        "source_type": source_type,
        "source_id": rn_id,
        "items": [
            {
                "part_no": pn,
                "make": mk,
                "quantity": qty,
                "godown_id": location["godown"]["id"],
                "godown_name": location["godown"]["godown_name"],
                "rack_id": location["rack"]["id"],
                "rack_no": location["rack"]["rack_no"],
                "box_id": location["box"]["id"],
                "box_no": location["box"]["box_no"],
            }
        ],
    }


# ============================================================================
# TC1 — simple RN -> Racking
# ============================================================================
class TestTC1SimpleRnRacking:
    def test_rn_finalize_then_full_racking(self, auth, location):
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=100)
        finalized = _finalize_rn(auth, rn["id"])
        assert finalized["status"] == "FINAL"

        # No SRN / no ERN spawned
        assert _get_srn_for_rn(auth, rn["id"]) is None
        assert _get_ern_for_rn(auth, rn["id"]) is None

        # Create + record RKN for full 100
        rkn = auth.post(
            f"{BASE_URL}/api/racking-notes",
            json=_rkn_payload(rn["id"], pn, mk, 100, location, "RN"),
        ).json()
        r = auth.post(f"{BASE_URL}/api/racking-notes/{rkn['id']}/record")
        assert r.status_code == 200, r.text

        rkn_after = auth.get(f"{BASE_URL}/api/racking-notes/{rkn['id']}").json()
        assert rkn_after["status"] == "RECORDED"

        rn_after = _get_rn(auth, rn["id"])
        assert rn_after["status"] == "FULLY_RACKED", (
            f"expected FULLY_RACKED got {rn_after['status']}"
        )


# ============================================================================
# TC2 — RN(short) -> SRN -> child SRN with children[] entry
# ============================================================================
class TestTC2ChildSrnTracking:
    def test_child_srn_back_reference_in_parent_items(self, auth):
        # invoice 100 / received 80 -> short 20
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=80)
        _finalize_rn(auth, rn["id"])

        parent_srn = _get_srn_for_rn(auth, rn["id"])
        assert parent_srn is not None
        assert parent_srn["status"] == "PENDING"
        assert float(parent_srn["items"][0]["short_qty"]) == 20.0

        # PUT only (don't finalize) — fulfilled_qty=5 -> PARTIALLY_RECEIVED
        upd = {
            "items": [{"part_no": pn, "make": mk, "fulfilled_qty": 5}],
            "fulfillment_date": "",
        }
        r = auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent_srn['id']}", json=upd
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "PARTIALLY_RECEIVED", body["status"]

        # Now finalize -> should spawn CHILD SRN with short_qty=15
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent_srn['id']}/finalize"
        )
        assert r.status_code == 200, r.text

        # Re-fetch parent SRN and inspect children[]
        parent_after = _get_srn(auth, parent_srn["id"])
        item = next(
            i for i in parent_after["items"]
            if i.get("part_no") == pn and i.get("make") == mk
        )
        children = item.get("children") or []
        assert len(children) == 1, (
            f"expected exactly 1 child entry, got {len(children)}: {children}"
        )
        ch = children[0]
        assert ch.get("child_srn_id"), f"missing child_srn_id: {ch}"
        assert ch.get("child_srn_no", "").startswith("SRN/"), ch
        assert float(ch.get("short_qty") or 0) == 15.0, ch
        assert ch.get("created_at"), ch

        # Resolve the child SRN through public GET endpoint (TC5)
        child = _get_srn(auth, ch["child_srn_id"])
        assert child["srn_no"] == ch["child_srn_no"]
        assert child["status"] == "PENDING"
        assert child["parent_srn_id"] == parent_srn["id"]
        assert child["parent_rn_id"] == rn["id"]
        ch_item = next(
            i for i in child["items"] if i["part_no"] == pn and i["make"] == mk
        )
        assert float(ch_item["short_qty"]) == 15.0


# ============================================================================
# TC3 — RN(over) -> ERN -> child ERN with children[] entry
# ============================================================================
class TestTC3ChildErnTracking:
    def test_child_ern_back_reference_in_parent_items(self, auth):
        # invoice 100 / received 110 -> extra 10
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=110)
        _finalize_rn(auth, rn["id"])

        parent_ern = _get_ern_for_rn(auth, rn["id"])
        assert parent_ern is not None
        assert parent_ern["status"] == "PENDING"
        assert float(parent_ern["items"][0]["extra_qty"]) == 10.0

        # PUT only — accepted=3 / rejected=0 -> 3<10 -> PARTIALLY_ACCEPTED
        upd = {
            "items": [
                {"part_no": pn, "make": mk, "accepted_qty": 3, "rejected_qty": 0}
            ]
        }
        r = auth.put(
            f"{BASE_URL}/api/extra-received-notes/{parent_ern['id']}", json=upd
        )
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "PARTIALLY_ACCEPTED", r.json()["status"]

        # Finalize -> child ERN with extra_qty=7
        r = auth.post(
            f"{BASE_URL}/api/extra-received-notes/{parent_ern['id']}/finalize"
        )
        assert r.status_code == 200, r.text

        parent_after = _get_ern(auth, parent_ern["id"])
        item = next(
            i for i in parent_after["items"]
            if i.get("part_no") == pn and i.get("make") == mk
        )
        children = item.get("children") or []
        assert len(children) == 1, f"expected 1 child ERN entry, got: {children}"
        ch = children[0]
        assert ch.get("child_ern_id"), ch
        assert ch.get("child_ern_no", "").startswith("ERN/"), ch
        assert float(ch.get("extra_qty") or 0) == 7.0, ch
        assert ch.get("created_at"), ch

        # Resolve via GET endpoint
        child = _get_ern(auth, ch["child_ern_id"])
        assert child["ern_no"] == ch["child_ern_no"]
        assert child["status"] == "PENDING"
        assert child["parent_ern_id"] == parent_ern["id"]
        assert child["parent_rn_id"] == rn["id"]
        ch_item = next(
            i for i in child["items"] if i["part_no"] == pn and i["make"] == mk
        )
        assert float(ch_item["extra_qty"]) == 7.0


# ============================================================================
# TC4 — 3-level SRN chain (parent -> child -> grandchild)
# ============================================================================
class TestTC4ThreeLevelSrnChain:
    def test_three_level_srn_chain_with_back_references(self, auth):
        # RN inv 100 / received 80 -> parent SRN short=20
        rn, pn, mk = _create_rn(auth, invoice_qty=100, received_qty=80)
        _finalize_rn(auth, rn["id"])
        parent_srn = _get_srn_for_rn(auth, rn["id"])
        assert float(parent_srn["items"][0]["short_qty"]) == 20.0

        # PUT parent fulfilled=5 (<20) then finalize -> child SRN (short=15)
        auth.put(
            f"{BASE_URL}/api/short-received-notes/{parent_srn['id']}",
            json={
                "items": [{"part_no": pn, "make": mk, "fulfilled_qty": 5}],
                "fulfillment_date": "",
            },
        )
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{parent_srn['id']}/finalize"
        )
        assert r.status_code == 200, r.text

        parent_after = _get_srn(auth, parent_srn["id"])
        p_children = parent_after["items"][0].get("children") or []
        assert len(p_children) == 1, p_children
        child_srn_id = p_children[0]["child_srn_id"]
        assert float(p_children[0]["short_qty"]) == 15.0

        # Now PUT child SRN fulfilled=8 (<15) then finalize -> grandchild (short=7)
        child = _get_srn(auth, child_srn_id)
        assert child["parent_srn_id"] == parent_srn["id"]
        assert child["parent_rn_id"] == rn["id"]

        auth.put(
            f"{BASE_URL}/api/short-received-notes/{child_srn_id}",
            json={
                "items": [{"part_no": pn, "make": mk, "fulfilled_qty": 8}],
                "fulfillment_date": "",
            },
        )
        r = auth.post(
            f"{BASE_URL}/api/short-received-notes/{child_srn_id}/finalize"
        )
        assert r.status_code == 200, r.text

        child_after = _get_srn(auth, child_srn_id)
        c_children = child_after["items"][0].get("children") or []
        assert len(c_children) == 1, c_children
        grandchild_srn_id = c_children[0]["child_srn_id"]
        assert float(c_children[0]["short_qty"]) == 7.0

        # Grandchild: no children, parent links chain back to original RN
        grand = _get_srn(auth, grandchild_srn_id)
        assert grand["parent_srn_id"] == child_srn_id
        assert grand["parent_rn_id"] == rn["id"], (
            f"parent_rn_id must propagate to original RN, got {grand['parent_rn_id']}"
        )
        gc_children = grand["items"][0].get("children") or []
        assert gc_children == [], f"grandchild must have no children yet: {gc_children}"
        assert float(grand["items"][0]["short_qty"]) == 7.0
        assert grand["status"] == "PENDING"


# ============================================================================
# TC5 — child IDs resolve via public GET endpoints
# ============================================================================
class TestTC5ChildIdsResolvable:
    def test_child_srn_and_ern_get_endpoints(self, auth):
        # SRN side
        rn1, pn1, mk1 = _create_rn(auth, invoice_qty=20, received_qty=10)
        _finalize_rn(auth, rn1["id"])
        srn = _get_srn_for_rn(auth, rn1["id"])
        auth.put(
            f"{BASE_URL}/api/short-received-notes/{srn['id']}",
            json={
                "items": [{"part_no": pn1, "make": mk1, "fulfilled_qty": 1}],
                "fulfillment_date": "",
            },
        )
        auth.post(f"{BASE_URL}/api/short-received-notes/{srn['id']}/finalize")
        srn_after = _get_srn(auth, srn["id"])
        ch_srn_id = srn_after["items"][0]["children"][0]["child_srn_id"]
        r = auth.get(f"{BASE_URL}/api/short-received-notes/{ch_srn_id}")
        assert r.status_code == 200, r.text
        assert r.json()["id"] == ch_srn_id

        # ERN side
        rn2, pn2, mk2 = _create_rn(auth, invoice_qty=10, received_qty=20)
        _finalize_rn(auth, rn2["id"])
        ern = _get_ern_for_rn(auth, rn2["id"])
        auth.put(
            f"{BASE_URL}/api/extra-received-notes/{ern['id']}",
            json={
                "items": [
                    {"part_no": pn2, "make": mk2, "accepted_qty": 1, "rejected_qty": 0}
                ]
            },
        )
        auth.post(f"{BASE_URL}/api/extra-received-notes/{ern['id']}/finalize")
        ern_after = _get_ern(auth, ern["id"])
        ch_ern_id = ern_after["items"][0]["children"][0]["child_ern_id"]
        r = auth.get(f"{BASE_URL}/api/extra-received-notes/{ch_ern_id}")
        assert r.status_code == 200, r.text
        assert r.json()["id"] == ch_ern_id
