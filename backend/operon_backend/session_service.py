"""SupportSession lifecycle outside the investigation cycle itself:
creation (with the initial evidence request), then — once investigation.py
has produced a remediation plan — policy, approval, execution, server-side
verification, bounded retry and escalation.

The backend is authoritative throughout: policy is evaluated on the
session's own pending action against the provider capabilities recorded at
creation, execution requires the policy decision (and approval where
required) for that exact proposal, and verification is decided here from the
evidence the plan cited — the provider only reports what it observed.
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DBSession

from operon_backend.activity import record_activity
from operon_backend.db_models import SessionRecord
from operon_backend.evidence import (
    DEFAULT_COLLECTORS,
    RECOLLECT_COLLECTORS,
    build_request,
    issue_request,
)
from operon_backend.investigation import next_cycle_blocked
from operon_backend.knowledge import record_resolved_session_to_kb
from operon_backend.loop_driver import (
    MAX_ACTION_ATTEMPTS,
    escalate,
    escalate_for_limit,
    update_or_create_hypothesis,
)
from operon_backend.policy import evaluate
from operon_backend.schemas import (
    COLLECTORS,
    PolicyDecision,
    SessionPolicyRequest,
    VerificationObservation,
    VerificationPlan,
)
from operon_backend.state_machine import IllegalTransition, SessionPhase, transition
from operon_backend.tripwire import redact_credentials
from operon_backend.verification import evaluate as evaluate_verification

logger = logging.getLogger(__name__)


class RequestMismatch(Exception):
    """The client referred to an action other than the session's pending one."""


def create_session(
    db: DBSession,
    user_issue: str,
    source: str = "github",
    provider_capabilities: list[str] | None = None,
    collectors: list[str] | None = None,
) -> SessionRecord:
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
        environment_context={
            "provider": "extension",
            "source": source,
            "provider_capabilities": list(provider_capabilities or []),
            "collectors": [c for c in (collectors or COLLECTORS) if c in COLLECTORS],
        },
        activity=[],
        diagnoses=[],
        retrievals=[],
        investigation_cycle=0,
    )
    record_activity(record, "session_created", "support session created", redaction_applied=redactions, source=source)
    request, refused = build_request(
        record,
        purpose="initial",
        collectors=DEFAULT_COLLECTORS,
        params=None,
        reason="Initial evidence: what the page is doing right now.",
        requires_user_action=False,
    )
    db.add(record)
    db.flush()  # apply column defaults (empty history lists, zero counters)
    if request is None:
        # Nothing this provider may collect: the investigation cannot start.
        return escalate(db, record, "escalated_requested_evidence_unavailable",
                        f"This provider can't collect any evidence ({'; '.join(refused)}).")
    issue_request(record, request, refused)
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


def _pending(session: SessionRecord) -> dict:
    if not session.pending_action:
        raise IllegalTransition("The session has no pending remediation.")
    return session.pending_action


def _require_pending_action(session: SessionRecord, action_id: str | None) -> dict:
    pending = _pending(session)
    if action_id is not None and action_id != pending.get("action_id"):
        raise RequestMismatch(
            f"Request refers to '{action_id}', but the session's pending action is '{pending.get('action_id')}'."
        )
    return pending


def _tenant(session: SessionRecord) -> str | None:
    return (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None


# ---- Policy -----------------------------------------------------------------------------


def apply_policy(db: DBSession, session: SessionRecord, request: SessionPolicyRequest) -> PolicyDecision:
    """Evaluates the session's own pending action — never an action named by
    the client — against the capabilities recorded for this provider."""
    require_phase(session, SessionPhase.ACTION_PROPOSED)
    pending = _require_pending_action(session, request.action_id)
    if request.params is not None and request.params != (pending.get("parameters") or {}):
        raise RequestMismatch("Request parameters differ from the pending action's parameters.")

    recorded = (session.environment_context or {}).get("provider_capabilities") or []
    capabilities = recorded or list(request.provider_capabilities or [])
    decision = evaluate(pending["action_id"], pending.get("parameters") or {}, capabilities)

    session.policy_decision = {
        **decision.model_dump(),
        "proposal_id": pending.get("proposal_id"),
        "capabilities_source": "session" if recorded else "request",
        "at": datetime.now(UTC).isoformat(),
    }
    record_activity(session, "policy_decided", f"{decision.decision}: {decision.reason}",
                    proposal_id=pending.get("proposal_id"), action_id=decision.action_id, decision=decision.decision)

    if decision.decision == "DENY":
        escalate(db, session, "escalated_policy_denied", decision.reason)
        return decision
    if decision.decision == "REQUIRE_APPROVAL":
        transition(session, SessionPhase.WAITING_FOR_APPROVAL, decision.reason)
    else:
        transition(session, SessionPhase.EXECUTING, decision.reason)
    db.commit()
    db.refresh(session)
    return decision


# ---- Approval ---------------------------------------------------------------------------


def record_approval(db: DBSession, session: SessionRecord, approved: bool) -> SessionRecord:
    require_phase(session, SessionPhase.WAITING_FOR_APPROVAL)
    pending = _pending(session)
    session.approval = {
        "approved": approved,
        "proposal_id": pending.get("proposal_id"),
        "action_id": pending.get("action_id"),
        "at": datetime.now(UTC).isoformat(),
    }
    record_activity(session, "approval", "approved by the user" if approved else "declined by the user",
                    proposal_id=pending.get("proposal_id"), approved=approved)

    if approved:
        transition(session, SessionPhase.EXECUTING, "user approved the proposed action")
    else:
        session.resolution_state = "declined_by_user"
        transition(session, SessionPhase.RESOLVED, "user declined the proposed action")

    db.commit()
    db.refresh(session)
    return session


# ---- Execution ----------------------------------------------------------------------------


def _execution_authorized(session: SessionRecord, pending: dict) -> None:
    """Defense in depth on top of the state machine: the action that ran must
    be the one policy evaluated and (where required) the user approved."""
    decision = session.policy_decision or {}
    if decision.get("proposal_id") != pending.get("proposal_id") or decision.get("decision") not in ("ALLOW", "REQUIRE_APPROVAL"):
        raise IllegalTransition("No policy decision permits executing the pending action.")
    if decision.get("decision") == "REQUIRE_APPROVAL":
        approval = session.approval or {}
        if not approval.get("approved") or approval.get("proposal_id") != pending.get("proposal_id"):
            raise IllegalTransition("The pending action requires approval, and it has not been approved.")


def record_action_result(db: DBSession, session: SessionRecord, action_id: str | None, succeeded: bool, detail: str) -> SessionRecord:
    require_phase(session, SessionPhase.EXECUTING)
    pending = _require_pending_action(session, action_id)
    _execution_authorized(session, pending)
    detail, _ = redact_credentials(detail or "")

    session.action_attempt_count = (session.action_attempt_count or 0) + 1
    session.attempted_actions = [
        *(session.attempted_actions or []),
        {
            "proposal_id": pending.get("proposal_id"),
            "action_id": pending.get("action_id"),
            "params": pending.get("parameters", {}),
            "attempt": session.action_attempt_count,
            "succeeded": succeeded,
            "verified": None,
            "detail": detail,
            "at": datetime.now(UTC).isoformat(),
        },
    ]
    record_activity(session, "action_executed", f"{pending.get('action_id')}: {'succeeded' if succeeded else 'failed'} — {detail}",
                    proposal_id=pending.get("proposal_id"), succeeded=succeeded)

    if succeeded:
        transition(session, SessionPhase.VERIFYING, "action executed, checking outcome")
        db.commit()
        db.refresh(session)
        return session

    transition(session, SessionPhase.VERIFYING, f"action did not execute: {detail}")
    _mark_last_attempt(session, verified=False)
    session.verification_state = {
        "outcome": "not_run",
        "passed": False,
        "message": f"Nothing to verify — the action did not execute: {detail}",
        "proposal_id": pending.get("proposal_id"),
        "at": datetime.now(UTC).isoformat(),
    }
    return _after_failed_attempt(db, session, session.verification_state["message"], failure_kind="action_failed")


# ---- Verification, retry -----------------------------------------------------------------


def _mark_last_attempt(session: SessionRecord, *, verified: bool) -> None:
    if session.attempted_actions:
        attempts = [dict(a) for a in session.attempted_actions]
        attempts[-1]["verified"] = verified
        session.attempted_actions = attempts


def record_verification(db: DBSession, session: SessionRecord, action_id: str | None, observation: VerificationObservation) -> SessionRecord:
    require_phase(session, SessionPhase.VERIFYING)
    pending = _require_pending_action(session, action_id)
    plan = VerificationPlan.model_validate(pending["verification"]) if pending.get("verification") else None
    result = evaluate_verification(plan, observation)

    session.verification_state = {
        "outcome": result.outcome,
        "passed": result.passed,
        "message": result.message,
        "proposal_id": pending.get("proposal_id"),
        "strategy": plan.strategy if plan else None,
        "observed": {
            "console": len(observation.console),
            "network": len(observation.network),
            "storage_keys": [s.key for s in observation.storage] if observation.storage is not None else None,
            "service_worker_scopes": observation.service_worker_scopes,
            "error": observation.error,
        },
        "at": datetime.now(UTC).isoformat(),
    }
    _mark_last_attempt(session, verified=result.passed)
    record_activity(session, "verification", result.message, outcome=result.outcome, proposal_id=pending.get("proposal_id"))

    if result.passed:
        session.resolution_state = "resolved"
        transition(session, SessionPhase.RESOLVED, result.message)
        record_activity(session, "resolved", result.message)
        record_resolved_session_to_kb(db, session, tenant_id=_tenant(session))
        db.commit()
        db.refresh(session)
        return session

    return _after_failed_attempt(db, session, result.message, failure_kind="verification_failed")


def _after_failed_attempt(db: DBSession, session: SessionRecord, message: str, *, failure_kind: str) -> SessionRecord:
    """A remediation didn't work (didn't run, failed, or couldn't be verified).
    Refute the hypothesis, then either re-collect evidence for a *different*
    remediation (bounded) or escalate."""
    if session.hypotheses:
        current = next(
            (h for h in session.hypotheses if h.get("hypothesis_id") == session.current_hypothesis_id),
            session.hypotheses[-1],
        )
        update_or_create_hypothesis(
            session,
            description=current.get("description", ""),
            confidence=0.0,
            status="contradicted",
            contradicting_evidence_ids=current.get("supporting_evidence_ids", []),
            hypothesis_id=current.get("hypothesis_id"),
        )

    if (session.action_attempt_count or 0) >= MAX_ACTION_ATTEMPTS:
        return escalate(db, session, f"escalated_{failure_kind}", f"{message} (max {MAX_ACTION_ATTEMPTS} remediation attempts reached)")

    pending = session.pending_action or {}
    plan = pending.get("verification") or {}
    transition(session, SessionPhase.INVESTIGATING, f"{failure_kind.replace('_', ' ')}, retry budget remains: {message}")
    request, refused = build_request(
        session,
        purpose="retry",
        collectors=RECOLLECT_COLLECTORS,
        params={"storage_keys": plan.get("storage_keys") or []},
        reason=f"'{pending.get('action_id')}' did not fix the problem ({message}). Re-collecting the page's current "
        f"state so a different remediation can be chosen.",
        requires_user_action=False,
    )
    if request is None:
        return escalate(db, session, "escalated_retry_evidence_unavailable",
                        f"{message}; the evidence needed to retry can't be collected ({'; '.join(refused)})")
    blocked = next_cycle_blocked(session, len(request.collectors))
    if blocked:
        return escalate_for_limit(db, session, blocked)
    issue_request(session, request, refused)
    record_activity(session, "retry", f"attempt {session.action_attempt_count} failed; re-collecting evidence for a different remediation",
                    failed_proposal_id=pending.get("proposal_id"), reason=message)
    transition(session, SessionPhase.NEED_INFORMATION, request.reason)
    db.commit()
    db.refresh(session)
    return session
