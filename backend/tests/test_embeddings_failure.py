"""Embedding availability, failure behavior and retrieval edge cases.

Deterministic: the model itself is stubbed. Whether the *real* model loads
and ranks correctly is checked by tests/live/test_live_embeddings.py and
scripts/validate_services.py.
"""

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from starlette.testclient import TestClient

from flow_helpers import corrupt_storage, new_session, submit
from operon_backend import embeddings
from operon_backend.config import settings
from operon_backend.db_models import Base, KnowledgeChunk
from operon_backend.embeddings import EmbeddingUnavailable, cosine_similarity
from operon_backend.main import app
from operon_backend.retrieval import search

client = TestClient(app)


@pytest.fixture
def failing_model(monkeypatch):
    calls = {"n": 0}

    def load():
        calls["n"] += 1
        raise ConnectionError("download blocked by test")

    monkeypatch.setattr(embeddings, "_load_model", load)
    return calls


def test_load_failure_becomes_embedding_unavailable_with_the_cause():
    def load():
        raise ConnectionError("download blocked")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(embeddings, "_load_model", load)
        with pytest.raises(EmbeddingUnavailable) as exc:
            embeddings.embed("x")
    assert "ConnectionError" in str(exc.value) and isinstance(exc.value.__cause__, ConnectionError)


def test_a_failed_load_is_not_retried_during_the_cooldown(failing_model):
    for _ in range(3):
        with pytest.raises(EmbeddingUnavailable):
            embeddings.embed("x")
    assert failing_model["n"] == 1
    with pytest.raises(EmbeddingUnavailable) as exc:
        embeddings.embed_batch(["a", "b"])
    assert "not retrying for" in str(exc.value)


def test_the_load_is_retried_after_the_cooldown(failing_model, monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(embeddings.time, "monotonic", lambda: clock["t"])
    with pytest.raises(EmbeddingUnavailable):
        embeddings.embed("x")
    clock["t"] += settings.embedding_retry_cooldown_seconds + 1
    with pytest.raises(EmbeddingUnavailable):
        embeddings.embed("x")
    assert failing_model["n"] == 2


def test_reset_clears_the_remembered_failure(failing_model):
    with pytest.raises(EmbeddingUnavailable):
        embeddings.embed("x")
    embeddings.reset_unavailable_state()
    with pytest.raises(EmbeddingUnavailable):
        embeddings.embed("x")
    assert failing_model["n"] == 2


def test_investigation_degrades_cleanly_and_records_the_embedding_failure(failing_model):
    s = new_session(client)
    first = submit(client, s, storage=[corrupt_storage()]).json()
    assert first["session"]["phase"] == "ACTION_PROPOSED"
    [record] = first["session"]["retrievals"]
    assert record["status"] == "error" and record["error"] == "EmbeddingUnavailable"
    assert "ConnectionError" in record["error_detail"]
    assert record["chunk_ids"] == [] and first["session"]["knowledge_references"] == []
    reason = next(t for t in first["session"]["phase_history"] if t["to"] == "KNOWLEDGE_LOOKUP")["reason"]
    assert "knowledge search unavailable" in reason

    # A second session inside the cooldown fails fast instead of retrying the download.
    s2 = new_session(client, "another")
    second = submit(client, s2, storage=[corrupt_storage()]).json()
    assert second["session"]["retrievals"][0]["status"] == "error"
    assert failing_model["n"] == 1


def test_error_is_distinct_from_no_match_in_the_session_record(failing_model, monkeypatch):
    s = new_session(client)
    errored = submit(client, s, storage=[corrupt_storage()]).json()["session"]["retrievals"][0]
    embeddings.reset_unavailable_state()
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    s2 = new_session(client)
    empty = submit(client, s2, storage=[corrupt_storage()]).json()["session"]["retrievals"][0]
    assert (errored["status"], empty["status"]) == ("error", "no_match")


# ---- retrieval edge cases with a stand-in vector (deterministic) ----------------------------------


def _temp_db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'kb.db'}")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _vec(*head):
    return [*head] + [0.0] * (embeddings.EMBEDDING_DIM - len(head))


def test_empty_knowledge_base_returns_nothing_without_error(tmp_path, monkeypatch):
    monkeypatch.setattr("operon_backend.retrieval.embed", lambda text: _vec(1.0))
    db = _temp_db(tmp_path)
    assert search(db, "anything at all") == []


def test_dimension_and_persistence_round_trip(tmp_path, monkeypatch):
    stored = _vec(0.25, -0.5, 0.125, 0.0625)
    db = _temp_db(tmp_path)
    db.add(KnowledgeChunk(id="kb_t", source_type="kb", source_id="t", content_text="t", embedding=stored, chunk_metadata={}))
    db.commit()
    db.close()

    reloaded = _temp_db(tmp_path).get(KnowledgeChunk, "kb_t")  # a fresh session: really read back from disk
    assert len(reloaded.embedding) == embeddings.EMBEDDING_DIM == 384
    assert cosine_similarity(stored, reloaded.embedding) == pytest.approx(1.0)

    monkeypatch.setattr("operon_backend.retrieval.embed", lambda text: _vec(0.25, -0.5, 0.125, 0.0625))
    [hit] = search(_temp_db(tmp_path), "q")
    assert hit.chunk_id == "kb_t" and hit.score == pytest.approx(1.0)


def test_cosine_similarity_edge_cases():
    assert cosine_similarity(_vec(1.0), _vec(1.0)) == pytest.approx(1.0)
    assert cosine_similarity(_vec(1.0), _vec(0.0, 1.0)) == pytest.approx(0.0)
    assert cosine_similarity(_vec(), _vec(1.0)) == 0.0  # zero vector never divides by zero
