"""Retrieval over knowledge_chunks — curated KB entries, error catalogue, tool registry,
and resolved-session history.

Supports:
- Dense semantic vector search using 384-dim MiniLM embeddings
- Query builders for browser evidence, GitHub REST/GraphQL API errors, and Actions CI logs
- Strict multi-tenant isolation (zero cross-tenant history leakage, per Safety §12 / Red-Team R17)
- Subsystem and source_type facet filtering (per taxonomy.md)
- HTTP status code and message-pattern relevance boosting
- Freshness and staleness-aware filtering
- Prompt-ready formatted context generation with anti-hallucination guardrails
"""

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

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


def build_github_api_query(
    user_issue: str,
    status_code: int | None = None,
    error_message: str | None = None,
    headers: dict[str, str] | None = None,
    endpoint: str | None = None,
) -> str:
    """Builds a rich search query from a GitHub REST/GraphQL API failure."""
    lines = [f"User issue: {user_issue}"]
    if status_code:
        lines.append(f"HTTP Status: {status_code}")
    if endpoint:
        lines.append(f"Endpoint: {endpoint}")
    if error_message:
        lines.append(f"Error message: {error_message}")

    if headers:
        for k, v in headers.items():
            kl = k.lower()
            if kl in ("x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "x-accepted-github-permissions"):
                lines.append(f"Header {k}: {v}")

    return "\n".join(lines)


def build_github_actions_query(
    user_issue: str,
    workflow_name: str | None = None,
    job_name: str | None = None,
    step_name: str | None = None,
    exit_code: int | None = None,
    log_excerpt: str | None = None,
) -> str:
    """Builds a rich search query from a GitHub Actions CI failure and scrubbed logs."""
    lines = [f"User issue: {user_issue}"]
    if workflow_name:
        lines.append(f"Workflow: {workflow_name}")
    if job_name:
        lines.append(f"Job: {job_name}")
    if step_name:
        lines.append(f"Step: {step_name}")
    if exit_code is not None:
        lines.append(f"Exit code: {exit_code}")
    if log_excerpt:
        lines.append("Failing log excerpt:")
        lines.append(log_excerpt[:1000])

    return "\n".join(lines)


@dataclass
class RetrievedChunk:
    chunk_id: str
    source_type: str
    source_id: str
    content_text: str
    score: float
    metadata: dict[str, Any] = field(default_factory=dict)


def search(
    db: DBSession,
    query_text: str,
    top_k: int = 5,
    similarity_floor: float = SIMILARITY_FLOOR,
    tenant_id: str | None = None,
    source_types: list[str] | None = None,
    subsystem: str | None = None,
    http_status: int | None = None,
    include_stale: bool = True,
    max_age_days: int | None = None,
) -> list[RetrievedChunk]:
    """
    Retrieves the most relevant knowledge chunks for `query_text`.

    Filters:
    - tenant_id: strictly enforces tenant isolation. KB, error, and tool chunks
      are shared; history chunks are only returned if their tenant_id matches.
    - source_types: filter to specific sources (e.g. ['kb', 'error', 'tool', 'history']).
    - subsystem: filter to specific subsystem ('api', 'auth', 'actions', etc.).
    - http_status: boosts error chunks with matching HTTP status codes.
    - include_stale / max_age_days: filter out chunks exceeding staleness window.
    """
    query_vec = embed(query_text)
    chunks = db.query(KnowledgeChunk).all()
    now_date = date.today()

    scored: list[RetrievedChunk] = []

    for chunk in chunks:
        meta = chunk.chunk_metadata or {}

        # 1. Multi-tenant isolation: prevent cross-tenant history leakage
        if chunk.source_type == "history":
            chunk_tenant = meta.get("tenant_id")
            if chunk_tenant != "shared":
                if not tenant_id or chunk_tenant != tenant_id:
                    continue

        # 2. Source type filtering
        if source_types and chunk.source_type not in source_types:
            continue

        # 3. Subsystem filtering
        if subsystem and meta.get("subsystem"):
            if meta["subsystem"].lower() != subsystem.lower():
                continue

        # 4. Freshness / staleness filtering
        if not include_stale and max_age_days is not None:
            last_ver = meta.get("last_verified")
            if last_ver:
                try:
                    if isinstance(last_ver, str):
                        ver_date = datetime.strptime(last_ver, "%Y-%m-%d").date()
                    elif isinstance(last_ver, date):
                        ver_date = last_ver
                    else:
                        ver_date = None

                    if ver_date and (now_date - ver_date).days > max_age_days:
                        continue
                except Exception:
                    pass

        # 5. Semantic similarity
        cos_score = cosine_similarity(query_vec, chunk.embedding)
        final_score = cos_score

        # 6. Hybrid boost: matching HTTP status code or message patterns
        if http_status and meta.get("http_status"):
            chunk_statuses = meta["http_status"]
            if isinstance(chunk_statuses, list) and http_status in chunk_statuses:
                final_score += 0.12

        # Check for message pattern match in query
        patterns = meta.get("message_patterns", [])
        if isinstance(patterns, list):
            for pat in patterns:
                if pat and pat.lower() in query_text.lower():
                    final_score += 0.10
                    break

        if final_score >= similarity_floor:
            scored.append(
                RetrievedChunk(
                    chunk_id=chunk.id,
                    source_type=chunk.source_type,
                    source_id=chunk.source_id,
                    content_text=chunk.content_text,
                    score=final_score,
                    metadata=meta,
                )
            )

    scored.sort(key=lambda r: r.score, reverse=True)
    return scored[:top_k]


def format_retrieved_context(retrieved: list[RetrievedChunk]) -> str:
    """
    Formats retrieved chunks into a prompt-ready markdown block.
    Reminds the model of Contract 1 / RAG Guardrail:
    Retrieved knowledge is PRECEDENT, not current evidence.
    """
    if not retrieved:
        return ""

    lines = [
        "### Retrieved Knowledge Precedent",
        "NOTE: Retrieved knowledge is PRECEDENT, not current evidence.",
        "You may cite chunk IDs in 'knowledge_refs' to support your diagnostic reasoning,",
        "but NEVER cite a knowledge reference as an evidence_id, and never assume",
        "evidence exists unless it was directly observed in the current investigation bundle.",
        "",
    ]
    for r in retrieved:
        lines.append(f"#### [{r.chunk_id}] (Source: {r.source_type}, Score: {r.score:.2f})")
        lines.append(r.content_text.strip())
        lines.append("")

    return "\n".join(lines).strip()
