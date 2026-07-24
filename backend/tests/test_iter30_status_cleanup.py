"""Iter-30 status cleanup regression tests.

Verifies:
  1. Active 12-status set is enforced. Legacy statuses
     (FINAL / RACKING_PENDING / FULLY_RECEIVED / RACKED / PARTIALLY_REJECTED)
     are never returned by the API.
  2. Legacy fields `racking_status` / `racked_at` are no longer present on
     SRN / ERN documents.
  3. /api/racking-notes/sources never exposes the legacy `racking_status` key
     (top-level or nested).
  4. _is_source_fully_racked correctly blocks creating a 2nd RKN against a
     fully-racked source (HTTP 409).
  5. _compute_ern_status returns PARTIALLY_ACCEPTED when children have only
     rejected_qty>0 with no accepted (legacy PARTIALLY_REJECTED removed).
  6. RN finalize transitions DRAFT -> RACKING_NOTE_DRAFT (not FINAL).
"""
import os
import uuid
from pathlib import Path

import pytest
import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / "frontend" / ".env")
BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"

ALLOWED_RN = {"DRAFT", "RACKING_NOTE_DRAFT", "PARTIALLY_RACKED", "FULLY_RACKED"}
ALLOWED_SRN = {"PENDING", "PARTIALLY_RECEIVED", "COMPLETE"}
ALLOWED_ERN = {"PENDING", "PARTIALLY_ACCEPTED", "COMPLETE"}
ALLOWED_RKN = {"DRAFT", "RECORDED"}
LEGACY = {"FINAL", "RACKING_PENDING", "FULLY_RECEIVED", "RACKED", "PARTIALLY_REJECTED"}


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def H(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- 1. Production data must use only the active 12-status set ----------
class TestExistingDataStatuses:
    def test_rn_statuses_within_allowed_set(self, H):
        r = requests.get(f"{BASE_URL}/api/receipt-notes", headers=H, timeout=20)
        assert r.status_code == 200
        bad = [(d["id"], d.get("status")) for d in r.json() if d.get("status") not in ALLOWED_RN]
        assert not bad, f"RNs with disallowed status: {bad}"

    def test_srn_statuses_within_allowed_set_and_no_legacy_fields(self, H):
        r = requests.get(f"{BASE_URL}/api/short-received-notes", headers=H, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        bad = [(d["id"], d.get("status")) for d in rows if d.get("status") not in ALLOWED_SRN]
        assert not bad, f"SRNs with disallowed status: {bad}"
        rs_present = [d["id"] for d in rows if "racking_status" in d]
        ra_present = [d["id"] for d in rows if "racked_at" in d]
        assert not rs_present, f"SRNs still expose racking_status: {rs_present}"
        assert not ra_present, f"SRNs still expose racked_at: {ra_present}"

    def test_ern_statuses_within_allowed_set_and_no_legacy_fields(self, H):
        r = requests.get(f"{BASE_URL}/api/extra-received-notes", headers=H, timeout=20)
        assert r.status_code == 200
        rows = r.json()
        bad = [(d["id"], d.get("status")) for d in rows if d.get("status") not in ALLOWED_ERN]
        assert not bad, f"ERNs with disallowed status: {bad}"
        rs_present = [d["id"] for d in rows if "racking_status" in d]
        assert not rs_present, f"ERNs still expose racking_status: {rs_present}"

    def test_rkn_statuses_within_allowed_set(self, H):
        r = requests.get(f"{BASE_URL}/api/racking-notes", headers=H, timeout=20)
        assert r.status_code == 200
        bad = [(d["id"], d.get("status")) for d in r.json() if d.get("status") not in ALLOWED_RKN]
        assert not bad, f"RKNs with disallowed status: {bad}"

    def test_rkn_sources_endpoint_no_racking_status_key(self, H):
        r = requests.get(f"{BASE_URL}/api/racking-notes/sources", headers=H, timeout=20)
        assert r.status_code == 200
        groups = r.json()
        for g in groups:
            assert "racking_status" not in g, f"top-level racking_status leaked: {g}"
            for s in g.get("sources", []):
                assert "racking_status" not in s, f"nested racking_status leaked: {s}"


# ---------- 2. RN finalize -> RACKING_NOTE_DRAFT (never FINAL) ----------
class TestFinalizeProducesRackingNoteDraft:
    """End-to-end: create RN with one row, finalize, assert status=RACKING_NOTE_DRAFT."""

    @pytest.fixture(scope="class")
    def seeded(self, H):
        tag = uuid.uuid4().hex[:6].upper()
        sm = {
            "part_no": f"ITER30-{tag}",
            "make": f"M30-{tag}",
            "description": "iter30 test part",
            "uom": "NOS",
            "category": "TEST",
            "minimum_stock": 0,
        }
        r = requests.post(f"{BASE_URL}/api/stock-master", json=sm, headers=H, timeout=15)
        assert r.status_code in (200, 201), r.text
        sm_id = r.json()["id"]

        # godown / rack / box
        g = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"GD30_{tag}"}, headers=H, timeout=15)
        assert g.status_code in (200, 201), g.text
        g_id = g.json()["id"]
        rk = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g_id, "rack_no": f"R30_{tag}", "total_boxes": 1}, headers=H, timeout=15)
        assert rk.status_code in (200, 201), rk.text
        rk_id = rk.json()["id"]
        bx = requests.post(f"{BASE_URL}/api/boxes", json={"rack_id": rk_id, "box_no": f"B30_{tag}", "box_category": "Misc"}, headers=H, timeout=15)
        assert bx.status_code in (200, 201), bx.text
        bx_id = bx.json()["id"]
        yield {"tag": tag, "part_no": sm["part_no"], "make": sm["make"], "g": g_id, "rk": rk_id, "bx": bx_id, "sm_id": sm_id}

        # Cleanup
        requests.delete(f"{BASE_URL}/api/boxes/{bx_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/racks/{rk_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/godowns/{g_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/stock-master/{sm_id}", headers=H, timeout=10)

    def _create_draft_rn(self, H, seeded, invoice_qty, received_qty):
        body = {
            "stock_in_type": "INVOICE",
            "supplier_name": f"SUP30-{seeded['tag']}",
            "invoice_no": f"INV30-{seeded['tag']}-{uuid.uuid4().hex[:4]}",
            "invoice_date": "2026-04-01",
            "goods_received_date": "2026-04-02",
            "items": [
                {
                    "part_no": seeded["part_no"],
                    "make": seeded["make"],
                    "description": "iter30 row",
                    "uom": "NOS",
                    "invoice_qty": invoice_qty,
                    "received_qty": received_qty,
                }
            ],
        }
        r = requests.post(f"{BASE_URL}/api/receipt-notes", json=body, headers=H, timeout=15)
        assert r.status_code in (200, 201), r.text
        return r.json()["id"]

    def test_finalize_promotes_to_racking_note_draft(self, H, seeded):
        rn_id = self._create_draft_rn(H, seeded, invoice_qty=10, received_qty=10)
        r = requests.post(f"{BASE_URL}/api/receipt-notes/{rn_id}/finalize", headers=H, timeout=20)
        assert r.status_code == 200, r.text
        rn = r.json()
        assert rn["status"] == "RACKING_NOTE_DRAFT", f"Expected RACKING_NOTE_DRAFT, got {rn['status']}"
        assert rn["status"] not in LEGACY

        # Cleanup: delete RN (and any child auto-RKN). Some endpoints cascade; if not, leave.
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=H, timeout=10)


# ---------- 3. _is_source_fully_racked blocks 2nd RKN with HTTP 409 ----------
class TestSecondRknBlocked:
    """When a source is fully covered by RECORDED RKNs, attempting to create
    another RKN against it must return 409."""

    @pytest.fixture(scope="class")
    def setup(self, H):
        tag = uuid.uuid4().hex[:6].upper()
        sm = requests.post(
            f"{BASE_URL}/api/stock-master",
            json={"part_no": f"ITER30B-{tag}", "make": f"MB30-{tag}", "description": "x", "uom": "NOS", "category": "T", "minimum_stock": 0},
            headers=H, timeout=15,
        )
        assert sm.status_code in (200, 201), sm.text
        sm_id = sm.json()["id"]
        g = requests.post(f"{BASE_URL}/api/godowns", json={"godown_name": f"GD30B_{tag}"}, headers=H, timeout=15).json()
        rk = requests.post(f"{BASE_URL}/api/racks", json={"godown_id": g["id"], "rack_no": f"R30B_{tag}", "total_boxes": 1}, headers=H, timeout=15).json()
        bx = requests.post(f"{BASE_URL}/api/boxes", json={"rack_id": rk["id"], "box_no": f"B30B_{tag}", "box_category": "Misc"}, headers=H, timeout=15).json()

        # Create + finalize RN with received_qty=5 (fully matches invoice)
        rn = requests.post(
            f"{BASE_URL}/api/receipt-notes",
            json={
                "stock_in_type": "INVOICE",
                "supplier_name": f"SUP30B-{tag}",
                "invoice_no": f"INV30B-{tag}-{uuid.uuid4().hex[:4]}",
                "invoice_date": "2026-04-01",
                "goods_received_date": "2026-04-02",
                "items": [
                    {
                        "part_no": f"ITER30B-{tag}", "make": f"MB30-{tag}",
                        "description": "x", "uom": "NOS",
                        "invoice_qty": 5, "received_qty": 5,
                    }
                ],
            },
            headers=H, timeout=15,
        )
        assert rn.status_code in (200, 201), rn.text
        rn_id = rn.json()["id"]
        fin = requests.post(f"{BASE_URL}/api/receipt-notes/{rn_id}/finalize", headers=H, timeout=20)
        assert fin.status_code == 200, fin.text

        # The auto-RKN draft created on finalize -- record it fully to make source fully racked.
        # Find the auto-RKN tied to this RN.
        all_rkns = requests.get(f"{BASE_URL}/api/racking-notes", headers=H, timeout=20).json()
        auto = next((x for x in all_rkns if x.get("source_type") == "RN" and x.get("source_id") == rn_id), None)
        assert auto, "Auto-RKN not created on finalize"
        rkn_id = auto["id"]

        # Patch the RKN allocations: assign full 5 to the box, then record.
        # Use update endpoint with items having allocations.
        upd_body = {
            "items": [
                {
                    "part_no": f"ITER30B-{tag}",
                    "make": f"MB30-{tag}",
                    "uom": "NOS",
                    "quantity": 5,
                    "godown_id": g["id"],
                    "rack_id": rk["id"],
                    "box_id": bx["id"],
                }
            ]
        }
        upd = requests.put(f"{BASE_URL}/api/racking-notes/{rkn_id}", json=upd_body, headers=H, timeout=15)
        assert upd.status_code == 200, upd.text
        rec = requests.post(f"{BASE_URL}/api/racking-notes/{rkn_id}/record", headers=H, timeout=20)
        assert rec.status_code == 200, rec.text
        # /record returns {ok, transactions_created, auto_rkn_no}; verify status via GET.
        rkn_after = requests.get(f"{BASE_URL}/api/racking-notes/{rkn_id}", headers=H, timeout=15).json()
        assert rkn_after.get("status") == "RECORDED", f"RKN not recorded: {rkn_after.get('status')}"

        yield {"rn_id": rn_id, "rkn_id": rkn_id, "tag": tag, "g": g["id"], "rk": rk["id"], "bx": bx["id"], "part_no": f"ITER30B-{tag}", "make": f"MB30-{tag}", "sm_id": sm_id}

        # cleanup
        requests.delete(f"{BASE_URL}/api/racking-notes/{rkn_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/boxes/{bx['id']}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/racks/{rk['id']}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/godowns/{g['id']}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/stock-master/{sm_id}", headers=H, timeout=10)

    def test_attempt_create_second_rkn_against_fully_racked_source_returns_409(self, H, setup):
        body = {
            "source_type": "RN",
            "source_id": setup["rn_id"],
            "items": [
                {
                    "part_no": setup["part_no"],
                    "make": setup["make"],
                    "uom": "NOS",
                    "quantity": 1,
                    "godown_id": setup["g"],
                    "rack_id": setup["rk"],
                    "box_id": setup["bx"],
                }
            ],
        }
        r = requests.post(f"{BASE_URL}/api/racking-notes", json=body, headers=H, timeout=20)
        assert r.status_code == 409, f"Expected 409 fully-racked block, got {r.status_code}: {r.text}"

    def test_rn_status_now_fully_racked(self, H, setup):
        rn = requests.get(f"{BASE_URL}/api/receipt-notes/{setup['rn_id']}", headers=H, timeout=15).json()
        assert rn["status"] == "FULLY_RACKED", f"Expected FULLY_RACKED, got {rn.get('status')}"


# ---------- 4. _compute_ern_status: rejected-only -> PARTIALLY_ACCEPTED (not legacy PARTIALLY_REJECTED) ----------
class TestErnRejectedOnlyReturnsPartiallyAccepted:
    @pytest.fixture(scope="class")
    def setup(self, H):
        tag = uuid.uuid4().hex[:6].upper()
        # Stock master
        sm = requests.post(
            f"{BASE_URL}/api/stock-master",
            json={"part_no": f"ITER30E-{tag}", "make": f"ME30-{tag}", "description": "x", "uom": "NOS", "category": "T", "minimum_stock": 0},
            headers=H, timeout=15,
        )
        assert sm.status_code in (200, 201)
        sm_id = sm.json()["id"]
        # RN with overage (received > invoice) so finalize creates ERN
        rn = requests.post(
            f"{BASE_URL}/api/receipt-notes",
            json={
                "stock_in_type": "INVOICE",
                "supplier_name": f"SUP30E-{tag}",
                "invoice_no": f"INV30E-{tag}-{uuid.uuid4().hex[:4]}",
                "invoice_date": "2026-04-01",
                "goods_received_date": "2026-04-02",
                "items": [
                    {
                        "part_no": f"ITER30E-{tag}", "make": f"ME30-{tag}",
                        "description": "x", "uom": "NOS",
                        "invoice_qty": 5, "received_qty": 10,
                    }
                ],
            },
            headers=H, timeout=15,
        )
        assert rn.status_code in (200, 201), rn.text
        rn_id = rn.json()["id"]
        fin = requests.post(f"{BASE_URL}/api/receipt-notes/{rn_id}/finalize", headers=H, timeout=20)
        assert fin.status_code == 200, fin.text
        # Find the ERN auto-created
        erns = requests.get(f"{BASE_URL}/api/extra-received-notes", headers=H, timeout=15).json()
        ern = next((e for e in erns if e.get("parent_rn_id") == rn_id), None)
        assert ern, "ERN should be auto-created for overage"
        ern_id = ern["id"]
        yield {"ern_id": ern_id, "rn_id": rn_id, "tag": tag, "part_no": f"ITER30E-{tag}", "make": f"ME30-{tag}", "sm_id": sm_id, "extra_qty": 5}

        # cleanup
        requests.delete(f"{BASE_URL}/api/extra-received-notes/{ern_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/receipt-notes/{rn_id}", headers=H, timeout=10)
        requests.delete(f"{BASE_URL}/api/stock-master/{sm_id}", headers=H, timeout=10)

    def test_rejected_only_child_returns_partially_accepted(self, H, setup):
        ern_id = setup["ern_id"]
        # Add a child entry with rejected_qty>0, accepted_qty=0
        body = {
            "part_no": setup["part_no"],
            "make": setup["make"],
            "uom": "NOS",
            "accepted_qty": 0,
            "rejected_qty": 2,
            "remarks": "rejected-only iter30",
        }
        r = requests.post(f"{BASE_URL}/api/extra-received-notes/{ern_id}/children", json=body, headers=H, timeout=15)
        assert r.status_code in (200, 201), r.text
        ern = r.json() if isinstance(r.json(), dict) and r.json().get("status") else requests.get(
            f"{BASE_URL}/api/extra-received-notes/{ern_id}", headers=H, timeout=15
        ).json()
        assert ern["status"] == "PARTIALLY_ACCEPTED", (
            f"Expected PARTIALLY_ACCEPTED for rejected-only child, got {ern.get('status')}"
        )
        assert ern["status"] not in LEGACY
