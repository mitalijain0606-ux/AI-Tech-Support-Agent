"""Deployment readiness: configuration validation, database URL handling and
the /health (liveness) vs /ready (readiness) probes."""

import pytest
from starlette.testclient import TestClient

from operon_backend import embeddings
from operon_backend import main as backend_main
from operon_backend.config import Settings
from operon_backend.main import app, check_configuration

client = TestClient(app)


# ---- database URLs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "given,expected",
    [
        ("postgres://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
        ("postgresql://u:p@host/db?sslmode=require", "postgresql+psycopg://u:p@host/db?sslmode=require"),
        ("postgresql+psycopg://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
        ("sqlite:///./operon.db", "sqlite:///./operon.db"),
    ],
)
def test_database_urls_are_normalized_for_the_installed_driver(given, expected):
    assert Settings(database_url=given).sqlalchemy_url == expected


def test_sqlite_detection():
    assert Settings(database_url="sqlite:///x.db").is_sqlite
    assert not Settings(database_url="postgres://u:p@h/d").is_sqlite


# ---- configuration problems ------------------------------------------------------------------


def test_missing_groq_key_is_a_warning_that_names_the_variable_not_a_value():
    problems = Settings(groq_api_key="").problems()
    assert any("GROQ_API_KEY" in message and level == "warning" for level, message in problems)
    assert not Settings(groq_api_key="x" * 8).problems() or all("GROQ_API_KEY" not in m for _, m in Settings(groq_api_key="x" * 8).problems())


def test_production_with_sqlite_warns():
    assert any("DATABASE_URL" in m for _, m in Settings(environment="production", database_url="sqlite:///x.db").problems())
    assert not any("DATABASE_URL" in m for _, m in Settings(environment="production", database_url="postgres://u:p@h/d").problems())


def test_problem_messages_never_contain_secret_values():
    secret = "super-secret-value-123"
    settings = Settings(groq_api_key=secret, database_url=f"postgres://user:{secret}@h/d", environment="production")
    assert secret not in " ".join(m for _, m in settings.problems())


def test_an_unsafe_production_configuration_refuses_to_start(monkeypatch):
    class Unsafe(Settings):
        def problems(self):
            return [("error", "AUTH is disabled")]

    monkeypatch.setattr(backend_main, "settings", Unsafe(environment="production"))
    with pytest.raises(RuntimeError, match="Refusing to start"):
        check_configuration()
    monkeypatch.setattr(backend_main, "settings", Unsafe(environment="development"))
    check_configuration()  # development only warns


# ---- probes ---------------------------------------------------------------------------------


def test_health_is_dependency_free():
    assert client.get("/health").json() == {"status": "ok"}


def test_ready_reports_checks_without_secrets(monkeypatch):
    body = client.get("/ready").json()
    assert body["status"] in ("ready", "degraded")
    assert body["checks"]["database"] == {"status": "ok", "kind": "sqlite"}
    assert body["checks"]["groq"]["configured"] is False  # the test suite blanks the key
    assert set(body["checks"]["embeddings"]) == {"loaded", "unavailable", "reason"}

    sentinel = "sentinel-key-value-0123456789"
    monkeypatch.setattr(backend_main.settings, "groq_api_key", sentinel)
    configured = client.get("/ready")
    assert configured.json()["checks"]["groq"]["configured"] is True
    assert sentinel not in configured.text  # whether it is set is reported, never what it is


def test_ready_is_degraded_not_failed_when_the_embedding_model_is_unavailable(monkeypatch):
    monkeypatch.setattr(embeddings, "status", lambda: {"loaded": False, "unavailable": True, "reason": "ProxyError"})
    res = client.get("/ready")
    assert res.status_code == 200 and res.json()["status"] == "degraded"


def test_ready_is_503_when_the_database_is_down(monkeypatch):
    class Broken:
        def execute(self, *a, **k):
            raise ConnectionError("db down")

        def close(self):
            pass

    monkeypatch.setattr(backend_main, "SessionLocal", lambda: Broken())
    res = client.get("/ready")
    assert res.status_code == 503 and res.json()["status"] == "unavailable"
    assert res.json()["checks"]["database"] == {"status": "error", "error": "ConnectionError"}
    assert "db down" not in res.text  # the exception type only, never its message
    assert client.get("/health").status_code == 200  # liveness is unaffected
