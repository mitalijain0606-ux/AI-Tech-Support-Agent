"""Evidence model: requests, ingestion validation, provenance, budget,
evidence window, and the deterministic understanding stage."""

from flow_helpers import CAPABILITIES, corrupt_storage, new_session, submit
from starlette.testclient import TestClient

from operon_backend.db import SessionLocal
from operon_backend.evidence import (
    COLLECTOR_POLICY_ACTION,
    KIND_CAPS,
    build_request,
    evidence_window,
    understand,
)
from operon_backend.loop_driver import MAX_EVIDENCE_ITEMS
from operon_backend.main import app
from operon_backend.schemas import COLLECTORS, EvidenceBundle
from operon_backend.session_service import create_session

client = TestClient(app)


def test_every_collector_is_policy_gated():
    assert set(COLLECTOR_POLICY_ACTION) == set(COLLECTORS)


def test_initial_request_is_issued_at_creation_and_recorded():
    s = new_session(client)
    req = s["evidence_request"]
    assert req["purpose"] == "initial"
    assert req["collectors"] == ["console", "network", "storage", "cookies", "page"]
    assert s["tool_call_count"] == len(req["collectors"])
    assert [a["kind"] for a in s["activity"]] == ["session_created", "evidence_requested"]


def test_request_drops_collectors_the_provider_cannot_run():
    s = new_session(client, collectors=["console", "storage"])
    assert s["evidence_request"]["collectors"] == ["console", "storage"]

    # Policy-gated: without network_requests capability, 'network' is refused.
    s2 = new_session(client, capabilities=["console_errors", "inspect_page"])
    assert "network" not in s2["evidence_request"]["collectors"]
    refused = s2["activity"][-1]["data"]["refused"]
    assert any(r.startswith("network:") for r in refused)


def test_provider_that_can_collect_nothing_escalates_immediately():
    s = new_session(client, capabilities=["clear_storage_key"])
    assert s["phase"] == "ESCALATED"
    assert s["resolution_state"] == "escalated_requested_evidence_unavailable"


def test_request_params_are_bounded():
    db = SessionLocal()
    try:
        session = create_session(db, "x", provider_capabilities=CAPABILITIES)
        req, _ = build_request(
            session, purpose="information", collectors=["storage", "page", "bogus"],
            params={"storage_keys": [f"k{i}" for i in range(50)], "selector": "x" * 999, "observe_ms": 99999},
            reason="r" * 2000, requires_user_action=False,
        )
        assert req.collectors == ["storage", "page"]
        assert len(req.params.storage_keys) == 10
        assert len(req.params.selector) == 200
        assert req.params.observe_ms == 8000
        assert len(req.reason) == 500
    finally:
        db.close()


def test_bundle_provenance_is_recorded():
    s = new_session(client)
    body = submit(client, s, storage=[corrupt_storage()], collectors=["storage"], bundle_id="bun_test1").json()
    [record] = body["session"]["evidence_bundles"]
    assert record["bundle_id"] == "bun_test1"
    assert record["request_id"] == s["evidence_request"]["request_id"]
    assert record["purpose"] == "initial" and record["cycle"] == 1 and record["after_attempt"] == 0
    assert record["item_count"] == 1


def test_bundle_for_a_different_request_is_rejected_without_side_effects():
    s = new_session(client)
    res = client.post(
        f"/api/sessions/{s['session_id']}/investigate",
        json={"bundle": {"url": "u", "timestamp": 1, "request_id": "req_forged"}},
    )
    assert res.status_code == 409
    after = client.get(f"/api/sessions/{s['session_id']}").json()
    assert after["evidence_bundles"] == [] and after["investigation_cycle"] == 0 and after["phase"] == "UNDERSTANDING"


def test_duplicate_evidence_ids_within_a_bundle_are_rejected():
    s = new_session(client)
    dup = submit(client, s, console=[{"id": "ev_001", "text": "a"}, {"id": "ev_001", "text": "b"}])
    assert dup.status_code == 422
    assert "Duplicate evidence ids" in dup.json()["detail"]


def test_evidence_ids_must_be_unique_across_the_session():
    s = new_session(client)
    first = submit(client, s, console=[{"id": "ev_001", "level": "warn", "text": "a warning"}]).json()
    assert first["session"]["phase"] == "NEED_INFORMATION"
    res = submit(client, first["session"], console=[{"id": "ev_001", "level": "warn", "text": "another"}])
    assert res.status_code == 409
    assert "already used" in res.json()["detail"]


def test_malformed_evidence_id_is_rejected():
    s = new_session(client)
    res = submit(client, s, console=[{"id": "<script>", "text": "x"}])
    assert res.status_code == 422


def test_per_kind_caps_are_enforced():
    s = new_session(client)
    many = [{"id": f"ev_{i:03d}", "text": "e"} for i in range(KIND_CAPS["console"] + 1)]
    assert submit(client, s, console=many).status_code == 422


def test_evidence_budget_exhaustion_escalates_and_preserves_evidence(monkeypatch):
    monkeypatch.setattr("operon_backend.evidence.MAX_EVIDENCE_ITEMS", 3)
    s = new_session(client)
    first = submit(client, s, console=[{"id": f"ev_00{i}", "level": "warn", "text": "w"} for i in range(1, 3)]).json()
    assert first["session"]["phase"] == "NEED_INFORMATION"
    second = submit(client, first["session"], console=[{"id": f"ev_01{i}", "level": "warn", "text": "w"} for i in range(1, 3)]).json()
    assert second["session"]["phase"] == "ESCALATED"
    assert second["session"]["resolution_state"] == "escalated_evidence_budget_exhausted"
    assert len(second["session"]["evidence_bundles"]) == 1  # the earlier evidence is preserved
    assert MAX_EVIDENCE_ITEMS > 3  # the real budget is untouched outside this test


def test_evidence_window_starts_after_each_remediation_attempt():
    db = SessionLocal()
    try:
        session = create_session(db, "w")
        session.collected_evidence = [
            {"bundle": EvidenceBundle(url="u", timestamp=1, console=[{"id": "ev_001", "text": "old"}]).model_dump(), "after_attempt": 0, "item_count": 1},
            {"bundle": EvidenceBundle(url="u", timestamp=2, console=[{"id": "ev_002", "text": "new"}]).model_dump(), "after_attempt": 1, "item_count": 1},
        ]
        session.action_attempt_count = 1
        assert evidence_window(session).all_evidence_ids() == {"ev_002"}
        session.action_attempt_count = 0
        assert evidence_window(session).all_evidence_ids() == {"ev_001"}
    finally:
        db.rollback()
        db.close()


def test_understanding_lists_anomalies_with_ids_and_treats_page_state_as_context():
    bundle = EvidenceBundle(
        url="u", timestamp=1,
        console=[{"id": "ev_1", "level": "error", "text": "TypeError"}, {"id": "ev_2", "level": "warn", "text": "w"}],
        network=[{"id": "ev_3", "method": "GET", "url": "https://x/a", "status": 503},
                 {"id": "ev_4", "method": "GET", "url": "https://x/t", "status": 0, "status_text": "net::ERR_BLOCKED_BY_CLIENT"}],
        storage=[{"id": "ev_5", "key": "k", "parse_status": "syntax_error"}, {"id": "ev_6", "key": "ok", "parse_status": "valid_json"}],
        page=[{"id": "ev_7", "url_path": "/x", "service_worker_controlled": True, "service_worker_scopes": ["/"]}],
    )
    u = understand(bundle)
    assert {a["id"] for a in u["anomalies"]} == {"ev_1", "ev_3", "ev_4", "ev_5"}
    assert u["context"][0]["id"] == "ev_7"
    assert u["has_anomalies"] is True
