"""Remediation plan → policy → approval → execution → verification, and
every way a client might try to get around it."""

import pytest
from flow_helpers import (
    action_result,
    approve,
    corrupt_storage,
    new_session,
    policy,
    storage_state,
    submit,
    verify,
)
from starlette.testclient import TestClient

from operon_backend.main import app

client = TestClient(app)


def proposed(issue="dashboard broken", capabilities=None, **evidence):
    s = new_session(client, issue, capabilities=capabilities)
    body = submit(client, s, **(evidence or {"storage": [corrupt_storage()]})).json()
    assert body["session"]["phase"] == "ACTION_PROPOSED", body["session"]["phase"]
    return body["session"]


def test_plan_is_structured_and_grounded():
    session = proposed(console=[{"id": "ev_001", "level": "error", "text": "SyntaxError: bad JSON"}], storage=[corrupt_storage()])
    plan = session["pending_action"]
    assert plan["proposal_id"].startswith("prop_")
    assert plan["action_id"] == "clear_storage_key" and plan["parameters"] == {"key": "operon_demo_cache"}
    assert plan["target"] == {"storage_key": "operon_demo_cache"}
    assert plan["rationale"] and plan["expected_effect"]
    assert plan["requires_approval"] is True and plan["risk"] == "destructive_or_sensitive"
    assert plan["verification"]["strategy"] == "storage_recheck"
    cited = plan["verification"]["cited_evidence"]
    assert {i["id"] for i in cited["storage"] + cited["console"]} == set(plan["evidence_ids"]) == {"ev_001", "ev_002"}
    assert plan["attempt"] == 1 and plan["retry_of"] is None


def test_scenario_1_diagnosis_to_resolved():
    session = proposed()
    sid = session["session_id"]
    p = policy(client, sid).json()
    assert p["policy"]["decision"] == "REQUIRE_APPROVAL" and p["session"]["phase"] == "WAITING_FOR_APPROVAL"
    assert p["session"]["policy_decision"]["proposal_id"] == session["pending_action"]["proposal_id"]
    assert p["session"]["policy_decision"]["capabilities_source"] == "session"
    assert approve(client, sid).json()["phase"] == "EXECUTING"
    assert action_result(client, sid, "clear_storage_key").json()["phase"] == "VERIFYING"
    final = verify(client, sid, "clear_storage_key", storage=[storage_state()]).json()
    assert final["phase"] == "RESOLVED" and final["resolution_state"] == "resolved"
    assert final["verification_state"]["outcome"] == "passed"
    assert final["attempted_actions"][-1]["verified"] is True


def test_scenario_5_policy_rejects_action_and_it_never_executes():
    session = proposed(capabilities=["console_errors", "network_requests", "inspect_page"])  # no clear_storage_key
    sid = session["session_id"]
    p = policy(client, sid, provider_capabilities=["clear_storage_key"]).json()  # client claim is ignored
    assert p["policy"]["decision"] == "DENY"
    assert p["session"]["phase"] == "ESCALATED" and p["session"]["resolution_state"] == "escalated_policy_denied"
    assert approve(client, sid).status_code == 409
    assert action_result(client, sid, "clear_storage_key").status_code == 409
    assert client.get(f"/api/sessions/{sid}").json()["attempted_actions"] == []


def test_policy_evaluates_the_pending_action_not_a_client_supplied_one():
    sid = proposed()["session_id"]
    swapped = policy(client, sid, action_id="reload", params={"ignore_cache": True})
    assert swapped.status_code == 409
    tampered = policy(client, sid, action_id="clear_storage_key", params={"key": "something_else"})
    assert tampered.status_code == 409
    assert client.get(f"/api/sessions/{sid}").json()["phase"] == "ACTION_PROPOSED"


def test_approval_cannot_be_skipped_or_forged():
    sid = proposed()["session_id"]
    # Before policy: no approval, no execution.
    assert approve(client, sid).status_code == 409
    assert action_result(client, sid, "clear_storage_key").status_code == 409
    policy(client, sid)
    # Waiting for approval: executing is still refused.
    assert action_result(client, sid, "clear_storage_key").status_code == 409
    assert verify(client, sid, "clear_storage_key", storage=[storage_state()]).status_code == 409
    assert client.get(f"/api/sessions/{sid}").json()["phase"] == "WAITING_FOR_APPROVAL"


def test_execution_report_must_name_the_pending_action():
    sid = proposed()["session_id"]
    policy(client, sid)
    approve(client, sid)
    assert action_result(client, sid, "unregister_service_worker").status_code == 409
    assert action_result(client, sid, "clear_storage_key").status_code == 200


def test_client_cannot_declare_success_verification_is_decided_by_the_backend():
    sid = proposed()["session_id"]
    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    legacy = client.post(f"/api/sessions/{sid}/verify", json={"passed": True, "message": "trust me"})
    assert legacy.status_code == 422
    still_broken = verify(client, sid, "clear_storage_key", storage=[storage_state(present=True, status="syntax_error")]).json()
    assert still_broken["phase"] != "RESOLVED"
    assert still_broken["verification_state"]["outcome"] == "failed"


def test_allow_action_executes_without_approval():
    s = new_session(client, "something threw an error")
    body = submit(client, s, console=[{"id": "ev_001", "level": "error", "text": "TypeError: x is undefined"}]).json()
    sid = body["session"]["session_id"]
    assert body["session"]["pending_action"]["action_id"] == "reload"
    p = policy(client, sid).json()
    assert p["policy"]["decision"] == "ALLOW" and p["session"]["phase"] == "EXECUTING"
    assert verify(client, sid, "reload", console=[]).status_code == 409  # verification must follow execution
    assert action_result(client, sid, "reload", detail="reloaded").json()["phase"] == "VERIFYING"
    resolved = verify(client, sid, "reload", console=[]).json()
    assert resolved["phase"] == "RESOLVED"


def test_declined_action_never_executes():
    sid = proposed()["session_id"]
    policy(client, sid)
    declined = approve(client, sid, approved=False).json()
    assert declined["phase"] == "RESOLVED" and declined["resolution_state"] == "declined_by_user"
    assert declined["approval"]["approved"] is False
    assert action_result(client, sid, "clear_storage_key").status_code == 409


def test_failed_execution_is_a_failed_attempt_and_retries_or_escalates():
    sid = proposed()["session_id"]
    policy(client, sid)
    approve(client, sid)
    failed = action_result(client, sid, "clear_storage_key", succeeded=False, detail="tab unreachable").json()
    assert failed["phase"] == "NEED_INFORMATION"
    assert failed["verification_state"]["outcome"] == "not_run"
    assert failed["evidence_request"]["purpose"] == "retry"


@pytest.mark.parametrize("error", ["debugger_unavailable", "interrupted"])
def test_scenario_9_unobservable_verification_never_leaves_the_session_stuck(error):
    s = new_session(client, "something threw an error")
    body = submit(client, s, console=[{"id": "ev_001", "level": "error", "text": "TypeError: boom"}]).json()
    sid = body["session"]["session_id"]
    policy(client, sid)
    action_result(client, sid, "reload")
    after = verify(client, sid, "reload", error=error).json()
    assert after["verification_state"]["outcome"] == "inconclusive"
    assert after["phase"] == "NEED_INFORMATION"  # retry path, not stuck in VERIFYING
    assert after["attempted_actions"][-1]["verified"] is False


def test_scenario_4_retry_with_a_different_action_resolves():
    sid = proposed(console=[{"id": "ev_001", "level": "error", "text": "SyntaxError: bad JSON"}], storage=[corrupt_storage()])["session_id"]
    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    # Storage is fixed but the page keeps throwing: the cited console error reappeared.
    failed = verify(client, sid, "clear_storage_key", console=[{"id": "ev_050", "level": "error", "text": "SyntaxError: bad JSON"}],
                    storage=[storage_state()]).json()
    assert failed["phase"] == "NEED_INFORMATION" and failed["verification_state"]["outcome"] == "failed"

    retry = submit(client, failed, console=[{"id": "ev_060", "level": "error", "text": "TypeError: stale bundle"}]).json()
    plan = retry["session"]["pending_action"]
    assert plan["action_id"] == "reload" and plan["attempt"] == 2 and plan["retry_of"]
    assert plan["evidence_ids"] == ["ev_060"]  # cites the *new* evidence, not the pre-action window
    policy(client, sid)
    action_result(client, sid, "reload")
    final = verify(client, sid, "reload", console=[]).json()
    assert final["phase"] == "RESOLVED"
    assert [a["action_id"] for a in final["attempted_actions"]] == ["clear_storage_key", "reload"]


def test_escalation_preserves_the_full_record_and_never_claims_resolution():
    sid = proposed()["session_id"]
    policy(client, sid)
    approve(client, sid)
    action_result(client, sid, "clear_storage_key")
    first = verify(client, sid, "clear_storage_key", storage=[storage_state(present=True, status="syntax_error")]).json()
    final = submit(client, first, storage=[corrupt_storage("ev_030")]).json()["session"]
    assert final["phase"] == "ESCALATED" and final["resolution_state"] != "resolved"
    esc = final["escalation_state"]
    assert esc["reason"] and esc["evidence_bundles"] == 2 and esc["diagnoses"] == 2
    assert esc["attempted_actions"][0]["verified"] is False
    assert esc["last_verification"]["outcome"] == "failed"
    kinds = [a["kind"] for a in final["activity"]]
    for kind in ("evidence_received", "knowledge_search", "diagnosis", "action_proposed", "policy_decided",
                 "approval", "action_executed", "verification", "retry", "escalated"):
        assert kind in kinds, kind
    assert "resolved" not in kinds
