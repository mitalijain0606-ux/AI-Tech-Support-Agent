import pytest

from operon_backend.db import SessionLocal
from operon_backend.db_models import KnowledgeChunk
from operon_backend.embeddings import embed
from operon_backend.knowledge import SEED_DOCUMENTS
from operon_backend.retrieval import search


@pytest.fixture(scope="module", autouse=True)
def seeded_kb():
    """Seed the two real KB documents into the test database once per
    module — real embeddings, not mocked, so this is a genuine test of
    retrieval quality, not just wiring."""
    db = SessionLocal()
    try:
        for doc in SEED_DOCUMENTS:
            content = doc.to_embedding_text()
            db.add(
                KnowledgeChunk(
                    id=f"kb_{doc.doc_id}",
                    source_type="kb",
                    source_id=doc.doc_id,
                    content_text=content,
                    embedding=embed(content),
                    chunk_metadata=doc.model_dump(),
                )
            )
        db.commit()
    finally:
        db.close()
    yield


def test_corrupted_cache_query_retrieves_its_own_doc():
    db = SessionLocal()
    try:
        results = search(db, "my dashboard looks corrupted, console shows SyntaxError parsing JSON")
    finally:
        db.close()

    assert len(results) >= 1
    assert results[0].chunk_id == "kb_kb_corrupted_cache"


def test_ad_blocker_query_retrieves_its_own_doc():
    db = SessionLocal()
    try:
        results = search(db, "some content is silently missing, might be blocked by an extension")
    finally:
        db.close()

    assert len(results) >= 1
    assert results[0].chunk_id == "kb_kb_blocked_by_client"


def test_unrelated_query_retrieves_nothing_above_floor():
    db = SessionLocal()
    try:
        results = search(db, "what's the weather like today")
    finally:
        db.close()

    assert results == []
