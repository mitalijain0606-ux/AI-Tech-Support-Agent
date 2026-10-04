"""REAL embedding model (sentence-transformers/all-MiniLM-L6-v2 via fastembed).

These invoke the actual ONNX model — no stand-in. The first run downloads
~90 MB from huggingface.co, so they skip (with the reason) where that host
is unreachable; with OPERON_REQUIRE_LIVE=embeddings they fail instead.
"""

import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import live_gate
from operon_backend import embeddings
from operon_backend.db_models import Base, KnowledgeChunk
from operon_backend.embeddings import EMBEDDING_DIM, cosine_similarity, embed, embed_batch
from operon_backend.knowledge import ingest_all_knowledge
from operon_backend.retrieval import SIMILARITY_FLOOR, search

pytestmark = pytest.mark.live_embeddings


@pytest.fixture(scope="module", autouse=True)
def real_model():
    # Guard against a stand-in silently producing "live" evidence.
    assert embeddings._model.__module__ == "operon_backend.embeddings", "a stand-in embedder is active; live tests need the real model"
    embeddings.reset_unavailable_state()
    try:
        return embeddings._model()
    except embeddings.EmbeddingUnavailable as exc:
        live_gate.unavailable("embeddings", str(exc))


@pytest.fixture(scope="module")
def kb(tmp_path_factory):
    engine = create_engine(f"sqlite:///{tmp_path_factory.mktemp('kb') / 'live_kb.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine)
    db = factory()
    stats = ingest_all_knowledge(db)
    db.close()
    return factory, stats


def test_model_produces_unit_vectors_of_the_expected_dimension():
    vec = np.array(embed("localStorage config is corrupted"))
    assert vec.shape == (EMBEDDING_DIM,) == (384,)
    assert np.linalg.norm(vec) == pytest.approx(1.0, abs=1e-3)


def test_embedding_is_deterministic_and_batch_matches_single():
    texts = ["net::ERR_BLOCKED_BY_CLIENT on telemetry", "SyntaxError: Unexpected token in JSON"]
    a, b = embed_batch(texts), embed_batch(texts)
    assert cosine_similarity(a[0], b[0]) == pytest.approx(1.0, abs=1e-5)
    assert cosine_similarity(embed(texts[1]), a[1]) == pytest.approx(1.0, abs=1e-4)


@pytest.mark.parametrize(
    "anchor,related,unrelated",
    [
        ("corrupted JSON in localStorage breaks the dashboard", "invalid cached config fails to parse at page load", "recipe for sourdough bread"),
        ("ad blocker cancelled the request", "request blocked by a browser extension", "database index fragmentation"),
        ("API returned 403 resource not accessible", "insufficient permissions for the installation token", "how to bake a cake"),
    ],
)
def test_semantic_ordering(anchor, related, unrelated):
    a, r, u = embed_batch([anchor, related, unrelated])
    assert cosine_similarity(a, r) > cosine_similarity(a, u) + 0.1


def test_knowledge_base_indexes_with_real_vectors(kb):
    factory, stats = kb
    assert stats["total_chunks"] >= 80
    db = factory()
    try:
        chunks = db.query(KnowledgeChunk).all()
        assert len(chunks) == stats["total_chunks"]
        assert all(len(c.embedding) == 384 for c in chunks)
        assert all(np.linalg.norm(c.embedding) == pytest.approx(1.0, abs=1e-3) for c in chunks[:20])
    finally:
        db.close()


@pytest.mark.parametrize(
    "query,expected_chunk",
    [
        ("my dashboard looks corrupted. console: SyntaxError Unexpected token in JSON; storage 'operon_demo_cache' parse_status syntax_error", "kb_kb_corrupted_cache"),
        ("some content on the page never loaded. network GET https://collector.github.com/telemetry -> 0 net::ERR_BLOCKED_BY_CLIENT", "kb_kb_blocked_by_client"),
    ],
)
def test_known_failure_queries_retrieve_their_own_entry(kb, query, expected_chunk):
    factory, _ = kb
    db = factory()
    try:
        results = search(db, query, top_k=3)
        assert expected_chunk in [r.chunk_id for r in results], [(r.chunk_id, round(r.score, 2)) for r in results]
        assert results[0].score >= SIMILARITY_FLOOR
    finally:
        db.close()


def test_unrelated_query_matches_nothing_above_the_floor(kb):
    factory, _ = kb
    db = factory()
    try:
        assert search(db, "what is the best sourdough bread recipe for a beginner baker") == []
    finally:
        db.close()


def test_persisted_vectors_reload_unchanged(kb):
    factory, _ = kb
    db = factory()
    try:
        fresh = embed("clear the corrupted storage key")
        row = db.get(KnowledgeChunk, "kb_kb_corrupted_cache")
        before = cosine_similarity(fresh, row.embedding)
    finally:
        db.close()
    db2 = factory()  # a new session: re-read from disk
    try:
        row2 = db2.get(KnowledgeChunk, "kb_kb_corrupted_cache")
        assert cosine_similarity(fresh, row2.embedding) == pytest.approx(before, abs=1e-9)
        assert before > 0.3
    finally:
        db2.close()
