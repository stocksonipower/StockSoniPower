"""Phase 2 In-App Notifications tests.

Covers:
- GET /api/notifications: items + unread_count, sorting, limit
- GET /api/notifications/unread-count
- POST /api/notifications/mark-read (specific ids, mark-all, idempotent)
- Triggers: auth.login, auth.lockout, user.created, user.deactivated,
            user.reactivated, stock_master.created, stock_master.deleted
- Visibility: admin sees all; staff sees only allowed module audiences;
              auth/user.* (audience=admin) hidden from staff.
"""
import os
import uuid
import time
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL not set")

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"


# ---------- helpers / fixtures ----------
def _login(session, email, password):
    return session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=15,
    )


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def admin_headers(s):
    r = _login(s, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture(scope="module")
def created_resources():
    """Track resources we create; clean up at end."""
    res = {"user_ids": [], "stock_master_ids": []}
    yield res
    # teardown
    r = _login(requests.Session(), ADMIN_EMAIL, ADMIN_PASSWORD)
    if r.status_code != 200:
        return
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    for uid in res["user_ids"]:
        try:
            requests.delete(f"{BASE_URL}/api/users/{uid}", headers=h, timeout=10)
        except Exception:
            pass
    for sid in res["stock_master_ids"]:
        try:
            requests.delete(f"{BASE_URL}/api/stock-master/{sid}", headers=h, timeout=10)
        except Exception:
            pass


# ---------- list / unread-count basics ----------
class TestListAndUnreadCount:
    def test_admin_login_creates_auth_login_notif(self, s, admin_headers):
        # Admin already logged-in via fixture; query notifications.
        r = s.get(f"{BASE_URL}/api/notifications?limit=50", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "unread_count" in data
        assert isinstance(data["items"], list)
        assert isinstance(data["unread_count"], int)
        # At least the admin-login notification we just produced should be present.
        types = [n["type"] for n in data["items"]]
        assert "auth.login" in types, f"auth.login not found among: {types[:10]}"

    def test_unread_count_endpoint(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers)
        assert r.status_code == 200
        d = r.json()
        assert "unread_count" in d and isinstance(d["unread_count"], int)
        assert d["unread_count"] >= 0

    def test_items_sorted_desc_by_created_at(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/notifications?limit=50", headers=admin_headers)
        assert r.status_code == 200
        items = r.json()["items"]
        if len(items) >= 2:
            for a, b in zip(items, items[1:]):
                assert a["created_at"] >= b["created_at"], "items not sorted desc by created_at"

    def test_limit_param(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/notifications?limit=2", headers=admin_headers)
        assert r.status_code == 200
        items = r.json()["items"]
        assert len(items) <= 2


# ---------- triggers ----------
class TestNotificationTriggers:
    def test_lockout_trigger(self, s, admin_headers, created_resources):
        # Create a user, then fail-login 5 times to trigger lockout.
        email = f"test_lockout_{uuid.uuid4().hex[:8]}@example.com"
        r = s.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={"email": email, "password": "abcdef", "name": "Lock User", "role": "staff"},
        )
        assert r.status_code in (200, 201), r.text
        uid = r.json()["id"]
        created_resources["user_ids"].append(uid)

        sess = requests.Session()
        for _ in range(5):
            sess.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": "WRONG"}, timeout=15)
        # Wait briefly for the notif insert
        time.sleep(0.5)
        r = s.get(f"{BASE_URL}/api/notifications?limit=20", headers=admin_headers)
        assert r.status_code == 200
        items = r.json()["items"]
        lockouts = [n for n in items if n["type"] == "auth.lockout"]
        assert any(email in (n.get("message") or "") for n in lockouts), \
            f"auth.lockout for {email} not found"

        # Reactivate to clear lockout (also produces user.reactivated)
        r = s.put(
            f"{BASE_URL}/api/users/{uid}",
            headers=admin_headers,
            json={"is_active": True},
        )
        assert r.status_code == 200

    def test_user_created_and_deactivated_triggers(self, s, admin_headers, created_resources):
        email = f"test_cruduser_{uuid.uuid4().hex[:8]}@example.com"
        r = s.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={"email": email, "password": "abcdef", "name": "CRUD User", "role": "staff"},
        )
        assert r.status_code in (200, 201)
        uid = r.json()["id"]
        created_resources["user_ids"].append(uid)

        # DELETE -> user.deactivated
        r = s.delete(f"{BASE_URL}/api/users/{uid}", headers=admin_headers)
        assert r.status_code in (200, 204)

        # PUT is_active=true -> user.reactivated
        r = s.put(f"{BASE_URL}/api/users/{uid}", headers=admin_headers, json={"is_active": True})
        assert r.status_code == 200

        time.sleep(0.3)
        r = s.get(f"{BASE_URL}/api/notifications?limit=100", headers=admin_headers)
        items = r.json()["items"]
        types_for_uid = [n["type"] for n in items if n.get("ref_id") == uid]
        for t in ("user.created", "user.deactivated", "user.reactivated"):
            assert t in types_for_uid, f"missing {t} for user {uid}; got {types_for_uid}"

    def test_stock_master_created_and_deleted_triggers(self, s, admin_headers, created_resources):
        part_no = f"TEST_PN_{uuid.uuid4().hex[:6]}"
        r = s.post(
            f"{BASE_URL}/api/stock-master",
            headers=admin_headers,
            json={"part_no": part_no, "make": "TEST_MAKE", "description": "test item"},
        )
        assert r.status_code in (200, 201), r.text
        sid = r.json()["id"]
        created_resources["stock_master_ids"].append(sid)

        # DELETE
        r = s.delete(f"{BASE_URL}/api/stock-master/{sid}", headers=admin_headers)
        # Some impls return 200 with empty body or 204; or 400 if referenced
        # Either way notification only fires on success.
        deleted_ok = r.status_code in (200, 204)

        time.sleep(0.3)
        r = s.get(f"{BASE_URL}/api/notifications?limit=100", headers=admin_headers)
        items = r.json()["items"]
        sm_types = [n["type"] for n in items if n.get("ref_id") == sid]
        assert "stock_master.created" in sm_types, f"stock_master.created not found; got {sm_types}"
        if deleted_ok:
            assert "stock_master.deleted" in sm_types, "stock_master.deleted not found"
            # deletion succeeded → don't try to delete again in teardown
            created_resources["stock_master_ids"].remove(sid)

        # Verify audience=module + module=stock_master
        for n in items:
            if n.get("ref_id") == sid and n["type"] == "stock_master.created":
                assert n["audience"] == "module"
                assert n["module"] == "stock_master"
                break


# ---------- visibility for staff ----------
class TestStaffVisibility:
    @pytest.fixture(scope="class")
    def staff_setup(self, admin_headers, created_resources):
        # create a staff with stock_in=True, stock_out=False
        sess = requests.Session()
        email = f"test_staff_vis_{uuid.uuid4().hex[:8]}@example.com"
        password = "abcdef"
        r = sess.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={
                "email": email, "password": password, "name": "Vis Staff", "role": "staff",
                "module_access": {
                    "stock_master": False, "locations": False,
                    "stock_in": True, "stock_out": False,
                    "stock_summary": False, "low_stock": False, "transactions": False,
                },
            },
        )
        assert r.status_code in (200, 201), r.text
        uid = r.json()["id"]
        created_resources["user_ids"].append(uid)
        # login as staff
        r = sess.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200
        token = r.json()["token"]
        return {"headers": {"Authorization": f"Bearer {token}"}, "id": uid, "email": email}

    def test_staff_cannot_see_admin_audience_notifs(self, s, staff_setup):
        r = s.get(f"{BASE_URL}/api/notifications?limit=200", headers=staff_setup["headers"])
        assert r.status_code == 200
        items = r.json()["items"]
        # auth.* and user.* notifications have audience="admin" → must NOT be visible to staff
        for n in items:
            assert not n["type"].startswith("auth."), f"staff saw auth notif: {n}"
            assert not n["type"].startswith("user."), f"staff saw user notif: {n}"

    def test_staff_cannot_see_disabled_module_notifs(self, s, admin_headers, staff_setup, created_resources):
        # As admin, create a stock_master notification (module=stock_master, but staff has stock_master=False)
        part_no = f"TEST_VIS_{uuid.uuid4().hex[:6]}"
        r = s.post(
            f"{BASE_URL}/api/stock-master",
            headers=admin_headers,
            json={"part_no": part_no, "make": "TEST_VIS", "description": "vis test"},
        )
        assert r.status_code in (200, 201)
        sid = r.json()["id"]
        created_resources["stock_master_ids"].append(sid)
        time.sleep(0.3)

        r = s.get(f"{BASE_URL}/api/notifications?limit=200", headers=staff_setup["headers"])
        assert r.status_code == 200
        items = r.json()["items"]
        # staff with stock_master=False should NOT see this notification
        sm_seen = [n for n in items if n.get("ref_id") == sid]
        assert sm_seen == [], f"staff saw stock_master notif they shouldn't: {sm_seen}"

    def test_staff_unread_count_lower_than_admin(self, s, admin_headers, staff_setup):
        ra = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers)
        rs = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=staff_setup["headers"])
        assert ra.status_code == 200 and rs.status_code == 200
        # admin sees everything, staff sees a strict subset
        assert ra.json()["unread_count"] >= rs.json()["unread_count"]


# ---------- mark-read ----------
class TestMarkRead:
    def test_mark_specific_ids(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/notifications?limit=5", headers=admin_headers)
        assert r.status_code == 200
        items = r.json()["items"]
        unread_ids = [n["id"] for n in items if not n["read"]]
        if not unread_ids:
            pytest.skip("no unread notifications to mark")
        target = unread_ids[:1]
        r = s.post(
            f"{BASE_URL}/api/notifications/mark-read",
            headers=admin_headers,
            json={"ids": target},
        )
        assert r.status_code == 200
        # Verify GET shows it as read=True now
        r = s.get(f"{BASE_URL}/api/notifications?limit=50", headers=admin_headers)
        items = r.json()["items"]
        for n in items:
            if n["id"] in target:
                assert n["read"] is True

    def test_mark_specific_ids_idempotent(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/notifications?limit=10", headers=admin_headers)
        items = r.json()["items"]
        if not items:
            pytest.skip("no items")
        target = [items[0]["id"]]
        # Call twice — second should not fail and should return updated=0 (already read)
        r1 = s.post(
            f"{BASE_URL}/api/notifications/mark-read", headers=admin_headers, json={"ids": target}
        )
        r2 = s.post(
            f"{BASE_URL}/api/notifications/mark-read", headers=admin_headers, json={"ids": target}
        )
        assert r1.status_code == 200 and r2.status_code == 200

    def test_mark_all_with_null_ids(self, s, admin_headers, created_resources):
        # Generate a fresh unread item so we have something to mark
        email = f"test_markall_{uuid.uuid4().hex[:8]}@example.com"
        r = s.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={"email": email, "password": "abcdef", "name": "Mark User", "role": "staff"},
        )
        assert r.status_code in (200, 201)
        created_resources["user_ids"].append(r.json()["id"])
        time.sleep(0.2)

        # Confirm we have unread > 0
        c = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers).json()
        assert c["unread_count"] >= 1

        # Mark ALL with ids=null
        r = s.post(
            f"{BASE_URL}/api/notifications/mark-read",
            headers=admin_headers,
            json={"ids": None},
        )
        assert r.status_code == 200

        c2 = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers).json()
        assert c2["unread_count"] == 0, f"unread_count should be 0 after mark-all, got {c2}"

    def test_mark_all_empty_list_marks_all(self, s, admin_headers, created_resources):
        # Generate one new unread item
        email = f"test_markempty_{uuid.uuid4().hex[:8]}@example.com"
        r = s.post(
            f"{BASE_URL}/api/users",
            headers=admin_headers,
            json={"email": email, "password": "abcdef", "name": "Mark Empty", "role": "staff"},
        )
        assert r.status_code in (200, 201)
        created_resources["user_ids"].append(r.json()["id"])
        time.sleep(0.2)

        before = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers).json()["unread_count"]
        assert before >= 1

        r = s.post(
            f"{BASE_URL}/api/notifications/mark-read",
            headers=admin_headers,
            json={"ids": []},
        )
        assert r.status_code == 200
        after = s.get(f"{BASE_URL}/api/notifications/unread-count", headers=admin_headers).json()["unread_count"]
        assert after == 0, f"empty list should mark-all; before={before} after={after}"
