"""Wires SupportSession persistence to the state machine and to the
existing diagnose()/evaluate() functions — reused exactly as they are,
not reimplemented. Phase 1 walks the session through the legal states in
one straight pass per AGENT_ARCHITECTURE.md's own scope note: this is
"today's flow, now through named states," not the real bounded loop yet
(that's Phase 3).
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DBSession

from operon_backend.db_models import SessionRecord
from operon_backend.knowledge import record_resolved_session_to_kb
from operon_backend.loop_driver import (
    CLOSED_HYPOTHESIS_STATUSES,
    MAX_ACTION_ATTEMPTS,
    MAX_INVESTIGATION_STEPS,
    MAX_LLM_CALLS,
    MAX_TOOL_CALLS,
    LimitExceeded,
    check_limits,
    escalate_for_limit,
    log_diagnostic_step,
    update_or_create_hypothesis,
)
from operon_backend.retrieval import RetrievedChunk
from operon_backend.schemas import (
    Diagnosis,
    EvidenceBundle,
    HypothesisStatus,
    PolicyDecision,
    RemediationProposal,
)
from operon_backend.state_machine import IllegalTransition, SessionPhase, transition
from operon_backend.tripwire import redact_credentials

logger = logging.getLogger(__name__)


def create_session(db: DBSession, user_issue: str, source: str = "github") -> SessionRecord:
    # The user's own words are free text that reaches the database, the LLM,
    # retrieval and the knowledge base — redact anything credential-shaped
    # here, once, so no later step ever sees the raw value.
    user_issue, redactions = redact_credentials(user_issue)
    if redactions:
        logger.warning("Redacted credential-shaped value(s) from user_issue: %s", ", ".join(redactions))
    record = SessionRecord(
        id=str(uuid.uuid4()),
        user_issue=user_issue,
        source=source,
        phase=SessionPhase.UNDERSTANDING.value,
        conversation_history=[
            {
                "role": "user",
                "content": user_issue,
                "at": datetime.now(UTC).isoformat(),
                "redaction_applied": redactions,
            }
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


# Phases from which a new evidence bundle may be submitted for diagnosis.
INVESTIGABLE_PHASES = (SessionPhase.UNDERSTANDING.value, SessionPhase.INVESTIGATING.value)


def begin_investigation_cycle(db: DBSession, session: SessionRecord) -> LimitExceeded | None:
    """Gate that must pass before any retrieval or LLM work is spent on an
    /investigate call. Raises IllegalTransition if the session can't accept
    evidence in its current phase; if a hard limit is already reached,
    escalates the session and returns the LimitExceeded."""
    if session.phase not in INVESTIGABLE_PHASES:
        raise IllegalTransition(
            f"Investigation requires phase UNDERSTANDING or INVESTIGATING, session is in {session.phase}"
        )
    limit_exc = check_limits(session)
    if limit_exc:
        escalate_for_limit(db, session, limit_exc)
    return limit_exc


def _remediation_previously_failed(session: SessionRecord, action_id: str, params: dict) -> bool:
    """True if this exact action (same id and params) was already attempted
    in this session and either failed to execute or failed verification."""
    for attempt in session.attempted_actions or []:
        if attempt.get("action_id") != action_id or (attempt.get("params") or {}) != (params or {}):
            continue
        if attempt.get("succeeded") is False or attempt.get("verified") is False:
            return True
    return False


def _log_step(session: SessionRecord, *, tool: str, reason: str, intent: str, expected_information: str) -> None:
    log_diagnostic_step(
        session,
        tool=tool,
        reason=reason,
        intent=intent,
        expected_information=expected_information,
    )


def record_diagnosis(
    db: DBSession,
    session: SessionRecord,
    bundle: EvidenceBundle,
    diagnosis: Diagnosis,
    retrieved: list[RetrievedChunk] | None = None,
    retrieval_error: str | None = None,
) -> SessionRecord:
    if session.phase not in INVESTIGABLE_PHASES:
        raise IllegalTransition(
            f"record_diagnosis requires phase UNDERSTANDING or INVESTIGATING, session is in {session.phase}"
        )

    # Check hard limits first
    limit_exc = check_limits(session)
    if limit_exc:
        return escalate_for_limit(db, session, limit_exc)

    retrieved = retrieved or []
    tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None

    if session.phase == SessionPhase.UNDERSTANDING.value:
        if retrieval_error:
            lookup_reason = f"knowledge search unavailable ({retrieval_error}); continuing without retrieved precedent"
        elif retrieved:
            summary = ", ".join(f"{r.chunk_id} ({r.score:.2f})" for r in retrieved)
            lookup_reason = f"found {len(retrieved)} relevant knowledge chunk(s): {summary}"
        else:
            lookup_reason = "no knowledge chunk scored above the similarity floor"
        transition(session, SessionPhase.KNOWLEDGE_LOOKUP, lookup_reason)
        transition(session, SessionPhase.INVESTIGATING, "evidence already collected by the extension")
        session.collected_evidence = [*session.collected_evidence, bundle.model_dump()]
        _log_step(
            session,
            tool="collect_evidence",
            reason="initial evidence collection from the active tab",
            intent="investigate",
            expected_information="console/network/storage/cookie signals",
        )
    else:
        session.collected_evidence = [*session.collected_evidence, bundle.model_dump()]
        _log_step(
            session,
            tool="collect_evidence",
            reason="additional evidence collected for ongoing investigation",
            intent="investigate",
            expected_information="signals for hypothesis validation",
        )

    session.llm_call_count += 1
    session.confidence = diagnosis.confidence
    session.issue_category = diagnosis.category
    session.knowledge_references = diagnosis.knowledge_refs

    # Case 1: Insufficient evidence -> candidate hypothesis -> loop cycle
    if diagnosis.category == "insufficient_evidence":
        hyp = update_or_create_hypothesis(
            session,
            description=diagnosis.root_cause,
            confidence=diagnosis.confidence,
            status="candidate",
            supporting_evidence_ids=diagnosis.evidence_ids,
        )

        limit_exc = check_limits(session)
        if limit_exc:
            return escalate_for_limit(db, session, limit_exc)

        # Bounded loop: INVESTIGATING -> KNOWLEDGE_LOOKUP -> INVESTIGATING
        transition(
            session,
            SessionPhase.KNOWLEDGE_LOOKUP,
            f"insufficient initial evidence, refining knowledge lookup for candidate: {hyp.description}",
        )
        transition(
            session,
            SessionPhase.INVESTIGATING,
            "evaluating refined knowledge and awaiting specific evidence checks",
        )
        _log_step(
            session,
            tool="search_knowledge",
            intent="investigate",
            reason=f"refined knowledge search for candidate {hyp.hypothesis_id}",
            expected_information="diagnostic checks and failure signatures",
        )

    # Case 2: Sufficient evidence / confirmed / supported or known category
    else:
        if diagnosis.resolvable_automatically:
            hyp_status: HypothesisStatus = "confirmed"
        elif diagnosis.proposed_action is not None:
            hyp_status = "supported"
        else:
            hyp_status = "supported" if diagnosis.category != "unknown" else "candidate"

        if hyp_status == "candidate" and diagnosis.proposed_action is None:
            hyp = update_or_create_hypothesis(
                session,
                description=diagnosis.root_cause,
                confidence=diagnosis.confidence,
                status="candidate",
            )
            transition(session, SessionPhase.HYPOTHESIS_FORMED, "formed candidate hypothesis from diagnosis call")
            transition(session, SessionPhase.DIAGNOSING, "evaluating the hypothesis against the evidence")
            session.resolution_state = "escalated_no_action_available"
            transition(session, SessionPhase.ESCALATED, diagnosis.reasoning)
            record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
        else:
            action_already_failed = diagnosis.proposed_action is not None and _remediation_previously_failed(
                session, diagnosis.proposed_action.action_id, diagnosis.proposed_action.params
            )
            hyp = update_or_create_hypothesis(
                session,
                description=diagnosis.root_cause,
                confidence=diagnosis.confidence,
                status=hyp_status,
                supporting_evidence_ids=diagnosis.evidence_ids,
            )

            # Never re-propose a remediation that already failed, and never
            # advance a hypothesis that verification already refuted —
            # AGENT_ARCHITECTURE.md: "never retry the same action unchanged".
            if action_already_failed or hyp.status in CLOSED_HYPOTHESIS_STATUSES:
                if action_already_failed:
                    session.resolution_state = "escalated_remediation_already_failed"
                    reason = (
                        f"proposed remediation '{diagnosis.proposed_action.action_id}' with params "
                        f"{diagnosis.proposed_action.params} already failed in this session; "
                        f"not retrying it unchanged"
                    )
                else:
                    session.resolution_state = "escalated_hypothesis_contradicted"
                    reason = (
                        f"evidence still points to {hyp.hypothesis_id}, which was already "
                        f"{hyp.status}; no alternative explanation found"
                    )
                transition(session, SessionPhase.ESCALATED, reason)
                record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
                db.commit()
                db.refresh(session)
                return session

            transition(session, SessionPhase.HYPOTHESIS_FORMED, f"formed {hyp.hypothesis_id} from the diagnosis call")
            transition(session, SessionPhase.DIAGNOSING, "evaluating the hypothesis against the evidence")

            if diagnosis.proposed_action is None:
                session.resolution_state = "escalated_no_action_available"
                transition(session, SessionPhase.ESCALATED, diagnosis.reasoning)
                record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
            else:
                proposal = RemediationProposal(
                    diagnosis=diagnosis.root_cause,
                    evidence_ids=diagnosis.evidence_ids,
                    action_id=diagnosis.proposed_action.action_id,
                    parameters=diagnosis.proposed_action.params,
                    expected_effect=diagnosis.reasoning,
                    risk="unknown",
                    verification_predicate=f"evidence supporting {hyp.hypothesis_id} no longer present after the action",
                    requires_approval=True,
                )
                session.pending_action = proposal.model_dump()
                transition(session, SessionPhase.ACTION_PROPOSED, "diagnosis produced a proposed action")

    db.commit()
    db.refresh(session)
    return session


def record_policy(db: DBSession, session: SessionRecord, decision: PolicyDecision) -> SessionRecord:
    require_phase(session, SessionPhase.ACTION_PROPOSED)

    if decision.decision == "DENY":
        session.resolution_state = "escalated_policy_denied"
        transition(session, SessionPhase.ESCALATED, decision.reason)
        tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None
        record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
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
            "params": session.pending_action.get("parameters", {}) if session.pending_action else {},
            "succeeded": succeeded,
            "verified": None,
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
    if session.attempted_actions:
        attempts = [dict(a) for a in session.attempted_actions]
        attempts[-1]["verified"] = passed
        session.attempted_actions = attempts

    if passed:
        session.resolution_state = "resolved"
        transition(session, SessionPhase.RESOLVED, message)
        tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None
        record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
    elif session.action_attempt_count < MAX_ACTION_ATTEMPTS:
        if session.hypotheses:
            current_h = next(
                (h for h in session.hypotheses if h.get("hypothesis_id") == session.current_hypothesis_id),
                session.hypotheses[-1],
            )
            update_or_create_hypothesis(
                session,
                description=current_h.get("description", ""),
                confidence=0.0,
                status="contradicted",
                contradicting_evidence_ids=current_h.get("supporting_evidence_ids", []),
                hypothesis_id=current_h.get("hypothesis_id"),
            )
        transition(session, SessionPhase.INVESTIGATING, f"verification failed, retry budget remains: {message}")
    else:
        session.resolution_state = "escalated_verification_failed"
        transition(session, SessionPhase.ESCALATED, f"verification failed, max attempts reached: {message}")
        tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None
        record_resolved_session_to_kb(db, session, tenant_id=tenant_id)

    db.commit()
    db.refresh(session)
    return session

