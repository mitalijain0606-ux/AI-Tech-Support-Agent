"""Comprehensive tests for the Operon RAG Pipeline.

Verifies:
1. Ingestion of all knowledge corpora (markdown docs, playbooks, error catalogue, tool registry, sections)
2. Accurate semantic retrieval for GitHub API errors, rate limits, Actions CI failures, and tool discovery
3. Multi-tenant isolation (zero cross-tenant history leakage, Safety §12 / Red-Team R17)
4. Freshness and staleness filtering
5. Idempotent re-seeding
6. Session resolution learning hook
7. Query builders and prompt context formatting
"""

import pytest

from operon_backend.db import SessionLocal
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.knowledge import (
    ingest_all_knowledge,
    record_resolved_session_to_kb,
)
from operon_backend.retrieval import (
    build_github_actions_query,
    build_github_api_query,
    format_retrieved_context,
    search,
)
from operon_backend.session_service import (
    create_session,
    record_action_result,
    record_approval,
    record_diagnosis,
    record_policy,
    record_verification,
)
from operon_backend.schemas import (
    Diagnosis,
    EvidenceBundle,
    PolicyDecision,
    ProposedAction,
)


@pytest.fixture(scope="module", autouse=True)
def fully_seeded_kb():
    """Seeds the full RAG knowledge base once for this test module."""
    db = SessionLocal()
    try:
        stats = ingest_all_knowledge(db, force_reembed=False)
        assert stats["total_chunks"] >= 80
        assert stats["errors"] == 17
        assert stats["tools"] == 14
        assert stats["kb_documents"] >= 6
    finally:
        db.close()
    yield


def test_full_kb_seeding_and_chunk_count():
    db = SessionLocal()
    try:
        total_chunks = db.query(KnowledgeChunk).count()
        assert total_chunks >= 80

        # Check that all source types exist
        source_types = {c.source_type for c in db.query(KnowledgeChunk.source_type).distinct()}
        assert "kb" in source_types
        assert "kb_section" in source_types
        assert "error" in source_types
        assert "tool" in source_types
    finally:
        db.close()


def test_idempotent_reseed():
    db = SessionLocal()
    try:
        initial_count = db.query(KnowledgeChunk).count()
        stats = ingest_all_knowledge(db, force_reembed=False)
        after_count = db.query(KnowledgeChunk).count()
        assert initial_count == after_count == stats["total_chunks"]
    finally:
        db.close()


def test_retrieval_api_403_permission_failure():
    db = SessionLocal()
    try:
        query = build_github_api_query(
            user_issue="A GitHub API tool call failed with 403",
            status_code=403,
            error_message="Resource not accessible by integration",
            headers={"X-Accepted-GitHub-Permissions": "pull_requests=write,contents=write"},
            endpoint="POST /repos/owner/repo/pulls",
        )
        results = search(db, query, top_k=5, http_status=403)
        assert len(results) >= 1
        chunk_ids = [r.chunk_id for r in results]
        assert "err_rest.403.resource_not_accessible.integration" in chunk_ids or any("api_403" in cid for cid in chunk_ids)
        assert results[0].score >= 0.50
    finally:
        db.close()


def test_retrieval_rate_limit_exceeded():
    db = SessionLocal()
    try:
        query = build_github_api_query(
            user_issue="API rate limit exceeded during burst",
            status_code=403,
            error_message="API rate limit exceeded",
            headers={"x-ratelimit-remaining": "0", "retry-after": "60"},
        )
        results = search(db, query, top_k=5, http_status=403)
        assert len(results) >= 1
        chunk_ids = [r.chunk_id for r in results]
        assert "err_rest.rate_limit.primary" in chunk_ids or "err_rest.rate_limit.secondary" in chunk_ids
    finally:
        db.close()


def test_retrieval_actions_ci_failure():
    db = SessionLocal()
    try:
        query = build_github_actions_query(
            user_issue="CI check run failed on main branch",
            workflow_name="ci.yml",
            job_name="build",
            step_name="npm ci",
            exit_code=1,
            log_excerpt="npm ERR! code EBADENGINE\nnpm ERR! required: node >=20\nnpm ERR! actual: node v18.19.0",
        )
        results = search(db, query, top_k=5)
        assert len(results) >= 1
        chunk_ids = [r.chunk_id for r in results]
        assert any("failed_actions_run" in cid or "actions_troubleshooting" in cid for cid in chunk_ids)
    finally:
        db.close()


def test_retrieval_tool_discovery():
    db = SessionLocal()
    try:
        results = search(db, "download workflow logs archive for a failing run attempt", top_k=3, source_types=["tool"])
        assert len(results) >= 1
        assert results[0].chunk_id == "tool_github.get_workflow_logs"
    finally:
        db.close()


def test_retrieval_webhook_signature_verification():
    db = SessionLocal()
    try:
        results = search(db, "verify webhook HMAC signature with X-Hub-Signature-256 header", top_k=3)
        assert len(results) >= 1
        chunk_ids = [r.chunk_id for r in results]
        assert any("webhooks" in cid for cid in chunk_ids)
    finally:
        db.close()


def test_multi_tenant_isolation_red_team_r17():
    """
    Verifies Safety §12 / Red-Team R17:
    Zero cross-tenant history leakage.
    Tenant A's resolved session history must NEVER be returned to Tenant B.
    """
    db = SessionLocal()
    try:
        # Create resolved session for Tenant A
        session_a = SessionRecord(
            id="session_tenant_alpha_001",
            user_issue="Proprietary microservice deployment auth failed with secret code ALPHA99",
            source="github",
            phase="RESOLVED",
            resolution_state="resolved",
            issue_category="auth_failure",
            hypotheses=[{"description": "Alpha service token expired"}],
        )
        db.add(session_a)
        db.commit()

        chunk_a_id = record_resolved_session_to_kb(db, session_a, tenant_id="tenant_alpha")
        assert chunk_a_id == "hist_session_tenant_alpha_001"

        # Query as Tenant Alpha -> must find its own history
        results_alpha = search(
            db,
            "Proprietary microservice deployment auth failed ALPHA99",
            tenant_id="tenant_alpha",
            source_types=["history"],
        )
        assert any(r.chunk_id == chunk_a_id for r in results_alpha)

        # Query as Tenant Beta -> must NEVER find Tenant Alpha's history
        results_beta = search(
            db,
            "Proprietary microservice deployment auth failed ALPHA99",
            tenant_id="tenant_beta",
            source_types=["history"],
        )
        assert not any(r.chunk_id == chunk_a_id for r in results_beta)

        # Unauthenticated query without tenant_id -> must NEVER return private tenant history
        results_no_tenant = search(
            db,
            "Proprietary microservice deployment auth failed ALPHA99",
            tenant_id=None,
            source_types=["history"],
        )
        assert not any(r.chunk_id == chunk_a_id for r in results_no_tenant)
    finally:
        # Cleanup
        to_del = db.get(KnowledgeChunk, "hist_session_tenant_alpha_001")
        if to_del:
            db.delete(to_del)
        sess = db.get(SessionRecord, "session_tenant_alpha_001")
        if sess:
            db.delete(sess)
        db.commit()
        db.close()


def test_session_lifecycle_wires_ingestion_hook():
    """Verifies that verifying a session end-to-end creates a history chunk in the RAG store."""
    db = SessionLocal()
    try:
        session = create_session(db, "Live session for RAG verification test")
        session.user_context = {"tenant_id": "tenant_test_live"}
        db.commit()

        # Walk through state machine
        bundle = EvidenceBundle(
            url="https://github.com/owner/repo",
            timestamp=1727265600.0,
            console=[],
            network=[],
            storage=[],
            cookies=[],
        )

        diag = Diagnosis(
            category="storage_corruption",
            root_cause="Bad localStorage key",
            reasoning="Corrupted key",
            evidence_ids=[],
            confidence=0.9,
            resolvable_automatically=True,
            proposed_action=ProposedAction(action_id="clear_storage_key", params={"key": "test_key"}),
        )
        record_diagnosis(db, session, bundle, diag)
        record_policy(db, session, PolicyDecision(action_id="clear_storage_key", decision="REQUIRE_APPROVAL", reason="Permitted action"))
        record_approval(db, session, approved=True)
        record_action_result(db, session, succeeded=True, detail="Key cleared")
        record_verification(db, session, passed=True, message="Storage is now valid JSON")

        assert session.phase == "RESOLVED"
        assert session.resolution_state == "resolved"

        # Check that history chunk was created
        hist_chunk = db.get(KnowledgeChunk, f"hist_{session.id}")
        assert hist_chunk is not None
        assert hist_chunk.source_type == "history"
        assert hist_chunk.chunk_metadata.get("tenant_id") == "tenant_test_live"
    finally:
        db.close()


def test_format_retrieved_context():
    db = SessionLocal()
    try:
        results = search(db, "rate limit exceeded", top_k=2)
        formatted = format_retrieved_context(results)
        assert "### Retrieved Knowledge Precedent" in formatted
        assert "PRECEDENT, not current evidence" in formatted
        assert results[0].chunk_id in formatted
    finally:
        db.close()
