"""Model calls cut off by a restart count against the session's budget (inflight.py)."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from starlette.testclient import TestClient

from flow_helpers import FakeGroq, answer, corrupt_storage, new_session, submit
from operon_backend import inflight
from operon_backend.db import SessionLocal
from operon_backend.db_models import InflightModelCall, SessionRecord
from operon_backend.llm import LLMError
from operon_backend.loop_driver import MAX_LLM_CALLS
from operon_backend.main import app

client = TestClient(app)
CLEAR = {"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}}


@pytest.fixture(autouse=True)
def no_retrieval(monkeypatch):
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def marker(session_id):
    db = SessionLocal()
    try:
        return db.get(InflightModelCall, session_id)
    finally:
        db.close()


def leave_marker(session_id, process_id="a-process-that-no-longer-exists", age_seconds=5):
    """What a backend that stopped mid-call leaves behind."""
    db = SessionLocal()
    try:
        db.add(InflightModelCall(session_id=session_id, process_id=process_id,
                                 started_at=datetime.now(UTC) - timedelta(seconds=age_seconds)))
        db.commit()
    finally:
        db.close()


def stored(session_id):
    db = SessionLocal()
    try:
        return db.get(SessionRecord, session_id)
    finally:
        db.close()


def test_the_marker_exists_during_the_call_and_is_gone_after_it(monkeypatch):
    s = new_session(client)
    seen = {}

    async def call(messages):
        seen["marker"] = marker(s["session_id"])
        return json.dumps(answer(action=CLEAR))

    FakeGroq(monkeypatch, [])
    monkeypatch.setattr("operon_backend.llm._call_groq", call)
    assert submit(client, s, storage=[corrupt_storage()]).status_code == 200
    assert seen["marker"] is not None and seen["marker"].process_id == inflight.PROCESS_ID
    assert marker(s["session_id"]) is None


def test_the_marker_is_removed_when_the_call_fails(monkeypatch):
    s = new_session(client)
    FakeGroq(monkeypatch, [LLMError("Groq API error (status 500)")])
    assert submit(client, s, storage=[corrupt_storage()]).status_code == 400
    assert marker(s["session_id"]) is None


def test_a_call_cut_off_by_a_restart_is_counted_once_on_the_next_cycle():
    s = new_session(client)
    before = stored(s["session_id"]).llm_call_count or 0
    leave_marker(s["session_id"])
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]  # offline engine: no model call of its own
    assert body["llm_call_count"] == before + 1
    kinds = [a["kind"] for a in body["activity"]]
    assert kinds.count("diagnosis_interrupted") == 1
    assert marker(s["session_id"]) is None


def test_a_call_still_running_in_this_process_is_not_counted():
    s = new_session(client)
    leave_marker(s["session_id"], process_id=inflight.PROCESS_ID, age_seconds=1)
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    assert "diagnosis_interrupted" not in [a["kind"] for a in body["activity"]]


def test_a_stale_marker_of_this_process_is_counted():
    s = new_session(client)
    leave_marker(s["session_id"], process_id=inflight.PROCESS_ID, age_seconds=inflight.max_call_seconds() + 60)
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    assert "diagnosis_interrupted" in [a["kind"] for a in body["activity"]]


def test_an_interruption_can_use_up_the_budget_and_escalate():
    s = new_session(client)
    db = SessionLocal()
    try:
        row = db.get(SessionRecord, s["session_id"])
        row.llm_call_count = MAX_LLM_CALLS - 1
        db.commit()
    finally:
        db.close()
    leave_marker(s["session_id"])
    body = submit(client, s, storage=[corrupt_storage()]).json()
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["llm_call_count"] == MAX_LLM_CALLS
