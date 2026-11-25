"""Idle, unfinished sessions expire (session_service.expire_if_idle): when they are next
loaded, and in the startup sweep. Expiry closes the session without a ticket, and a fix
that was waiting for approval can no longer be approved."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from starlette.testclient import TestClient

from flow_helpers import approve, corrupt_storage, new_session, policy, submit
from operon_backend.config import settings
from operon_backend.db import SessionLocal, engine
from operon_backend.db_models import SessionRecord, Ticket
from operon_backend.main import app
from operon_backend.session_service import EXPIRED_IDLE, expire_idle_sessions

client = TestClient(app)


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setattr(settings, "session_idle_expiry_hours", 24.0)
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def age(session_id: str, hours: float) -> None:
    """Pretend the session was last touched `hours` ago (raw SQL: no onupdate)."""
    with engine.begin() as conn:
        conn.execute(text("UPDATE sessions SET updated_at = :t WHERE id = :id"),
                     {"t": datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=hours), "id": session_id})


def waiting_for_approval() -> str:
    s = new_session(client)
    assert submit(client, s, storage=[corrupt_storage()]).json()["session"]["phase"] == "ACTION_PROPOSED"
    assert policy(client, s["session_id"]).status_code == 200
    return s["session_id"]


def test_a_session_idle_past_the_limit_expires_when_loaded_without_a_ticket():
    sid = waiting_for_approval()
    age(sid, 25)
    body = client.get(f"/api/sessions/{sid}").json()
    assert body["phase"] == "ESCALATED"
    assert body["escalation_state"]["resolution_state"] == EXPIRED_IDLE
    assert body["escalation_state"]["ticket_id"] is None
    assert "expired after 24 hours" in body["escalation_state"]["reason"]
    db = SessionLocal()
    try:
        assert db.query(Ticket).filter(Ticket.session_id == sid).count() == 0
    finally:
        db.close()


def test_an_expired_proposal_can_no_longer_be_approved():
    sid = waiting_for_approval()
    age(sid, 48)
    res = approve(client, sid)
    assert res.status_code == 409
    after = client.get(f"/api/sessions/{sid}").json()
    assert after["attempted_actions"] == [] and after["phase"] == "ESCALATED"


def test_a_recently_used_session_is_untouched():
    sid = waiting_for_approval()
    age(sid, 23)
    assert client.get(f"/api/sessions/{sid}").json()["phase"] == "WAITING_FOR_APPROVAL"


def test_activity_refreshes_the_idle_clock():
    s = new_session(client)
    sid = s["session_id"]
    age(sid, 23.9)
    submit(client, s, storage=[corrupt_storage()])  # any change counts as activity
    db = SessionLocal()
    try:
        row = db.get(SessionRecord, sid)
        since = row.updated_at.replace(tzinfo=UTC) if row.updated_at.tzinfo is None else row.updated_at
        assert datetime.now(UTC) - since < timedelta(minutes=1)
    finally:
        db.close()


def test_finished_sessions_never_change():
    sid = waiting_for_approval()
    approve(client, sid, approved=False)  # declined: a terminal outcome
    before = client.get(f"/api/sessions/{sid}").json()
    age(sid, 1000)
    after = client.get(f"/api/sessions/{sid}").json()
    assert after["phase"] == before["phase"] and after["escalation_state"] == before["escalation_state"]


def test_the_startup_sweep_expires_only_idle_unfinished_sessions():
    old, fresh = waiting_for_approval(), waiting_for_approval()
    age(old, 30)
    db = SessionLocal()
    try:
        assert expire_idle_sessions(db) >= 1
        assert db.get(SessionRecord, old).resolution_state == EXPIRED_IDLE
        assert db.get(SessionRecord, fresh).phase == "WAITING_FOR_APPROVAL"
    finally:
        db.close()


def test_expiry_can_be_switched_off(monkeypatch):
    monkeypatch.setattr(settings, "session_idle_expiry_hours", 0)
    sid = waiting_for_approval()
    age(sid, 500)
    assert client.get(f"/api/sessions/{sid}").json()["phase"] == "WAITING_FOR_APPROVAL"


def test_a_session_from_before_the_column_existed_is_measured_from_creation():
    sid = waiting_for_approval()
    with engine.begin() as conn:
        conn.execute(text("UPDATE sessions SET updated_at = NULL, created_at = :t WHERE id = :id"),
                     {"t": datetime.now(UTC).replace(tzinfo=None) - timedelta(hours=40), "id": sid})
    assert client.get(f"/api/sessions/{sid}").json()["escalation_state"]["resolution_state"] == EXPIRED_IDLE
