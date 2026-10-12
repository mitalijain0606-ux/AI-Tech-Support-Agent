"""Production hardening of the public surface:

- `/ready` gives an anonymous caller in production only a generic status; detailed
  diagnostics need an authenticated admin key (the normal authentication, not a
  bypass); outside production nothing changes.
- `/docs`, `/redoc` and `/openapi.json` are not served in production, and are in
  development.
- `/health` stays open and unchanged (it is what the platform's health check uses).
"""

import json
import subprocess
import sys
from pathlib import Path

import pytest
from auth_helpers import mint
from starlette.testclient import TestClient

from operon_backend import embeddings
from operon_backend import main as backend_main
from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.main import api_docs_urls, app
from operon_backend.ratelimit import limiter

client = TestClient(app)
BACKEND_ROOT = Path(__file__).resolve().parent.parent

# Every fragment that would tell an anonymous caller something about the deployment.
FORBIDDEN_IN_ANONYMOUS = [
    "sqlite", "postgres", "kind", "curated", "chunk", "knowledge", "embedding", "loaded", "unavailable_reason",
    "groq", "openai", "gpt", "model", "configured", "config_problems", "REDIS", "AUTH_REQUIRED", "environment",
    "production", "development", "checks", "reason", "error", "Error",
]


@pytest.fixture
def db():
    session = SessionLocal()
    yield session
    session.close()


@pytest.fixture
def production(monkeypatch):
    monkeypatch.setattr(settings, "environment", "production")
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "groq_api_key", "sentinel-key-value-0123456789")  # configured: must still not be revealed
    limiter.reset()
    yield
    limiter.reset()


def anonymous_is_minimal(res, status="ok", code=200):
    assert res.status_code == code
    assert res.json() == {"status": status}
    for fragment in FORBIDDEN_IN_ANONYMOUS:
        assert fragment not in res.text, f"anonymous /ready response leaks {fragment!r}: {res.text}"
    assert "sentinel-key-value" not in res.text


# ---- /ready: anonymous in production ---------------------------------------------------------


def test_anonymous_ready_in_production_is_only_a_generic_status(production):
    anonymous_is_minimal(client.get("/ready"))


def test_anonymous_ready_hides_a_degraded_state(production, monkeypatch):
    monkeypatch.setattr(embeddings, "status", lambda: {"loaded": False, "unavailable": True, "reason": "ProxyError"})
    anonymous_is_minimal(client.get("/ready"))


def test_anonymous_ready_reports_unavailable_without_detail_when_the_database_is_down(production, monkeypatch):
    class Broken:
        def execute(self, *a, **k):
            raise ConnectionError("db down at 10.0.0.5")

        def close(self):
            pass

    monkeypatch.setattr(backend_main, "SessionLocal", lambda: Broken())
    res = client.get("/ready")
    anonymous_is_minimal(res, status="unavailable", code=503)
    assert "10.0.0.5" not in res.text and "ConnectionError" not in res.text
    assert client.get("/health").status_code == 200  # liveness is independent


def test_every_unauthorized_viewer_gets_the_same_minimal_answer(production):
    viewer, user = mint("acme", "v", "viewer"), mint("acme", "u", "user")
    for headers in ({}, viewer, user):
        anonymous_is_minimal(client.get("/ready", headers=headers))


# ---- /ready: authenticated admin ---------------------------------------------------------------


def test_an_admin_key_gets_full_diagnostics(production):
    admin = mint("acme", "root", "admin")
    res = client.get("/ready", headers=admin)
    assert res.status_code == 200
    body = res.json()
    assert body["status"] in ("ready", "degraded")
    assert set(body) == {"status", "checks", "config_problems"}
    assert body["checks"]["database"] == {"status": "ok", "kind": "sqlite"}
    assert body["checks"]["environment"] == "production"
    assert body["checks"]["groq"]["configured"] is True
    assert "sentinel-key-value" not in res.text  # even the admin never sees a secret value


def test_an_admin_sees_a_degraded_state_that_an_anonymous_caller_does_not(production, monkeypatch):
    monkeypatch.setattr(embeddings, "status", lambda: {"loaded": False, "unavailable": True, "reason": "ProxyError"})
    admin = mint("acme", "root", "admin")
    assert client.get("/ready", headers=admin).json()["status"] == "degraded"
    anonymous_is_minimal(client.get("/ready"))


def test_the_admin_path_is_the_ordinary_authentication_not_a_bypass(production, db):
    from operon_backend.auth import create_api_key, revoke_api_key

    # forged / malformed credentials: the usual 401, no detail
    for header in ({"Authorization": "Bearer opk_forged"}, {"Authorization": "Basic abc"}, {"Authorization": "Bearer"}):
        res = client.get("/ready", headers=header)
        assert res.status_code == 401 and res.json() == {"detail": "Authentication required"}
        assert "checks" not in res.text
        limiter.reset()
    # a revoked admin key stops working
    token, row = create_api_key(db, "acme", "ex-admin", "admin")
    headers = {"Authorization": f"Bearer {token}"}
    assert "checks" in client.get("/ready", headers=headers).json()
    assert revoke_api_key(db, row.id)
    assert client.get("/ready", headers=headers).status_code == 401
    # guessing keys at /ready shares the failed-attempt throttle with every other endpoint
    limiter.reset()
    codes = [client.get("/ready", headers={"Authorization": "Bearer opk_guess"}).status_code for _ in range(settings.rate_limit_auth_failures_per_minute + 2)]
    assert codes[0] == 401 and codes[-1] == 429


# ---- /ready outside production is unchanged ----------------------------------------------------


def test_outside_production_ready_still_shows_diagnostics_to_everyone(monkeypatch):
    for environment in ("development", "test"):
        monkeypatch.setattr(settings, "environment", environment)
        body = client.get("/ready").json()
        assert body["status"] in ("ready", "degraded") and "checks" in body and "config_problems" in body


def test_health_is_open_and_identical_in_production(production):
    res = client.get("/health")
    assert res.status_code == 200 and res.json() == {"status": "ok"}


# ---- documentation endpoints --------------------------------------------------------------------


def test_docs_urls_by_environment():
    assert api_docs_urls("production") == {"docs_url": None, "redoc_url": None, "openapi_url": None}
    for environment in ("development", "test"):
        assert api_docs_urls(environment) == {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}


def test_this_test_environment_serves_docs():
    assert settings.environment != "production"
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 200, path


def _run_app_in_a_fresh_process(environment: str, tmp_path) -> dict:
    """The real module, imported with ENVIRONMENT set, on a migrated throwaway database —
    the only faithful way to test construction-time configuration."""
    env = {
        "PATH": "/usr/bin:/bin",
        "ENVIRONMENT": environment,
        "AUTH_REQUIRED": "true",
        "DATABASE_URL": f"sqlite:///{tmp_path}/fresh.db",
        "GROQ_API_KEY": "",
        "LOG_LEVEL": "ERROR",
    }
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND_ROOT, env=env, check=True, capture_output=True)
    code = (
        "import json\n"
        "from starlette.testclient import TestClient\n"
        "from operon_backend.main import app\n"
        "c = TestClient(app)\n"
        "out = {p: c.get(p).status_code for p in ('/docs', '/redoc', '/openapi.json', '/health', '/ready')}\n"
        "out['ready_body'] = c.get('/ready').json()\n"
        "out['routes'] = sorted(r.path for r in app.routes if r.path in ('/docs', '/redoc', '/openapi.json'))\n"
        "print('RESULT ' + json.dumps(out))\n"
    )
    done = subprocess.run([sys.executable, "-c", code], cwd=BACKEND_ROOT, env=env, check=True, capture_output=True, text=True)
    line = next(line for line in done.stdout.splitlines() if line.startswith("RESULT "))
    return json.loads(line[len("RESULT "):])


def test_a_production_process_serves_no_docs_and_a_minimal_ready(tmp_path):
    out = _run_app_in_a_fresh_process("production", tmp_path)
    assert (out["/docs"], out["/redoc"], out["/openapi.json"]) == (404, 404, 404)
    assert out["routes"] == []
    assert out["/health"] == 200
    assert out["/ready"] == 200 and out["ready_body"] == {"status": "ok"}


def test_a_development_process_serves_docs_and_detailed_ready(tmp_path):
    out = _run_app_in_a_fresh_process("development", tmp_path)
    assert (out["/docs"], out["/redoc"], out["/openapi.json"]) == (200, 200, 200)
    assert out["/health"] == 200 and "checks" in out["ready_body"]
