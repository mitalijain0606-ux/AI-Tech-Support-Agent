import pytest
from pydantic import ValidationError
from starlette.testclient import TestClient

from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import SessionRecord
from operon_backend.loop_driver import (
    MAX_ACTION_ATTEMPTS,
    MAX_INVESTIGATION_STEPS,
    MAX_LLM_CALLS,
    MAX_TOOL_CALLS,
    check_limits,
    escalate_for_limit,
    update_or_create_hypothesis,
)
from operon_backend.main import app
from operon_backend.schemas import Hypothesis, RemediationProposal
from operon_backend.session_service import (
    create_session,
    record_action_result,
    record_diagnosis,
    record_policy,
    record_verification,
)
from operon_backend.state_machine import SessionPhase

client = TestClient(app)


def test_hypothesis_schema_and_status_validation():
    """Hypothesis status must be strictly from the allowed literal set."""
    hyp = Hypothesis(
        hypothesis_id="hyp_001",
        description="Corrupted local storage key",
        confidence=0.9,
        supporting_evidence_ids=["ev_001"],
        status="candidate",
    )
    assert hyp.status == "candidate"

    with pytest.raises(ValidationError):
        Hypothesis(
            hypothesis_id="hyp_002",
            description="Invalid status",
            confidence=0.5,
            status="invalid_status",  # type: ignore
        )


def test_remediation_proposal_schema():
    """RemediationProposal requires verification predicate and defaults requires_approval."""
    proposal = RemediationProposal(
        diagnosis="Stale service worker",
        evidence_ids=["ev_sw_1"],
        action_id="unregister_service_worker",
        parameters={"scope": "/"},
        expected_effect="Forces browser to fetch latest assets",
        verification_predicate="service worker registration removed",
    )
    assert proposal.requires_approval is True
    assert proposal.risk == "unknown"
    data = proposal.model_dump()
    assert data["action_id"] == "unregister_service_worker"
    assert data["parameters"]["scope"] == "/"


def test_update_or_create_hypothesis_preserves_and_merges():
    """Hypothesis updates must merge evidence IDs without duplication and update status."""
    db = SessionLocal()
    try:
        session = create_session(db, "Testing hypothesis update")

        # Create initial candidate
        h1 = update_or_create_hypothesis(
            session,
            description="Cache corruption",
            confidence=0.4,
            status="candidate",
            supporting_evidence_ids=["ev_001"],
        )
        assert len(session.hypotheses) == 1
        assert session.hypotheses[0]["status"] == "candidate"
        assert session.hypotheses[0]["supporting_evidence_ids"] == ["ev_001"]

        # Update existing hypothesis with new evidence and confirmed status
        h2 = update_or_create_hypothesis(
            session,
            description="Cache corruption",
            confidence=0.95,
            status="confirmed",
            supporting_evidence_ids=["ev_001", "ev_002"],
        )
        assert len(session.hypotheses) == 1
        assert h2.hypothesis_id == h1.hypothesis_id
        assert session.hypotheses[0]["status"] == "confirmed"
        assert session.hypotheses[0]["supporting_evidence_ids"] == ["ev_001", "ev_002"]
        assert session.hypotheses[0]["confidence"] == 0.95
    finally:
        db.close()


def test_phase3_gate_insufficient_evidence_loops_before_diagnosing():
    """Phase 3 Gate from AGENT_ARCHITECTURE.md:
    A session that starts with insufficient evidence can loop through
    INVESTIGATING -> KNOWLEDGE_LOOKUP -> INVESTIGATING before reaching DIAGNOSING.
    """
    settings.groq_api_key = ""  # deterministic rule-based fallback
    res = client.post("/api/sessions", json={"user_issue": "insufficient evidence reported"})
    assert res.status_code == 200
    session_id = res.json()["session_id"]

    # Turn 1: Initial bundle has no errors -> triggers insufficient_evidence
    empty_bundle = {"url": "https://github.com", "timestamp": 1726000000.0}
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": empty_bundle})
    assert res.status_code == 200
    body1 = res.json()

    # Must loop: UNDERSTANDING -> KNOWLEDGE_LOOKUP -> INVESTIGATING -> KNOWLEDGE_LOOKUP -> INVESTIGATING
    phases = [entry["to"] for entry in body1["session"]["phase_history"]]
    assert phases == [
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
    ]
    # In INVESTIGATING, holds a candidate hypothesis, NOT DIAGNOSING
    assert body1["session"]["phase"] == "INVESTIGATING"
    assert len(body1["session"]["hypotheses"]) == 1
    assert body1["session"]["hypotheses"][0]["status"] == "candidate"

    # Turn 2: Missing evidence arrives via /investigate endpoint
    resolved_bundle = {
        "url": "https://github.com",
        "timestamp": 1726000001.0,
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
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": resolved_bundle})
    assert res.status_code == 200
    body2 = res.json()

    # Now hypothesis is confirmed and advances through DIAGNOSING -> ACTION_PROPOSED
    assert body2["session"]["phase"] == "ACTION_PROPOSED"
    assert body2["session"]["hypotheses"][0]["status"] == "confirmed"

    all_phases = [entry["to"] for entry in body2["session"]["phase_history"]]
    assert all_phases == [
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
        "HYPOTHESIS_FORMED",
        "DIAGNOSING",
        "ACTION_PROPOSED",
    ]


def test_phase3_gate_max_investigation_steps_limit_escalates():
    """Phase 3 Gate: A limit-exceeded case correctly escalates instead of looping forever."""
    db = SessionLocal()
    try:
        session = create_session(db, "Hard limit test")
        session.phase = SessionPhase.INVESTIGATING.value
        session.phase_history = [{"to": "INVESTIGATING"}] * MAX_INVESTIGATION_STEPS

        limit_exc = check_limits(session)
        assert limit_exc is not None
        assert limit_exc.limit_name == "max_investigation_steps"

        escalate_for_limit(db, session, limit_exc)
        assert session.phase == SessionPhase.ESCALATED.value
        assert session.resolution_state == "escalated_max_investigation_steps_exceeded"
    finally:
        db.close()


def test_phase3_gate_max_tool_calls_limit_escalates():
    """Hard limit max_tool_calls = 6 triggers automatic escalation."""
    db = SessionLocal()
    try:
        session = create_session(db, "Tool call limit test")
        session.phase = SessionPhase.INVESTIGATING.value
        session.tool_call_count = MAX_TOOL_CALLS

        limit_exc = check_limits(session)
        assert limit_exc is not None
        assert limit_exc.limit_name == "max_tool_calls"

        escalate_for_limit(db, session, limit_exc)
        assert session.phase == SessionPhase.ESCALATED.value
        assert session.resolution_state == "escalated_max_tool_calls_exceeded"
    finally:
        db.close()


def test_phase3_gate_max_llm_calls_limit_escalates():
    """Hard limit max_llm_calls = 12 triggers automatic escalation."""
    db = SessionLocal()
    try:
        session = create_session(db, "LLM call limit test")
        session.phase = SessionPhase.INVESTIGATING.value
        session.llm_call_count = MAX_LLM_CALLS

        limit_exc = check_limits(session)
        assert limit_exc is not None
        assert limit_exc.limit_name == "max_llm_calls"

        escalate_for_limit(db, session, limit_exc)
        assert session.phase == SessionPhase.ESCALATED.value
        assert session.resolution_state == "escalated_max_llm_calls_exceeded"
    finally:
        db.close()


def test_verification_failure_updates_hypothesis_and_retries():
    """When verification fails on the 1st attempt:
    1. The hypothesis is marked contradicted.
    2. Session returns to INVESTIGATING.
    When verification fails on the 2nd attempt:
    Session escalates to ESCALATED with max attempts reached.
    """
    settings.groq_api_key = ""
    res = client.post("/api/sessions", json={"user_issue": "dashboard broken"})
    session_id = res.json()["session_id"]

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "storage": [
            {
                "id": "ev_001",
                "key": "operon_demo_cache",
                "present": True,
                "parse_status": "syntax_error",
                "error_message": "Unexpected token",
            }
        ],
    }
    client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    client.post(
        f"/api/sessions/{session_id}/policy",
        json={
            "action_id": "clear_storage_key",
            "params": {"key": "operon_demo_cache"},
            "provider_capabilities": ["clear_storage_key"],
        },
    )
    client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "cleared"})

    # 1st verification failure
    res_fail1 = client.post(
        f"/api/sessions/{session_id}/verify",
        json={"passed": False, "message": "error still visible after reload"},
    )
    assert res_fail1.status_code == 200
    body_fail1 = res_fail1.json()
    assert body_fail1["phase"] == "INVESTIGATING"
    assert body_fail1["action_attempt_count"] == 1
    # Check hypothesis status updated to contradicted
    assert body_fail1["hypotheses"][0]["status"] == "contradicted"

    # Retry cycle: new evidence points at a *different* key, so this is a
    # genuinely different remediation, not the failed one repeated.
    retry_bundle = {
        "url": "https://github.com",
        "timestamp": 1726000001.0,
        "storage": [
            {"id": "ev_010", "key": "other_cache", "present": True, "parse_status": "syntax_error"}
        ],
    }
    res_retry = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": retry_bundle})
    assert res_retry.json()["session"]["phase"] == "ACTION_PROPOSED"
    client.post(
        f"/api/sessions/{session_id}/policy",
        json={
            "action_id": "clear_storage_key",
            "params": {"key": "other_cache"},
            "provider_capabilities": ["clear_storage_key"],
        },
    )
    client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "cleared again"})

    # 2nd verification failure -> MAX_ACTION_ATTEMPTS reached -> ESCALATED
    res_fail2 = client.post(
        f"/api/sessions/{session_id}/verify",
        json={"passed": False, "message": "error persists repeatedly"},
    )
    assert res_fail2.status_code == 200
    body_fail2 = res_fail2.json()
    assert body_fail2["phase"] == "ESCALATED"
    assert body_fail2["resolution_state"] == "escalated_verification_failed"
    assert body_fail2["action_attempt_count"] == 2


# ---- Investigation-flow fixes ------------------------------------------------

_CORRUPTED_BUNDLE = {
    "url": "https://github.com",
    "timestamp": 1726000000.0,
    "storage": [
        {"id": "ev_001", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}
    ],
}


def _forbid_retrieval_and_llm(monkeypatch):
    async def _no_llm(*args, **kwargs):
        raise AssertionError("LLM must not be called")

    def _no_search(*args, **kwargs):
        raise AssertionError("retrieval must not run")

    monkeypatch.setattr("operon_backend.main.diagnose", _no_llm)
    monkeypatch.setattr("operon_backend.main.search", _no_search)


def test_investigate_in_wrong_phase_returns_409_before_retrieval_or_llm(monkeypatch):
    settings.groq_api_key = ""
    session_id = client.post("/api/sessions", json={"user_issue": "dashboard broken"}).json()["session_id"]
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": _CORRUPTED_BUNDLE})
    assert res.json()["session"]["phase"] == "ACTION_PROPOSED"

    _forbid_retrieval_and_llm(monkeypatch)
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": _CORRUPTED_BUNDLE})
    assert res.status_code == 409


def test_investigate_limit_hit_escalates_before_retrieval_or_llm(monkeypatch):
    db = SessionLocal()
    try:
        session = create_session(db, "limit before work")
        session.phase = SessionPhase.INVESTIGATING.value
        session.tool_call_count = MAX_TOOL_CALLS
        db.commit()
        session_id = session.id
    finally:
        db.close()

    _forbid_retrieval_and_llm(monkeypatch)
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": _CORRUPTED_BUNDLE})
    assert res.status_code == 200
    body = res.json()
    # Consistent with the session: no diagnosis, no action, session escalated.
    assert body["diagnosis"] is None
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_max_tool_calls_exceeded"
    assert body["session"]["llm_call_count"] == 0


def test_contradicted_hypothesis_is_not_reconfirmed():
    db = SessionLocal()
    try:
        session = create_session(db, "contradiction")
        h = update_or_create_hypothesis(session, description="Corrupted key", confidence=0.9, status="confirmed")
        update_or_create_hypothesis(
            session, description="Corrupted key", confidence=0.0, status="contradicted", hypothesis_id=h.hypothesis_id
        )

        # Restating the same root cause must not reopen it.
        again = update_or_create_hypothesis(
            session, description="corrupted  KEY", confidence=0.95, status="confirmed", supporting_evidence_ids=["ev_9"]
        )
        assert again.hypothesis_id == h.hypothesis_id
        assert again.status == "contradicted"
        assert again.confidence == 0.0
        assert "ev_9" in again.supporting_evidence_ids
        assert len(session.hypotheses) == 1
    finally:
        db.close()


def test_different_explanation_creates_competing_hypothesis_not_overwrite():
    db = SessionLocal()
    try:
        session = create_session(db, "competing hypotheses")
        h1 = update_or_create_hypothesis(session, description="Corrupted key", confidence=0.9, status="supported")
        h2 = update_or_create_hypothesis(session, description="Expired session cookie", confidence=0.7, status="supported")
        assert h1.hypothesis_id != h2.hypothesis_id
        assert [h["description"] for h in session.hypotheses] == ["Corrupted key", "Expired session cookie"]
        assert session.current_hypothesis_id == h2.hypothesis_id
    finally:
        db.close()


def test_candidate_is_refined_in_place():
    db = SessionLocal()
    try:
        session = create_session(db, "refinement")
        c = update_or_create_hypothesis(session, description="Not enough evidence yet", confidence=0.3, status="candidate")
        r = update_or_create_hypothesis(session, description="Corrupted key", confidence=0.9, status="confirmed")
        assert r.hypothesis_id == c.hypothesis_id
        assert len(session.hypotheses) == 1
    finally:
        db.close()


def test_same_failed_remediation_is_not_reproposed():
    settings.groq_api_key = ""
    session_id = client.post("/api/sessions", json={"user_issue": "dashboard broken"}).json()["session_id"]
    client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": _CORRUPTED_BUNDLE})
    client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}, "provider_capabilities": ["clear_storage_key"]},
    )
    client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "cleared"})
    res = client.post(f"/api/sessions/{session_id}/verify", json={"passed": False, "message": "still broken"})
    assert res.json()["phase"] == "INVESTIGATING"
    assert res.json()["attempted_actions"][-1]["verified"] is False

    # Same evidence → same diagnosis → same action. Must escalate, not re-propose.
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": _CORRUPTED_BUNDLE})
    assert res.status_code == 200
    body = res.json()
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_remediation_already_failed"
    assert body["session"]["pending_action"]["action_id"] == "clear_storage_key"  # the old, failed one
    assert body["diagnosis"]["proposed_action"] is None
    assert body["session"]["hypotheses"][0]["status"] == "contradicted"
    # ACTION_PROPOSED was reached exactly once — for the original attempt.
    assert [p["to"] for p in body["session"]["phase_history"]].count("ACTION_PROPOSED") == 1
