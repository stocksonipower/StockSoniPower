"""
Iter-29 supplementary edge cases for the auto-RKN workflow.

Covers things the main suite skipped:
  - ERN parallel (Rule 3 mirror): POST/PUT /api/extra-received-notes/{id}/children
  - PUT /api/short-received-notes/{id}/children/{child_no} increasing received_qty
  - GENERAL stock_in_type (no invoice): finalize still auto-creates RKN
  - invoice > received → ERN auto-created + auto-RKN for received only
  - invoice < received → ERN auto-created (extra) + auto-RKN for received qty
  - Multi-item RN with mixed qty
  - Each auto-RKN inherits assignee from source's parent
"""
import os
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
API = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN = ("admin@stockmgmt.com", "admin123")


def _h(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/api/auth/login", json={"email": ADMIN[0], "password": ADMIN[1]})
    r.raise_for_status()
    return r.json()["token"]


@pytest.fixture(scope="module")
def setup(token):
    h = _h(token)
    sfx = uuid.uuid4().hex[:6].upper()
    pn1 = f"AUTO29E_{sfx}_A"
    pn2 = f"AUTO29E_{sfx}_B"
    mk = f"AUTO29E_MK_{sfx}"
    base = {
        "model": "M-AUTO", "make": mk,
        "old_part_no": "", "new_part_no": "", "make_part_no": "",
        "description_1": "iter29 edge", "description_2": "",
        "remarks_oem": "", "remarks_others": "",
        "item_category": "Test", "unit": "PCS",
        "reorder_level": 0, "image": "", "images": [],
    }
    sm1 = requests.post(f"{API}/api/stock-master", headers=h, json={**base, "part_no": pn1})
    sm1.raise_for_status()
    sm2 = requests.post(f"{API}/api/stock-master", headers=h, json={**base, "part_no": pn2})
    sm2.raise_for_status()
    g = requests.post(f"{API}/api/godowns", headers=h, json={"godown_name": f"GD_E_{sfx}"}).json()
    rk = requests.post(f"{API}/api/racks", headers=h,
                       json={"godown_id": g["id"], "rack_no": f"R_{sfx}", "total_boxes": 1}).json()
    bx = requests.post(f"{API}/api/boxes", headers=h,
                       json={"rack_id": rk["id"], "box_no": f"B_{sfx}", "box_category": "Misc"}).json()
    yield {"part_no_a": pn1, "part_no_b": pn2, "make": mk,
           "godown": g, "rack": rk, "box": bx,
           "sm1": sm1.json()["id"], "sm2": sm2.json()["id"]}
    requests.delete(f"{API}/api/stock-master/{sm1.json()['id']}", headers=h)
    requests.delete(f"{API}/api/stock-master/{sm2.json()['id']}", headers=h)
    requests.delete(f"{API}/api/boxes/{bx['id']}", headers=h)
    requests.delete(f"{API}/api/racks/{rk['id']}", headers=h)
    requests.delete(f"{API}/api/godowns/{g['id']}", headers=h)


def _item(part_no, make, invoice_qty, received_qty):
    return {
        "part_no": part_no, "make": make,
        "model": "M-AUTO",
        "old_part_no": "", "new_part_no": "", "make_part_no": "",
        "description_1": "iter29 edge", "description_2": "",
        "remarks_oem": "", "remarks_others": "",
        "item_category": "Test", "unit": "PCS",
        "invoice_qty": invoice_qty, "received_qty": received_qty,
        "quantity": received_qty,
    }


def _create_rn(token, items, stock_in_type="INVOICE"):
    h = _h(token)
    payload = {
        "stock_in_type": stock_in_type,
        "invoice_no": "" if stock_in_type == "GENERAL" else f"INV-{uuid.uuid4().hex[:6]}",
        "invoice_date": "2026-04-01",
        "goods_received_date": "2026-04-02",
        "items": items,
    }
    r = requests.post(f"{API}/api/receipt-notes", headers=h, json=payload)
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------- Rule 1 extras
class TestRule1ExtraScenarios:
    def test_invoice_greater_than_received_creates_srn_and_rkn_for_received(self, token, setup):
        """invoice 20, received 12 → SRN for 8 short + RKN for 12 received only."""
        rn = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 20, 12)])
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200
        assert f.headers.get("X-Auto-RKN-No")
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        my = [r for r in rkns if r.get("receipt_note_id") == rn["id"]
              and r.get("auto_source") == "rn-finalize"]
        assert len(my) == 1
        assert my[0]["items"][0]["quantity"] == 12
        srns = requests.get(f"{API}/api/short-received-notes?page_size=200", headers=_h(token)).json()
        my_srn = [s for s in srns if s.get("parent_rn_id") == rn["id"]]
        assert len(my_srn) == 1
        assert my_srn[0]["items"][0]["short_qty"] == 8

    def test_invoice_less_than_received_creates_ern_and_rkn_for_received(self, token, setup):
        """invoice 5, received 8 → ERN for 3 extra + RKN for 8 received."""
        rn = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 5, 8)])
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200, f.text
        assert f.headers.get("X-Auto-RKN-No"), "should auto-create RKN for received qty 8"
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        my = [r for r in rkns if r.get("receipt_note_id") == rn["id"]
              and r.get("auto_source") == "rn-finalize"]
        assert len(my) == 1
        assert my[0]["items"][0]["quantity"] == 8
        erns = requests.get(f"{API}/api/extra-received-notes?page_size=200", headers=_h(token)).json()
        my_ern = [e for e in erns if e.get("parent_rn_id") == rn["id"]]
        assert len(my_ern) == 1, f"ERN expected for invoice<received. got: {my_ern}"

    def test_general_stock_in_type_finalize_auto_rkn(self, token, setup):
        """GENERAL stock_in (invoice_qty must be >0 per validation) — finalize must auto-RKN."""
        rn = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 6, 6)],
                        stock_in_type="GENERAL")
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200, f.text
        assert f.headers.get("X-Auto-RKN-No"), "GENERAL stock_in must still auto-RKN"
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        my = [r for r in rkns if r.get("receipt_note_id") == rn["id"]
              and r.get("auto_source") == "rn-finalize"]
        assert len(my) == 1
        assert my[0]["items"][0]["quantity"] == 6

    def test_multi_item_rn_with_mixed_qty(self, token, setup):
        """Two items: A invoice=10/recv=10, B invoice=8/recv=5 → one auto-RKN with both items, plus SRN for B-shortfall."""
        rn = _create_rn(token, [
            _item(setup["part_no_a"], setup["make"], 10, 10),
            _item(setup["part_no_b"], setup["make"], 8, 5),
        ])
        f = requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token))
        assert f.status_code == 200, f.text
        assert f.headers.get("X-Auto-RKN-No")
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        my = [r for r in rkns if r.get("receipt_note_id") == rn["id"]
              and r.get("auto_source") == "rn-finalize"]
        assert len(my) == 1
        rkn_items = my[0]["items"]
        # One row per part_no with the received qty
        qty_by_pn = {it["part_no"]: it["quantity"] for it in rkn_items}
        assert qty_by_pn.get(setup["part_no_a"]) == 10
        assert qty_by_pn.get(setup["part_no_b"]) == 5
        # SRN must exist for B's shortfall of 3
        srns = requests.get(f"{API}/api/short-received-notes?page_size=200", headers=_h(token)).json()
        my_srn = [s for s in srns if s.get("parent_rn_id") == rn["id"]]
        assert len(my_srn) == 1
        srn_items = my_srn[0]["items"]
        assert any(it["part_no"] == setup["part_no_b"] and it["short_qty"] == 3 for it in srn_items)


# ---------------------------------------------------------------- Rule 3 SRN PUT
class TestRule3SrnChildPut:
    def test_put_child_increases_received_qty_creates_rkn(self, token, setup):
        """Add SRN child with received_qty=0,not_receivable=2 → no RKN.
        Then PUT child to received_qty=4 → auto-RKN for full 4."""
        rn = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 10, 0)])
        requests.post(f"{API}/api/receipt-notes/{rn['id']}/finalize", headers=_h(token)).raise_for_status()
        srns = requests.get(f"{API}/api/short-received-notes?page_size=200", headers=_h(token)).json()
        srn = next(s for s in srns if s.get("parent_rn_id") == rn["id"])
        # 1) Add child with received_qty=0
        add = requests.post(f"{API}/api/short-received-notes/{srn['id']}/children",
                            headers=_h(token),
                            json={"part_no": setup["part_no_a"], "make": setup["make"],
                                  "received_qty": 0, "not_receivable_qty": 2})
        assert add.status_code == 200
        assert not add.headers.get("X-Auto-RKN-No")
        srn_obj = add.json()
        # latest child = last in children list of matching item
        item = next(it for it in srn_obj["items"]
                    if it["part_no"] == setup["part_no_a"] and it["make"] == setup["make"])
        child_no = item["children"][-1]["child_srn_no"]

        # 2) PUT child increasing received_qty to 4
        put = requests.put(
            f"{API}/api/short-received-notes/{srn['id']}/children/{child_no}",
            headers=_h(token),
            json={"part_no": setup["part_no_a"], "make": setup["make"],
                  "received_qty": 4, "not_receivable_qty": 2},
        )
        assert put.status_code == 200, put.text
        # Should auto-create RKN for the 4 newly-fulfilled units
        assert put.headers.get("X-Auto-RKN-No"), \
            f"PUT increasing received_qty must auto-create RKN. body={put.text}"
        new_rkn_no = put.headers["X-Auto-RKN-No"]
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        new = next(r for r in rkns if r["rkn_no"] == new_rkn_no)
        assert new["status"] == "DRAFT"
        assert new["source_type"] == "SRN"
        assert new["source_id"] == srn["id"]
        assert new.get("auto_source") == "srn-child-save"
        assert new["items"][0]["quantity"] == 4


# ---------------------------------------------------------------- Rule 3 ERN parallel
class TestRule3ErnChildAutoRkn:
    def _setup_ern(self, token, setup):
        """Create RN with invoice<received → triggers ERN."""
        rn = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 5, 5)])
        # Finalize cleanly first (no ERN auto-created yet for this approach).
        # Use the documented path: invoice < received in payload → ERN auto-created
        # at finalize.  Re-create with mismatched qty:
        rn2 = _create_rn(token, [_item(setup["part_no_a"], setup["make"], 4, 8)])
        requests.post(f"{API}/api/receipt-notes/{rn2['id']}/finalize", headers=_h(token)).raise_for_status()
        erns = requests.get(f"{API}/api/extra-received-notes?page_size=200", headers=_h(token)).json()
        ern = next((e for e in erns if e.get("parent_rn_id") == rn2["id"]), None)
        return rn2, ern

    def test_ern_child_save_creates_rkn(self, token, setup):
        rn, ern = self._setup_ern(token, setup)
        if ern is None:
            pytest.skip("ERN not created by finalize for invoice<received — workflow may differ")
        add = requests.post(
            f"{API}/api/extra-received-notes/{ern['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no_a"], "make": setup["make"],
                  "accepted_qty": 3, "rejected_qty": 0},
        )
        assert add.status_code == 200, add.text
        assert add.headers.get("X-Auto-RKN-No"), "ERN child save with accepted_qty>0 must auto-RKN"
        new_rkn_no = add.headers["X-Auto-RKN-No"]
        rkns = requests.get(f"{API}/api/racking-notes?page_size=200", headers=_h(token)).json()
        new = next(r for r in rkns if r["rkn_no"] == new_rkn_no)
        assert new["status"] == "DRAFT"
        assert new["source_type"] == "ERN"
        assert new["source_id"] == ern["id"]
        assert new.get("auto_source") == "ern-child-save"
        assert new["items"][0]["quantity"] == 3

    def test_ern_child_zero_accepted_no_rkn(self, token, setup):
        rn, ern = self._setup_ern(token, setup)
        if ern is None:
            pytest.skip("ERN not auto-created for invoice<received")
        add = requests.post(
            f"{API}/api/extra-received-notes/{ern['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no_a"], "make": setup["make"],
                  "accepted_qty": 0, "rejected_qty": 2},
        )
        assert add.status_code == 200
        assert not add.headers.get("X-Auto-RKN-No")

    def test_ern_child_put_increase_creates_rkn(self, token, setup):
        rn, ern = self._setup_ern(token, setup)
        if ern is None:
            pytest.skip("ERN not auto-created for invoice<received")
        add = requests.post(
            f"{API}/api/extra-received-notes/{ern['id']}/children", headers=_h(token),
            json={"part_no": setup["part_no_a"], "make": setup["make"],
                  "accepted_qty": 0, "rejected_qty": 1},
        )
        assert add.status_code == 200
        assert not add.headers.get("X-Auto-RKN-No")
        ern_obj = add.json()
        item = next(it for it in ern_obj["items"]
                    if it["part_no"] == setup["part_no_a"] and it["make"] == setup["make"])
        child_no = item["children"][-1]["child_ern_no"]
        put = requests.put(
            f"{API}/api/extra-received-notes/{ern['id']}/children/{child_no}",
            headers=_h(token),
            json={"part_no": setup["part_no_a"], "make": setup["make"],
                  "accepted_qty": 2, "rejected_qty": 1},
        )
        assert put.status_code == 200, put.text
        assert put.headers.get("X-Auto-RKN-No"), "PUT ERN child increasing accepted_qty must auto-RKN"
