"""Hard limits, hypothesis model, and the bounded loop's terminal paths."""

import pytest
from flow_helpers import (
    action_result,
    approve,
    corrupt_storage,
    new_session,
    policy,
    storage_state,
    submit,
    verify,
)
from pydantic import ValidationError
from starlette.testclient import TestClient

from operon_backend.db import SessionLocal
from operon_backend.loop_driver import (
    MAX_ACTION_ATTEMPTS,
    MAX_INVESTIGATION_CYCLES,
    MAX_LLM_CALLS,
    MAX_TOOL_CALLS,
    check_limits,
    escalate_for_limit,
    update_or_create_hypothesis,
)
from operon_backend.main import app
from operon_backend.schemas import Hypothesis, RemediationProposal
from operon_backend.session_service import create_session
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



def test_insufficient_evidence_requests_more_then_diagnoses():
    """NEED_INFORMATION is a real, reachable phase: no anomaly -> the session
    asks for specific evidence; once it arrives, the loop diagnoses."""
    s = new_session(client, "dashboard blank")
    assert s["phase"] == "UNDERSTANDING" and s["evidence_request"]["purpose"] == "initial"

    b1 = submit(client, s).json()
    assert b1["session"]["phase"] == "NEED_INFORMATION"
    req = b1["session"]["evidence_request"]
    assert req["purpose"] == "information" and req["requires_user_action"] is True
    assert set(req["collectors"]) <= {"console", "network", "storage", "page"}
    assert b1["session"]["hypotheses"][0]["status"] == "candidate"

    b2 = submit(client, b1["session"], console=[{"id": "ev_001", "level": "error", "text": "SyntaxError: bad JSON"}],
                storage=[corrupt_storage()]).json()
    assert b2["session"]["phase"] == "ACTION_PROPOSED"
    assert b2["session"]["hypotheses"][0]["status"] == "confirmed"
    assert [p["to"] for p in b2["session"]["phase_history"]] == [
        "KNOWLEDGE_LOOKUP", "INVESTIGATING", "NEED_INFORMATION",
        "INVESTIGATING", "KNOWLEDGE_LOOKUP", "INVESTIGATING",
        "HYPOTHESIS_FORMED", "DIAGNOSING", "ACTION_PROPOSED",
    ]


@pytest.mark.parametrize(
    "field,value,limit_name",
    [
        ("investigation_cycle", MAX_INVESTIGATION_CYCLES, "max_investigation_cycles"),
        ("tool_call_count", MAX_TOOL_CALLS, "max_tool_calls"),
        ("llm_call_count", MAX_LLM_CALLS, "max_llm_calls"),
    ],
)
def test_hard_limits_escalate_and_preserve_history(field, value, limit_name):
    db = SessionLocal()
    try:
        session = create_session(db, "Hard limit test")
        setattr(session, field, value)
        limit_exc = check_limits(session)
        assert limit_exc is not None and limit_exc.limit_name == limit_name

        escalate_for_limit(db, session, limit_exc)
        assert session.phase == SessionPhase.ESCALATED.value
        assert session.resolution_state == f"escalated_{limit_name}_exceeded"
        assert session.escalation_state["reason"].startswith("Investigation halted")
        assert session.activity[-1]["kind"] == "escalated"
    finally:
        db.close()


def test_verification_failure_retries_with_a_different_action_then_escalates():
    """1st attempt fails verification -> hypothesis contradicted, evidence is
    re-collected automatically, a *different* remediation is chosen; when
    that fails too, MAX_ACTION_ATTEMPTS escalates."""
    s = new_session(client, "dashboard broken")
    b = submit(client, s, storage=[corrupt_storage("ev_001")]).json()
    sid = b["session"]["session_id"]
    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    fail1 = verify(client, sid, "clear_storage_key", storage=[storage_state(present=True, status="syntax_error")]).json()
    assert fail1["phase"] == "NEED_INFORMATION"
    assert fail1["action_attempt_count"] == 1
    assert fail1["hypotheses"][0]["status"] == "contradicted"
    assert fail1["evidence_request"]["purpose"] == "retry"
    assert fail1["evidence_request"]["requires_user_action"] is False
    assert "operon_demo_cache" in fail1["evidence_request"]["params"]["storage_keys"]

    retry = submit(client, fail1, storage=[corrupt_storage("ev_010", "other_cache")]).json()
    assert retry["session"]["phase"] == "ACTION_PROPOSED"
    pending = retry["session"]["pending_action"]
    assert pending["parameters"] == {"key": "other_cache"} and pending["attempt"] == 2
    assert pending["retry_of"] == b["session"]["pending_action"]["proposal_id"]
    assert pending["retry_reason"].startswith("Verification failed")

    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    fail2 = verify(client, sid, "clear_storage_key", storage=[storage_state("other_cache", True, "syntax_error")]).json()
    assert fail2["phase"] == "ESCALATED"
    assert fail2["resolution_state"] == "escalated_verification_failed"
    assert fail2["action_attempt_count"] == MAX_ACTION_ATTEMPTS
    assert len(fail2["escalation_state"]["attempted_actions"]) == 2


def test_investigate_in_wrong_phase_returns_409_before_retrieval_or_llm(monkeypatch):
    s = new_session(client)
    b = submit(client, s, storage=[corrupt_storage()]).json()
    assert b["session"]["phase"] == "ACTION_PROPOSED"

    async def _no_llm(*args, **kwargs):
        raise AssertionError("LLM must not be called")

    def _no_search(*args, **kwargs):
        raise AssertionError("retrieval must not run")

    monkeypatch.setattr("operon_backend.investigation.run_diagnosis", _no_llm)
    monkeypatch.setattr("operon_backend.investigation.search", _no_search)
    res = submit(client, b["session"], storage=[corrupt_storage("ev_099")])
    assert res.status_code == 409


def test_investigate_limit_hit_escalates_before_retrieval_or_llm(monkeypatch):
    db = SessionLocal()
    try:
        session = create_session(db, "limit before work")
        session.tool_call_count = MAX_TOOL_CALLS
        db.commit()
        session_id, request = session.id, dict(session.evidence_request)
    finally:
        db.close()

    async def _no_llm(*args, **kwargs):
        raise AssertionError("LLM must not be called")

    monkeypatch.setattr("operon_backend.investigation.run_diagnosis", _no_llm)
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: (_ for _ in ()).throw(AssertionError()))
    res = submit(client, {"session_id": session_id, "evidence_request": request}, storage=[corrupt_storage()])
    assert res.status_code == 200
    body = res.json()
    assert body["diagnosis"] is None
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_max_tool_calls_exceeded"
    assert body["session"]["llm_call_count"] == 0
    assert body["session"]["evidence_bundles"] == []  # nothing consumed after the limit


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
    s = new_session(client)
    b = submit(client, s, storage=[corrupt_storage()]).json()
    sid = b["session"]["session_id"]
    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    res = verify(client, sid, "clear_storage_key", storage=[storage_state(present=True, status="syntax_error")]).json()
    assert res["phase"] == "NEED_INFORMATION"
    assert res["attempted_actions"][-1]["verified"] is False

    # Same evidence again -> same diagnosis -> same action. Must escalate, not re-propose.
    body = submit(client, res, storage=[corrupt_storage("ev_020")]).json()
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_remediation_already_failed"
    assert body["session"]["pending_action"]["action_id"] == "clear_storage_key"  # the old, failed one
    assert body["diagnosis"]["proposed_action"] is None
    assert body["session"]["hypotheses"][0]["status"] == "contradicted"
    assert [p["to"] for p in body["session"]["phase_history"]].count("ACTION_PROPOSED") == 1
