"""Seed and update the RAG vector store from the knowledge base.

Indexes:
1. Playbooks and troubleshooting documents (docs/knowledge-base/**/*.md)
2. Granular chapter sections for deep semantic retrieval
3. Error intelligence catalogue (docs/knowledge-base/06-errors/errors.yaml)
4. Tool registry contracts (docs/knowledge-base/07-tools/tool-registry.yaml)
5. Curated scenario playbooks (github-scenarios.md)

Usage:
    python docs/knowledge-base/scripts/seed_rag.py [--force] [--db-url <url>]
"""

import argparse
import sys
from pathlib import Path

# Add backend directory to sys.path
REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))


from operon_backend.db import SessionLocal, init_db
from operon_backend.knowledge import ingest_all_knowledge


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed RAG Pipeline from Knowledge Base")
    parser.add_argument("--force", action="store_true", help="Force re-embedding all chunks even if unchanged")
    parser.add_argument("--kb-dir", type=str, default=str(REPO_ROOT / "docs" / "knowledge-base"), help="Knowledge base path")
    args = parser.parse_args()

    init_db()
    db = SessionLocal()
    try:
        kb_path = Path(args.kb_dir).resolve()
        print(f"Reading documentation from: {kb_path}")
        print("Ingesting knowledge base into vector store...")

        stats = ingest_all_knowledge(db, kb_dir=kb_path, force_reembed=args.force)

        print("\n" + "=" * 50)
        print("Operon Knowledge Base RAG Pipeline Seeding Complete:")
        print("=" * 50)
        print(f"  • Curated Seed Playbooks:  {stats['seed_documents']:3d}")
        print(f"  • Markdown Articles:       {stats['kb_documents']:3d}")
        print(f"  • Deep Chapter Sections:   {stats['sections']:3d}")
        print(f"  • Error Catalogue Entries: {stats['errors']:3d}")
        print(f"  • Tool Registry Contracts: {stats['tools']:3d}")
        print("  " + "-" * 46)
        print(f"  Total Active RAG Chunks:   {stats['total_chunks']:3d}")
        print("=" * 50)
    finally:
        db.close()


if __name__ == "__main__":
    main()
