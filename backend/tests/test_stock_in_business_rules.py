"""Business-rule regression tests for Stock In.

These tests cover the repaired rules:
- direct /stock-in must not create inventory
- GENERAL receipt notes do not require invoice_qty
- legacy SRN/ERN update paths still auto-create RKNs
- ERN reject closes pending extra qty without creating stock/racking
"""
import os
import uuid

import pytest
import requests
from dotenv import load_dotenv

load_dotenv("/app/frontend/.env")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
pytestmark = pytest.mark.skipif(not BASE_URL, reason="REACT_APP_BACKEND_URL must be set")
API = lambda path: f"{BASE_URL}/api{path}"


@pytest.fixture(scope="module")
def auth():
    s = requests.Session()
    credentials = [
        (os.environ.get("ADMIN_EMAIL", ""), os.environ.get("ADMIN_PASSWORD", "")),
        ("admin@stockmgmt.com", "admin123"),
        ("admin@stock.com", "admin123"),
    ]
    r = None
    for email, password in credentials:
        if not email or not password:
            continue
        r = s.post(API("/auth/login"), json={"email": email, "password": password}, timeout=20)
        if r.status_code == 200:
            break
    assert r is not None and r.status_code == 200, r.text if r is not None else "No admin credentials configured"
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def seed(auth):
    suffix = uuid.uuid4().hex[:8].upper()
    sm = auth.post(API("/stock-master"), json={
        "part_no": f"BR_{suffix}",
        "make": f"MK_{suffix}",
        "model": "BR",
        "description_1": "business rules",
        "unit": "PCS",
        "reorder_level": 0,
    }, timeout=20)
    assert sm.status_code == 200, sm.text
    g = auth.post(API("/godowns"), json={"godown_name": f"GD_BR_{suffix}"}, timeout=20)
    assert g.status_code == 200, g.text
    rk = auth.post(API("/racks"), json={"godown_id": g.json()["id"], "rack_no": f"R_BR_{suffix}", "total_boxes": 1}, timeout=20)
    assert rk.status_code == 200, rk.text
    bx = auth.post(API("/boxes"), json={"rack_id": rk.json()["id"], "box_no": f"B_BR_{suffix}", "box_category": "TEST"}, timeout=20)
    assert bx.status_code == 200, bx.text
    return {"stock_master": sm.json(), "godown": g.json(), "rack": rk.json(), "box": bx.json()}


def _create_rn(auth, seed, invoice_qty, received_qty, stock_in_type="INVOICE", include_invoice=True):
    item = {
        "part_no": seed["stock_master"]["part_no"],
        "make": seed["stock_master"]["make"],
        "received_qty": received_qty,
    }
    if include_invoice:
        item["invoice_qty"] = invoice_qty
    r = auth.post(API("/receipt-notes"), json={
        "stock_in_type": stock_in_type,
        "invoice_no": "" if stock_in_type == "GENERAL" else f"INV-{uuid.uuid4().hex[:6]}",
        "invoice_date": "",
        "goods_received_date": "",
        "items": [item],
    }, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()


def _list_rkns(auth, **params):
    r = auth.get(API("/racking-notes"), params={"page_size": 5000, **params}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()


def test_direct_stock_in_is_disabled(auth, seed):
    r = auth.post(API("/stock-in"), json={
        "part_no": seed["stock_master"]["part_no"],
        "make": seed["stock_master"]["make"],
        "quantity": 1,
        "godown_id": seed["godown"]["id"],
        "rack_id": seed["rack"]["id"],
        "box_id": seed["box"]["id"],
    }, timeout=20)
    assert r.status_code == 410, r.text


def test_general_receipt_omits_invoice_qty_and_auto_creates_rkn(auth, seed):
    rn = _create_rn(auth, seed, invoice_qty=None, received_qty=15, stock_in_type="GENERAL", include_invoice=False)
    assert rn["items"][0]["invoice_qty"] == 15
    f = auth.post(API(f"/receipt-notes/{rn['id']}/finalize"), timeout=20)
    assert f.status_code == 200, f.text
    rkns = [r for r in _list_rkns(auth) if r.get("source_type") == "RN" and r.get("source_id") == rn["id"]]
    assert len(rkns) == 1
    assert rkns[0]["status"] == "DRAFT"
    assert rkns[0]["items"][0]["quantity"] == 15


def test_legacy_srn_update_auto_creates_rkn(auth, seed):
    rn = _create_rn(auth, seed, invoice_qty=10, received_qty=8)
    auth.post(API(f"/receipt-notes/{rn['id']}/finalize"), timeout=20).raise_for_status()
    srns = auth.get(API("/short-received-notes"), params={"parent_rn_id": rn["id"]}, timeout=20).json()
    srn = srns[0]
    u = auth.put(API(f"/short-received-notes/{srn['id']}"), json={
        "items": [{
            "part_no": seed["stock_master"]["part_no"],
            "make": seed["stock_master"]["make"],
            "fulfilled_qty": 2,
        }],
    }, timeout=20)
    assert u.status_code == 200, u.text
    assert u.headers.get("X-Auto-RKN-No")
    assert u.json()["status"] == "COMPLETE"
    rkns = [r for r in _list_rkns(auth) if r.get("source_type") == "SRN" and r.get("source_id") == srn["id"]]
    assert len(rkns) == 1
    assert rkns[0]["items"][0]["quantity"] == 2


def test_legacy_ern_update_auto_creates_rkn_for_accepted_qty(auth, seed):
    rn = _create_rn(auth, seed, invoice_qty=10, received_qty=12)
    auth.post(API(f"/receipt-notes/{rn['id']}/finalize"), timeout=20).raise_for_status()
    erns = auth.get(API("/extra-received-notes"), params={"parent_rn_id": rn["id"]}, timeout=20).json()
    ern = erns[0]
    u = auth.put(API(f"/extra-received-notes/{ern['id']}"), json={
        "items": [{
            "part_no": seed["stock_master"]["part_no"],
            "make": seed["stock_master"]["make"],
            "accepted_qty": 2,
            "rejected_qty": 0,
        }],
    }, timeout=20)
    assert u.status_code == 200, u.text
    assert u.headers.get("X-Auto-RKN-No")
    assert u.json()["status"] == "COMPLETE"
    rkns = [r for r in _list_rkns(auth) if r.get("source_type") == "ERN" and r.get("source_id") == ern["id"]]
    assert len(rkns) == 1
    assert rkns[0]["items"][0]["quantity"] == 2


def test_ern_reject_closes_without_rkn(auth, seed):
    rn = _create_rn(auth, seed, invoice_qty=10, received_qty=12)
    auth.post(API(f"/receipt-notes/{rn['id']}/finalize"), timeout=20).raise_for_status()
    ern = auth.get(API("/extra-received-notes"), params={"parent_rn_id": rn["id"]}, timeout=20).json()[0]
    before = [r for r in _list_rkns(auth) if r.get("source_type") == "ERN" and r.get("source_id") == ern["id"]]
    assert before == []
    rej = auth.post(API(f"/extra-received-notes/{ern['id']}/reject"), timeout=20)
    assert rej.status_code == 200, rej.text
    assert rej.json()["status"] == "COMPLETE"
    after = [r for r in _list_rkns(auth) if r.get("source_type") == "ERN" and r.get("source_id") == ern["id"]]
    assert after == []
