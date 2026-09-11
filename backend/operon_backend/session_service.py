"""Wires SupportSession persistence to the state machine and to the
existing diagnose()/evaluate() functions — reused exactly as they are,
not reimplemented. Phase 1 walks the session through the legal states in
one straight pass per AGENT_ARCHITECTURE.md's own scope note: this is
"today's flow, now through named states," not the real bounded loop yet
(that's Phase 3).
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DBSession

from operon_backend.db_models import SessionRecord
from operon_backend.schemas import Diagnosis, EvidenceBundle, PolicyDecision
from operon_backend.state_machine import IllegalTransition, SessionPhase, transition

MAX_ACTION_ATTEMPTS = 2


def create_session(db: DBSession, user_issue: str, source: str = "github") -> SessionRecord:
    record = SessionRecord(
        id=str(uuid.uuid4()),
        user_issue=user_issue,
        source=source,
        phase=SessionPhase.UNDERSTANDING.value,
        conversation_history=[
            {"role": "user", "content": user_issue, "at": datetime.now(UTC).isoformat()}
        ],
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_session(db: DBSession, session_id: str) -> SessionRecord | None:
    return db.get(SessionRecord, session_id)


def require_phase(session: SessionRecord, expected: SessionPhase) -> None:
    if session.phase != expected.value:
        raise IllegalTransition(
            f"This operation requires phase {expected.value}, session is in {session.phase}"
        )


def _log_step(session: SessionRecord, *, tool: str, reason: str, intent: str, expected_information: str) -> None:
    session.diagnostic_steps = [
        *session.diagnostic_steps,
        {
            "intent": intent,
            "reason": reason,
            "tool": tool,
            "expected_information": expected_information,
            "at": datetime.now(UTC).isoformat(),
        },
    ]
    session.tool_call_count += 1


def record_diagnosis(db: DBSession, session: SessionRecord, bundle: EvidenceBundle, diagnosis: Diagnosis) -> SessionRecord:
    require_phase(session, SessionPhase.UNDERSTANDING)

    transition(session, SessionPhase.KNOWLEDGE_LOOKUP, "no knowledge base wired yet (Phase 2 of AGENT_ARCHITECTURE.md)")
    transition(session, SessionPhase.INVESTIGATING, "evidence already collected by the extension")

    session.collected_evidence = [*session.collected_evidence, bundle.model_dump()]
    _log_step(
        session,
        tool="collect_evidence",
        reason="initial evidence collection from the active tab",
        intent="investigate",
        expected_information="console/network/storage/cookie signals",
    )

    hypothesis_id = f"hyp_{uuid.uuid4().hex[:8]}"
    if diagnosis.category == "insufficient_evidence":
        hypothesis_status = "candidate"
    elif diagnosis.resolvable_automatically:
        hypothesis_status = "confirmed"
    else:
        hypothesis_status = "supported"

    session.hypotheses = [
        *session.hypotheses,
        {
            "hypothesis_id": hypothesis_id,
            "description": diagnosis.root_cause,
            "confidence": diagnosis.confidence,
            "supporting_evidence_ids": diagnosis.evidence_ids,
            "contradicting_evidence_ids": [],
            "required_tests": [],
            "status": hypothesis_status,
        },
    ]
    session.current_hypothesis_id = hypothesis_id
    session.confidence = diagnosis.confidence
    session.issue_category = diagnosis.category
    session.llm_call_count += 1

    transition(session, SessionPhase.HYPOTHESIS_FORMED, f"formed {hypothesis_id} from the diagnosis call")
    transition(session, SessionPhase.DIAGNOSING, "evaluating the hypothesis against the evidence")

    if diagnosis.proposed_action is None:
        session.resolution_state = "escalated_no_action_available"
        transition(session, SessionPhase.ESCALATED, diagnosis.reasoning)
    else:
        session.pending_action = {
            "diagnosis": diagnosis.root_cause,
            "evidence_ids": diagnosis.evidence_ids,
            "action_id": diagnosis.proposed_action.action_id,
            "parameters": diagnosis.proposed_action.params,
            "expected_effect": diagnosis.reasoning,
            "risk": "unknown",
            "verification_predicate": f"evidence supporting {hypothesis_id} no longer present after the action",
            "requires_approval": True,
        }
        transition(session, SessionPhase.ACTION_PROPOSED, "diagnosis produced a proposed action")

    db.commit()
    db.refresh(session)
    return session


def record_policy(db: DBSession, session: SessionRecord, decision: PolicyDecision) -> SessionRecord:
    require_phase(session, SessionPhase.ACTION_PROPOSED)

    if decision.decision == "DENY":
        session.resolution_state = "escalated_policy_denied"
        transition(session, SessionPhase.ESCALATED, decision.reason)
    elif decision.decision == "REQUIRE_APPROVAL":
        transition(session, SessionPhase.WAITING_FOR_APPROVAL, decision.reason)
    else:
        transition(session, SessionPhase.EXECUTING, decision.reason)

    db.commit()
    db.refresh(session)
    return session


def record_approval(db: DBSession, session: SessionRecord, approved: bool) -> SessionRecord:
    require_phase(session, SessionPhase.WAITING_FOR_APPROVAL)

    if approved:
        transition(session, SessionPhase.EXECUTING, "user approved the proposed action")
    else:
        session.resolution_state = "declined_by_user"
        transition(session, SessionPhase.RESOLVED, "user declined the proposed action")

    db.commit()
    db.refresh(session)
    return session


def record_action_result(db: DBSession, session: SessionRecord, succeeded: bool, detail: str) -> SessionRecord:
    require_phase(session, SessionPhase.EXECUTING)

    session.action_attempt_count += 1
    session.attempted_actions = [
        *session.attempted_actions,
        {
            "action_id": session.pending_action.get("action_id") if session.pending_action else None,
            "succeeded": succeeded,
            "detail": detail,
            "at": datetime.now(UTC).isoformat(),
        },
    ]

    if not succeeded and session.action_attempt_count >= MAX_ACTION_ATTEMPTS:
        session.resolution_state = "escalated_action_failed"
        transition(session, SessionPhase.ESCALATED, f"action execution failed, max attempts reached: {detail}")
    else:
        transition(session, SessionPhase.VERIFYING, "action executed, checking outcome")

    db.commit()
    db.refresh(session)
    return session


def record_verification(db: DBSession, session: SessionRecord, passed: bool, message: str) -> SessionRecord:
    require_phase(session, SessionPhase.VERIFYING)

    session.verification_state = {
        "passed": passed,
        "message": message,
        "at": datetime.now(UTC).isoformat(),
    }

    if passed:
        session.resolution_state = "resolved"
        transition(session, SessionPhase.RESOLVED, message)
    elif session.action_attempt_count < MAX_ACTION_ATTEMPTS:
        # Phase 3 (the real bounded loop) is what actually drives a second
        # cycle from here. Today this correctly lands the session in
        # INVESTIGATING and stops — a real next step, honestly incomplete.
        transition(session, SessionPhase.INVESTIGATING, f"verification failed, retry budget remains: {message}")
    else:
        session.resolution_state = "escalated_verification_failed"
        transition(session, SessionPhase.ESCALATED, f"verification failed, max attempts reached: {message}")

    db.commit()
    db.refresh(session)
    return session
