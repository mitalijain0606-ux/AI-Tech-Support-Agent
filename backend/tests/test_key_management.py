"""API key expiry and the admin key-management API (keys_admin.py), plus the CLI's
--expires-days. Authentication is ON for every test here."""

from datetime import UTC, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from auth_helpers import mint
from operon_backend.auth import authenticate, create_api_key
from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import ApiKey
from operon_backend.main import app
from operon_backend.ratelimit import limiter

client = TestClient(app)


@pytest.fixture(autouse=True)
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    limiter.reset()
    yield
    limiter.reset()


def key_with_expiry(expires_at, tenant="exp", subject="u1", role="user"):
    db = SessionLocal()
    try:
        token, row = create_api_key(db, tenant, subject, role, label="t", expires_at=expires_at)
        return token, row.id
    finally:
        db.close()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ---- expiry ------------------------------------------------------------------------------------


def test_an_expired_key_is_refused_like_a_revoked_one():
    token, _ = key_with_expiry(datetime.now(UTC) - timedelta(seconds=1))
    res = client.get("/api/admin/keys", headers=bearer(token))
    assert res.status_code == 401
    unknown = client.get("/api/admin/keys", headers=bearer("opk_" + "x" * 43))
    assert res.json() == unknown.json()  # no oracle: expired looks like unknown


def test_a_key_works_until_it_expires():
    token, _ = key_with_expiry(datetime.now(UTC) + timedelta(days=1))
    db = SessionLocal()
    try:
        assert authenticate(db, token) is not None
        later = datetime.now(UTC) + timedelta(days=2)
        row = db.query(ApiKey).filter(ApiKey.subject == "u1", ApiKey.tenant_id == "exp").order_by(ApiKey.created_at.desc()).first()
        from operon_backend.auth import is_expired

        assert is_expired(row, now=later) and not is_expired(row)
    finally:
        db.close()


def test_a_key_without_expiry_never_expires():
    token, _ = key_with_expiry(None)
    db = SessionLocal()
    try:
        assert authenticate(db, token) is not None
    finally:
        db.close()


# ---- admin API: who may call it ------------------------------------------------------------------


@pytest.mark.parametrize("role,code", [("user", 403), ("viewer", 403)])
def test_only_admins_manage_keys(role, code):
    h = mint("acme", f"someone-{role}", role)
    assert client.get("/api/admin/keys", headers=h).status_code == code
    assert client.post("/api/admin/keys", headers=h, json={"subject": "x"}).status_code == code


def test_without_a_key_the_admin_api_is_401():
    assert client.get("/api/admin/keys").status_code == 401


# ---- admin API: create, list, revoke, rotate -----------------------------------------------------


def test_an_admin_creates_a_key_that_works_and_is_listed_without_secrets():
    admin = mint("acme2", "boss", "admin")
    res = client.post("/api/admin/keys", headers=admin, json={"subject": "carol", "role": "user", "label": "laptop", "expires_in_days": 30})
    assert res.status_code == 201
    body = res.json()
    token = body["token"]
    assert token.startswith("opk_") and body["key"]["state"] == "active" and body["key"]["expires_at"]
    assert client.get(f"/api/sessions/{'0' * 8}", headers=bearer(token)).status_code == 404  # authenticated: a real 404, not 401

    listed = client.get("/api/admin/keys", headers=admin).json()["keys"]
    assert {k["subject"] for k in listed} >= {"boss", "carol"}
    text = str(listed)
    assert token not in text and "key_hash" not in text  # never the token or its hash


def test_revoking_a_key_stops_it_at_once():
    admin = mint("acme3", "boss", "admin")
    created = client.post("/api/admin/keys", headers=admin, json={"subject": "dave"}).json()
    res = client.post(f"/api/admin/keys/{created['key']['id']}/revoke", headers=admin)
    assert res.status_code == 200 and res.json()["key"]["state"] == "revoked"
    assert client.get("/api/admin/keys", headers=bearer(created["token"])).status_code == 401
    again = client.post(f"/api/admin/keys/{created['key']['id']}/revoke", headers=admin)
    assert again.status_code == 409


def test_rotating_replaces_the_key_with_the_same_identity():
    admin = mint("acme4", "boss", "admin")
    old = client.post("/api/admin/keys", headers=admin, json={"subject": "erin", "role": "viewer", "label": "ci"}).json()
    res = client.post(f"/api/admin/keys/{old['key']['id']}/rotate", headers=admin, json={"expires_in_days": 7})
    assert res.status_code == 201
    new = res.json()
    assert (new["key"]["subject"], new["key"]["role"], new["key"]["label"]) == ("erin", "viewer", "ci")
    assert new["key"]["expires_at"] and new["replaced"]["state"] == "revoked"
    db = SessionLocal()
    try:
        assert authenticate(db, old["token"]) is None
        assert authenticate(db, new["token"]).subject == "erin"
    finally:
        db.close()


def test_an_admin_cannot_lock_itself_out():
    admin_token, admin_id = key_with_expiry(None, tenant="acme5", subject="boss", role="admin")
    h = bearer(admin_token)
    assert client.post(f"/api/admin/keys/{admin_id}/revoke", headers=h).status_code == 409
    assert client.post(f"/api/admin/keys/{admin_id}/rotate", headers=h).status_code == 409
    assert client.get("/api/admin/keys", headers=h).status_code == 200  # still works


def test_another_tenants_keys_are_invisible_and_untouchable():
    mine = mint("tenant-a", "boss", "admin")
    _, foreign_id = key_with_expiry(None, tenant="tenant-b", subject="victim")
    assert foreign_id not in str(client.get("/api/admin/keys", headers=mine).json())
    for path in (f"/api/admin/keys/{foreign_id}/revoke", f"/api/admin/keys/{foreign_id}/rotate", "/api/admin/keys/nope/revoke"):
        res = client.post(path, headers=mine)
        assert res.status_code == 404 and res.json()["detail"] == "No such key"  # same answer as an unknown id
    db = SessionLocal()
    try:
        assert db.get(ApiKey, foreign_id).revoked_at is None
    finally:
        db.close()


@pytest.mark.parametrize("body", [
    {"subject": "bad name with spaces"},
    {"subject": "x", "role": "superuser"},
    {"subject": "x", "expires_in_days": 0},
    {"subject": "x", "tenant_id": "other"},  # the tenant always comes from the admin's key
])
def test_invalid_requests_are_rejected(body):
    admin = mint("acme6", "boss", "admin")
    assert client.post("/api/admin/keys", headers=admin, json=body).status_code == 422


# ---- CLI -----------------------------------------------------------------------------------------


def test_cli_creates_an_expiring_key_and_lists_its_state(capsys):
    from scripts.manage_keys import main

    assert main(["create", "--tenant", "cli", "--subject", "frank", "--expires-days", "3"]) == 0
    out = capsys.readouterr().out
    assert "expires: 20" in out and "token  : opk_" in out
    assert main(["list", "--tenant", "cli"]) == 0
    assert "active" in capsys.readouterr().out
