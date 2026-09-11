"""The state machine from AGENT_ARCHITECTURE.md. The backend is the sole
authority over which phase a session is in — an LLM stage may recommend a
transition, but only `transition()` here can actually make one, and only
if it's in the whitelist below. This is what "the LLM proposes, the
backend disposes" means in code.
"""

from datetime import UTC, datetime
from enum import Enum


class SessionPhase(str, Enum):
    UNDERSTANDING = "UNDERSTANDING"
    KNOWLEDGE_LOOKUP = "KNOWLEDGE_LOOKUP"
    NEED_INFORMATION = "NEED_INFORMATION"
    INVESTIGATING = "INVESTIGATING"
    HYPOTHESIS_FORMED = "HYPOTHESIS_FORMED"
    DIAGNOSING = "DIAGNOSING"
    ACTION_PROPOSED = "ACTION_PROPOSED"
    WAITING_FOR_APPROVAL = "WAITING_FOR_APPROVAL"
    EXECUTING = "EXECUTING"
    VERIFYING = "VERIFYING"
    RESOLVED = "RESOLVED"
    ESCALATED = "ESCALATED"


# The legal-transition whitelist from AGENT_ARCHITECTURE.md's state machine
# section. RESOLVED and ESCALATED are terminal — nothing leaves them.
TRANSITIONS: dict[SessionPhase, set[SessionPhase]] = {
    SessionPhase.UNDERSTANDING: {
        SessionPhase.KNOWLEDGE_LOOKUP,
        SessionPhase.NEED_INFORMATION,
        SessionPhase.ESCALATED,
    },
    SessionPhase.KNOWLEDGE_LOOKUP: {
        SessionPhase.NEED_INFORMATION,
        SessionPhase.INVESTIGATING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.NEED_INFORMATION: {
        SessionPhase.INVESTIGATING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.INVESTIGATING: {
        SessionPhase.HYPOTHESIS_FORMED,
        SessionPhase.KNOWLEDGE_LOOKUP,
        SessionPhase.ESCALATED,
    },
    SessionPhase.HYPOTHESIS_FORMED: {
        SessionPhase.DIAGNOSING,
        SessionPhase.INVESTIGATING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.DIAGNOSING: {
        SessionPhase.ACTION_PROPOSED,
        SessionPhase.ESCALATED,
    },
    SessionPhase.ACTION_PROPOSED: {
        SessionPhase.WAITING_FOR_APPROVAL,
        SessionPhase.EXECUTING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.WAITING_FOR_APPROVAL: {
        SessionPhase.EXECUTING,
        SessionPhase.RESOLVED,
    },
    SessionPhase.EXECUTING: {
        SessionPhase.VERIFYING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.VERIFYING: {
        SessionPhase.RESOLVED,
        SessionPhase.INVESTIGATING,
        SessionPhase.ESCALATED,
    },
    SessionPhase.RESOLVED: set(),
    SessionPhase.ESCALATED: set(),
}


class IllegalTransition(Exception):
    """Raised when code tries to move a session to a phase that isn't
    reachable from its current phase. This should only ever fire from a
    programming bug — it's the thing that makes illegal states
    unrepresentable rather than just discouraged."""


def transition(session, to: SessionPhase, reason: str) -> None:
    current = SessionPhase(session.phase)
    allowed = TRANSITIONS.get(current, set())
    if to not in allowed:
        raise IllegalTransition(f"Cannot transition from {current.value} to {to.value}: {reason}")

    session.phase_history = [
        *session.phase_history,
        {
            "from": current.value,
            "to": to.value,
            "reason": reason,
            "at": datetime.now(UTC).isoformat(),
        },
    ]
    session.phase = to.value
    session.step_count += 1
