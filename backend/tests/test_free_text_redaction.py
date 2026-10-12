"""Free text (the user's issue, answers, an action's outcome) is redacted for
credential shapes no fixed rule knows. Mirror of extension/tests/free-text-heuristics.test.mjs."""

import json
import random

import pytest
from flow_helpers import new_session, submit
from starlette.testclient import TestClient

from operon_backend.main import app
from operon_backend.tripwire import redact_free_text, shannon_entropy

client = TestClient(app)
BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
UNKNOWN_KEY = "Zq9Xk2LmN8vB4cR7tY1wE5uI3oP6aS0d"


def test_random_keys_are_redacted_at_measured_rates():
    rng = random.Random(42)
    for length, minimum in ((24, 0.9), (32, 0.97), (40, 0.99), (64, 0.99)):
        hits = 0
        for _ in range(2000):
            key = "".join(rng.choice(BASE62) for _ in range(length))
            out, _ = redact_free_text(f"my key is {key} please help")
            hits += key[:12] not in out and "please help" in out
        assert hits / 2000 >= minimum, (length, hits / 20)


@pytest.mark.parametrize(
    "secret",
    [
        "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
        "SG." + "abcdEFGH1234abcd" + "." + "ijklMNOP5678ijkl",
        "npm_" + "abcdEFGHijklMNOP0123456789abcdEF",
        "pypi-" + "AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWprbG1ub3BxcnN0dQ",
        UNKNOWN_KEY,
    ],
)
def test_unknown_formats_are_redacted(secret):
    out, rules = redact_free_text(f"x {secret} y")
    assert secret[6:] not in out and rules


def test_stated_secrets_only_when_they_look_like_one():
    assert "[REDACTED:stated_secret]" in redact_free_text("my password is hunter2x, please reset it")[0]
    for ok in ("my token is expired", "the password is wrong", "the key is missing", "pin is required for this"):
        assert redact_free_text(ok) == (ok, [])


@pytest.mark.parametrize(
    "text",
    [
        "The dashboard shows a 500 error at /api/projects after I clicked Save",
        "TypeError: Cannot read properties of undefined (reading 'map') at renderProjectListItems",
        "Error: getUserPreferencesFromLocalStorageHandlerFactory is not a function",
        "commit 4f3a9c1d2b7e9f0a1b2c3d4e5f60718293a4b5c6 broke it",
        "session 123e4567-e89b-12d3-a456-426614174000 expired",
        "see https://github.com/octocat/Hello-World/issues/1234 and https://example.com/AbCdEf123456GhIjKl789012MnOpQr",
        "I use Chrome 129.0.6668.89 on macOS 14.6.1",
        "version 2026.10.10-rc1 of buggy-cloud",
    ],
)
def test_ordinary_text_is_unchanged(text):
    assert redact_free_text(text) == (text, [])


def test_known_limitation_identifier_with_digit_can_be_over_redacted():
    assert "[REDACTED:high_entropy_token] fails" in redact_free_text("ReactDOMServerRenderToPipeableStream2ndAttempt fails")[0]


def test_entropy_helper():
    assert shannon_entropy("aaaa") == 0


# ---- the API stores none of it ---------------------------------------------------------------


def test_the_issue_is_stored_without_an_unknown_format_key():
    res = client.post("/api/sessions", json={"user_issue": f"broken, key {UNKNOWN_KEY}, my password is hunter2x9", "provider_capabilities": ["inspect_page"]})
    assert res.status_code == 200
    assert UNKNOWN_KEY not in res.text and "hunter2x9" not in res.text
    assert UNKNOWN_KEY not in client.get(f"/api/sessions/{res.json()['session_id']}").text


def test_an_answer_is_stored_without_an_unknown_format_key(monkeypatch):
    from flow_helpers import FakeGroq, answer

    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    FakeGroq(monkeypatch, [answer("insufficient_evidence", (), info={"collectors": ["console"], "reason": "r", "question": "What did you click?"})])
    s = new_session(client)
    body = submit(client, s, console=[{"id": "ev_c", "level": "warning", "text": "w"}]).json()["session"]
    res = client.post(f"/api/sessions/{body['session_id']}/answer", json={"request_id": body["evidence_request"]["request_id"], "answer": f"I pasted {UNKNOWN_KEY}"})
    assert res.status_code == 200
    assert UNKNOWN_KEY not in client.get(f"/api/sessions/{body['session_id']}").text


# ---- evidence text written by the page --------------------------------------------------------------


def test_console_text_in_unknown_formats_is_scrubbed_before_it_is_stored_or_shown_to_the_model():
    s = new_session(client)
    body = submit(
        client,
        s,
        console=[
            {"id": "ev_c1", "level": "error", "text": f"auth failed key={UNKNOWN_KEY} and my password is hunter2x9"},
            {"id": "ev_c2", "level": "error", "text": "TypeError: Cannot read properties of undefined (reading 'map')"},
        ],
        network=[{"id": "ev_n1", "method": "GET", "url": f"https://api.test/x/{UNKNOWN_KEY}", "status": 500}],
        storage=[{"id": "ev_s1", "key": "k", "present": True, "parse_status": "syntax_error", "error_message": f'Unexpected token, "{UNKNOWN_KEY}" is not valid JSON'}],
    )
    assert body.status_code == 200, body.text
    from operon_backend.db import SessionLocal
    from operon_backend.db_models import SessionRecord

    db = SessionLocal()
    try:
        raw = json.dumps(db.get(SessionRecord, s["session_id"]).collected_evidence)
    finally:
        db.close()
    assert UNKNOWN_KEY not in raw and "hunter2x9" not in raw
    assert "TypeError: Cannot read properties of undefined (reading 'map')" in raw  # ordinary text untouched
    assert UNKNOWN_KEY not in client.get(f"/api/sessions/{s['session_id']}").text


def test_observations_are_scrubbed_the_same_way_so_verification_still_compares_like_with_like():
    from operon_backend.evidence import scrub_observation
    from operon_backend.schemas import ConsoleEvidence, VerificationObservation

    obs = VerificationObservation(console=[ConsoleEvidence(id="ev_1", text=f"failed key={UNKNOWN_KEY}")], network=[])
    cleaned = scrub_observation(obs)
    assert UNKNOWN_KEY not in cleaned.console[0].text
    assert scrub_observation(cleaned).console[0].text == cleaned.console[0].text  # idempotent
