"""Authentication: API keys, the 401 contract, key lifecycle, roles."""

import pytest
from starlette.testclient import TestClient

from auth_helpers import mint
from flow_helpers import CAPABILITIES
from operon_backend.auth import ROLES, TOKEN_PREFIX, authenticate, create_api_key, hash_token, revoke_api_key
from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import ApiKey
from operon_backend.main import app
from operon_backend.ratelimit import limiter

client = TestClient(app)
NEW = {"user_issue": "my dashboard is broken", "provider_capabilities": CAPABILITIES}


@pytest.fixture(autouse=True)
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)


@pytest.fixture
def db():
    session = SessionLocal()
    yield session
    session.close()


# ---- keys -------------------------------------------------------------------------------------


def test_only_a_hash_of_the_token_is_stored(db):
    token, row = create_api_key(db, "acme", "alice", "user", "laptop")
    assert token.startswith(TOKEN_PREFIX) and len(token) > 40
    stored = db.get(ApiKey, row.id)
    assert stored.key_hash == hash_token(token) and token not in (stored.key_hash, stored.key_prefix)
    assert token not in repr([getattr(stored, c.name) for c in ApiKey.__table__.columns])


def test_keys_are_random_and_unique(db):
    tokens = {create_api_key(db, "acme", "alice")[0] for _ in range(20)}
    assert len(tokens) == 20


@pytest.mark.parametrize("tenant,subject,role", [("bad tenant", "alice", "user"), ("acme", "a b", "user"), ("acme", "alice", "root"), ("", "alice", "user"), ("x" * 65, "alice", "user")])
def test_invalid_key_parameters_are_rejected(db, tenant, subject, role):
    with pytest.raises(ValueError):
        create_api_key(db, tenant, subject, role)


def test_authenticate_resolves_tenant_subject_and_role(db):
    token, row = create_api_key(db, "acme", "alice", "admin")
    principal = authenticate(db, token)
    assert (principal.tenant_id, principal.subject, principal.role, principal.key_id) == ("acme", "alice", "admin", row.id)
    assert db.get(ApiKey, row.id).last_used_at is not None


def test_revoked_unknown_and_malformed_tokens_authenticate_as_nobody(db):
    token, row = create_api_key(db, "acme", "alice")
    assert revoke_api_key(db, row.id) and not revoke_api_key(db, row.id)
    assert authenticate(db, token) is None
    assert authenticate(db, TOKEN_PREFIX + "x" * 43) is None
    assert authenticate(db, "not-a-token") is None
    assert authenticate(db, TOKEN_PREFIX + "x" * 500) is None


# ---- the 401 contract -------------------------------------------------------------------------------


def test_every_session_endpoint_requires_authentication():
    calls = [
        ("post", "/api/sessions", NEW),
        ("get", "/api/sessions/some-id", None),
        ("get", "/api/sessions/some-id/events", None),
        ("post", "/api/sessions/some-id/investigate", {"bundle": {"url": "u", "timestamp": 1}}),
        ("post", "/api/sessions/some-id/diagnose", {"bundle": {"url": "u", "timestamp": 1}}),
        ("post", "/api/sessions/some-id/policy", {}),
        ("post", "/api/sessions/some-id/approve", {"approved": True}),
        ("post", "/api/sessions/some-id/action-result", {"action_id": "reload", "succeeded": True}),
        ("post", "/api/sessions/some-id/verify", {"action_id": "reload", "observation": {}}),
        ("post", "/api/policy", {"action_id": "reload", "provider_capabilities": ["reload"]}),
        ("post", "/api/diagnose", {"message": "x", "bundle": {"url": "u", "timestamp": 1}}),
    ]
    for method, path, body in calls:
        limiter.reset()  # this test is about the 401 contract, not the failed-attempt throttle (test_rate_limit.py)
        res = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert res.status_code == 401, (path, res.status_code)
        assert res.headers["www-authenticate"] == "Bearer"
        assert res.json() == {"detail": "Authentication required"}


def test_health_and_ready_stay_open_for_orchestrators():
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code in (200, 503)


def test_one_message_for_missing_malformed_unknown_and_revoked(db):
    token, row = create_api_key(db, "acme", "alice")
    revoke_api_key(db, row.id)
    bodies = set()
    for header in ({}, {"Authorization": "Bearer"}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer opk_nope"}, {"Authorization": f"Bearer {token}"}):
        res = client.post("/api/sessions", json=NEW, headers=header)
        assert res.status_code == 401
        bodies.add(res.text)
    assert len(bodies) == 1  # no oracle for what was wrong


def test_a_valid_key_creates_and_reads_its_session():
    headers = mint("acme", "alice")
    created = client.post("/api/sessions", json=NEW, headers=headers)
    assert created.status_code == 200
    sid = created.json()["session_id"]
    assert client.get(f"/api/sessions/{sid}", headers=headers).status_code == 200


def test_the_token_is_never_echoed_in_responses_or_logs(caplog):
    caplog.set_level("DEBUG")
    headers = mint("acme", "alice")
    token = headers["Authorization"].split()[1]
    res = client.post("/api/sessions", json=NEW, headers=headers)
    assert token not in res.text and token not in caplog.text
    bad = client.post("/api/sessions", json=NEW, headers={"Authorization": f"Bearer {token}x"})
    assert token not in bad.text and token not in caplog.text


# ---- roles ------------------------------------------------------------------------------------------------


def test_a_viewer_key_can_read_but_not_create_or_decide():
    owner = mint("acme", "alice", "user")
    sid = client.post("/api/sessions", json=NEW, headers=owner).json()["session_id"]
    viewer = mint("acme", "alice", "viewer")  # same subject, read-only key
    assert client.get(f"/api/sessions/{sid}", headers=viewer).status_code == 200
    assert client.post("/api/sessions", json=NEW, headers=viewer).status_code == 403
    for path, body in (("policy", {}), ("approve", {"approved": True}), ("action-result", {"action_id": "reload", "succeeded": True})):
        assert client.post(f"/api/sessions/{sid}/{path}", json=body, headers=viewer).status_code == 403, path


def test_roles_are_a_closed_set():
    assert ROLES == ("viewer", "user", "admin")


# ---- authentication turned off (local development) ------------------------------------------------------------------


def test_with_auth_disabled_everyone_is_the_public_principal(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", False)
    res = client.post("/api/sessions", json=NEW)
    assert res.status_code == 200
    sid = res.json()["session_id"]
    assert client.get(f"/api/sessions/{sid}").status_code == 200
