"""The bounded investigation loop driver and hard limit enforcement.

From AGENT_ARCHITECTURE.md Phase 3:
- Replaces the linear walk with an iterative multi-cycle driver.
- Enforces hard limits:
    max_investigation_steps: 8
    max_tool_calls: 6
    max_llm_calls: 12
    max_action_attempts: 2
- Manages the Hypothesis model (candidate, supported, contradicted, confirmed, rejected).
- Ensures that:
    1. A session that starts with insufficient evidence can loop through
       INVESTIGATING -> KNOWLEDGE_LOOKUP -> INVESTIGATING before reaching DIAGNOSING.
    2. A limit-exceeded case correctly escalates instead of looping forever.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DBSession

from operon_backend.db_models import SessionRecord
from operon_backend.knowledge import record_resolved_session_to_kb
from operon_backend.retrieval import build_query, search
from operon_backend.schemas import (
    Diagnosis,
    EvidenceBundle,
    Hypothesis,
    HypothesisStatus,
    RemediationProposal,
)
from operon_backend.state_machine import SessionPhase, transition

MAX_INVESTIGATION_STEPS: int = 8
MAX_TOOL_CALLS: int = 6
MAX_LLM_CALLS: int = 12
MAX_ACTION_ATTEMPTS: int = 2

# A hypothesis in one of these states has been refuted — e.g. its remediation
# failed verification — and must never be silently re-confirmed.
CLOSED_HYPOTHESIS_STATUSES = frozenset({"contradicted", "rejected"})


class LimitExceeded(Exception):
    def __init__(self, limit_name: str, current_value: int, max_value: int):
        self.limit_name = limit_name
        self.current_value = current_value
        self.max_value = max_value
        super().__init__(f"Limit exceeded: {limit_name} ({current_value} >= {max_value})")


def check_limits(session: SessionRecord) -> LimitExceeded | None:
    """Verifies that the session has not exceeded any hard limits."""
    inv_steps = sum(
        1
        for p in session.phase_history
        if p.get("to")
        in (
            SessionPhase.INVESTIGATING.value,
            SessionPhase.KNOWLEDGE_LOOKUP.value,
            SessionPhase.NEED_INFORMATION.value,
        )
    )
    if inv_steps >= MAX_INVESTIGATION_STEPS:
        return LimitExceeded("max_investigation_steps", inv_steps, MAX_INVESTIGATION_STEPS)
    if session.tool_call_count >= MAX_TOOL_CALLS:
        return LimitExceeded("max_tool_calls", session.tool_call_count, MAX_TOOL_CALLS)
    if session.llm_call_count >= MAX_LLM_CALLS:
        return LimitExceeded("max_llm_calls", session.llm_call_count, MAX_LLM_CALLS)
    return None


def escalate_for_limit(db: DBSession, session: SessionRecord, exc: LimitExceeded) -> SessionRecord:
    """Escalates a session cleanly when a hard limit is reached."""
    if session.phase not in (SessionPhase.RESOLVED.value, SessionPhase.ESCALATED.value):
        session.resolution_state = f"escalated_{exc.limit_name}_exceeded"
        transition(
            session,
            SessionPhase.ESCALATED,
            f"Investigation halted: hard limit '{exc.limit_name}' reached ({exc.current_value} >= {exc.max_value})",
        )
        tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None
        record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
        db.commit()
        db.refresh(session)
    return session


def update_or_create_hypothesis(
    session: SessionRecord,
    *,
    description: str,
    confidence: float,
    status: HypothesisStatus,
    supporting_evidence_ids: list[str] | None = None,
    contradicting_evidence_ids: list[str] | None = None,
    required_tests: list[str] | None = None,
    hypothesis_id: str | None = None,
) -> Hypothesis:
    """Updates an existing hypothesis or creates a new one.
    Structural rule from AGENT_ARCHITECTURE.md: new evidence updates
    existing hypotheses' supporting/contradicting IDs and status before
    creating a new hypothesis.

    Matching, in order: an explicit `hypothesis_id`; else a hypothesis with
    the same description; else the current hypothesis, but only while it is
    still a `candidate` (a vague candidate being refined into a specific
    one). A supported/confirmed hypothesis with a different description is
    a competing explanation and gets its own entry.

    A closed hypothesis (contradicted/rejected) is never reopened by
    implicit matching: restating it merges the new evidence but keeps its
    closed status, so callers can see it was already refuted.
    """
    supporting_ids = supporting_evidence_ids or []
    contradicting_ids = contradicting_evidence_ids or []
    req_tests = required_tests or []

    def _norm(text: str) -> str:
        return " ".join(text.split()).casefold()

    match_index: int | None = None
    if hypothesis_id:
        match_index = next(
            (i for i, h in enumerate(session.hypotheses) if h.get("hypothesis_id") == hypothesis_id), None
        )
    if match_index is None and description:
        match_index = next(
            (i for i, h in enumerate(session.hypotheses) if _norm(h.get("description", "")) == _norm(description)),
            None,
        )
    if match_index is None and session.current_hypothesis_id:
        match_index = next(
            (
                i
                for i, h in enumerate(session.hypotheses)
                if h.get("hypothesis_id") == session.current_hypothesis_id and h.get("status") == "candidate"
            ),
            None,
        )

    if match_index is not None:
        i, h = match_index, session.hypotheses[match_index]
        merged_supporting = list(dict.fromkeys(h.get("supporting_evidence_ids", []) + supporting_ids))
        merged_contradicting = list(dict.fromkeys(h.get("contradicting_evidence_ids", []) + contradicting_ids))
        merged_tests = list(dict.fromkeys(h.get("required_tests", []) + req_tests))
        keep_closed = (
            not hypothesis_id
            and h.get("status") in CLOSED_HYPOTHESIS_STATUSES
            and status not in CLOSED_HYPOTHESIS_STATUSES
        )
        updated_h = Hypothesis(
            hypothesis_id=h["hypothesis_id"],
            description=description or h.get("description", ""),
            confidence=h.get("confidence", 0.0) if keep_closed else confidence,
            supporting_evidence_ids=merged_supporting,
            contradicting_evidence_ids=merged_contradicting,
            required_tests=merged_tests,
            status=h["status"] if keep_closed else status,
        )
        updated_list = list(session.hypotheses)
        updated_list[i] = updated_h.model_dump()
        session.hypotheses = updated_list
        session.current_hypothesis_id = updated_h.hypothesis_id
        return updated_h

    # Create new hypothesis
    new_h = Hypothesis(
        hypothesis_id=f"hyp_{uuid.uuid4().hex[:8]}",
        description=description,
        confidence=confidence,
        supporting_evidence_ids=supporting_ids,
        contradicting_evidence_ids=contradicting_ids,
        required_tests=req_tests,
        status=status,
    )
    session.hypotheses = [*session.hypotheses, new_h.model_dump()]
    session.current_hypothesis_id = new_h.hypothesis_id
    return new_h


def log_diagnostic_step(
    session: SessionRecord,
    *,
    tool: str,
    intent: str,
    reason: str,
    expected_information: str,
) -> None:
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
