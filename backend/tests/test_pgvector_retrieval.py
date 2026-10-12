"""Retrieval on a real PostgreSQL with pgvector.

The contract: the pgvector path returns what the in-process scan returns (the
database only proposes candidates; exact scoring decides), tenant isolation is
enforced inside the SQL so one tenant's history can never crowd out another's
results, and ingestion keeps the vector column in sync. Uses the real
embedding model, like the other retrieval tests.
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import db_support
from operon_backend import retrieval
from operon_backend.db_models import KnowledgeChunk
from operon_backend.embeddings import EMBEDDING_DIM, embed
from operon_backend.knowledge import ensure_knowledge_base, ingest_all_knowledge
from operon_backend.retrieval import KnowledgeIndexEmpty, pgvector_available, search

QUERIES = [
    "my dashboard looks corrupted. console: SyntaxError Unexpected token in JSON; storage 'operon_demo_cache' syntax_error",
    "some content never loaded. network GET https://collector.github.com/telemetry -> 0 net::ERR_BLOCKED_BY_CLIENT",
    "API returned 403 resource not accessible by integration",
    "what is the best sourdough bread recipe for a beginner baker",
]


@pytest.fixture(scope="module")
def pg():
    """One migrated database with the real knowledge base indexed, shared by the read-only tests."""
    url = db_support.new_postgres_database()
    db_support.migrate(url)
    engine = create_engine(url)
    session = sessionmaker(bind=engine)()
    ingest_all_knowledge(session)
    yield session
    session.close()
    engine.dispose()


@pytest.fixture
def empty_pg():
    url = db_support.new_postgres_database()
    db_support.migrate(url)
    engine = create_engine(url)
    session = sessionmaker(bind=engine)()
    yield session
    session.close()
    engine.dispose()


def test_pgvector_is_detected_only_where_the_migration_ran(pg, tmp_path):
    assert pgvector_available(pg)
    lite = sessionmaker(bind=create_engine(f"sqlite:///{tmp_path / 'x.db'}"))()
    assert not pgvector_available(lite)


def test_the_database_proposes_candidates_and_exact_scoring_decides(pg, monkeypatch):
    seen = []
    original = retrieval._pgvector_candidates

    def spy(*args, **kwargs):
        rows = original(*args, **kwargs)
        seen.append(len(rows))
        return rows

    monkeypatch.setattr(retrieval, "_pgvector_candidates", spy)
    results = search(pg, QUERIES[0])
    assert seen and 0 < seen[0] <= retrieval.PGVECTOR_CANDIDATES
    assert results[0].chunk_id == "kb_kb_corrupted_cache"


@pytest.mark.parametrize("query", QUERIES)
def test_the_pgvector_path_agrees_with_the_in_process_scan(pg, monkeypatch, query):
    with_index = search(pg, query, top_k=5)
    monkeypatch.setattr(retrieval, "pgvector_available", lambda db: False)
    scanned = search(pg, query, top_k=5)
    assert [r.chunk_id for r in with_index] == [r.chunk_id for r in scanned]
    assert [round(r.score, 6) for r in with_index] == [round(r.score, 6) for r in scanned]


def test_an_unrelated_query_still_matches_nothing(pg):
    assert search(pg, QUERIES[3]) == []


def test_ingestion_keeps_the_vector_column_in_sync_and_is_idempotent(pg):
    count = pg.execute(text("SELECT count(*) FROM knowledge_chunks")).scalar()
    assert count >= 80
    assert pg.execute(text("SELECT count(*) FROM knowledge_chunks WHERE embedding_vec IS NULL")).scalar() == 0
    ingest_all_knowledge(pg)
    assert pg.execute(text("SELECT count(*) FROM knowledge_chunks")).scalar() == count  # nothing duplicated
    assert ensure_knowledge_base(pg) == {"status": "present", "chunks": count}


def test_another_tenants_history_can_neither_be_seen_nor_crowd_out_results(empty_pg):
    db = empty_pg
    ingest_all_knowledge(db)
    query = QUERIES[0]
    near = embed(query)  # the most attractive possible embedding for this query
    for i in range(retrieval.PGVECTOR_CANDIDATES + 20):  # more than the candidate limit
        db.add(KnowledgeChunk(id=f"hist_evil_{i}", source_type="history", source_id=f"s{i}", content_text=f"evil past session {i}", embedding=near, chunk_metadata={"tenant_id": "evil-co"}))
    db.add(KnowledgeChunk(id="hist_acme_1", source_type="history", source_id="a1", content_text="acme past session", embedding=near, chunk_metadata={"tenant_id": "acme"}))
    db.add(KnowledgeChunk(id="hist_shared_1", source_type="history", source_id="sh", content_text="shared past session", embedding=near, chunk_metadata={"tenant_id": "shared"}))
    db.commit()

    acme = {r.chunk_id for r in search(db, query, tenant_id="acme", top_k=20)}
    assert "kb_kb_corrupted_cache" in acme  # the curated KB was not crowded out
    assert "hist_acme_1" in acme and "hist_shared_1" in acme
    assert not any(c.startswith("hist_evil_") for c in acme)

    evil = {r.chunk_id for r in search(db, query, tenant_id="evil-co", top_k=100)}
    assert any(c.startswith("hist_evil_") for c in evil) and "hist_acme_1" not in evil

    nobody = {r.chunk_id for r in search(db, query, tenant_id=None, top_k=100)}  # no tenant: shared history only
    assert "hist_shared_1" in nobody and "kb_kb_corrupted_cache" in nobody
    assert not any(c.startswith("hist_evil_") or c == "hist_acme_1" for c in nobody)


def test_source_type_filters_run_in_the_database_too(pg):
    only_errors = search(pg, QUERIES[2], source_types=["error"], similarity_floor=0.0, top_k=10)
    assert only_errors and {r.source_type for r in only_errors} == {"error"}


def test_an_empty_index_is_reported_not_searched(empty_pg):
    with pytest.raises(KnowledgeIndexEmpty):
        search(empty_pg, QUERIES[0])
    assert ensure_knowledge_base(empty_pg)["status"] == "seeded"
    assert search(empty_pg, QUERIES[0])[0].chunk_id == "kb_kb_corrupted_cache"


def test_stored_vectors_have_the_models_dimension(pg):
    dims = pg.execute(text("SELECT DISTINCT vector_dims(embedding_vec) FROM knowledge_chunks")).scalars().all()
    assert dims == [EMBEDDING_DIM]
