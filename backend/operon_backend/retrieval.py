"""Retrieval over knowledge_chunks — curated KB entries and (once Phase 3
wires up the ingestion hook) resolved-session history. Brute-force cosine
similarity in Python: at KB-plus-a-few-hundred-sessions scale this is
fast enough, and it's what keeps this running on SQLite today without
needing pgvector's ANN index. Moving the actual similarity computation
into Postgres later doesn't change this function's signature.
"""

from dataclasses import dataclass

from sqlalchemy.orm import Session as DBSession

from operon_backend.db_models import KnowledgeChunk
from operon_backend.embeddings import cosine_similarity, embed
from operon_backend.schemas import EvidenceBundle

SIMILARITY_FLOOR = 0.35


def build_query(user_issue: str, bundle: EvidenceBundle) -> str:
    """What actually gets embedded to search — the complaint plus a short
    evidence summary, per AGENT_ARCHITECTURE.md's retrieval mechanics.
    Deliberately the same short summary shape an L2 engineer would type
    into a search bar, not the raw bundle."""
    lines = [user_issue]
    for c in bundle.console:
        lines.append(f"console {c.level}: {c.text}")
    for n in bundle.network:
        lines.append(f"network {n.method} {n.url} -> {n.status} {n.status_text or ''}".strip())
    for s in bundle.storage:
        lines.append(f"storage '{s.key}': {s.parse_status}")
    return "\n".join(lines)


@dataclass
class RetrievedChunk:
    chunk_id: str
    source_type: str
    source_id: str
    content_text: str
    score: float


def search(db: DBSession, query_text: str, top_k: int = 5) -> list[RetrievedChunk]:
    query_vec = embed(query_text)
    chunks = db.query(KnowledgeChunk).all()

    scored = [
        RetrievedChunk(
            chunk_id=chunk.id,
            source_type=chunk.source_type,
            source_id=chunk.source_id,
            content_text=chunk.content_text,
            score=cosine_similarity(query_vec, chunk.embedding),
        )
        for chunk in chunks
    ]
    scored = [r for r in scored if r.score >= SIMILARITY_FLOOR]
    scored.sort(key=lambda r: r.score, reverse=True)
    return scored[:top_k]
