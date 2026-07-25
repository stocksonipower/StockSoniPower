"""WMS-grade Stock In domain tests.

Covers the full Receipt Note -> SRN/ERN -> Racking -> Stock chain, including the
synchronization, cascade, integrity and concurrency rules.

Run against an ISOLATED database — these tests create receipt notes, racking
notes and real stock ledger entries:

    DB_NAME=stock_management_test uvicorn server:app --port 8001
    WMS_BASE=http://127.0.0.1:8001 pytest tests/test_stock_in_wms.py -v
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

BASE = os.environ.get("WMS_BASE") or os.environ.get("REACT_APP_BACKEND_URL", "")
BASE = BASE.rstrip("/")
pytestmark = pytest.mark.skipif(not BASE, reason="WMS_BASE must point at an isolated test backend")
API = lambda p: f"{BASE}/api{p}"


def _rows(x):
    return x.get("items", x) if isinstance(x, dict) else x


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    for email, pw in [(os.environ.get("ADMIN_EMAIL", ""), os.environ.get("ADMIN_PASSWORD", "")),
                      ("admin@stock.com", "admin123"), ("admin@stockmgmt.com", "admin123")]:
        if not email:
            continue
        r = sess.post(API("/auth/login"), json={"email": email, "password": pw}, timeout=30)
        if r.status_code == 200:
            sess.headers.update({"Authorization": f"Bearer {r.json()['token']}",
                                 "Content-Type": "application/json"})
            return sess
    pytest.skip("no admin credentials worked")


@pytest.fixture(scope="module")
def loc(s):
    tag = uuid.uuid4().hex[:6].upper()
    g = s.post(API("/godowns"), json={"godown_name": f"WG-{tag}"}, timeout=30).json()
    rk = s.post(API("/racks"), json={"godown_id": g["id"], "rack_no": f"WR-{tag}", "total_boxes": 1},
                timeout=30).json()
    bx = s.post(API("/boxes"), json={"rack_id": rk["id"], "box_no": f"WB-{tag}", "box_category": "T"},
                timeout=30).json()
    return {"godown_id": g["id"], "godown_name": g["godown_name"], "rack_id": rk["id"],
            "rack_no": rk["rack_no"], "box_id": bx["id"], "box_no": bx["box_no"], "box_category": "T"}


def new_part(s):
    tag = uuid.uuid4().hex[:8].upper()
    body = {"part_no": f"WMS-{tag}", "make": "ACME", "description_1": "wms test part",
            "unit": "NOS", "item_category": "TEST", "reorder_level": 0}
    r = s.post(API("/stock-master"), json=body, timeout=30)
    assert r.status_code == 200, r.text
    return {"part_no": body["part_no"], "make": body["make"]}


def create_rn(s, rows, stock_in_type="INVOICE", narration=""):
    body = {"stock_in_type": stock_in_type, "invoice_no": f"IV-{uuid.uuid4().hex[:6]}",
            "invoice_date": "", "goods_received_date": "", "narration": narration,
            "items": [{"part_no": p["part_no"], "make": p["make"], "invoice_qty": inv,
                       "received_qty": rec} for (p, inv, rec) in rows]}
    r = s.post(API("/receipt-notes"), json=body, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def rn_edit_body(rn, rows, narration="edited"):
    return {"stock_in_type": rn.get("stock_in_type", "INVOICE"), "invoice_no": rn.get("invoice_no", ""),
            "invoice_date": "", "goods_received_date": "", "narration": narration,
            "items": [{"part_no": p["part_no"], "make": p["make"], "invoice_qty": inv,
                       "received_qty": rec} for (p, inv, rec) in rows]}


def finalize(s, rn):
    r = s.post(API(f"/receipt-notes/{rn['id']}/finalize"), timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def drafts_for_rn(s, rn_id):
    all_rkn = _rows(s.get(API("/racking-notes"), params={"page_size": 500}, timeout=30).json())
    return [k for k in all_rkn if k.get("receipt_note_id") == rn_id and k.get("status") == "DRAFT"]


def rack_and_record(s, rkn, loc):
    full = s.get(API(f"/racking-notes/{rkn['id']}"), timeout=30).json()
    for it in full["items"]:
        it.update(loc)
    up = s.put(API(f"/racking-notes/{rkn['id']}"),
               json={"source_type": full.get("source_type"), "source_id": full.get("source_id"),
                     "items": full["items"], "narration": ""}, timeout=30)
    assert up.status_code == 200, up.text
    return s.post(API(f"/racking-notes/{rkn['id']}/record"), timeout=30)


def stock_of(s, part):
    rowset = _rows(s.get(API("/stock-balance"), params={"search": part["part_no"]}, timeout=30).json())
    return sum(float(x.get("total_quantity") or 0) for x in rowset
               if x.get("part_no") == part["part_no"] and x.get("make") == part["make"])


def srns_of(s, rn_id):
    return _rows(s.get(API("/short-received-notes"), params={"parent_rn_id": rn_id}, timeout=30).json())


def erns_of(s, rn_id):
    return _rows(s.get(API("/extra-received-notes"), params={"parent_rn_id": rn_id}, timeout=30).json())


# ---------------------------------------------------------------- workflow 1
def test_normal_receipt_auto_racks_and_holds_stock_until_recorded(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 10)])
    assert rn["status"] == "DRAFT"
    out = finalize(s, rn)
    assert out["status"] == "RACKING_NOTE_DRAFT"

    d = drafts_for_rn(s, rn["id"])
    assert d, "finalize must auto-create a DRAFT racking note"
    assert d[0].get("auto_source") == "rn-finalize"
    assert stock_of(s, p) == 0, "no stock may exist before racking is recorded"

    assert rack_and_record(s, d[0], loc).status_code == 200
    assert stock_of(s, p) == 10


# ------------------------------------------------- workflow 1: live sync (fix)
def test_receipt_note_editable_while_racking_incomplete(s):
    """The core regression: a DRAFT racking note must not freeze its parent."""
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 10)])
    finalize(s, rn)
    assert drafts_for_rn(s, rn["id"]), "precondition: an auto DRAFT racking note exists"

    r = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 12, 12)]), timeout=30)
    assert r.status_code == 200, f"RN must stay editable until stock moves: {r.text}"
    assert s.get(API(f"/receipt-notes/{rn['id']}"), timeout=30).json()["items"][0]["invoice_qty"] == 12


def test_edit_clamps_draft_racking_quantity(s):
    """Reducing received qty must propagate down to the pending racking note."""
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 10)])
    finalize(s, rn)

    r = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 4, 4)]), timeout=30)
    assert r.status_code == 200, r.text
    for k in drafts_for_rn(s, rn["id"]):
        full = s.get(API(f"/racking-notes/{k['id']}"), timeout=30).json()
        for it in full["items"]:
            assert float(it["quantity"]) <= 4 + 1e-6, "racking qty must be clamped to the new received qty"


def test_edit_resyncs_shortfall_on_srn(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 6)])          # shortfall 4
    finalize(s, rn)
    assert float(srns_of(s, rn["id"])[0]["items"][0]["short_qty"]) == 4

    r = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 10, 8)]), timeout=30)
    assert r.status_code == 200, r.text
    assert float(srns_of(s, rn["id"])[0]["items"][0]["short_qty"]) == 2, "shortfall must follow the parent"


def test_edit_removing_shortfall_deletes_srn(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 6)])
    finalize(s, rn)
    assert srns_of(s, rn["id"])

    r = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 10, 10)]), timeout=30)
    assert r.status_code == 200, r.text
    assert not srns_of(s, rn["id"]), "no shortfall left, so the SRN must not be stranded"


def test_edit_cannot_shrink_below_already_received(s):
    """Integrity: an edit may not strand quantity a supplier already delivered."""
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 4)])          # shortfall 6
    finalize(s, rn)
    srn = srns_of(s, rn["id"])[0]
    add = s.post(API(f"/short-received-notes/{srn['id']}/children"),
                 json={"part_no": p["part_no"], "make": p["make"], "received_qty": 5,
                       "not_receivable_qty": 0}, timeout=30)
    assert add.status_code == 200, add.text

    # New shortfall would be 2, but 5 has already been received against it.
    r = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 10, 8)]), timeout=30)
    assert r.status_code == 409
    assert "already has" in r.text


def test_edit_and_delete_blocked_once_stock_recorded(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 5, 5)])
    finalize(s, rn)
    assert rack_and_record(s, drafts_for_rn(s, rn["id"])[0], loc).status_code == 200

    e = s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 9, 9)]), timeout=30)
    assert e.status_code == 409 and "already been recorded" in e.text
    d = s.delete(API(f"/receipt-notes/{rn['id']}"), timeout=30)
    assert d.status_code == 409 and "already been recorded" in d.text


# ------------------------------------------------------------ delete cascade
def test_delete_cascades_pending_children(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 6)])          # yields an SRN + a DRAFT racking note
    finalize(s, rn)
    assert srns_of(s, rn["id"]) and drafts_for_rn(s, rn["id"])

    r = s.delete(API(f"/receipt-notes/{rn['id']}"), timeout=30)
    assert r.status_code == 200, r.text
    assert s.get(API(f"/receipt-notes/{rn['id']}"), timeout=30).status_code == 404
    assert not srns_of(s, rn["id"]), "orphan SRN left behind"
    assert not drafts_for_rn(s, rn["id"]), "orphan racking note left behind"


def test_delete_blocked_when_child_has_committed_qty(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 4)])
    finalize(s, rn)
    srn = srns_of(s, rn["id"])[0]
    s.post(API(f"/short-received-notes/{srn['id']}/children"),
           json={"part_no": p["part_no"], "make": p["make"], "received_qty": 3,
                 "not_receivable_qty": 0}, timeout=30)

    r = s.delete(API(f"/receipt-notes/{rn['id']}"), timeout=30)
    assert r.status_code == 409 and "already has" in r.text


# ---------------------------------------------------------------- workflow 2
def test_partial_deliveries_multiple_child_srns_then_auto_complete(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 4)])          # shortfall 6
    finalize(s, rn)
    srn = srns_of(s, rn["id"])[0]
    assert srn["status"] == "PENDING"

    for qty in (2, 3):
        r = s.post(API(f"/short-received-notes/{srn['id']}/children"),
                   json={"part_no": p["part_no"], "make": p["make"], "received_qty": qty,
                         "not_receivable_qty": 0}, timeout=30)
        assert r.status_code == 200, r.text
    mid = s.get(API(f"/short-received-notes/{srn['id']}"), timeout=30).json()
    assert mid["status"] == "PARTIALLY_RECEIVED"
    kids = mid["items"][0]["children"]
    assert [c["child_srn_no"].rsplit("-", 1)[-1] for c in kids] == ["A", "B"]

    # Supplier confirms the last 1 will never arrive -> closes the obligation, no stock.
    before = stock_of(s, p)
    r = s.post(API(f"/short-received-notes/{srn['id']}/children"),
               json={"part_no": p["part_no"], "make": p["make"], "received_qty": 0,
                     "not_receivable_qty": 1}, timeout=30)
    assert r.status_code == 200, r.text
    done = s.get(API(f"/short-received-notes/{srn['id']}"), timeout=30).json()
    assert done["status"] == "COMPLETE", "4 received + 1 not-receivable + 1 = original shortfall"
    assert stock_of(s, p) == before, "not-receivable must never create stock"


def test_srn_cannot_exceed_pending(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 7)])          # shortfall 3
    finalize(s, rn)
    srn = srns_of(s, rn["id"])[0]
    r = s.post(API(f"/short-received-notes/{srn['id']}/children"),
               json={"part_no": p["part_no"], "make": p["make"], "received_qty": 99,
                     "not_receivable_qty": 0}, timeout=30)
    assert r.status_code == 400 and "Exceeds Pending Qty" in r.text


# ---------------------------------------------------------------- workflow 3
def test_extra_received_partial_accept_and_reject(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 30)])         # extra 20
    finalize(s, rn)
    ern = erns_of(s, rn["id"])[0]
    assert ern["status"] == "PENDING"
    assert float(ern["items"][0]["extra_qty"]) == 20

    r = s.post(API(f"/extra-received-notes/{ern['id']}/children"),
               json={"part_no": p["part_no"], "make": p["make"], "accepted_qty": 12,
                     "rejected_qty": 8}, timeout=30)
    assert r.status_code == 200, r.text
    after = s.get(API(f"/extra-received-notes/{ern['id']}"), timeout=30).json()
    assert after["status"] == "COMPLETE", "12 accepted + 8 rejected == 20 extra"

    ern_drafts = [k for k in _rows(s.get(API("/racking-notes"), params={"page_size": 500}, timeout=30).json())
                  if k.get("source_type") == "ERN" and k.get("source_id") == ern["id"]]
    assert ern_drafts, "accepted extra qty must become rackable"
    total = sum(float(i["quantity"]) for k in ern_drafts
                for i in s.get(API(f"/racking-notes/{k['id']}"), timeout=30).json()["items"])
    assert total == 12, "only the accepted 12 is rackable; the rejected 8 never enters inventory"


def test_ern_reject_creates_no_stock_and_no_racking(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 15)])         # extra 5
    finalize(s, rn)
    ern = erns_of(s, rn["id"])[0]
    before = stock_of(s, p)

    r = s.post(API(f"/extra-received-notes/{ern['id']}/reject"), json={"items": []}, timeout=30)
    assert r.status_code == 200, r.text
    assert s.get(API(f"/extra-received-notes/{ern['id']}"), timeout=30).json()["status"] == "COMPLETE"
    assert stock_of(s, p) == before
    assert not [k for k in _rows(s.get(API("/racking-notes"), params={"page_size": 500}, timeout=30).json())
                if k.get("source_type") == "ERN" and k.get("source_id") == ern["id"]], \
        "a full rejection must not create anything rackable"


# ----------------------------------------------------------------- integrity
def test_record_is_idempotent(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 6, 6)])
    finalize(s, rn)
    k = drafts_for_rn(s, rn["id"])[0]
    assert rack_and_record(s, k, loc).status_code == 200
    assert stock_of(s, p) == 6

    again = s.post(API(f"/racking-notes/{k['id']}/record"), timeout=30)
    assert again.status_code in (200, 409)
    assert stock_of(s, p) == 6, "re-recording must never double-count stock"


def test_direct_stock_in_endpoint_remains_disabled(s):
    p = new_part(s)
    r = s.post(API("/stock-in"), json={"part_no": p["part_no"], "make": p["make"], "quantity": 5,
                                       "godown_id": "x", "rack_id": "y", "box_id": "z"}, timeout=30)
    assert r.status_code == 410, "stock may only enter through a recorded racking note"


# --------------------------------------------------------------- concurrency
def test_concurrent_record_moves_stock_exactly_once(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 8, 8)])
    finalize(s, rn)
    k = drafts_for_rn(s, rn["id"])[0]
    full = s.get(API(f"/racking-notes/{k['id']}"), timeout=30).json()
    for it in full["items"]:
        it.update(loc)
    s.put(API(f"/racking-notes/{k['id']}"),
          json={"source_type": full.get("source_type"), "source_id": full.get("source_id"),
                "items": full["items"], "narration": ""}, timeout=30)

    def fire(_):
        return s.post(API(f"/racking-notes/{k['id']}/record"), timeout=60).status_code

    with ThreadPoolExecutor(max_workers=4) as ex:
        codes = list(ex.map(fire, range(4)))

    assert codes.count(200) >= 1
    assert stock_of(s, p) == 8, f"concurrent records double-counted stock (codes={codes})"


def test_concurrent_srn_deliveries_do_not_duplicate_suffixes(s):
    p = new_part(s)
    rn = create_rn(s, [(p, 20, 5)])          # shortfall 15
    finalize(s, rn)
    srn = srns_of(s, rn["id"])[0]

    def fire(_):
        return s.post(API(f"/short-received-notes/{srn['id']}/children"),
                      json={"part_no": p["part_no"], "make": p["make"], "received_qty": 1,
                            "not_receivable_qty": 0}, timeout=60).status_code

    with ThreadPoolExecutor(max_workers=4) as ex:
        codes = list(ex.map(fire, range(4)))

    kids = s.get(API(f"/short-received-notes/{srn['id']}"), timeout=30).json()["items"][0]["children"]
    suffixes = [c["child_srn_no"] for c in kids]
    assert len(suffixes) == len(set(suffixes)), f"duplicate child SRN numbers: {suffixes} (codes={codes})"
    assert len(kids) == codes.count(200), "every accepted delivery must be persisted exactly once"


# -------------------------------------------------------------- audit trail
def test_audit_trail_records_who_and_what(s, loc):
    p = new_part(s)
    rn = create_rn(s, [(p, 10, 10)])
    finalize(s, rn)
    s.put(API(f"/receipt-notes/{rn['id']}"), json=rn_edit_body(rn, [(p, 11, 11)]), timeout=30)
    rack_and_record(s, drafts_for_rn(s, rn["id"])[0], loc)

    from pymongo import MongoClient
    cli = MongoClient(os.environ["MONGO_URL"])
    logs = list(cli[os.environ.get("WMS_TEST_DB", "stock_management_test")]
                .inventory_audit_logs.find({"module": "stock_in"}))
    cli.close()
    actions = {l["action"] for l in logs}
    assert {"receipt_note.finalized", "receipt_note.updated", "racking_note.recorded"} <= actions
    sample = next(l for l in logs if l["action"] == "receipt_note.updated")
    for field in ("created_by", "created_at", "old_value", "new_value", "reason", "linked_documents"):
        assert field in sample, f"audit entry missing '{field}'"
