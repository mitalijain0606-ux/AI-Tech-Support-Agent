"""Credential-handling red team: every secret kind is detected, redacted where
free text is kept, rejected where evidence is submitted, and never reaches
storage, the model, the activity log, the knowledge base, API responses or logs.

Every secret below is assembled at runtime from fragments so that no literal
token-shaped string lives in the repository (and so that scanners don't flag
these fixtures as leaks). None of them is a real credential.
"""

import json
import logging

import pytest
from starlette.testclient import TestClient

from flow_helpers import FakeGroq, answer, corrupt_storage, new_session, submit
from operon_backend import knowledge
from operon_backend.db import SessionLocal
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.main import app
from operon_backend.tripwire import TripwireHit, find_credentials, redact_credentials, scan_raw_payload

client = TestClient(app)


def _j(*parts: str) -> str:
    return "".join(parts)


ALNUM = "A1b2C3d4E5f6G7h8J9k0"  # 20 chars
HEX40 = "3f786850e387550fdab836ed7e6dc881de23001b"
HEX64 = HEX40 + "9c1d2e3f4a5b6c7d8e9f0a1b"

# (kind, secret text, the raw value that must never survive redaction)
SECRETS: list[tuple[str, str, str]] = [
    ("jwt", _j("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTYifQ", ".", "c2lnbmF0dXJlLXZhbHVl"), "c2lnbmF0dXJlLXZhbHVl"),
    ("bearer header", _j("Authorization: Bea", "rer ", ALNUM, "xyz"), ALNUM + "xyz"),
    ("bare long hex", _j("9f86d081884c7d65", "9a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "9a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
    ("basic auth", _j("Authorization: Ba", "sic ", "dXNlcm5hbWU6cGFzc3dvcmQxMjM0"), "dXNlcm5hbWU6cGFzc3dvcmQxMjM0"),
    ("json password", _j('{"pass', 'word": "', "hunter2-", ALNUM, '"}'), "hunter2-" + ALNUM),
    ("json access_token", _j('{"access', '_token": "', "at-", ALNUM, '"}'), "at-" + ALNUM),
    ("json api_key", _j('{"api', '_key": "', "k-", ALNUM, '"}'), "k-" + ALNUM),
    ("json client_secret", _j('{"client', '_secret": "', "cs-", ALNUM, '"}'), "cs-" + ALNUM),
    ("json session_id", _j('{"session', '_id": "', "sid-", ALNUM, '"}'), "sid-" + ALNUM),
    ("github classic token", _j("gh", "p_", ALNUM, ALNUM[:16]), ALNUM + ALNUM[:16]),
    ("github oauth token", _j("gh", "o_", ALNUM, ALNUM[:16]), ALNUM + ALNUM[:16]),
    ("github fine-grained token", _j("github", "_pat_", "11ABCDEFG0", ALNUM, "_", ALNUM), ALNUM + "_" + ALNUM),
    ("groq key", _j("gs", "k_", ALNUM, ALNUM), ALNUM + ALNUM),
    ("openai-style key", _j("s", "k-", "proj-", ALNUM, ALNUM), ALNUM + ALNUM),
    ("slack token", _j("xo", "xb-", "123456789012-", "abcdefABCDEF1234"), "abcdefABCDEF1234"),
    ("aws access key id", _j("AK", "IA", "IOSFODNN7EXAMPL0"), "IOSFODNN7EXAMPL0"),
    ("google api key", _j("AI", "za", "SyD-", ALNUM, "abcdefghijklm"), ALNUM + "abcdefghijklm"),
    ("pem private key header", _j("-----BEGIN ", "RSA PRIVATE", " KEY-----"), "PRIVATE KEY-----"),
    ("der private key body", _j("MI", "IEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7", "VJTUt9Us8cKj"), "VJTUt9Us8cKj"),
    ("postgres connection string", _j("postgres", "ql://app:", "s3cr3tPassw0rd", "@db.internal:5432/app"), "s3cr3tPassw0rd"),
    ("https url userinfo", _j("https://deploy:", "Tok3nValue99", "@github.com/octo/repo.git"), "Tok3nValue99"),
    ("url query access_token", _j("https://api.example.com/v1/me?access", "_token=", "qt-", ALNUM), "qt-" + ALNUM),
    ("url fragment token", _j("https://app.example.com/cb#id", "_token=", "ft-", ALNUM), "ft-" + ALNUM),
    ("url query api_key", _j("https://maps.example.com/js?v=3&api", "_key=", "ak-", ALNUM), "ak-" + ALNUM),
    ("password assignment", _j("pass", "word=", "Hunter2Hunter2"), "Hunter2Hunter2"),
    ("api key assignment", _j("api", "_key: ", "9f8e7d6c5b4a3210"), "9f8e7d6c5b4a3210"),
    ("cookie header", _j("Coo", "kie: ", "_gh_sess=", "abc123DEF456ghi789; logged_in=yes"), "abc123DEF456ghi789"),
    ("set-cookie header", _j("Set-Coo", "kie: ", "user_session=", "zz99YY88xx77; Path=/; HttpOnly"), "zz99YY88xx77"),
    ("hex in url query", _j("https://github.com/octo/repo?tok", "en=", HEX40), HEX40),
    ("hex in url fragment", _j("https://github.com/octo/repo#", HEX40), HEX40),
    ("hex in url userinfo", _j("https://", HEX40, "@github.com/octo/repo"), HEX40),
    ("hex after secret word", _j("pass", "word sha256: ", HEX64), HEX64),
]

# Things that look a little like secrets but are not — must never trigger
# (a hit on an evidence payload rejects the whole investigation cycle).
BENIGN: list[tuple[str, str]] = [
    ("form validation message", "password: required"),
    ("prose about tokens", "Your session token expired, please sign in again."),
    ("cookie banner", "This site uses cookies to improve your experience."),
    ("commit sha in prose", f"HEAD is at {HEX40} Merge pull request #12"),
    ("commit keyword", f"commit {HEX40}"),
    ("sha256 digest", f"sha256: {HEX64}"),
    ("owner/repo pin", f"uses: actions/checkout@{HEX40}"),
    ("sha in url path", f"https://github.com/octo/repo/commit/{HEX40}"),
    ("sha in tree url path", f"https://github.com/octo/repo/tree/{HEX40}/src"),
    ("uuid", "request id 123e4567-e89b-12d3-a456-426614174000"),
    ("css color", "color: #ff00ff; background: #00ff00"),
    ("short sk word", "sk-1 is a size class"),
    ("plain url with query", "https://github.com/octo/repo/issues?q=is%3Aopen&page=2"),
    ("console error", "TypeError: Cannot read properties of undefined (reading 'token')"),
    ("network failure", "GET https://collector.github.com/telemetry -> 0 net::ERR_BLOCKED_BY_CLIENT"),
    ("storage key name", "localStorage key 'auth_token_expiry' parse_status ok"),
    ("api key word without value", "api_key: missing"),
]

SECRET_IDS = [kind for kind, _, _ in SECRETS]


# ---- detection & redaction primitives ---------------------------------------------------------


@pytest.mark.parametrize("kind,secret,raw", SECRETS, ids=SECRET_IDS)
def test_every_secret_kind_is_detected(kind, secret, raw):
    assert find_credentials(secret), f"{kind} not detected"
    with pytest.raises(TripwireHit):
        scan_raw_payload(json.dumps({"console": [{"id": "ev_001", "level": "error", "text": f"failed: {secret}"}]}))


@pytest.mark.parametrize("kind,secret,raw", SECRETS, ids=SECRET_IDS)
def test_every_secret_kind_is_redacted_from_free_text(kind, secret, raw):
    text = f"the page broke after I saw {secret} in the console"
    redacted, rules = redact_credentials(text)
    assert raw not in redacted
    assert rules and "[REDACTED:" in redacted
    assert redacted.startswith("the page broke")  # the rest of the message is kept


@pytest.mark.parametrize("kind,text", BENIGN, ids=[k for k, _ in BENIGN])
def test_benign_look_alikes_are_not_flagged(kind, text):
    assert find_credentials(text) == []
    scan_raw_payload(json.dumps({"text": text}))  # does not raise


def test_tripwire_error_never_echoes_the_whole_secret():
    secret = SECRETS[9][1]  # github classic token
    with pytest.raises(TripwireHit) as exc:
        scan_raw_payload(secret)
    assert secret not in str(exc.value) and SECRETS[9][2] not in str(exc.value)


# ---- end to end: nothing raw reaches storage, model, activity, KB, responses or logs --------------


def _session_row_json(session_id: str) -> str:
    db = SessionLocal()
    try:
        row = db.get(SessionRecord, session_id)
        return json.dumps({c.name: getattr(row, c.name) for c in row.__table__.columns}, default=str)
    finally:
        db.close()


@pytest.mark.parametrize("kind,secret,raw", SECRETS, ids=SECRET_IDS)
def test_secret_in_the_users_issue_is_redacted_before_anything_sees_it(kind, secret, raw, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    groq = FakeGroq(monkeypatch, [answer(action={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}})])
    seen_queries: list[str] = []
    monkeypatch.setattr("operon_backend.investigation.search", lambda db, q, *a, **k: seen_queries.append(q) or [])

    s = new_session(client, issue=f"dashboard broken; console showed {secret}")
    assert raw not in json.dumps(s)
    res = submit(client, s, storage=[corrupt_storage()])
    assert res.status_code == 200, res.text

    assert raw not in res.text  # API response
    assert raw not in _session_row_json(s["session_id"])  # database: user_issue, history, activity, diagnoses
    assert groq.calls and all(raw not in json.dumps(call) for call in groq.calls)  # model prompt
    assert seen_queries and all(raw not in q for q in seen_queries)  # retrieval query
    assert raw not in caplog.text  # logs
    assert "[REDACTED:" in json.dumps(groq.calls[0])


@pytest.mark.parametrize("kind,secret,raw", SECRETS, ids=SECRET_IDS)
def test_secret_in_submitted_evidence_rejects_the_submission_and_stores_nothing(kind, secret, raw, caplog):
    caplog.set_level(logging.DEBUG)
    s = new_session(client)
    res = submit(client, s, console=[{"id": "ev_001", "level": "error", "text": f"boom {secret}"}])
    assert res.status_code == 422 and "Security Tripwire Triggered" in res.json()["detail"]
    assert raw not in res.text
    row = _session_row_json(s["session_id"])
    assert raw not in row
    after = client.get(f"/api/sessions/{s['session_id']}").json()
    assert after["evidence_bundles"] == [] and after["phase"] == s["phase"]
    assert raw not in caplog.text


def test_secret_in_the_verification_observation_is_rejected(monkeypatch):
    FakeGroq(monkeypatch, [answer(action={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}})])
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    s = new_session(client)
    body = submit(client, s, storage=[corrupt_storage()]).json()
    action_id = body["session"]["pending_action"]["action_id"]
    secret, raw = SECRETS[12][1], SECRETS[12][2]  # groq key
    res = client.post(
        f"/api/sessions/{s['session_id']}/verify",
        json={"action_id": action_id, "observation": {"console": [{"id": "x", "level": "error", "text": secret}], "network": []}},
    )
    assert res.status_code == 422 and raw not in res.text
    assert raw not in _session_row_json(s["session_id"])


def test_secret_in_an_action_result_detail_is_redacted(monkeypatch):
    FakeGroq(monkeypatch, [answer(action={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}})])
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    s = new_session(client)
    submit(client, s, storage=[corrupt_storage()])
    assert client.post(f"/api/sessions/{s['session_id']}/policy", json={}).status_code == 200
    assert client.post(f"/api/sessions/{s['session_id']}/approve", json={"approved": True}).status_code == 200
    secret, raw = SECRETS[19][1], SECRETS[19][2]  # connection string
    res = client.post(
        f"/api/sessions/{s['session_id']}/action-result",
        json={"action_id": "clear_storage_key", "succeeded": False, "detail": f"failed: {secret}"},
    )
    assert res.status_code == 200, res.text
    assert raw not in res.text and raw not in _session_row_json(s["session_id"])


@pytest.mark.parametrize("kind,secret,raw", SECRETS[:6] + SECRETS[19:22], ids=SECRET_IDS[:6] + SECRET_IDS[19:22])
def test_secret_never_reaches_the_knowledge_base(kind, secret, raw, monkeypatch):
    embedded: list[str] = []
    monkeypatch.setattr(knowledge, "embed", lambda text: embedded.append(text) or [0.0] * 384)
    record = SessionRecord(
        id=f"safety-{abs(hash(kind))}",
        user_issue=f"issue with {secret}",  # a raw value, as if an older row predates redaction
        source="github",
        phase="RESOLVED",
        resolution_state="resolved",
        hypotheses=[{"description": f"root cause mentions {secret}"}],
    )
    db = SessionLocal()
    try:
        chunk_id = knowledge.record_resolved_session_to_kb(db, record)
        assert chunk_id
        chunk = db.get(KnowledgeChunk, chunk_id)
        assert raw not in chunk.content_text and raw not in json.dumps(chunk.chunk_metadata, default=str)
        assert embedded and raw not in embedded[0]
        db.delete(chunk)
        db.commit()
    finally:
        db.close()


def test_git_sha_evidence_is_accepted_end_to_end(monkeypatch):
    """The Git-SHA exemption: commit ids in prose or URL paths must not trip the evidence tripwire."""
    FakeGroq(monkeypatch, [answer(action={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}})])
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    s = new_session(client)
    res = submit(
        client,
        s,
        storage=[corrupt_storage()],
        console=[
            {"id": "ev_001", "level": "info", "text": f"HEAD is at {HEX40}"},
            {"id": "ev_003", "level": "error", "text": f"failed to load https://github.com/octo/repo/commit/{HEX40}"},
        ],
    )
    assert res.status_code == 200, res.text
