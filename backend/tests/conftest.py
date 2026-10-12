import os
import pathlib

# Must happen before any `operon_backend.config` import anywhere — pydantic-
# settings reads this at Settings() construction time, which happens at
# module import. A dedicated file (not the dev operon.db, not :memory:,
# which is per-connection and breaks under SQLAlchemy's default pooling)
# keeps test runs isolated and repeatable.
_TEST_DB_PATH = pathlib.Path(__file__).parent.parent / "test_operon.db"
if _TEST_DB_PATH.exists():
    _TEST_DB_PATH.unlink()
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB_PATH}"

# Create tables directly rather than relying on FastAPI's lifespan handler
# firing — that only happens when TestClient is used as a context manager,
# which is an easy thing for a test file to forget.
from operon_backend.db import init_db

init_db()

import pytest

from operon_backend.config import settings


@pytest.fixture(autouse=True)
def _auth_off_by_default(monkeypatch):
    """Most tests exercise the investigation itself, not authentication; they
    run as the anonymous "public" principal. Authentication, tenant isolation
    and rate limits have their own suites (test_auth.py, test_tenants.py,
    test_rate_limit.py), which turn it on with the `auth_on` fixture."""
    monkeypatch.setattr(settings, "auth_required", False)
    from operon_backend.ratelimit import limiter

    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture(autouse=True)
def _offline_engine_by_default(monkeypatch):
    """Every test runs against the labelled offline engine unless it installs
    FakeGroq (tests/flow_helpers.py). No test can reach a real model."""
    monkeypatch.setattr(settings, "groq_api_key", "")


@pytest.fixture(autouse=True)
def _isolate_session_history():
    """Resolved/escalated sessions are saved as `history` knowledge chunks.
    Remove them after each test so one test's sessions never become another
    test's retrieval results."""
    yield
    from operon_backend.db import SessionLocal
    from operon_backend.db_models import KnowledgeChunk

    db = SessionLocal()
    try:
        db.query(KnowledgeChunk).filter(KnowledgeChunk.source_type == "history").delete()
        db.commit()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _independent_embedding_state():
    """A remembered embedding-load failure (cooldown) must not leak between tests."""
    from operon_backend import embeddings

    embeddings.reset_unavailable_state()
    yield
    embeddings.reset_unavailable_state()
