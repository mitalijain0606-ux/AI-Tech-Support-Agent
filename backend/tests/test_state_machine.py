from types import SimpleNamespace

import pytest

from operon_backend.state_machine import IllegalTransition, SessionPhase, transition


def make_session(phase: SessionPhase = SessionPhase.UNDERSTANDING):
    return SimpleNamespace(phase=phase.value, phase_history=[], step_count=0)


def test_legal_transition_updates_phase_and_logs_history():
    session = make_session()
    transition(session, SessionPhase.KNOWLEDGE_LOOKUP, "starting knowledge search")

    assert session.phase == SessionPhase.KNOWLEDGE_LOOKUP.value
    assert session.step_count == 1
    assert len(session.phase_history) == 1
    entry = session.phase_history[0]
    assert entry["from"] == SessionPhase.UNDERSTANDING.value
    assert entry["to"] == SessionPhase.KNOWLEDGE_LOOKUP.value
    assert entry["reason"] == "starting knowledge search"
    assert "at" in entry


def test_illegal_transition_raises_and_does_not_mutate():
    session = make_session(SessionPhase.RESOLVED)

    with pytest.raises(IllegalTransition):
        transition(session, SessionPhase.EXECUTING, "should not be allowed")

    # A rejected transition must leave the session exactly as it was —
    # illegal states are unrepresentable, not just discouraged.
    assert session.phase == SessionPhase.RESOLVED.value
    assert session.phase_history == []
    assert session.step_count == 0


def test_verifying_can_reach_all_three_documented_outcomes():
    for target in (SessionPhase.RESOLVED, SessionPhase.INVESTIGATING, SessionPhase.ESCALATED):
        session = make_session(SessionPhase.VERIFYING)
        transition(session, target, "test")
        assert session.phase == target.value


def test_terminal_phases_accept_no_further_transitions():
    for terminal in (SessionPhase.RESOLVED, SessionPhase.ESCALATED):
        session = make_session(terminal)
        with pytest.raises(IllegalTransition):
            transition(session, SessionPhase.UNDERSTANDING, "should never happen")
