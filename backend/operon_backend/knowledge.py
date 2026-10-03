"""KnowledgeDocument and RAG Ingestion Pipeline — grounded in AGENT_ARCHITECTURE.md,
production-architecture.md, and docs/knowledge-base.

Manages all knowledge base corpora:
1. Curated markdown articles & playbooks (docs/knowledge-base/**/*.md)
2. Machine-readable error intelligence entries (docs/knowledge-base/06-errors/errors.yaml)
3. Tool registry contracts (docs/knowledge-base/07-tools/tool-registry.yaml)
4. Granular chapter sections for deep semantic retrieval
5. Curated demo/scenario documents (SEED_DOCUMENTS)
6. Resolved session history (learning loop) with multi-tenant isolation
"""

import logging
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DBSession

from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.embeddings import embed, embed_batch
from operon_backend.tripwire import redact_credentials

logger = logging.getLogger(__name__)

KB_DIR_DEFAULT = Path(__file__).resolve().parents[2] / "docs" / "knowledge-base"
FRONT_MATTER_RE = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
SECTION_HEADING_RE = re.compile(r"(?m)^## (.+)$")


class KnowledgeDocument(BaseModel):
    """Troubleshooting article or playbook conforming to docs/knowledge-base/00-methodology/article-template.md."""

    doc_id: str
    title: str
    severity: str | None = None
    symptoms: list[str] = Field(default_factory=list)
    causes: list[str] = Field(default_factory=list)
    diagnostic_checks: list[str] = Field(default_factory=list)
    evidence_patterns: list[str] = Field(default_factory=list)
    recommended_actions: list[str] = Field(default_factory=list)
    prerequisites: list[str] = Field(default_factory=list)
    contraindications: list[str] = Field(default_factory=list)
    verification_predicates: list[str] = Field(default_factory=list)
    escalation_conditions: list[str] = Field(default_factory=list)

    # Freshness & provenance metadata per research-methodology.md
    sources: list[str] = Field(default_factory=list)
    last_verified: str | date | None = None

    api_version: str | None = None
    stability: str | None = None
    confidence: str | None = None
    body: str = ""

    def to_embedding_text(self) -> str:
        """What gets embedded: title, symptoms, evidence patterns, causes,
        diagnostic checks, recommended actions, and body content for chapter documents."""
        parts = [self.title]
        if self.symptoms:
            parts.append("Symptoms: " + "; ".join(self.symptoms))
        if self.evidence_patterns:
            parts.append("Evidence patterns: " + "; ".join(self.evidence_patterns))
        if self.causes:
            parts.append("Causes: " + "; ".join(self.causes))
        if self.diagnostic_checks:
            parts.append("Diagnostic checks: " + "; ".join(self.diagnostic_checks))
        if self.recommended_actions:
            parts.append("Recommended actions: " + ", ".join(self.recommended_actions))
        if self.body and not self.symptoms and not self.causes:
            # For chapter-level articles with body text instead of structured playbook fields
            clean_body = re.sub(r"\[src:[a-z0-9\-]+\]", "", self.body).strip()
            parts.append(clean_body[:1200])
        return "\n".join(p for p in parts if p.strip())


class ErrorDocument(BaseModel):
    """Machine-readable error intelligence entry from docs/knowledge-base/06-errors/errors.yaml."""

    error_id: str
    name: str
    message_patterns: list[str] = Field(default_factory=list)
    http_status: list[int] = Field(default_factory=list)
    subsystem: str = "api"
    severity: str = "medium"
    verification_status: str = "verified"
    sources: list[str] = Field(default_factory=list)
    common_causes: list[str] = Field(default_factory=list)
    rare_causes: list[str] = Field(default_factory=list)
    distinguish_from: list[str] = Field(default_factory=list)
    required_evidence: list[str] = Field(default_factory=list)
    diagnostic_steps: list[str] = Field(default_factory=list)
    remediation: list[str] = Field(default_factory=list)
    verification: list[str] = Field(default_factory=list)
    rollback: str = ""
    retry: str = ""
    related_errors: list[str] = Field(default_factory=list)
    github_documentation: list[str] = Field(default_factory=list)
    last_verified: str | date | None = "2026-09-20"
    stability: str = "stable"

    def to_embedding_text(self) -> str:
        parts = [
            f"GitHub Error: {self.name} (ID: {self.error_id})",
            f"Subsystem: {self.subsystem} | Status: {self.http_status} | Severity: {self.severity}",
        ]
        if self.message_patterns:
            parts.append("Message patterns: " + "; ".join(self.message_patterns))
        if self.common_causes:
            parts.append("Common causes: " + "; ".join(self.common_causes))
        if self.distinguish_from:
            parts.append("Distinguish from: " + "; ".join(self.distinguish_from))
        if self.required_evidence:
            parts.append("Required evidence: " + "; ".join(self.required_evidence))
        if self.diagnostic_steps:
            parts.append("Diagnostic steps: " + "; ".join(self.diagnostic_steps))
        if self.remediation:
            parts.append("Remediation: " + "; ".join(self.remediation))
        return "\n".join(parts)


class ToolDocument(BaseModel):
    """Machine-readable tool specification from docs/knowledge-base/07-tools/tool-registry.yaml."""

    name: str
    purpose: str
    endpoint: str = ""
    permissions: dict[str, Any] = Field(default_factory=dict)
    risk_level: str = "read_only"
    failure_modes: list[str] = Field(default_factory=list)
    idempotency_type: str = "idempotent"
    verification: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    notes: str = ""
    last_verified: str | date | None = "2026-09-20"
    stability: str = "stable"

    def to_embedding_text(self) -> str:
        parts = [
            f"GitHub Tool: {self.name}",
            f"Purpose: {self.purpose}",
            f"Endpoint: {self.endpoint}",
            f"Risk level: {self.risk_level}",
        ]
        if self.permissions:
            perms_str = ", ".join(f"{k}:{v}" for k, v in self.permissions.get("required", {}).items())
            parts.append(f"Required permissions: {perms_str}")
        if self.failure_modes:
            parts.append("Failure modes: " + "; ".join(self.failure_modes))
        if self.notes:
            parts.append(f"Notes: {self.notes}")
        return "\n".join(parts)


class SectionChunk(BaseModel):
    """Substantive section unit from chapter markdown files."""

    chunk_id: str
    doc_id: str
    doc_title: str
    heading: str
    content: str
    subsystem: str = "general"
    sources: list[str] = Field(default_factory=list)
    last_verified: str | date | None = "2026-09-20"
    stability: str = "stable"

    def to_embedding_text(self) -> str:
        clean = re.sub(r"\[src:[a-z0-9\-]+\]", "", self.content).strip()
        return f"Document: {self.doc_title}\nSection: {self.heading}\n\n{clean[:1200]}"


# Restructured from docs/plan/github-scenarios.md's two implemented scenarios
SEED_DOCUMENTS: list[KnowledgeDocument] = [
    KnowledgeDocument(
        doc_id="kb_corrupted_cache",
        title="Corrupted cached config in localStorage",
        symptoms=[
            "dashboard looks corrupted or blank",
            "page fails during initialization",
            "UI components that read cached config don't render",
        ],
        causes=[
            "a previous bad deploy or crash left a malformed JSON string in localStorage",
        ],
        diagnostic_checks=[
            "read the storage key and attempt to JSON.parse it",
            "check the browser console for a SyntaxError at page load",
        ],
        evidence_patterns=[
            "console error containing 'SyntaxError' and 'JSON'",
            "storage signal with parse_status == 'syntax_error'",
        ],
        recommended_actions=["clear_storage_key"],
        prerequisites=["the specific corrupted key must be known, not guessed"],
        contraindications=[
            "never clear all storage — only the specific key showing a parse failure",
        ],
        verification_predicates=[
            "the storage key either no longer exists or parses as valid JSON",
            "no SyntaxError appears in the console after reload",
        ],
        escalation_conditions=[
            "the same key becomes corrupted again immediately after clearing (likely a server-side bug, not a client-side cache issue)",
        ],
        sources=["rest-troubleshooting"],
        last_verified="2026-09-20",
        stability="stable",
        confidence="high",
    ),
    KnowledgeDocument(
        doc_id="kb_blocked_by_client",
        title="Browser extension blocking network requests",
        symptoms=[
            "parts of the page never load",
            "some content silently missing with no visible error banner",
        ],
        causes=[
            "an ad blocker or privacy extension the user has installed is cancelling requests to this domain",
        ],
        diagnostic_checks=[
            "inspect network requests for ones that never received a response",
            "check for net::ERR_BLOCKED_BY_CLIENT or a CDP blockedReason",
        ],
        evidence_patterns=[
            "network entry with status == 0 and status_text mentioning 'blocked'",
        ],
        recommended_actions=[],
        prerequisites=[],
        contraindications=[
            "never attempt to disable another browser extension — this is not a capability Operon has",
        ],
        verification_predicates=[
            "the previously blocked request succeeds after the user adjusts their blocker settings",
        ],
        escalation_conditions=[
            "the user reports no ad blocker or privacy extension installed — the block may be server-side (CORS) instead",
        ],
        sources=["rest-troubleshooting"],
        last_verified="2026-09-20",
        stability="stable",
        confidence="high",
    ),
]


def load_markdown_kb_documents(kb_dir: Path | None = None) -> list[KnowledgeDocument]:
    """Loads all markdown articles declaring a doc_id in front matter."""
    kb_path = kb_dir or KB_DIR_DEFAULT
    docs: list[KnowledgeDocument] = []
    doc_fields = set(KnowledgeDocument.model_fields)

    for md in sorted(kb_path.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        m = FRONT_MATTER_RE.match(text)
        if not m:
            continue
        try:
            meta = yaml.safe_load(m.group(1))
        except Exception:
            continue
        if isinstance(meta, dict) and "doc_id" in meta:
            fields = {k: v for k, v in meta.items() if k in doc_fields}
            fields["body"] = text[m.end():]
            docs.append(KnowledgeDocument(**fields))

    return docs


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_").lower()
    return slug[:40]


def extract_markdown_sections(kb_dir: Path | None = None) -> list[SectionChunk]:
    """Extracts granular section units from markdown documents with doc_id."""
    kb_path = kb_dir or KB_DIR_DEFAULT
    sections: list[SectionChunk] = []

    for md in sorted(kb_path.rglob("*.md")):
        text = md.read_text(encoding="utf-8")
        m = FRONT_MATTER_RE.match(text)
        if not m:
            continue
        try:
            meta = yaml.safe_load(m.group(1))
        except Exception:
            continue
        if not isinstance(meta, dict) or "doc_id" not in meta:
            continue

        doc_id = meta["doc_id"]
        doc_title = meta.get("title", md.stem)
        sources = meta.get("sources", [])
        last_verified = meta.get("last_verified", "2026-09-20")

        # Map subsystem from path
        subsystem = "api"
        rel_parts = md.relative_to(kb_path).parts
        if len(rel_parts) > 1:
            first_dir = rel_parts[0]
            if "auth" in first_dir:
                subsystem = "auth"
            elif "actions" in first_dir:
                subsystem = "actions"
            elif "webhooks" in first_dir:
                subsystem = "webhooks"
            elif "tools" in first_dir:
                subsystem = "tools"
            elif "playbooks" in first_dir:
                subsystem = "playbook"

        body = text[m.end():]
        raw_sections = re.split(r"(?m)^## ", body)
        for raw_sec in raw_sections[1:]:
            lines = raw_sec.strip().splitlines()
            if not lines:
                continue
            heading = lines[0].strip()
            content = "\n".join(lines[1:]).strip()
            if len(content) < 40:
                continue

            slug = _slugify(heading)
            sec_chunk = SectionChunk(
                chunk_id=f"kb_{doc_id}_{slug}",
                doc_id=doc_id,
                doc_title=doc_title,
                heading=heading,
                content=content,
                subsystem=subsystem,
                sources=sources,
                last_verified=last_verified,
            )
            sections.append(sec_chunk)

    return sections


def load_error_documents(errors_yaml_path: Path | None = None) -> list[ErrorDocument]:
    """Loads all machine-readable error intelligence entries from errors.yaml."""
    yaml_file = errors_yaml_path or (KB_DIR_DEFAULT / "06-errors" / "errors.yaml")
    if not yaml_file.exists():
        return []

    data = yaml.safe_load(yaml_file.read_text(encoding="utf-8"))
    errors_raw = data.get("errors", []) if isinstance(data, dict) else []
    error_docs: list[ErrorDocument] = []

    for item in errors_raw:
        if not isinstance(item, dict) or "id" not in item:
            continue
        doc = ErrorDocument(
            error_id=item["id"],
            name=item.get("name", item["id"]),
            message_patterns=item.get("message_patterns", []),
            http_status=item.get("http_status", []),
            subsystem=item.get("subsystem", "api"),
            severity=item.get("severity", "medium"),
            verification_status=item.get("verification_status", "verified"),
            sources=item.get("sources", []),
            common_causes=item.get("common_causes", []),
            rare_causes=item.get("rare_causes", []),
            distinguish_from=item.get("distinguish_from", []),
            required_evidence=item.get("required_evidence", []),
            diagnostic_steps=item.get("diagnostic_steps", []),
            remediation=item.get("remediation", []),
            verification=item.get("verification", []),
            rollback=str(item.get("rollback", "")),
            retry=str(item.get("retry", "")),
            related_errors=item.get("related_errors", []),
            github_documentation=item.get("github_documentation", []),
            last_verified="2026-09-20",
        )
        error_docs.append(doc)

    return error_docs


def load_tool_documents(tool_registry_path: Path | None = None) -> list[ToolDocument]:
    """Loads all machine-readable tool contracts from tool-registry.yaml."""
    yaml_file = tool_registry_path or (KB_DIR_DEFAULT / "07-tools" / "tool-registry.yaml")
    if not yaml_file.exists():
        return []

    data = yaml.safe_load(yaml_file.read_text(encoding="utf-8"))
    tools_raw = data.get("tools", []) if isinstance(data, dict) else []
    tool_docs: list[ToolDocument] = []

    for item in tools_raw:
        if not isinstance(item, dict) or "name" not in item:
            continue
        risk_dict = item.get("risk", {})
        risk_level = risk_dict.get("level", "read_only") if isinstance(risk_dict, dict) else "read_only"
        idem_dict = item.get("idempotency", {})
        idem_type = idem_dict.get("type", "idempotent") if isinstance(idem_dict, dict) else "idempotent"

        doc = ToolDocument(
            name=item["name"],
            purpose=item.get("purpose", ""),
            endpoint=item.get("endpoint", ""),
            permissions=item.get("permissions", {}),
            risk_level=risk_level,
            failure_modes=item.get("failure_modes", []),
            idempotency_type=idem_type,
            verification=item.get("verification", []),
            sources=item.get("sources", []),
            notes=item.get("notes", ""),
            last_verified="2026-09-20",
        )
        tool_docs.append(doc)

    return tool_docs


def _sanitize_meta_for_json(obj: Any) -> Any:
    """Recursively converts dates, paths, and non-primitive objects to JSON-serializable types."""
    if isinstance(obj, dict):
        return {k: _sanitize_meta_for_json(v) for k, v in obj.items()}
    elif isinstance(obj, (list, tuple)):
        return [_sanitize_meta_for_json(x) for x in obj]
    elif isinstance(obj, (date, datetime)):
        return obj.isoformat()
    elif isinstance(obj, Path):
        return str(obj)
    return obj


def ingest_all_knowledge(
    db: DBSession,
    kb_dir: Path | None = None,
    force_reembed: bool = False,
) -> dict[str, int]:
    """
    Ingests all knowledge sources into the knowledge_chunks table:
    1. Curated seed documents
    2. Markdown documents and playbooks
    3. Markdown chapter sections
    4. Error intelligence definitions (errors.yaml)
    5. Tool registry specifications (tool-registry.yaml)

    Performs batch embedding for high efficiency and idempotent upsert.
    """
    kb_path = kb_dir or KB_DIR_DEFAULT
    stats = {
        "seed_documents": 0,
        "kb_documents": 0,
        "sections": 0,
        "errors": 0,
        "tools": 0,
        "total_chunks": 0,
    }

    # Collect all items to index
    # Tuple: (chunk_id, source_type, source_id, content_text, metadata)
    raw_units: list[tuple[str, str, str, str, dict[str, Any]]] = []

    # 1. Seed documents
    for doc in SEED_DOCUMENTS:
        chunk_id = f"kb_{doc.doc_id}"
        meta = doc.model_dump()
        meta["tenant_id"] = "shared"
        raw_units.append((chunk_id, "kb", doc.doc_id, doc.to_embedding_text(), _sanitize_meta_for_json(meta)))
        stats["seed_documents"] += 1

    # 2. Markdown articles & playbooks
    md_docs = load_markdown_kb_documents(kb_path)
    for doc in md_docs:
        chunk_id = f"kb_{doc.doc_id}"
        meta = doc.model_dump()
        meta.pop("body", None)
        meta["tenant_id"] = "shared"
        raw_units.append((chunk_id, "kb", doc.doc_id, doc.to_embedding_text(), _sanitize_meta_for_json(meta)))
        stats["kb_documents"] += 1

    # 3. Chapter sections
    sections = extract_markdown_sections(kb_path)
    for sec in sections:
        meta = sec.model_dump()
        meta["tenant_id"] = "shared"
        raw_units.append((sec.chunk_id, "kb_section", f"{sec.doc_id}#{sec.heading}", sec.to_embedding_text(), _sanitize_meta_for_json(meta)))
        stats["sections"] += 1

    # 4. Error intelligence (errors.yaml)
    errors = load_error_documents(kb_path / "06-errors" / "errors.yaml")
    for err in errors:
        chunk_id = f"err_{err.error_id}"
        meta = err.model_dump()
        meta["tenant_id"] = "shared"
        raw_units.append((chunk_id, "error", err.error_id, err.to_embedding_text(), _sanitize_meta_for_json(meta)))
        stats["errors"] += 1

    # 5. Tool registry (tool-registry.yaml)
    tools = load_tool_documents(kb_path / "07-tools" / "tool-registry.yaml")
    for tool in tools:
        chunk_id = f"tool_{tool.name}"
        meta = tool.model_dump()
        meta["tenant_id"] = "shared"
        raw_units.append((chunk_id, "tool", tool.name, tool.to_embedding_text(), _sanitize_meta_for_json(meta)))
        stats["tools"] += 1


    # Fetch existing chunks to identify which ones need embedding
    existing_chunks = {c.id: c for c in db.query(KnowledgeChunk).all()}

    units_to_embed: list[tuple[str, str, str, str, dict[str, Any]]] = []
    for chunk_id, source_type, source_id, text, meta in raw_units:
        existing = existing_chunks.get(chunk_id)
        if not force_reembed and existing and existing.content_text == text:
            # Metadata might have updated even if content unchanged
            existing.chunk_metadata = meta
            existing.source_type = source_type
            existing.source_id = source_id
        else:
            units_to_embed.append((chunk_id, source_type, source_id, text, meta))

    # Batch embed the ones that need vectors
    if units_to_embed:
        texts = [u[3] for u in units_to_embed]
        vectors = embed_batch(texts)
        for (chunk_id, source_type, source_id, text, meta), vec in zip(units_to_embed, vectors, strict=True):
            existing = existing_chunks.get(chunk_id)
            if existing:
                existing.content_text = text
                existing.embedding = vec
                existing.chunk_metadata = meta
                existing.source_type = source_type
                existing.source_id = source_id
            else:
                db.add(
                    KnowledgeChunk(
                        id=chunk_id,
                        source_type=source_type,
                        source_id=source_id,
                        content_text=text,
                        embedding=vec,
                        chunk_metadata=meta,
                    )
                )

    db.commit()
    stats["total_chunks"] = len(raw_units)
    return stats


def record_resolved_session_to_kb(
    db: DBSession,
    session: SessionRecord,
    tenant_id: str | None = None,
) -> str | None:
    """
    Ingestion hook: embeds a resolved or escalated session as historical precedent.
    Enforces that payload passes tripwire check before embedding, per production-architecture.md.
    Assigns tenant_id to enforce multi-tenant isolation, per agent-safety-and-execution.md §12.
    """
    resolved_phases = {"RESOLVED", "ESCALATED"}
    if session.phase not in resolved_phases and not session.resolution_state:
        return None

    # Summarize outcome
    lines = [
        f"Resolved Support Session (ID: {session.id})",
        f"Tenant ID: {tenant_id or 'shared'}",
        f"User issue: {session.user_issue}",
        f"Issue category: {session.issue_category or 'unknown'}",
        f"Resolution state: {session.resolution_state or session.phase}",
    ]
    if session.hypotheses:
        lead_hypo = session.hypotheses[0]
        desc = lead_hypo.get("description", "")
        lines.append(f"Root cause hypothesis: {desc}")

    if session.pending_action:
        act_id = session.pending_action.get("action_id", "")
        lines.append(f"Action executed: {act_id}")

    if session.verification_state:
        passed = session.verification_state.get("passed", False)
        lines.append(f"Verification outcome: {'PASSED' if passed else 'FAILED'}")

    content_text = "\n".join(lines)

    # Never embed a credential — but never let a credential-shaped string
    # (or a false positive) stop a session from finishing either: redact it.
    content_text, redactions = redact_credentials(content_text)
    if redactions:
        logger.warning("Redacted credential-shaped value(s) from session history: %s", ", ".join(redactions))

    chunk_id = f"hist_{session.id}"
    # Best-effort: the learning loop is an add-on to a finished session, so an
    # unavailable embedding model skips it instead of failing the request.
    try:
        vec = embed(content_text)
    except Exception as exc:  # noqa: BLE001 — any embedder/store failure (network, ONNX, OS, DB)
        logger.warning("Skipped saving session %s to the knowledge base: embedding failed (%s)", session.id, type(exc).__name__)
        return None
    metadata = {
        "tenant_id": tenant_id or "shared",
        "session_id": session.id,
        "issue_category": session.issue_category,
        "resolution_state": session.resolution_state,
        "confidence": session.confidence,
        "phase": session.phase,
    }

    existing = db.get(KnowledgeChunk, chunk_id)
    safe_metadata = _sanitize_meta_for_json(metadata)
    if existing:
        existing.content_text = content_text
        existing.embedding = vec
        existing.chunk_metadata = safe_metadata
    else:
        db.add(
            KnowledgeChunk(
                id=chunk_id,
                source_type="history",
                source_id=session.id,
                content_text=content_text,
                embedding=vec,
                chunk_metadata=safe_metadata,
            )
        )

    db.commit()
    return chunk_id
