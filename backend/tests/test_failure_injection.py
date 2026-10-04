"""Failure injection at the API boundary: collectors that can't run, a page
that never yields evidence, and a model that keeps failing. In every case the
session must stay consistent, never propose an ungrounded action, and end in a
bounded number of steps (resolved, still asking, or escalated — never stuck).

Already covered elsewhere: Groq timeout/5xx/malformed output
(test_groq_http_client.py), embedding model unavailable
(test_embeddings_failure.py), retrieval error (test_investigation_pipeline.py),
stale/reused request ids (test_api_contract.py), inconclusive verification
and failed remediation (test_remediation_lifecycle.py), evidence budget
(test_evidence.py), extension restart mid-step (extension/tests/resilience).
"""

import pytest
from starlette.testclient import TestClient

from flow_helpers import FakeGroq, corrupt_storage, new_session, submit
from operon_backend.llm import LLMError
from operon_backend.main import app

client = TestClient(app)
TERMINAL = {"ESCALATED", "RESOLVED"}


@pytest.fixture(autouse=True)
def _no_retrieval(monkeypatch):
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def get(sid: str) -> dict:
    return client.get(f"/api/sessions/{sid}").json()


def test_every_collector_failing_is_recorded_and_no_action_is_proposed():
    s = new_session(client)
    res = submit(client, s, collection_errors=["debugger_unavailable", "storage_unreachable", "page_unreachable"])
    assert res.status_code == 200, res.text
    session = res.json()["session"]
    assert session["pending_action"] is None
    assert session["phase"] in {"NEED_INFORMATION", "ESCALATED"}
    assert session["evidence_bundles"][0]["collection_errors"] == ["debugger_unavailable", "storage_unreachable", "page_unreachable"]
    understanding = [a for a in session["activity"] if a["kind"] == "understanding"][-1]
    assert understanding["data"]["collection_errors"]


def test_a_page_that_never_yields_evidence_ends_in_bounded_steps():
    s = new_session(client)
    for _ in range(12):
        if s["phase"] in TERMINAL or not s.get("evidence_request"):
            break
        res = submit(client, s, collection_errors=["tab_unreachable"])
        assert res.status_code == 200, res.text
        s = res.json()["session"]
    assert s["phase"] == "ESCALATED", s["phase"]
    assert s["pending_action"] is None
    assert s["escalation_state"]["reason"]
    assert s["resolution_state"] != "resolved"


def test_a_model_that_keeps_failing_never_consumes_evidence_and_the_session_recovers(monkeypatch):
    FakeGroq(monkeypatch, [LLMError("Failed to reach the model: timeout")] * 3)
    s = new_session(client)
    for _ in range(3):
        res = submit(client, get(s["session_id"]), storage=[corrupt_storage()])
        assert res.status_code == 400 and "timeout" in res.json()["detail"]
    after = get(s["session_id"])
    assert after["evidence_bundles"] == [] and after["pending_action"] is None
    assert after["phase"] == "UNDERSTANDING" and after["evidence_request"]
    assert after["llm_call_count"] == 3

    # The model comes back: the same outstanding request can still be answered.
    monkeypatch.setattr("operon_backend.config.settings.groq_api_key", "")  # offline engine
    ok = submit(client, after, storage=[corrupt_storage()])
    assert ok.status_code == 200 and ok.json()["session"]["phase"] == "ACTION_PROPOSED"


def test_the_llm_call_budget_escalates_instead_of_calling_forever(monkeypatch):
    FakeGroq(monkeypatch, [LLMError("Groq API returned status 503")] * 20)
    s = new_session(client)
    statuses = []
    for _ in range(20):
        current = get(s["session_id"])
        if current["phase"] in TERMINAL:
            break
        statuses.append(submit(client, current, storage=[corrupt_storage()]).status_code)
    final = get(s["session_id"])
    assert final["phase"] == "ESCALATED", (final["phase"], statuses)
    assert final["llm_call_count"] <= 12
    assert final["pending_action"] is None
