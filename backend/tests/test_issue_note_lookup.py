"""Backend tests for new Issue Note lookup + qty-vs-stock validation
(Iteration 8 enhancement).

Covers:
  - GET /api/issue-notes/lookup/{part_no} returns ONLY makes with positive stock
    each entry having {make, available_qty}
  - GET /api/issue-notes/lookup/{unknown_or_zero_part} returns {makes: []}
  - POST /api/issue-notes with qty > available_qty returns 400 with
    "cannot issue X — only Y in stock"
  - PUT /api/issue-notes/{id} with qty > available_qty returns 400
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"
ADMIN = {"email": "admin@stockmgmt.com", "password": "admin123"}


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json=ADMIN)
    assert r.status_code == 200, f"login failed: {r.text}"
    s.headers.update({"Authorization": f"Bearer {r.json()['token']}"})
    return s


# Helper: aggregate transactions to compute live stock per (part_no, make)
@pytest.fixture(scope="module")
def stock_index(client):
    r = client.get(f"{API}/transactions?page=1&page_size=10000")
    assert r.status_code == 200
    data = r.json()
    items = data if isinstance(data, list) else (data.get("items") or data.get("data") or [])
    bal = {}
    for t in items:
        k = (t.get("part_no", ""), t.get("make", ""))
        sign = 1 if t.get("type") == "IN" else -1
        bal[k] = bal.get(k, 0) + sign * (t.get("quantity") or 0)
    return bal


# =====================================================================
class TestIssueLookup:
    def test_lookup_returns_only_positive_stock_makes(self, client, stock_index):
        # Use canonical seed part 3911560
        r = client.get(f"{API}/issue-notes/lookup/3911560")
        assert r.status_code == 200, r.text
        data = r.json()
        assert "makes" in data and isinstance(data["makes"], list)
        # Every entry must have make + available_qty>0
        for entry in data["makes"]:
            assert "make" in entry and "available_qty" in entry
            assert entry["available_qty"] > 0
        # Cross-check vs aggregated transactions: every (3911560, make) with positive
        # qty in stock_index appears in lookup; none with <=0 appears.
        expected = {m: q for (p, m), q in stock_index.items() if p == "3911560" and q > 0}
        got = {e["make"]: e["available_qty"] for e in data["makes"]}
        assert set(got.keys()) == set(expected.keys()), (
            f"lookup makes mismatch. expected={expected}, got={got}"
        )
        for mk, q in expected.items():
            assert abs(got[mk] - q) < 1e-6, f"qty mismatch for make {mk}: {got[mk]} vs {q}"

    def test_lookup_unknown_part_returns_empty(self, client):
        r = client.get(f"{API}/issue-notes/lookup/__NO_SUCH_PART_XYZ_999__")
        assert r.status_code == 200
        assert r.json() == {"makes": []}

    def test_lookup_zero_balance_make_excluded(self, client, stock_index):
        """Find any (part, make) with non-positive balance and confirm absence."""
        zero = next(
            ((p, m) for (p, m), q in stock_index.items() if q <= 0 and p and m),
            None,
        )
        if not zero:
            pytest.skip("No zero-stock (part, make) in current data")
        part, make = zero
        r = client.get(f"{API}/issue-notes/lookup/{part}")
        assert r.status_code == 200
        makes = [e["make"] for e in r.json()["makes"]]
        assert make not in makes, f"zero-stock make '{make}' must NOT appear in lookup"


# =====================================================================
class TestIssueQtyValidation:
    def _pick(self, stock_index):
        # Pick first (part, make) with positive stock
        return next(((p, m, q) for (p, m), q in stock_index.items() if q > 0 and p and m), None)

    def test_post_rejects_overstock(self, client, stock_index):
        chosen = self._pick(stock_index)
        assert chosen, "no positive-stock part available"
        part, make, avail = chosen
        over = int(avail) + 100
        r = client.post(f"{API}/issue-notes", json={
            "items": [{"part_no": part, "make": make, "quantity": over}],
        })
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"
        msg = r.json().get("detail", "")
        assert "cannot issue" in msg.lower(), f"missing 'cannot issue' phrase: {msg}"
        assert "in stock" in msg.lower(), f"missing 'in stock' phrase: {msg}"
        assert str(over) in msg, f"requested qty not in message: {msg}"

    def test_post_accepts_within_stock_then_put_rejects_overstock(self, client, stock_index):
        chosen = self._pick(stock_index)
        assert chosen
        part, make, avail = chosen
        # Create with qty=1 (well within stock)
        create = client.post(f"{API}/issue-notes", json={
            "items": [{"part_no": part, "make": make, "quantity": 1}],
        })
        assert create.status_code == 200, create.text
        in_id = create.json()["id"]
        try:
            # PUT with qty=avail+50 should be rejected
            over = int(avail) + 50
            put = client.put(f"{API}/issue-notes/{in_id}", json={
                "items": [{"part_no": part, "make": make, "quantity": over}],
            })
            assert put.status_code == 400, f"expected 400, got {put.status_code}: {put.text}"
            msg = put.json().get("detail", "")
            assert "cannot issue" in msg.lower() and "in stock" in msg.lower()
        finally:
            client.delete(f"{API}/issue-notes/{in_id}")

    def test_post_accepts_qty_equal_to_available(self, client, stock_index):
        """Boundary test: exactly available_qty must be allowed."""
        chosen = self._pick(stock_index)
        assert chosen
        part, make, avail = chosen
        # Use a small positive qty that we know is <= avail (use avail itself)
        r = client.post(f"{API}/issue-notes", json={
            "items": [{"part_no": part, "make": make, "quantity": int(avail)}],
        })
        assert r.status_code == 200, f"boundary qty=avail rejected: {r.text}"
        in_id = r.json()["id"]
        client.delete(f"{API}/issue-notes/{in_id}")
