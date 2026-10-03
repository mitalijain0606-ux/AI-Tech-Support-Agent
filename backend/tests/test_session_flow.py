import logging

from starlette.testclient import TestClient

from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.embeddings import embed
from operon_backend.knowledge import SEED_DOCUMENTS
from operon_backend.main import app

client = TestClient(app)


def _create_session(user_issue: str) -> str:
    res = client.post("/api/sessions", json={"user_issue": user_issue})
    assert res.status_code == 200
    return res.json()["session_id"]


def _ensure_kb_seeded() -> None:
    """Idempotent — safe even if test_retrieval.py already seeded these
    into the same shared test database this run."""
    db = SessionLocal()
    try:
        for doc in SEED_DOCUMENTS:
            chunk_id = f"kb_{doc.doc_id}"
            if db.get(KnowledgeChunk, chunk_id):
                continue
            content = doc.to_embedding_text()
            db.add(
                KnowledgeChunk(
                    id=chunk_id,
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


def test_require_approval_path_reaches_resolved():
    """clear_storage_key is REQUIRE_APPROVAL — the session must pass through
    WAITING_FOR_APPROVAL and an explicit /approve call, never skip it."""
    settings.groq_api_key = ""  # deterministic rule-based diagnosis
    session_id = _create_session("my dashboard looks corrupted")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "console": [{"id": "ev_001", "level": "error", "text": "SyntaxError: Unexpected token in JSON"}],
        "storage": [
            {
                "id": "ev_002",
                "key": "operon_demo_cache",
                "present": True,
                "parse_status": "syntax_error",
                "error_message": "Unexpected token",
            }
        ],
    }

    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.status_code == 200
    body = res.json()
    assert body["session"]["phase"] == "ACTION_PROPOSED"
    assert body["diagnosis"]["proposed_action"]["action_id"] == "clear_storage_key"
    assert len(body["session"]["hypotheses"]) == 1
    assert body["session"]["hypotheses"][0]["status"] == "confirmed"

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={
            "action_id": "clear_storage_key",
            "params": {"key": "operon_demo_cache"},
            "provider_capabilities": ["inspect_page", "reload", "clear_storage_key"],
        },
    )
    assert res.status_code == 200
    assert res.json()["policy"]["decision"] == "REQUIRE_APPROVAL"
    assert res.json()["session"]["phase"] == "WAITING_FOR_APPROVAL"

    res = client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    assert res.status_code == 200
    assert res.json()["phase"] == "EXECUTING"

    res = client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "key removed"})
    assert res.status_code == 200
    assert res.json()["phase"] == "VERIFYING"

    res = client.post(f"/api/sessions/{session_id}/verify", json={"passed": True, "message": "no more SyntaxError"})
    assert res.status_code == 200
    final = res.json()
    assert final["phase"] == "RESOLVED"
    assert final["resolution_state"] == "resolved"

    phases = [entry["to"] for entry in final["phase_history"]]
    assert phases == [
        "KNOWLEDGE_LOOKUP",
        "INVESTIGATING",
        "HYPOTHESIS_FORMED",
        "DIAGNOSING",
        "ACTION_PROPOSED",
        "WAITING_FOR_APPROVAL",
        "EXECUTING",
        "VERIFYING",
        "RESOLVED",
    ]


def test_allow_decision_skips_approval():
    """`reload` is an ALLOW action — the session must go straight from
    ACTION_PROPOSED to EXECUTING, never through WAITING_FOR_APPROVAL."""
    settings.groq_api_key = ""
    session_id = _create_session("something threw an error")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "console": [{"id": "ev_001", "level": "error", "text": "TypeError: cannot read x of undefined"}],
    }
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.json()["diagnosis"]["proposed_action"]["action_id"] == "reload"

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "reload", "params": {"ignore_cache": True}, "provider_capabilities": ["reload"]},
    )
    assert res.json()["policy"]["decision"] == "ALLOW"
    assert res.json()["session"]["phase"] == "EXECUTING"


def test_no_proposed_action_escalates_immediately():
    """An evidence-backed diagnosis with no safe action (a server-side 500)
    escalates. (An empty bundle is insufficient_evidence and keeps
    investigating instead — see test_loop_driver.py.)"""
    settings.groq_api_key = ""
    session_id = _create_session("nothing seems wrong but users are complaining")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "network": [{"id": "ev_001", "method": "GET", "url": "https://github.com/api/x", "status": 500}],
    }
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    body = res.json()
    assert body["diagnosis"]["proposed_action"] is None
    assert body["session"]["phase"] == "ESCALATED"
    assert body["session"]["resolution_state"] == "escalated_no_action_available"


def test_policy_deny_escalates():
    """A capability the provider doesn't declare must DENY — and the
    session must reflect that as an escalation, not silently stall."""
    settings.groq_api_key = ""
    session_id = _create_session("my dashboard looks corrupted")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "storage": [
            {"id": "ev_001", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}
        ],
    }
    client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})

    res = client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}, "provider_capabilities": ["reload"]},
    )
    assert res.json()["policy"]["decision"] == "DENY"
    assert res.json()["session"]["phase"] == "ESCALATED"
    assert res.json()["session"]["resolution_state"] == "escalated_policy_denied"


def test_operation_out_of_phase_returns_409_not_a_silent_no_op():
    settings.groq_api_key = ""
    session_id = _create_session("test")

    # Approving before a diagnosis/policy step has even run must be rejected,
    # not silently accepted — the session is still in UNDERSTANDING.
    res = client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    assert res.status_code == 409


def test_unknown_session_returns_404():
    res = client.get("/api/sessions/does-not-exist")
    assert res.status_code == 404


def _knowledge_lookup_reason(session_body: dict) -> str:
    entry = next(t for t in session_body["phase_history"] if t["to"] == "KNOWLEDGE_LOOKUP")
    return entry["reason"]


def test_corrupted_cache_session_retrieves_its_kb_doc():
    """The AGENT_ARCHITECTURE.md Phase 2 gate, through the real endpoint:
    retrieval runs regardless of which diagnose() path (LLM or rule-based)
    is active, so this stays deterministic without needing a live Groq call."""
    settings.groq_api_key = ""
    _ensure_kb_seeded()
    session_id = _create_session("my dashboard looks corrupted")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "console": [{"id": "ev_001", "level": "error", "text": "SyntaxError: Unexpected token in JSON"}],
        "storage": [
            {
                "id": "ev_002",
                "key": "operon_demo_cache",
                "present": True,
                "parse_status": "syntax_error",
                "error_message": "Unexpected token",
            }
        ],
    }
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.status_code == 200
    assert "kb_kb_corrupted_cache" in _knowledge_lookup_reason(res.json()["session"])


def test_ad_blocker_session_retrieves_its_kb_doc():
    settings.groq_api_key = ""
    _ensure_kb_seeded()
    session_id = _create_session("some content on the page never loaded")

    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "network": [
            {
                "id": "ev_001",
                "method": "GET",
                "url": "https://collector.github.com/telemetry",
                "status": 0,
                "status_text": "net::ERR_BLOCKED_BY_CLIENT",
            }
        ],
    }
    res = client.post(f"/api/sessions/{session_id}/diagnose", json={"bundle": bundle})
    assert res.status_code == 200
    assert "kb_kb_blocked_by_client" in _knowledge_lookup_reason(res.json()["session"])


# ---- P0 regressions: credentials / commit SHAs in user_issue, embedding failure ----

TOKEN = "ghp_abcdefghijklmnop1234567890"
SHA1 = "0123456789abcdef0123456789abcdef01234567"
SERVER_ERROR_BUNDLE = {
    "url": "https://github.com",
    "timestamp": 1726000000.0,
    "network": [{"id": "ev_001", "method": "GET", "url": "https://github.com/api/x", "status": 500}],
}


def _fake_embed(_text: str) -> list[float]:
    return [1.0] * 384


def test_credential_in_user_issue_is_redacted_before_db_llm_and_logs(monkeypatch, caplog):
    settings.groq_api_key = ""
    seen_by_llm: list[str] = []

    from operon_backend import main as main_module

    real_diagnose = main_module.diagnose

    async def spy_diagnose(message, bundle, knowledge_context=None):
        seen_by_llm.append(message)
        return await real_diagnose(message, bundle, knowledge_context)

    monkeypatch.setattr("operon_backend.main.diagnose", spy_diagnose)
    monkeypatch.setattr("operon_backend.knowledge.embed", _fake_embed)

    with caplog.at_level(logging.DEBUG):
        res = client.post("/api/sessions", json={"user_issue": f"page broken, my header is Bearer {TOKEN}"})
        assert res.status_code == 200
        session_id = res.json()["session_id"]
        assert TOKEN not in res.json()["user_issue"]
        assert "[REDACTED:bearer_token]" in res.json()["user_issue"]

        res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": SERVER_ERROR_BUNDLE})
        assert res.status_code == 200
        assert res.json()["session"]["phase"] == "ESCALATED"

    assert seen_by_llm and all(TOKEN not in m for m in seen_by_llm)
    assert TOKEN not in caplog.text

    db = SessionLocal()
    try:
        record = db.get(SessionRecord, session_id)
        assert TOKEN not in record.user_issue
        assert TOKEN not in str(record.conversation_history)
        assert record.conversation_history[0]["redaction_applied"] == ["bearer_token"]
        chunk = db.get(KnowledgeChunk, f"hist_{session_id}")
        assert chunk is not None and TOKEN not in chunk.content_text
    finally:
        db.close()


def test_commit_sha_in_user_issue_reaches_a_terminal_state_and_is_kept(monkeypatch):
    """Regression: a commit SHA in the user's message used to make the
    knowledge-base save raise TripwireHit -> HTTP 500, session stuck."""
    settings.groq_api_key = ""
    monkeypatch.setattr("operon_backend.knowledge.embed", _fake_embed)

    issue = f"dashboard broken since commit {SHA1}"
    res = client.post("/api/sessions", json={"user_issue": issue})
    assert res.json()["user_issue"] == issue  # not redacted
    session_id = res.json()["session_id"]

    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": SERVER_ERROR_BUNDLE})
    assert res.status_code == 200
    assert res.json()["session"]["phase"] == "ESCALATED"

    db = SessionLocal()
    try:
        chunk = db.get(KnowledgeChunk, f"hist_{session_id}")
        assert chunk is not None and SHA1 in chunk.content_text
    finally:
        db.close()


def test_secret_shaped_hex_in_history_is_redacted_not_fatal(monkeypatch):
    """Even if a credential-shaped value reaches the history text by another
    route (e.g. an LLM root cause echoing it), saving redacts instead of raising."""
    from operon_backend.knowledge import record_resolved_session_to_kb
    from operon_backend.session_service import create_session

    monkeypatch.setattr("operon_backend.knowledge.embed", _fake_embed)
    db = SessionLocal()
    try:
        session = create_session(db, "something broke")
        session.phase = "ESCALATED"
        session.hypotheses = [{"hypothesis_id": "hyp_x", "description": f"key {SHA1} leaked"}]
        chunk_id = record_resolved_session_to_kb(db, session)
        chunk = db.get(KnowledgeChunk, chunk_id)
        assert SHA1 not in chunk.content_text
        assert "[REDACTED:long_hex_secret]" in chunk.content_text
    finally:
        db.close()


def test_investigate_continues_without_retrieval_when_search_fails(monkeypatch):
    """Regression: an unavailable embedding model made /investigate return an
    unhandled 500. Retrieval is precedent, not evidence, so it continues."""
    settings.groq_api_key = ""

    def broken_search(*args, **kwargs):
        raise RuntimeError("embedding model unavailable")

    monkeypatch.setattr("operon_backend.main.search", broken_search)
    session_id = _create_session("my dashboard looks corrupted")
    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "storage": [{"id": "ev_001", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}],
    }
    res = client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": bundle})
    assert res.status_code == 200
    body = res.json()
    assert body["session"]["phase"] == "ACTION_PROPOSED"
    assert "knowledge search unavailable (RuntimeError)" in _knowledge_lookup_reason(body["session"])
    assert body["session"]["knowledge_references"] == []


def test_session_still_resolves_when_saving_history_cannot_embed(monkeypatch):
    settings.groq_api_key = ""

    def broken_embed(_text):
        raise RuntimeError("embedding model unavailable")

    monkeypatch.setattr("operon_backend.main.search", lambda *a, **k: [])
    monkeypatch.setattr("operon_backend.knowledge.embed", broken_embed)
    session_id = _create_session("my dashboard looks corrupted")
    bundle = {
        "url": "https://github.com",
        "timestamp": 1726000000.0,
        "storage": [{"id": "ev_001", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}],
    }
    client.post(f"/api/sessions/{session_id}/investigate", json={"bundle": bundle})
    client.post(
        f"/api/sessions/{session_id}/policy",
        json={"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}, "provider_capabilities": ["clear_storage_key"]},
    )
    client.post(f"/api/sessions/{session_id}/approve", json={"approved": True})
    client.post(f"/api/sessions/{session_id}/action-result", json={"succeeded": True, "detail": "cleared"})
    res = client.post(f"/api/sessions/{session_id}/verify", json={"passed": True, "message": "clean"})
    assert res.status_code == 200
    assert res.json()["phase"] == "RESOLVED"
