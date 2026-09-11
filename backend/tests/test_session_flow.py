from starlette.testclient import TestClient

from operon_backend.config import settings
from operon_backend.main import app

client = TestClient(app)


def _create_session(user_issue: str) -> str:
    res = client.post("/api/sessions", json={"user_issue": user_issue})
    assert res.status_code == 200
    return res.json()["session_id"]


def test_require_approval_path_reaches_resolved():
    """clear_storage_key is REQUIRE_APPROVAL — the session must pass through
    WAITING_FOR_APPROVAL and an explicit /approve call, never skip it."""
    settings.groq_api_key = ""  # deterministic rule-based diagnosis
    session_id = _create_session("my dashboard looks corrupted")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "console": [{"id": "ev_001", "level": "error", "text": "SyntaxError: Unexpected token in JSON"}],
        "storage": [
            {
                "id": "ev_002",
                "key": "operon_demo_cache",
                "present": True,
                "parse_status": "syntax_error",
                "error_message": "Unexpected token",
            }
        ],
    }

    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.status_code == 200
    body = res.json()
    assert body["session"]["phase"] == "ACTION_PROPOSED"
    assert body["diagnosis"]["proposed_action"]["action_id"] == "clear_storage_key"
    assert len(body["session"]["hypotheses"]) == 1
    assert body["session"]["hypotheses"][0]["status"] == "confirmed"

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={
            "action_id": "clear_storage_key",
            "params": {"key": "operon_demo_cache"},
            "provider_capabilities": ["inspect_page", "reload", "clear_storage_key"],
        },
    )
    assert res.status_code == 200
    assert res.json()["policy"]["decision"] == "REQUIRE_APPROVAL"
    assert res.json()["session"]["phase"] == "WAITING_FOR_APPROVAL"

    res = client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    assert res.status_code == 200
    assert res.json()["phase"] == "EXECUTING"

    res = client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "key removed"})
    assert res.status_code == 200
    assert res.json()["phase"] == "VERIFYING"

    res = client.post(f"/api/sessions/{session_id}/verify", json={"passed": True, "message": "no more SyntaxError"})
    assert res.status_code == 200
    final = res.json()
    assert final["phase"] == "RESOLVED"
    assert final["resolution_state"] == "resolved"

    phases = [entry["to"] for entry in final["phase_history"]]
    assert phases == [
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
        "HYPOTHESIS_FORMED",
        "DIAGNOSING",
        "ACTION_PROPOSED",
        "WAITING_FOR_APPROVAL",
        "EXECUTING",
        "VERIFYING",
        "RESOLVED",
    ]


def test_allow_decision_skips_approval():
    """`reload` is an ALLOW action — the session must go straight from
    ACTION_PROPOSED to EXECUTING, never through WAITING_FOR_APPROVAL."""
    settings.groq_api_key = ""
    session_id = _create_session("something threw an error")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "console": [{"id": "ev_001", "level": "error", "text": "TypeError: cannot read x of undefined"}],
    }
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.json()["diagnosis"]["proposed_action"]["action_id"] == "reload"

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "reload", "params": {"ignore_cache": True}, "provider_capabilities": ["reload"]},
    )
    assert res.json()["policy"]["decision"] == "ALLOW"
    assert res.json()["session"]["phase"] == "EXECUTING"


def test_no_proposed_action_escalates_immediately():
    settings.groq_api_key = ""
    session_id = _create_session("nothing seems wrong but users are complaining")

    bundle = {"url": "https://github.com", "timestamp": 1726000000.0}
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    body = res.json()
    assert body["diagnosis"]["proposed_action"] is None
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_no_action_available"


def test_policy_deny_escalates():
    """A capability the provider doesn't declare must DENY — and the
    session must reflect that as an escalation, not silently stall."""
    settings.groq_api_key = ""
    session_id = _create_session("my dashboard looks corrupted")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "storage": [
            {"id": "ev_001", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}
        ],
    }
    client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}, "provider_capabilities": ["reload"]},
    )
    assert res.json()["policy"]["decision"] == "DENY"
    assert res.json()["session"]["phase"] == "ESCALATED"
    assert res.json()["session"]["resolution_state"] == "escalated_policy_denied"


def test_operation_out_of_phase_returns_409_not_a_silent_no_op():
    settings.groq_api_key = ""
    session_id = _create_session("test")

    # Approving before a diagnosis/policy step has even run must be rejected,
    # not silently accepted — the session is still in UNDERSTANDING.
    res = client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    assert res.status_code == 409


def test_unknown_session_returns_404():
    res = client.get("/api/sessions/does-not-exist")
    assert res.status_code == 404
