"""Model calls cut off by a restart still count against the session's budget.

A diagnosis runs inside the request that submitted the evidence, and a failed cycle is
rolled back so the evidence can be resubmitted. That also rolled back any trace of a model
call the backend was in the middle of when it stopped, so the call was never counted and a
session could exceed its model-call budget through repeated crashes.

Now a marker is committed (in its own short transaction) before each model call and deleted
when the call ends, successfully or not. At the start of the next cycle, a marker that is
still there and was left by a process that no longer exists (a different PROCESS_ID), or is
older than any call could take, is counted as one interrupted call and recorded in the
session's activity.
"""

import uuid
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session as DBSession

from operon_backend.activity import record_activity
from operon_backend.config import settings
from operon_backend.db_models import InflightModelCall, SessionRecord

PROCESS_ID = uuid.uuid4().hex  # new every time the backend starts


def max_call_seconds() -> float:
    """The longest one model call can legitimately take, retries included, plus slack."""
    retries = max(settings.groq_rate_limit_retries, 0)
    return settings.groq_timeout_seconds * (retries + 1) + settings.groq_rate_limit_max_wait_seconds * retries + 30


def _write(session_id: str, delete: bool, factory) -> None:
    db = factory()
    try:
        row = db.get(InflightModelCall, session_id)
        if delete:
            if row is not None and row.process_id == PROCESS_ID:
                db.delete(row)
        elif row is None:
            db.add(InflightModelCall(session_id=session_id, process_id=PROCESS_ID))
        else:
            row.started_at, row.process_id = datetime.now(UTC), PROCESS_ID
        db.commit()
    finally:
        db.close()


@contextmanager
def model_call(db: DBSession, session_id: str):
    """Marks a model call for `session_id` as in flight for the duration of the block."""
    factory = _factory(db)
    _write(session_id, delete=False, factory=factory)
    try:
        yield
    finally:
        _write(session_id, delete=True, factory=factory)


def _factory(db: DBSession):
    from sqlalchemy.orm import sessionmaker

    return sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)


def take_interrupted(db: DBSession, session_id: str, now: datetime | None = None) -> datetime | None:
    """Removes and returns the start time of a call that was cut off, if there is one.
    Uses its own short transaction, like the marker itself."""
    other = _factory(db)()
    try:
        row = other.get(InflightModelCall, session_id)
        if row is None:
            return None
        started = row.started_at if row.started_at.tzinfo else row.started_at.replace(tzinfo=UTC)
        stale = (now or datetime.now(UTC)) - started > timedelta(seconds=max_call_seconds())
        if row.process_id == PROCESS_ID and not stale:
            return None  # a call of this very process is still running (a concurrent request)
        other.delete(row)
        other.commit()
        return started
    finally:
        other.close()


def count_interrupted(db: DBSession, session: SessionRecord, now: datetime | None = None) -> bool:
    """Counts a call that was cut off against the session's budget; True if there was one.
    The session changes are part of the caller's transaction."""
    started = take_interrupted(db, session.id, now)
    if started is None:
        return False
    session.llm_call_count = (session.llm_call_count or 0) + 1
    record_activity(session, "diagnosis_interrupted",
                    "a model call was cut off before it finished (the backend stopped); it counts against this session's budget",
                    started_at=started.isoformat(), llm_calls=1)
    return True
