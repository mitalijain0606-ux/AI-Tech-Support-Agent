"""The whole session lifecycle through the real HTTP API on a real PostgreSQL
(with pgvector): JSON-column mutation tracking, tenant scoping, history
ingestion and retrieval behave as they do on SQLite."""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from starlette.testclient import TestClient

import db_support
from auth_helpers import mint  # noqa: F401  (same helpers, bound to the PG session below)
from flow_helpers import CAPABILITIES, corrupt_storage, storage_state
from operon_backend import main as backend_main
from operon_backend.auth import create_api_key
from operon_backend.config import settings
from operon_backend.db import get_db
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.knowledge import ingest_all_knowledge
from operon_backend.main import app


@pytest.fixture
def pg_app(monkeypatch):
    url = db_support.new_postgres_database()
    db_support.migrate(url)
    engine = create_engine(url)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    setup = factory()
    ingest_all_knowledge(setup)
    setup.close()

    def _get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    monkeypatch.setattr(backend_main, "SessionLocal", factory)
    monkeypatch.setattr(settings, "auth_required", True)
    yield factory
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def key(factory, tenant, subject, role="user"):
    db = factory()
    try:
        token, _ = create_api_key(db, tenant, subject, role)
    finally:
        db.close()
    return {"Authorization": f"Bearer {token}"}


def test_a_full_fix_resolves_on_postgres_and_learns_from_it(pg_app):
    client = TestClient(app)
    alice = key(pg_app, "acme", "alice")
    s = client.post("/api/sessions", json={"user_issue": "my dashboard looks corrupted", "provider_capabilities": CAPABILITIES}, headers=alice).json()
    sid = s["session_id"]
    bundle = {"url": "https://github.com/o/r", "timestamp": 1, "request_id": s["evidence_request"]["request_id"], "storage": [corrupt_storage()]}
    body = client.post(f"/api/sessions/{sid}/investigate", json={"bundle": bundle}, headers=alice).json()
    session = body["session"]
    assert session["phase"] == "ACTION_PROPOSED"
    assert session["retrievals"][0]["status"] == "ok" and "kb_kb_corrupted_cache" in session["retrievals"][0]["chunk_ids"]  # pgvector retrieval inside a real session

    plan = session["pending_action"]
    assert client.post(f"/api/sessions/{sid}/policy", json={}, headers=alice).json()["session"]["phase"] == "WAITING_FOR_APPROVAL"
    approved = client.post(f"/api/sessions/{sid}/approve", json={"approved": True, "proposal_id": plan["proposal_id"]}, headers=alice).json()
    assert approved["phase"] == "EXECUTING" and approved["approval"]["approved_by"] == "alice"
    done = client.post(f"/api/sessions/{sid}/action-result", json={"action_id": plan["action_id"], "succeeded": True, "detail": "cleared"}, headers=alice).json()
    assert done["phase"] == "VERIFYING"
    verdict = client.post(
        f"/api/sessions/{sid}/verify",
        json={"action_id": plan["action_id"], "observation": {"console": [], "network": [], "storage": [storage_state()]}},
        headers=alice,
    ).json()
    assert verdict["phase"] == "RESOLVED" and verdict["verification_state"]["outcome"] == "passed"

    # JSON columns round-trip and the whole record survived
    reloaded = client.get(f"/api/sessions/{sid}", headers=alice).json()
    assert [a["kind"] for a in reloaded["activity"]][-3:] == ["action_executed", "verification", "resolved"]
    assert reloaded["phase_history"][-1]["to"] == "RESOLVED"

    db = pg_app()
    try:
        row = db.get(SessionRecord, sid)
        assert (row.tenant_id, row.created_by) == ("acme", "alice")
        history = db.query(KnowledgeChunk).filter(KnowledgeChunk.id == f"hist_{sid}").one()  # learned, with its tenant, and vector-synced
        assert history.chunk_metadata["tenant_id"] == "acme"
        assert db.execute(text("SELECT embedding_vec IS NOT NULL FROM knowledge_chunks WHERE id = :i"), {"i": history.id}).scalar()
    finally:
        db.close()


def test_tenant_isolation_holds_on_postgres(pg_app):
    client = TestClient(app)
    alice, mallory = key(pg_app, "acme", "alice"), key(pg_app, "evil", "mallory")
    sid = client.post("/api/sessions", json={"user_issue": "x", "provider_capabilities": CAPABILITIES}, headers=alice).json()["session_id"]
    assert client.get(f"/api/sessions/{sid}", headers=mallory).status_code == 404
    assert client.get(f"/api/sessions/{sid}", headers=alice).status_code == 200


def test_readiness_reports_postgres(pg_app):
    body = TestClient(app).get("/ready").json()
    assert body["checks"]["database"] == {"status": "ok", "kind": "postgresql"}
    assert body["checks"]["knowledge_base"]["curated_chunks"] >= 80
