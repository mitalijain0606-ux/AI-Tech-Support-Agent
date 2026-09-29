"""CLI tool for querying the Operon RAG Knowledge Base.

Allows testing semantic retrieval, facet filtering, multi-tenant isolation,
and viewing the prompt-ready context block.

Usage:
    python docs/knowledge-base/scripts/query_rag.py "GitHub API returned 403"
    python docs/knowledge-base/scripts/query_rag.py --status 403 "Resource not accessible by integration"
    python docs/knowledge-base/scripts/query_rag.py --subsystem actions "CI run failed exit code 1"
    python docs/knowledge-base/scripts/query_rag.py --source-type tool "how to rerun failed jobs"
"""

import argparse
import sys
from pathlib import Path

# Add backend directory to sys.path
REPO_ROOT = Path(__file__).resolve().parents[3]
BACKEND_DIR = REPO_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))


from operon_backend.db import SessionLocal, init_db
from operon_backend.retrieval import format_retrieved_context, search


def main() -> None:
    parser = argparse.ArgumentParser(description="Query the Operon RAG Knowledge Base")
    parser.add_argument("query", type=str, help="Search query or issue description")
    parser.add_argument("--top-k", type=int, default=5, help="Number of chunks to retrieve (default: 5)")
    parser.add_argument("--status", type=int, default=None, help="HTTP status code filter/boost (e.g. 403, 404, 429)")
    parser.add_argument("--subsystem", type=str, default=None, help="Filter by subsystem (api, auth, actions, collab)")
    parser.add_argument("--source-type", type=str, default=None, help="Filter by source type (kb, kb_section, error, tool, history)")
    parser.add_argument("--tenant-id", type=str, default=None, help="Tenant ID for tenant-scoped history queries")
    parser.add_argument("--floor", type=float, default=0.30, help="Similarity score floor (default: 0.30)")
    parser.add_argument("--prompt-view", action="store_true", help="Print formatted prompt context block")
    args = parser.parse_args()

    init_db()
    db = SessionLocal()
    try:
        source_types = [args.source_type] if args.source_type else None
        results = search(
            db=db,
            query_text=args.query,
            top_k=args.top_k,
            similarity_floor=args.floor,
            tenant_id=args.tenant_id,
            source_types=source_types,
            subsystem=args.subsystem,
            http_status=args.status,
        )

        print(f"\nQuery: {args.query}")
        print(f"Results retrieved: {len(results)}\n" + "=" * 60)

        for i, r in enumerate(results, 1):
            subsys = r.metadata.get("subsystem", "n/a")
            print(f"{i}. [{r.chunk_id}] (Score: {r.score:.3f} | Type: {r.source_type} | Subsystem: {subsys})")
            snippet = r.content_text.strip().replace("\n", " ")
            if len(snippet) > 140:
                snippet = snippet[:140] + "..."
            print(f"   Excerpt: {snippet}\n")

        if args.prompt_view and results:
            print("=" * 60)
            print("FORMATTED LLM PROMPT CONTEXT BLOCK:")
            print("=" * 60)
            print(format_retrieved_context(results))
    finally:
        db.close()


if __name__ == "__main__":
    main()
