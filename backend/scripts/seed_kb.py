"""Embed and insert all knowledge sources into knowledge_chunks:
1. Curated demo seed documents (github-scenarios.md)
2. Curated markdown articles and playbooks (docs/knowledge-base/**/*.md)
3. Granular chapter sections for deep semantic retrieval
4. Machine-readable error intelligence entries (docs/knowledge-base/06-errors/errors.yaml)
5. Tool registry contracts (docs/knowledge-base/07-tools/tool-registry.yaml)

Idempotent — re-running replaces or updates each chunk rather than duplicating it.

Usage (from backend/):
    python scripts/seed_kb.py [--force] [--kb-dir <path>]
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from operon_backend.db import SessionLocal, init_db
from operon_backend.knowledge import ingest_all_knowledge


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the Operon RAG Knowledge Base")
    parser.add_argument("--force", action="store_true", help="Force re-embedding all chunks even if content is unchanged")
    parser.add_argument("--kb-dir", type=str, default=None, help="Path to docs/knowledge-base directory")
    args = parser.parse_args()

    init_db()
    db = SessionLocal()
    try:
        kb_path = Path(args.kb_dir).resolve() if args.kb_dir else None
        print("Indexing knowledge base into vector store...")
        stats = ingest_all_knowledge(db, kb_dir=kb_path, force_reembed=args.force)

        print("\nKnowledge Base Seeding Complete:")
        print(f"  • Seed documents:     {stats['seed_documents']}")
        print(f"  • Markdown articles:  {stats['kb_documents']}")
        print(f"  • Chapter sections:   {stats['sections']}")
        print(f"  • Error definitions:  {stats['errors']}")
        print(f"  • Tool contracts:     {stats['tools']}")
        print(f"  -----------------------------")
        print(f"  Total Indexed Chunks: {stats['total_chunks']}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
