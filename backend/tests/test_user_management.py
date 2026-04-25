"""Phase 1 User Management & Auth Security tests.

Covers:
- /api/auth/login lockout, last_login, deactivated user 403
- /api/auth/register removed (404)
- /api/users CRUD with module_access, force_password_reset
- /api/users PUT clears lockout_until on reactivation
- /api/users DELETE soft-deactivates
- /api/auth/me PUT (self-service name/password) clears force_password_reset
- /api/meta/modules returns 7 keys
- Module-level RBAC middleware (staff with stock_master=False -> 403)
"""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get('REACT_APP_BACKEND_URL', '').rstrip('/')
if not BASE_URL:
    raise RuntimeError("REACT_APP_BACKEND_URL not set")

ADMIN_EMAIL = "admin@stockmgmt.com"
ADMIN_PASSWORD = "admin123"

EXPECTED_MODULES = {
    "stock_master", "locations", "stock_in", "stock_out",
    "stock_summary", "low_stock", "transactions",
}


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def s():
    return requests.Session()


def _login(session, email, password):
    return session.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)


@pytest.fixture(scope="module")
def admin_token(s):
    r = _login(s, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def created_user_ids():
    ids = []
    yield ids
    # teardown: deactivate any users we created
    r = _login(requests.Session(), ADMIN_EMAIL, ADMIN_PASSWORD)
    if r.status_code == 200:
        h = {"Authorization": f"Bearer {r.json()['token']}"}
        for uid in ids:
            try:
                requests.delete(f"{BASE_URL}/api/users/{uid}", headers=h, timeout=10)
            except Exception:
                pass


def _new_email():
    # backend lowercases emails on store
    return f"test_user_{uuid.uuid4().hex[:8]}@example.com"


# ---------- /api/meta/modules ----------
class TestMetaModules:
    def test_modules_returns_seven_keys(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/meta/modules", headers=admin_headers)
        assert r.status_code == 200
        data = r.json()
        assert "modules" in data
        assert set(data["modules"]) == EXPECTED_MODULES
        assert len(data["modules"]) == 7


# ---------- /api/auth/register removed ----------
class TestRegisterRemoved:
    def test_register_endpoint_not_available(self, s):
        r = s.post(f"{BASE_URL}/api/auth/register",
                   json={"email": "x@x.com", "password": "abcdef", "name": "X"})
        # Should be 404 (not registered) or 405 (method removed). Anything other than 200/201 is acceptable.
        assert r.status_code in (404, 405), f"register still works? {r.status_code} {r.text}"


# ---------- /api/users CRUD ----------
class TestUsersCRUD:
    def test_admin_list_users(self, s, admin_headers):
        r = s.get(f"{BASE_URL}/api/users", headers=admin_headers)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list) and len(rows) >= 1
        # Verify expected fields
        sample = rows[0]
        for f in ("id", "email", "role", "is_active", "module_access", "force_password_reset"):
            assert f in sample, f"missing field {f} in user: {sample}"

    def test_create_staff_with_module_access(self, s, admin_headers, created_user_ids):
        email = _new_email()
        payload = {
            "email": email,
            "password": "secret123",
            "name": "TEST Staff One",
            "role": "staff",
            "module_access": {m: True for m in EXPECTED_MODULES},
            "force_password_reset": True,
        }
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers, json=payload)
        assert r.status_code == 200, r.text
        u = r.json()
        assert u["email"] == email
        assert u["role"] == "staff"
        assert u["force_password_reset"] is True
        assert u["module_access"]["stock_master"] is True
        assert u["is_active"] is True
        created_user_ids.append(u["id"])

    def test_create_duplicate_email_rejected(self, s, admin_headers, created_user_ids):
        email = _new_email()
        body = {"email": email, "password": "secret123", "name": "Dup"}
        r1 = s.post(f"{BASE_URL}/api/users", headers=admin_headers, json=body)
        assert r1.status_code == 200, r1.text
        created_user_ids.append(r1.json()["id"])
        r2 = s.post(f"{BASE_URL}/api/users", headers=admin_headers, json=body)
        assert r2.status_code == 400

    def test_create_short_password_rejected(self, s, admin_headers):
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": _new_email(), "password": "abc", "name": "Short"})
        assert r.status_code == 400

    def test_staff_cannot_list_users(self, s, admin_headers, created_user_ids):
        # create staff
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Staff List Test"})
        assert r.status_code == 200, r.text
        created_user_ids.append(r.json()["id"])

        # login as staff
        rl = _login(requests.Session(), email, "secret123")
        assert rl.status_code == 200
        staff_h = {"Authorization": f"Bearer {rl.json()['token']}"}
        rls = requests.get(f"{BASE_URL}/api/users", headers=staff_h)
        assert rls.status_code == 403

        # staff cannot create users
        rcs = requests.post(f"{BASE_URL}/api/users", headers=staff_h,
                            json={"email": _new_email(), "password": "abcdef", "name": "x"})
        assert rcs.status_code == 403

    def test_update_user_module_access_and_password(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Update Tgt"})
        assert r.status_code == 200
        uid = r.json()["id"]
        created_user_ids.append(uid)

        # update module_access (disable stock_master), change name, password, force_password_reset
        new_access = {m: True for m in EXPECTED_MODULES}
        new_access["stock_master"] = False
        upd = {
            "name": "Updated Name",
            "module_access": new_access,
            "password": "newpass456",
            "force_password_reset": True,
        }
        ru = s.put(f"{BASE_URL}/api/users/{uid}", headers=admin_headers, json=upd)
        assert ru.status_code == 200, ru.text
        body = ru.json()
        assert body["name"] == "Updated Name"
        assert body["module_access"]["stock_master"] is False
        assert body["force_password_reset"] is True

        # Verify new password works
        rl = _login(requests.Session(), email, "newpass456")
        assert rl.status_code == 200

    def test_delete_soft_deactivates(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Del Tgt"})
        uid = r.json()["id"]
        created_user_ids.append(uid)

        rd = s.delete(f"{BASE_URL}/api/users/{uid}", headers=admin_headers)
        assert rd.status_code == 200
        # verify it's soft-deleted (still in list but is_active=false)
        rl = s.get(f"{BASE_URL}/api/users", headers=admin_headers)
        match = [u for u in rl.json() if u["id"] == uid]
        assert len(match) == 1, "user should still exist (soft-delete)"
        assert match[0]["is_active"] is False

        # deactivated user cannot login (403)
        rlog = _login(requests.Session(), email, "secret123")
        assert rlog.status_code == 403


# ---------- Login: lockout / last_login / deactivated ----------
class TestLoginSecurity:
    def test_login_success_updates_last_login(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "LL"})
        uid = r.json()["id"]
        created_user_ids.append(uid)

        # before login, last_login is None
        before = [u for u in s.get(f"{BASE_URL}/api/users", headers=admin_headers).json() if u["id"] == uid][0]
        assert before.get("last_login") in (None, "")

        rl = _login(requests.Session(), email, "secret123")
        assert rl.status_code == 200

        after = [u for u in s.get(f"{BASE_URL}/api/users", headers=admin_headers).json() if u["id"] == uid][0]
        assert after.get("last_login"), "last_login was not set after successful login"

    def test_lockout_after_5_failed_attempts(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Lock"})
        uid = r.json()["id"]
        created_user_ids.append(uid)

        # 5 wrong attempts
        for i in range(5):
            rb = _login(requests.Session(), email, "wrongpass")
            assert rb.status_code == 401, f"attempt {i+1} expected 401 got {rb.status_code}"

        # 6th attempt with EITHER right or wrong password should be 423
        rl = _login(requests.Session(), email, "secret123")
        assert rl.status_code == 423, f"expected 423 lockout, got {rl.status_code} {rl.text}"

        # Verify lockout_until is set in admin list
        u = [x for x in s.get(f"{BASE_URL}/api/users", headers=admin_headers).json() if x["id"] == uid][0]
        assert u.get("lockout_until"), "lockout_until not set"

        # Admin reactivation (PUT is_active=true) clears lockout
        ru = s.put(f"{BASE_URL}/api/users/{uid}", headers=admin_headers, json={"is_active": True})
        assert ru.status_code == 200
        u2 = [x for x in s.get(f"{BASE_URL}/api/users", headers=admin_headers).json() if x["id"] == uid][0]
        assert not u2.get("lockout_until"), "lockout_until should be cleared after reactivate"

        # And login now works
        rok = _login(requests.Session(), email, "secret123")
        assert rok.status_code == 200

    def test_deactivated_user_login_403(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Deact"})
        uid = r.json()["id"]
        created_user_ids.append(uid)

        s.delete(f"{BASE_URL}/api/users/{uid}", headers=admin_headers)
        rlog = _login(requests.Session(), email, "secret123")
        assert rlog.status_code == 403


# ---------- /api/auth/me self-service ----------
class TestProfileSelfService:
    def test_self_update_name_and_password_clears_force_reset(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Self",
                         "force_password_reset": True})
        uid = r.json()["id"]
        created_user_ids.append(uid)

        rl = _login(requests.Session(), email, "secret123")
        assert rl.status_code == 200
        assert rl.json()["user"]["force_password_reset"] is True
        h = {"Authorization": f"Bearer {rl.json()['token']}"}

        # Self update name+password
        ru = requests.put(f"{BASE_URL}/api/auth/me", headers=h,
                          json={"name": "Self New Name", "password": "newpass789"})
        assert ru.status_code == 200, ru.text

        # Re-login with new password; force_password_reset should be cleared
        rl2 = _login(requests.Session(), email, "newpass789")
        assert rl2.status_code == 200
        assert rl2.json()["user"]["force_password_reset"] is False
        assert rl2.json()["user"]["name"] == "Self New Name"

    def test_self_short_password_rejected(self, s, admin_headers, created_user_ids):
        email = _new_email()
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers,
                   json={"email": email, "password": "secret123", "name": "Self2"})
        created_user_ids.append(r.json()["id"])
        rl = _login(requests.Session(), email, "secret123")
        h = {"Authorization": f"Bearer {rl.json()['token']}"}
        ru = requests.put(f"{BASE_URL}/api/auth/me", headers=h, json={"password": "abc"})
        assert ru.status_code == 400


# ---------- Module-level RBAC ----------
class TestModuleRBAC:
    def test_staff_blocked_on_disabled_module(self, s, admin_headers, created_user_ids):
        email = _new_email()
        access = {m: True for m in EXPECTED_MODULES}
        access["stock_master"] = False
        r = s.post(f"{BASE_URL}/api/users", headers=admin_headers, json={
            "email": email, "password": "secret123", "name": "RBAC",
            "module_access": access,
        })
        uid = r.json()["id"]
        created_user_ids.append(uid)

        rl = _login(requests.Session(), email, "secret123")
        assert rl.status_code == 200
        h = {"Authorization": f"Bearer {rl.json()['token']}"}

        # GET /api/stock-master -> 403
        rg = requests.get(f"{BASE_URL}/api/stock-master", headers=h)
        assert rg.status_code == 403, f"staff w/ stock_master=False should get 403, got {rg.status_code}"

        # POST /api/stock-master -> 403
        rp = requests.post(f"{BASE_URL}/api/stock-master", headers=h,
                           json={"part_no": "TESTRBAC", "make": "X"})
        assert rp.status_code == 403

        # Allowed module (transactions=True) should NOT be 403
        rt = requests.get(f"{BASE_URL}/api/transactions", headers=h)
        assert rt.status_code != 403, f"transactions should be allowed, got {rt.status_code}"

    def test_admin_always_allowed(self, s, admin_headers):
        r = requests.get(f"{BASE_URL}/api/stock-master", headers=admin_headers)
        assert r.status_code == 200
