"""Knowledge-base initialization at backend startup, and the empty-index
retrieval status.

Each test gets its own fresh SQLite database, wired into the app's startup
hook and request sessions, and drives the real FastAPI lifespan
(`with TestClient(app)`). The embedder is the real MiniLM model, like
test_retrieval.py; the unavailable-model case patches the loader.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from starlette.testclient import TestClient

from flow_helpers import corrupt_storage, new_session, submit
from operon_backend import embeddings, knowledge
from operon_backend import main as backend_main
from operon_backend.db import get_db
from operon_backend.db_models import Base, KnowledgeChunk
from operon_backend.main import app
from operon_backend.retrieval import KnowledgeIndexEmpty, knowledge_index_size, search


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    """A brand-new, empty database used by both startup and request handling."""
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    monkeypatch.setattr(backend_main, "SessionLocal", factory)

    def _get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    yield factory
    app.dependency_overrides.pop(get_db, None)
    engine.dispose()


def start_backend() -> None:
    """One full backend start (lifespan) and stop."""
    with TestClient(app) as c:
        assert c.get("/health").status_code == 200


def chunk_rows(factory) -> dict[str, tuple[str, list[float]]]:
    db = factory()
    try:
        return {c.id: (c.content_text, list(c.embedding)) for c in db.query(KnowledgeChunk).all()}
    finally:
        db.close()


# ---- startup ---------------------------------------------------------------------------------------


def test_fresh_database_startup_indexes_the_knowledge_base(fresh_db):
    assert chunk_rows(fresh_db) == {}
    start_backend()
    rows = chunk_rows(fresh_db)
    assert len(rows) >= 80
    assert {"kb_kb_corrupted_cache", "kb_kb_blocked_by_client"} <= set(rows)
    assert all(len(vec) == embeddings.EMBEDDING_DIM for _, vec in rows.values())  # real 384-d vectors


def test_restart_is_idempotent_and_does_not_re_embed(fresh_db, monkeypatch):
    start_backend()
    first = chunk_rows(fresh_db)

    calls = []
    real_batch = knowledge.embed_batch
    monkeypatch.setattr(knowledge, "embed_batch", lambda texts: calls.append(len(texts)) or real_batch(texts))
    start_backend()
    start_backend()

    assert chunk_rows(fresh_db) == first  # same ids, same content, same vectors — no duplicates
    assert calls == []  # an indexed knowledge base is never re-embedded at startup


def test_an_existing_knowledge_base_is_never_overwritten(fresh_db):
    db = fresh_db()
    db.add(KnowledgeChunk(id="kb_custom", source_type="kb", source_id="custom", content_text="operator-curated entry", embedding=[0.0] * 384, chunk_metadata={}))
    db.commit()
    db.close()

    start_backend()

    assert chunk_rows(fresh_db) == {"kb_custom": ("operator-curated entry", [0.0] * 384)}


def test_history_alone_does_not_count_as_an_initialized_knowledge_base(fresh_db):
    db = fresh_db()
    db.add(KnowledgeChunk(id="hist_1", source_type="history", source_id="s1", content_text="a past session", embedding=[0.0] * 384, chunk_metadata={"tenant_id": "shared"}))
    db.commit()
    db.close()

    start_backend()

    rows = chunk_rows(fresh_db)
    assert "hist_1" in rows and rows["hist_1"][0] == "a past session"  # preserved
    assert "kb_kb_corrupted_cache" in rows  # and the curated KB was indexed alongside it


def test_concurrent_seeding_by_another_process_is_not_an_error(fresh_db, monkeypatch):
    def seeded_by_someone_else(db, **_):
        other = fresh_db()
        other.add(KnowledgeChunk(id="kb_x", source_type="kb", source_id="x", content_text="x", embedding=[0.0] * 384, chunk_metadata={}))
        other.commit()
        other.close()
        raise IntegrityError("INSERT", {}, Exception("UNIQUE constraint failed: knowledge_chunks.id"))

    monkeypatch.setattr(knowledge, "ingest_all_knowledge", seeded_by_someone_else)
    db = fresh_db()
    try:
        assert knowledge.ensure_knowledge_base(db) == {"status": "present", "chunks": 1}
    finally:
        db.close()


def test_startup_survives_an_unavailable_embedding_model(fresh_db, monkeypatch, caplog):
    def blocked():
        raise OSError("model download blocked")

    monkeypatch.setattr(embeddings, "_load_model", blocked)
    start_backend()  # the backend still starts and serves
    assert chunk_rows(fresh_db) == {}
    assert "Knowledge base not initialized" in caplog.text


# ---- retrieval after startup ------------------------------------------------------------------------


def test_retrieval_after_startup_finds_the_corrupted_cache_entry(fresh_db):
    start_backend()
    with TestClient(app) as client:
        s = new_session(client, "my dashboard looks corrupted")
        session = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    [record] = session["retrievals"]
    assert record["status"] == "ok"
    assert record["chunk_ids"][0] == "kb_kb_corrupted_cache"


def test_genuine_no_match_is_reported_as_no_match(fresh_db):
    start_backend()
    db = fresh_db()
    try:
        assert knowledge_index_size(db) > 0
        assert search(db, "what is the best sourdough bread recipe for a beginner baker") == []
    finally:
        db.close()
    with TestClient(app) as client:
        s = new_session(client, "what is the best sourdough bread recipe for a beginner baker")
        session = submit(client, s).json()["session"]
    [record] = session["retrievals"]
    assert record["status"] == "no_match" and record["error"] is None


def test_an_empty_index_is_not_reported_as_no_match(fresh_db, monkeypatch):
    def blocked():
        raise OSError("model download blocked")

    monkeypatch.setattr(embeddings, "_load_model", blocked)
    start_backend()  # can't index: the KB stays empty
    embeddings.reset_unavailable_state()

    db = fresh_db()
    try:
        with pytest.raises(KnowledgeIndexEmpty):
            search(db, "my dashboard looks corrupted")
    finally:
        db.close()
    client = TestClient(app)  # no lifespan: nothing seeds behind the test's back
    s = new_session(client, "my dashboard looks corrupted")
    session = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    [record] = session["retrievals"]
    assert record["status"] == "empty_index" and record["chunk_ids"] == []
    assert "knowledge base is empty" in record["reason"]
    assert session["phase"] == "ACTION_PROPOSED"  # the investigation itself continues
