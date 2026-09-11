"""Embed and insert the curated KnowledgeDocuments into knowledge_chunks.
Idempotent — re-running replaces each doc's existing chunk rather than
duplicating it, so this is safe to run again after editing knowledge.py.

Usage (from backend/):
    .venv/bin/python scripts/seed_kb.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from operon_backend.db import SessionLocal, init_db
from operon_backend.db_models import KnowledgeChunk
from operon_backend.embeddings import embed
from operon_backend.knowledge import SEED_DOCUMENTS


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        for doc in SEED_DOCUMENTS:
            chunk_id = f"kb_{doc.doc_id}"
            existing = db.get(KnowledgeChunk, chunk_id)
            content_text = doc.to_embedding_text()
            vector = embed(content_text)

            if existing:
                existing.content_text = content_text
                existing.embedding = vector
                existing.chunk_metadata = doc.model_dump()
            else:
                db.add(
                    KnowledgeChunk(
                        id=chunk_id,
                        source_type="kb",
                        source_id=doc.doc_id,
                        content_text=content_text,
                        embedding=vector,
                        chunk_metadata=doc.model_dump(),
                    )
                )
            print(f"seeded {chunk_id}: {doc.title}")

        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
