"""Structured logging and request tracing, CORS configuration, key CLI."""

import io
import json
import logging

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from operon_backend.logging_config import RequestLogMiddleware, configure_logging, request_id_var
from operon_backend.main import app, configure_cors

client = TestClient(app)
TOKEN = "".join(["gh", "p_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0"])


@pytest.fixture
def log_lines():
    """Captures what the structured logger writes, as parsed JSON."""
    stream = io.StringIO()
    root = logging.getLogger()
    saved = list(root.handlers), root.level
    configure_logging("INFO", "json")
    for h in root.handlers:
        if getattr(h, "_operon", False):
            h.stream = stream
    yield lambda: [json.loads(line) for line in stream.getvalue().splitlines() if line.startswith("{")]
    root.handlers[:] = saved[0]
    root.setLevel(saved[1])


# ---- request ids --------------------------------------------------------------------------------------


def test_every_response_carries_a_request_id():
    a, b = client.get("/health"), client.get("/health")
    assert a.headers["x-request-id"] and a.headers["x-request-id"] != b.headers["x-request-id"]


def test_a_sane_inbound_request_id_is_honoured_and_a_hostile_one_is_not():
    assert client.get("/health", headers={"X-Request-ID": "trace-1234.abcd"}).headers["x-request-id"] == "trace-1234.abcd"
    for hostile in ("short", "has space and more than eight", "x" * 200, "evil\r\nSet-Cookie: a=b"):
        got = client.get("/health", headers={"X-Request-ID": hostile.replace("\r\n", "")}).headers["x-request-id"]
        assert got != hostile and len(got) <= 64


# ---- the access log --------------------------------------------------------------------------------------------


def test_one_json_access_line_per_request_without_query_string_or_body(log_lines):
    client.post("/api/diagnose?token=" + TOKEN, json={"message": "my password is hunter2hunter2", "bundle": {"url": "u", "timestamp": 1}})
    lines = [line for line in log_lines() if line["logger"] == "operon.request"]
    assert len(lines) == 1
    line = lines[0]
    assert line["method"] == "POST" and line["route"] == "/api/diagnose" and isinstance(line["status"], int)
    assert isinstance(line["duration_ms"], float) and line["request_id"] not in ("", "-")
    text = json.dumps(line)
    assert TOKEN[4:] not in text and "hunter2" not in text and "token=" not in text


def test_request_id_in_the_log_matches_the_response_header(log_lines):
    res = client.get("/health")
    assert [line["request_id"] for line in log_lines() if line["logger"] == "operon.request"] == [res.headers["x-request-id"]]


def test_secrets_in_any_log_message_are_masked(log_lines):
    logging.getLogger("operon.test").warning("upstream said: Authorization: Bearer %s", "abcdefghijklmnopqrstuvwxyz0123")
    logging.getLogger("operon.test").error("token leaked %s", TOKEN)
    out = json.dumps(log_lines())
    assert "abcdefghijklmnopqrstuvwxyz0123" not in out and TOKEN[4:] not in out and "[REDACTED:" in out


def test_text_format_is_readable_and_also_redacted():
    stream = io.StringIO()
    configure_logging("INFO", "text")
    root = logging.getLogger()
    handler = next(h for h in root.handlers if getattr(h, "_operon", False))
    handler.stream = stream
    token = request_id_var.set("req-abcdef12")
    try:
        logging.getLogger("x").info("hello %s", TOKEN)
    finally:
        request_id_var.reset(token)
        configure_logging("INFO", "text")
    out = stream.getvalue()
    assert "[req-abcdef12]" in out and "hello" in out and TOKEN[4:] not in out


# ---- error reporting --------------------------------------------------------------------------------------------


def test_an_unhandled_error_is_logged_with_its_type_and_answered_with_a_generic_500(log_lines):
    boom = FastAPI()
    boom.add_middleware(RequestLogMiddleware)

    @boom.get("/boom")
    async def _boom():
        raise RuntimeError(f"database exploded with credentials {TOKEN}")

    res = TestClient(boom, raise_server_exceptions=False).get("/boom", headers={"X-Request-ID": "trace-boom-0001"})
    assert res.status_code == 500
    assert res.json() == {"detail": "Internal error", "request_id": "trace-boom-0001"}
    assert TOKEN[4:] not in res.text and "exploded" not in res.text  # the caller learns nothing about internals
    errors = [line for line in log_lines() if line["level"] == "ERROR"]
    assert errors and errors[0]["error_type"] == "RuntimeError" and errors[0]["request_id"] == "trace-boom-0001"
    assert TOKEN[4:] not in json.dumps(errors) and "traceback" in errors[0]
    access = [line for line in log_lines() if line["logger"] == "operon.request" and line["level"] == "INFO"]
    assert access and access[0]["status"] == 500


# ---- CORS ---------------------------------------------------------------------------------------------------------


def test_cors_is_off_by_default():
    res = client.options("/api/sessions", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in res.headers
    assert "access-control-allow-origin" not in client.get("/health", headers={"Origin": "https://evil.example"}).headers


def test_only_configured_origins_are_allowed_and_credentials_are_never_enabled():
    target = FastAPI()

    @target.get("/x")
    async def _x():
        return {}

    configure_cors(target, ["https://app.example.com"])
    c = TestClient(target)
    ok = c.get("/x", headers={"Origin": "https://app.example.com"})
    assert ok.headers["access-control-allow-origin"] == "https://app.example.com"
    assert "access-control-allow-credentials" not in ok.headers
    assert "access-control-allow-origin" not in c.get("/x", headers={"Origin": "https://evil.example"}).headers
    pre = c.options("/x", headers={"Origin": "https://app.example.com", "Access-Control-Request-Method": "DELETE"})
    assert pre.status_code == 400  # methods outside GET/POST/OPTIONS are refused


def test_no_origins_means_no_middleware():
    target = FastAPI()
    configure_cors(target, [])
    assert not target.user_middleware


# ---- the key CLI --------------------------------------------------------------------------------------------------


def test_the_key_cli_creates_lists_and_revokes(capsys, monkeypatch):
    import importlib.util
    import pathlib

    spec = importlib.util.spec_from_file_location("manage_keys", pathlib.Path(__file__).parent.parent / "scripts" / "manage_keys.py")
    cli = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cli)

    assert cli.main(["create", "--tenant", "cli-co", "--subject", "dana", "--role", "admin", "--label", "ci"]) == 0
    out = capsys.readouterr().out
    key_id = next(line.split(":", 1)[1].strip() for line in out.splitlines() if line.startswith("key id"))
    token = next(line.split(":", 1)[1].strip() for line in out.splitlines() if line.startswith("token"))
    assert token.startswith("opk_")

    assert cli.main(["list", "--tenant", "cli-co"]) == 0
    listing = capsys.readouterr().out
    assert key_id in listing and "active" in listing and token not in listing  # a token is never listed

    assert cli.main(["revoke", key_id]) == 0 and cli.main(["revoke", key_id]) == 1
    assert "revoked" in capsys.readouterr().out
