"""Hard limits, escalation, and the hypothesis model for the bounded
investigation loop (the loop itself is driven by investigation.py).

Limits — every one of these ends the session in ESCALATED instead of
letting it run on:
    max_investigation_cycles  evidence submissions per session
    max_tool_calls            evidence collector runs requested per session
    max_llm_calls             model calls (including regenerations and failures)
    max_evidence_items        evidence items stored per session
    max_action_attempts       remediation attempts before escalating
    max_identical_requests    times the same evidence request may be issued
    max_retrievals            knowledge searches (retrieval is skipped, not
                              escalated, past this — it is optional precedent)
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy.orm import Session as DBSession

from operon_backend.activity import record_activity
from operon_backend.db_models import SessionRecord
from operon_backend.knowledge import record_resolved_session_to_kb
from operon_backend.schemas import Hypothesis, HypothesisStatus
from operon_backend.state_machine import SessionPhase, transition

MAX_INVESTIGATION_CYCLES: int = 5
MAX_TOOL_CALLS: int = 24
MAX_LLM_CALLS: int = 12
MAX_EVIDENCE_ITEMS: int = 300
MAX_ACTION_ATTEMPTS: int = 2
MAX_IDENTICAL_REQUESTS: int = 2
MAX_RETRIEVALS: int = 6

# A hypothesis in one of these states has been refuted — e.g. its remediation
# failed verification — and must never be silently re-confirmed.
CLOSED_HYPOTHESIS_STATUSES = frozenset({"contradicted", "rejected"})

TERMINAL_PHASES = (SessionPhase.RESOLVED.value, SessionPhase.ESCALATED.value)


class LimitExceeded(Exception):
    def __init__(self, limit_name: str, current_value: int, max_value: int):
        self.limit_name = limit_name
        self.current_value = current_value
        self.max_value = max_value
        super().__init__(f"Limit exceeded: {limit_name} ({current_value} >= {max_value})")


def evidence_item_count(session: SessionRecord) -> int:
    return sum(int(b.get("item_count", 0)) for b in (session.collected_evidence or []))


def check_limits(session: SessionRecord) -> LimitExceeded | None:
    """Whether the session may start another investigation cycle."""
    checks = [
        ("max_investigation_cycles", session.investigation_cycle or 0, MAX_INVESTIGATION_CYCLES),
        ("max_tool_calls", session.tool_call_count or 0, MAX_TOOL_CALLS),
        ("max_llm_calls", session.llm_call_count or 0, MAX_LLM_CALLS),
        ("max_evidence_items", evidence_item_count(session), MAX_EVIDENCE_ITEMS),
    ]
    for name, current, maximum in checks:
        if current >= maximum:
            return LimitExceeded(name, current, maximum)
    return None


def escalate(db: DBSession, session: SessionRecord, resolution_state: str, reason: str, guidance: str | None = None) -> SessionRecord:
    """The one way a session reaches ESCALATED: records why, preserves a
    summary of everything that happened, and saves it as history. Never
    claims resolution. Commits."""
    if session.phase in TERMINAL_PHASES:
        return session
    last_verification = session.verification_state or None
    session.resolution_state = resolution_state
    session.escalation_state = {
        "reason": reason,
        "resolution_state": resolution_state,
        "from_phase": session.phase,
        "at": datetime.now(UTC).isoformat(),
        "guidance": guidance,
        "investigation_cycles": session.investigation_cycle or 0,
        "evidence_bundles": len(session.collected_evidence or []),
        "evidence_items": evidence_item_count(session),
        "diagnoses": len(session.diagnoses or []),
        "attempted_actions": [
            {k: a.get(k) for k in ("action_id", "params", "succeeded", "verified", "detail")}
            for a in (session.attempted_actions or [])
        ],
        "last_verification": last_verification,
    }
    transition(session, SessionPhase.ESCALATED, reason)
    record_activity(session, "escalated", reason, resolution_state=resolution_state)
    tenant_id = (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None
    record_resolved_session_to_kb(db, session, tenant_id=tenant_id)
    db.commit()
    db.refresh(session)
    return session


def escalate_for_limit(db: DBSession, session: SessionRecord, exc: LimitExceeded) -> SessionRecord:
    """Escalates a session cleanly when a hard limit is reached."""
    return escalate(
        db,
        session,
        f"escalated_{exc.limit_name}_exceeded",
        f"Investigation halted: hard limit '{exc.limit_name}' reached ({exc.current_value} >= {exc.max_value})",
    )


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
