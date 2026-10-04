"""API contract validation: malformed, mismatched, stale, oversized and
forged requests against the SupportSession endpoints.

Every rejection must be a clean 4xx with a reason, and must leave the session
exactly as it was — no consumed evidence, no phase change, no recorded
attempt. The offline rule-based engine and a stubbed retrieval keep these
deterministic; nothing here talks to Groq or loads the embedding model.
"""

import json

import pytest
from starlette.testclient import TestClient

from flow_helpers import action_result, approve, corrupt_storage, new_session, policy, submit, verify
from operon_backend.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _no_retrieval(monkeypatch):
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def get(session_id: str) -> dict:
    return client.get(f"/api/sessions/{session_id}").json()


def unchanged(before: dict, session_id: str) -> None:
    after = get(session_id)
    for field in ("phase", "evidence_bundles", "pending_action", "remediation_attempts", "llm_call_count", "cycle_count", "evidence_request"):
        if field in before:
            assert after[field] == before[field], f"{field} changed on a rejected request"


def to_action_proposed() -> dict:
    s = new_session(client)
    body = submit(client, s, storage=[corrupt_storage()]).json()
    assert body["session"]["phase"] == "ACTION_PROPOSED", body
    return body["session"]


def to_verifying() -> dict:
    s = to_action_proposed()
    sid = s["session_id"]
    assert policy(client, sid).status_code == 200
    if get(sid)["phase"] == "WAITING_FOR_APPROVAL":
        assert approve(client, sid).status_code == 200
    res = action_result(client, sid, s["pending_action"]["action_id"])
    assert res.status_code == 200 and res.json()["phase"] == "VERIFYING", res.text
    return res.json()


# ---- session creation ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"user_issue": ""},
        {"user_issue": "x" * 4001},
        {"user_issue": 42},
        {"user_issue": "ok", "provider_capabilities": "inspect_page"},
        {"user_issue": "ok", "collectors": "console"},
    ],
    ids=["missing issue", "empty issue", "oversized issue", "wrong type", "capabilities not a list", "collectors not a list"],
)
def test_malformed_session_creation_is_rejected(body):
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 422, res.text


def test_non_json_body_is_rejected():
    res = client.post("/api/sessions", content=b"not json", headers={"content-type": "application/json"})
    assert res.status_code == 422


def test_unknown_collectors_and_capabilities_are_never_granted():
    """Unknown names are dropped, not trusted: the request only ever names collectors from the closed set."""
    s = new_session(client, collectors=["keylogger", "storage"], capabilities=["run_javascript", "inspect_page", "clear_storage_key"])
    assert s["evidence_request"]["collectors"] == ["storage"]
    refused = [a for a in s["activity"] if a["kind"] == "evidence_requested"][0]["data"]["refused"]
    assert "keylogger" not in json.dumps(s["evidence_request"]) and isinstance(refused, list)

    only_unknown = client.post("/api/sessions", json={"user_issue": "x", "collectors": ["keylogger"], "provider_capabilities": ["run_javascript"]})
    assert only_unknown.status_code == 200
    assert only_unknown.json()["phase"] == "ESCALATED" and only_unknown.json()["evidence_request"] is None


# ---- evidence submission ------------------------------------------------------------------------


def test_wrong_request_id_is_rejected_without_side_effects():
    s = new_session(client)
    res = client.post(
        f"/api/sessions/{s['session_id']}/investigate",
        json={"bundle": {"url": "https://github.com/o/r", "timestamp": 1, "request_id": "req_not_issued", "storage": [corrupt_storage()]}},
    )
    assert res.status_code == 409, res.text
    unchanged(s, s["session_id"])


def test_a_used_request_id_cannot_be_replayed():
    s = new_session(client)
    first = submit(client, s, storage=[corrupt_storage()])
    assert first.status_code == 200
    before = get(s["session_id"])
    replay = submit(client, s, storage=[corrupt_storage("ev_050")])  # the original request_id again
    assert replay.status_code == 409, replay.text
    unchanged(before, s["session_id"])


@pytest.mark.parametrize(
    "items",
    [
        {"console": [{"id": "ev_001", "level": "error"}]},  # missing text
        {"console": [{"id": "ev_001", "level": "error", "text": 5}]},
        {"network": [{"id": "ev_001", "url": "https://x", "status": "five hundred"}]},
        {"storage": [{"id": "ev_001", "key": "k", "present": "maybe"}]},
        {"console": "not a list"},
        {"console": [{"id": "ev_001", "level": "error", "text": "x"}] * 201},
    ],
    ids=["missing field", "wrong type", "bad status", "bad bool", "not a list", "over the per-kind cap"],
)
def test_malformed_evidence_is_rejected_without_side_effects(items):
    s = new_session(client)
    res = submit(client, s, **items)
    assert res.status_code in (409, 422), res.text
    unchanged(s, s["session_id"])


def test_missing_bundle_and_missing_url_are_rejected():
    s = new_session(client)
    assert client.post(f"/api/sessions/{s['session_id']}/investigate", json={}).status_code == 422
    res = client.post(f"/api/sessions/{s['session_id']}/investigate", json={"bundle": {"timestamp": 1, "request_id": s["evidence_request"]["request_id"]}})
    assert res.status_code == 422
    unchanged(s, s["session_id"])


@pytest.mark.parametrize(
    "items",
    [
        {"console": [{"id": "ev_001", "level": "error", "text": "SyntaxError " + "x" * 200_000}]},
        {"network": [{"id": "ev_001", "method": "GET", "url": "https://x/" + "a" * 5000, "status": 500}]},
        {"storage": [{"id": "ev_001", "key": "k" * 500, "present": True, "parse_status": "syntax_error"}]},
        {"console": [{"id": "ev_" + "1" * 100, "level": "error", "text": "x"}]},
    ],
    ids=["huge console text", "huge url", "huge storage key", "huge evidence id"],
)
def test_oversized_evidence_is_rejected_without_side_effects(items):
    """A page can log megabytes; the extension truncates, and the backend
    enforces bounds itself so no client pushes that into storage or the prompt."""
    s = new_session(client)
    res = submit(client, s, storage=[corrupt_storage("ev_900")], **items) if "storage" not in items else submit(client, s, **items)
    assert res.status_code == 422, res.text[:300]
    unchanged(s, s["session_id"])


def test_evidence_at_the_extensions_own_caps_is_accepted():
    s = new_session(client)
    console = [{"id": f"ev_{i:03d}", "level": "error", "text": "TypeError: " + "x" * 489} for i in range(1, 41)]
    res = submit(client, s, storage=[corrupt_storage("ev_900")], console=console)
    assert res.status_code == 200, res.text[:300]


def test_evidence_on_a_finished_session_is_rejected():
    s = to_verifying()
    res = submit(client, s, storage=[corrupt_storage("ev_090")])
    assert res.status_code == 409
    unchanged(s, s["session_id"])


def test_unknown_session_is_404_everywhere():
    for path, body in [
        ("investigate", {"bundle": {"url": "u", "timestamp": 1}}),
        ("policy", {}),
        ("approve", {"approved": True}),
        ("action-result", {"action_id": "reload", "succeeded": True}),
        ("verify", {"action_id": "reload", "observation": {}}),
    ]:
        assert client.post(f"/api/sessions/does-not-exist/{path}", json=body).status_code == 404, path


# ---- policy / approval / execution ---------------------------------------------------------------


def test_policy_for_a_different_or_unsupported_action_is_rejected():
    s = to_action_proposed()
    for body in ({"action_id": "run_javascript", "params": {"code": "alert(1)"}}, {"action_id": "reload"}):
        res = policy(client, s["session_id"], **body)
        assert res.status_code == 409, res.text
    res = policy(client, s["session_id"], action_id="clear_storage_key", params={"key": "something_else"})
    assert res.status_code == 409
    unchanged(s, s["session_id"])


def test_approval_needs_a_boolean():
    s = to_action_proposed()
    policy(client, s["session_id"])
    before = get(s["session_id"])
    for body in ({}, {"approved": "yes please"}, {"approved": None}):
        assert client.post(f"/api/sessions/{s['session_id']}/approve", json=body).status_code == 422
    unchanged(before, s["session_id"])


def test_action_result_for_another_action_is_rejected():
    s = to_action_proposed()
    sid = s["session_id"]
    policy(client, sid)
    if get(sid)["phase"] == "WAITING_FOR_APPROVAL":
        approve(client, sid)
    before = get(sid)
    assert action_result(client, sid, "unregister_service_worker").status_code == 409
    assert client.post(f"/api/sessions/{sid}/action-result", json={"succeeded": True}).status_code == 422
    assert client.post(f"/api/sessions/{sid}/action-result", json={"action_id": "clear_storage_key", "succeeded": True, "detail": "d" * 1001}).status_code == 422
    unchanged(before, sid)


def test_action_result_before_approval_is_rejected():
    s = to_action_proposed()
    res = action_result(client, s["session_id"], s["pending_action"]["action_id"])
    assert res.status_code == 409
    unchanged(s, s["session_id"])


# ---- verification -----------------------------------------------------------------------------------


def test_client_cannot_send_passed():
    s = to_verifying()
    for extra in ({"passed": True}, {"outcome": "passed"}):
        res = client.post(
            f"/api/sessions/{s['session_id']}/verify",
            json={"action_id": s["pending_action"]["action_id"], "observation": {"console": [], "network": []}, **extra},
        )
        assert res.status_code == 422, res.text
    res = client.post(
        f"/api/sessions/{s['session_id']}/verify",
        json={"action_id": s["pending_action"]["action_id"], "observation": {"console": [], "network": [], "passed": True}},
    )
    assert res.status_code == 422, res.text
    unchanged(s, s["session_id"])


def test_verification_for_another_action_is_rejected():
    s = to_verifying()
    assert verify(client, s["session_id"], "reload").status_code == 409
    unchanged(s, s["session_id"])


@pytest.mark.parametrize(
    "observation",
    [
        {"console": "none"},
        {"storage": [{"key": "k"}]},  # missing present/parse_status
        {"service_worker_scopes": "all"},
        {"console": [{"id": "x", "level": "error", "text": "e"}] * 201},
    ],
    ids=["console not a list", "storage row incomplete", "scopes not a list", "over the cap"],
)
def test_invalid_observation_is_rejected(observation):
    s = to_verifying()
    res = client.post(f"/api/sessions/{s['session_id']}/verify", json={"action_id": s["pending_action"]["action_id"], "observation": observation})
    assert res.status_code == 422, res.text
    unchanged(s, s["session_id"])


def test_verification_cannot_be_submitted_twice():
    s = to_verifying()
    first = verify(client, s["session_id"], s["pending_action"]["action_id"], storage=[{"key": "operon_demo_cache", "present": False, "parse_status": "empty"}])
    assert first.status_code == 200
    before = get(s["session_id"])
    second = verify(client, s["session_id"], s["pending_action"]["action_id"], storage=[{"key": "operon_demo_cache", "present": False, "parse_status": "empty"}])
    assert second.status_code == 409
    unchanged(before, s["session_id"])
