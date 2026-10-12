"""Authentication is required by default — in the code, in the example config a
person copies, and on a running app — and an unsafe production setting is refused."""

from pathlib import Path

import pytest
from dotenv import dotenv_values
from starlette.testclient import TestClient

from operon_backend.config import Settings, settings
from operon_backend.main import app

EXAMPLE = Path(__file__).resolve().parent.parent / ".env.example"
AUTH_ENV = ("AUTH_REQUIRED", "ENVIRONMENT", "CORS_ALLOW_ORIGINS")


@pytest.fixture
def clean_env(monkeypatch):
    for name in AUTH_ENV:
        monkeypatch.delenv(name, raising=False)


def test_the_code_default_requires_auth(clean_env):
    assert Settings(_env_file=None).auth_required is True


def test_the_example_config_a_person_copies_requires_auth(clean_env):
    values = dotenv_values(EXAMPLE)
    assert values["AUTH_REQUIRED"] == "true"
    assert Settings(_env_file=EXAMPLE).auth_required is True
    assert (values.get("CORS_ALLOW_ORIGINS") or "") == ""  # and no cross-origin access either


def test_the_example_config_carries_no_real_key(clean_env):
    assert not dotenv_values(EXAMPLE).get("GROQ_API_KEY")


def test_production_refuses_to_start_without_auth(clean_env):
    problems = Settings(_env_file=None, environment="production", auth_required=False).problems()
    assert ("error", "AUTH_REQUIRED is false: production must authenticate every session endpoint") in problems
    assert not [p for p in Settings(_env_file=None, environment="production", auth_required=True).problems() if p[0] == "error"]


SESSION_ENDPOINTS = [
    ("post", "/api/sessions", {"user_issue": "x"}),
    ("get", "/api/sessions/abc", None),
    ("get", "/api/sessions/abc/events", None),
    ("post", "/api/sessions/abc/investigate", {"bundle": {"url": "u", "timestamp": 1}}),
    ("post", "/api/sessions/abc/diagnose", {"bundle": {"url": "u", "timestamp": 1}}),
    ("post", "/api/sessions/abc/policy", {}),
    ("post", "/api/sessions/abc/answer", {"request_id": "r", "answer": "hi"}),
    ("post", "/api/sessions/abc/approve", {"approved": True}),
    ("post", "/api/sessions/abc/action-result", {"action_id": "reload", "succeeded": True}),
    ("post", "/api/sessions/abc/verify", {"action_id": "reload", "observation": {"console": [], "network": []}}),
    ("post", "/api/diagnose", {"message": "x", "bundle": {"url": "u", "timestamp": 1}}),
    ("post", "/api/policy", {"action_id": "reload"}),
]


def test_a_running_app_with_the_default_setting_rejects_every_unauthenticated_call(monkeypatch, clean_env):
    # conftest turns auth off for the other suites; restore the real default here.
    monkeypatch.setattr(settings, "auth_required", Settings(_env_file=None).auth_required)
    from operon_backend.ratelimit import limiter

    client = TestClient(app)
    for method, path, body in SESSION_ENDPOINTS:
        limiter.reset()  # the failed-auth throttle (tested elsewhere) would otherwise answer 429 after 10 attempts
        res = getattr(client, method)(path, **({"json": body} if body is not None else {}))
        assert res.status_code == 401, (path, res.status_code)
        assert res.headers["www-authenticate"] == "Bearer"
        bad = getattr(client, method)(path, headers={"Authorization": "Bearer opk_not-a-real-key"}, **({"json": body} if body is not None else {}))
        assert bad.status_code == 401 and bad.text == res.text, path  # no oracle between missing and forged
    assert client.get("/health").status_code == 200  # liveness stays open
