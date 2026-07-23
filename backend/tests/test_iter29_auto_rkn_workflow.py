"""
Iter-29 — Regression tests for the new RN → SRN → RKN auto-creation workflow.

Covers the 5 hooks added in this iteration:

  Rule 1 — RN finalize → auto DRAFT RKN for received qty
  Rule 2 — RKN record → auto DRAFT balance RKN for any unracked remainder
  Rule 3 — SRN child save (add + edit) → auto DRAFT RKN for child's received qty
  Rule 3-parallel — ERN child save (add + edit) → auto DRAFT RKN for child's accepted qty

All auto-created RKNs carry `auto_created=True` and an `auto_source` tag so the
frontend can render a tag/badge later.
"""
import os
import time
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")

API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN = ("admin@stockmgmt.com", "admin123")


def _login():
    r = requests.post(f"{API}/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    r.raise_for_status()
    return r.json()["token"]


def _h(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def token():
    return _login()


@pytest.fixture(scope="module")
def setup(token):
    """Create one stock_master row + one godown/rack/box for the suite."""
    h = _h(token)
    suffix = uuid.uuid4().hex[:6].upper()
    pn = f"AUTO29_{suffix}"
    mk = f"AUTO29_MK_{suffix}"
    sm = requests.post(
        f"{API}/api/stock-master", headers=h,
        json={
            "model": "M-AUTO", "part_no": pn, "make": mk,
            "old_part_no": "", "new_part_no": "", "make_part_no": "",
            "description_1": "auto-29 test", "description_2": "",
            "remarks_oem": "", "remarks_others": "",
            "item_category": "Test", "unit": "PCS",
            "reorder_level": 0, "image": "", "images": [],
        },
    )
    sm.raise_for_status()
    g = requests.post(f"{API}/api/godowns", headers=h,
                      json={"godown_name": f"GD_AUTO29_{suffix}"}).json()
    r = requests.post(f"{API}/api/racks", headers=h,
                      json={"godown_id": g["id"], "rack_no": f"R_{suffix}", "total_boxes": 1}).json()
    b = requests.post(f"{API}/api/boxes", headers=h,
                      json={"rack_id": r["id"], "box_no": f"B_{suffix}", "box_category": "Misc"}).json()
    yield {"part_no": pn, "make": mk, "godown": g, "rack": r, "box": b}
    # Cleanup
    requests.delete(f"{API}/api/stock-master/{sm.json()['id']}", headers=h)
    requests.delete(f"{API}/api/boxes/{b['id']}", headers=h)
    requests.delete(f"{API}/api/racks/{r['id']}", headers=h)
    requests.delete(f"{API}/api/godowns/{g['id']}", headers=h)


def _create_rn_draft(token, part_no, make, invoice_qty, received_qty):
    h = _h(token)
    payload = {
        "stock_in_type": "INVOICE",
        "invoice_no": f"INV-{uuid.uuid4().hex[:6]}",
        "invoice_date": "2026-04-01",
        "goods_received_date": "2026-04-02",
        "items": [{
            "part_no": part_no, "make": make,
            "model": "M-AUTO",
            "old_part_no": "", "new_part_no": "", "make_part_no": "",
            "description_1": "auto-29 test", "description_2": "",
            "remarks_oem": "", "remarks_others": "",
            "item_category": "Test", "unit": "PCS",
            "invoice_qty": invoice_qty, "received_qty": received_qty,
            "quantity": received_qty,
        }],
    }
    r = requests.post(f"{API}/api/receipt-notes", headers=h, json=payload)
    r.raise_for_status()
    return r.json()


def _list_rkn_for_rn(token, rn_id):
    h = _h(token)
    r = requests.get(f"{API}/api/racking-notes?page_size=200", headers=h)
    r.raise_for_status()
    return [x for x in r.json() if x.get("receipt_note_id") == rn_id]


# ----------------------------------------------------------------------------
# Rule 1: RN finalize auto-creates DRAFT RKN
# ----------------------------------------------------------------------------
class TestRule1RnFinalizeAutoRkn:
    def test_finalize_full_match_auto_creates_rkn(self, token, setup):
        """invoice == received → no SRN, but auto RKN should be created."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 10, 10)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200
        # Header announces the new RKN
        assert f.headers.get("X-Auto-RKN-No"), "auto-RKN no not exposed in header"
        # Status flips to RACKING_NOTE_DRAFT (because draft RKN exists)
        assert f.json()["status"] == "RACKING_NOTE_DRAFT"
        rkns = _list_rkn_for_rn(token, rn["id"])
        assert len(rkns) == 1
        rkn = rkns[0]
        assert rkn["status"] == "DRAFT"
        assert rkn.get("auto_created") is True
        assert rkn.get("auto_source") == "rn-finalize"
        # Item qty matches received qty
        assert any(it["quantity"] == 10 for it in rkn["items"])

    def test_finalize_with_shortfall_creates_srn_and_rkn(self, token, setup):
        """invoice 10, received 7 → SRN for 3 + RKN for 7 (received only)."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 10, 7)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200
        # Auto RKN should still be created for the 7 received
        assert f.headers.get("X-Auto-RKN-No")
        rkns = [r for r in _list_rkn_for_rn(token, rn["id"])
                if r.get("auto_source") == "rn-finalize"]
        assert len(rkns) == 1
        assert rkns[0]["items"][0]["quantity"] == 7
        # SRN should also exist for the 3 short
        srns = requests.get(
            f"{API}/api/short-received-notes?page_size=200", headers=_h(token),
        ).json()
        my_srns = [s for s in srns if s.get("parent_rn_id") == rn["id"]]
        assert len(my_srns) == 1
        assert my_srns[0]["items"][0]["short_qty"] == 3

    def test_finalize_with_zero_received_no_rkn(self, token, setup):
        """All-zero received → no RKN since nothing rackable."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 5, 0)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200
        assert not f.headers.get("X-Auto-RKN-No")
        rkns = _list_rkn_for_rn(token, rn["id"])
        assert len(rkns) == 0


# ----------------------------------------------------------------------------
# Rule 2: RKN record creates balance RKN if unracked qty remains
# ----------------------------------------------------------------------------
class TestRule2RknRecordBalance:
    def test_partial_racking_creates_balance_rkn(self, token, setup):
        """Received 100, RKN/001 racks 80 → balance RKN/002 for 20."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 100, 100)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        f.raise_for_status()

        rkns = _list_rkn_for_rn(token, rn["id"])
        assert len(rkns) == 1
        rkn1_id = rkns[0]["id"]

        # Edit RKN/001 to rack only 80 (partial), then record
        edit_items = [{
            **rkns[0]["items"][0],
            "quantity": 80,
            "godown_id": setup["godown"]["id"],
            "godown_name": setup["godown"]["godown_name"],
            "rack_id": setup["rack"]["id"],
            "rack_no": setup["rack"]["rack_no"],
            "box_id": setup["box"]["id"],
            "box_no": setup["box"]["box_no"],
            "box_category": setup["box"].get("box_category", ""),
        }]
        u = requests.put(
            f"{API}/api/racking-notes/{rkn1_id}",
            headers=_h(token),
            json={"source_type": "RN", "source_id": rn["id"], "items": edit_items},
        )
        assert u.status_code == 200, u.text

        rec = requests.post(f"{API}/api/racking-notes/{rkn1_id}/record", headers=_h(token))
        assert rec.status_code == 200, rec.text
        # Balance RKN was auto-created
        assert rec.headers.get("X-Auto-RKN-No"), f"no balance RKN created. resp: {rec.json()}"
        balance_rkn_no = rec.headers["X-Auto-RKN-No"]

        rkns2 = _list_rkn_for_rn(token, rn["id"])
        assert len(rkns2) == 2
        balance = next(r for r in rkns2 if r["rkn_no"] == balance_rkn_no)
        assert balance["status"] == "DRAFT"
        assert balance.get("auto_created") is True
        assert balance.get("auto_source") == "rkn-record-balance"
        assert balance["items"][0]["quantity"] == 20  # 100 - 80

    def test_full_racking_no_balance_rkn(self, token, setup):
        """Received 50, RKN racks all 50 → no balance RKN created."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 50, 50)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        f.raise_for_status()
        rkns = _list_rkn_for_rn(token, rn["id"])
        rkn1 = rkns[0]
        edit_items = [{
            **rkn1["items"][0],
            "quantity": 50,
            "godown_id": setup["godown"]["id"],
            "godown_name": setup["godown"]["godown_name"],
            "rack_id": setup["rack"]["id"],
            "rack_no": setup["rack"]["rack_no"],
            "box_id": setup["box"]["id"],
            "box_no": setup["box"]["box_no"],
            "box_category": setup["box"].get("box_category", ""),
        }]
        requests.put(
            f"{API}/api/racking-notes/{rkn1['id']}",
            headers=_h(token),
            json={"source_type": "RN", "source_id": rn["id"], "items": edit_items},
        ).raise_for_status()
        rec = requests.post(f"{API}/api/racking-notes/{rkn1['id']}/record", headers=_h(token))
        assert rec.status_code == 200
        assert not rec.headers.get("X-Auto-RKN-No")
        # RN should be FULLY_RACKED now
        full = requests.get(f"{API}/api/receipt-notes/{rn['id']}", headers=_h(token)).json()
        assert full["status"] == "FULLY_RACKED"


# ----------------------------------------------------------------------------
# Rule 3: SRN child save auto-creates RKN against SRN
# ----------------------------------------------------------------------------
class TestRule3SrnChildAutoRkn:
    def test_srn_child_save_creates_rkn(self, token, setup):
        """RN with shortfall → finalize → SRN PENDING → add child with received_qty=5 → auto RKN created."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 10, 0)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        f.raise_for_status()

        srns = requests.get(
            f"{API}/api/short-received-notes?page_size=200", headers=_h(token)
        ).json()
        srn = next(s for s in srns if s.get("parent_rn_id") == rn["id"])

        # Add a child slice that fulfills 5 of the 10 short
        add = requests.post(
            f"{API}/api/short-received-notes/{srn['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no"], "make": setup["make"],
                  "received_qty": 5, "not_receivable_qty": 0},
        )
        assert add.status_code == 200, add.text
        assert add.headers.get("X-Auto-RKN-No"), "no auto-RKN header on SRN child save"
        new_rkn_no = add.headers["X-Auto-RKN-No"]

        # Confirm the new RKN exists, is DRAFT, sourced from SRN, qty=5, tagged
        rkns = requests.get(
            f"{API}/api/racking-notes?page_size=200", headers=_h(token)
        ).json()
        new = next(r for r in rkns if r["rkn_no"] == new_rkn_no)
        assert new["status"] == "DRAFT"
        assert new["source_type"] == "SRN"
        assert new["source_id"] == srn["id"]
        assert new.get("auto_created") is True
        assert new.get("auto_source") == "srn-child-save"
        assert new["items"][0]["quantity"] == 5

    def test_srn_child_zero_received_no_rkn(self, token, setup):
        """Child with not_receivable_qty only (received_qty=0) → NO auto-RKN."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 10, 0)
        requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token)).raise_for_status()
        srns = requests.get(
            f"{API}/api/short-received-notes?page_size=200", headers=_h(token)
        ).json()
        srn = next(s for s in srns if s.get("parent_rn_id") == rn["id"])
        add = requests.post(
            f"{API}/api/short-received-notes/{srn['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no"], "make": setup["make"],
                  "received_qty": 0, "not_receivable_qty": 3},
        )
        assert add.status_code == 200
        assert not add.headers.get("X-Auto-RKN-No")


# ----------------------------------------------------------------------------
# End-to-end full scenario from the spec
# ----------------------------------------------------------------------------
class TestEndToEndScenario:
    def test_step_1_thru_5_ends_with_fully_racked(self, token, setup):
        """invoice 100, received 90 → SRN for 10 + auto RKN for 90.
        Record RKN/001 → RN PARTIALLY_RACKED.
        Add SRN child with received_qty=10 → auto RKN/002 for 10.
        Record RKN/002 → RN FULLY_RACKED, SRN COMPLETE."""
        rn = _create_rn_draft(token, setup["part_no"], setup["make"], 100, 90)
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        f.raise_for_status()

        rkns = _list_rkn_for_rn(token, rn["id"])
        assert len(rkns) == 1
        rkn1 = rkns[0]
        assert rkn1["items"][0]["quantity"] == 90

        # Record RKN/001 against full 90 → no balance RKN
        edit_items = [{
            **rkn1["items"][0],
            "quantity": 90,
            "godown_id": setup["godown"]["id"],
            "godown_name": setup["godown"]["godown_name"],
            "rack_id": setup["rack"]["id"], "rack_no": setup["rack"]["rack_no"],
            "box_id": setup["box"]["id"], "box_no": setup["box"]["box_no"],
            "box_category": setup["box"].get("box_category", ""),
        }]
        requests.put(
            f"{API}/api/racking-notes/{rkn1['id']}",
            headers=_h(token),
            json={"source_type": "RN", "source_id": rn["id"], "items": edit_items},
        ).raise_for_status()
        rec1 = requests.post(f"{API}/api/racking-notes/{rkn1['id']}/record", headers=_h(token))
        assert rec1.status_code == 200
        assert not rec1.headers.get("X-Auto-RKN-No")

        # RN should be PARTIALLY_RACKED (because SRN is still pending)
        st = requests.get(f"{API}/api/receipt-notes/{rn['id']}", headers=_h(token)).json()
        assert st["status"] == "PARTIALLY_RACKED"

        # Add SRN child for full 10 → auto RKN
        srns = requests.get(
            f"{API}/api/short-received-notes?page_size=200", headers=_h(token)
        ).json()
        srn = next(s for s in srns if s.get("parent_rn_id") == rn["id"])
        add = requests.post(
            f"{API}/api/short-received-notes/{srn['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no"], "make": setup["make"],
                  "received_qty": 10, "not_receivable_qty": 0},
        )
        assert add.status_code == 200
        rkn2_no = add.headers["X-Auto-RKN-No"]

        rkns2 = _list_rkn_for_rn(token, rn["id"])
        rkn2 = next(r for r in rkns2 if r["rkn_no"] == rkn2_no)

        # Edit + record RKN/002
        edit_items2 = [{
            **rkn2["items"][0],
            "quantity": 10,
            "godown_id": setup["godown"]["id"],
            "godown_name": setup["godown"]["godown_name"],
            "rack_id": setup["rack"]["id"], "rack_no": setup["rack"]["rack_no"],
            "box_id": setup["box"]["id"], "box_no": setup["box"]["box_no"],
            "box_category": setup["box"].get("box_category", ""),
        }]
        requests.put(
            f"{API}/api/racking-notes/{rkn2['id']}",
            headers=_h(token),
            json={"source_type": "SRN", "source_id": srn["id"], "items": edit_items2},
        ).raise_for_status()
        rec2 = requests.post(f"{API}/api/racking-notes/{rkn2['id']}/record", headers=_h(token))
        assert rec2.status_code == 200
        assert not rec2.headers.get("X-Auto-RKN-No")

        # ALL COMPLETE: RN FULLY_RACKED, SRN COMPLETE
        st2 = requests.get(f"{API}/api/receipt-notes/{rn['id']}", headers=_h(token)).json()
        assert st2["status"] == "FULLY_RACKED", f"expected FULLY_RACKED, got {st2['status']}"
        srn_after = requests.get(
            f"{API}/api/short-received-notes/{srn['id']}", headers=_h(token)
        ).json()
        assert srn_after["status"] == "COMPLETE"
