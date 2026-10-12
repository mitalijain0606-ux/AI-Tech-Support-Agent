"""The SDK and the extension are two ways in to ONE backend pipeline: the same endpoints, the
same policy, the same approval and verification. Only the declared source and capabilities differ."""

from flow_helpers import CAPABILITIES, approve, corrupt_storage, policy, submit, verify
from starlette.testclient import TestClient

from operon_backend.main import app

client = TestClient(app)
SDK_CAPS = ["inspect_page", "console_errors", "reset_user_preference", "clear_storage_key"]


def create(source, caps):
    res = client.post("/api/sessions", json={"user_issue": "dashboard broken", "source": source, "provider_capabilities": caps})
    assert res.status_code == 200, res.text
    return res.json()


def test_the_session_reports_who_created_it_and_what_that_provider_declared():
    sdk, ext = create("sdk", SDK_CAPS), create("extension", CAPABILITIES)
    assert (sdk["source"], sdk["provider_capabilities"]) == ("sdk", SDK_CAPS)
    assert (ext["source"], ext["provider_capabilities"]) == ("extension", CAPABILITIES)
    assert client.get(f"/api/sessions/{sdk['session_id']}").json()["source"] == "sdk"


def test_both_integrations_get_the_same_diagnosis_plan_policy_and_verification():
    results = {}
    for source, caps in (("sdk", SDK_CAPS), ("extension", CAPABILITIES)):
        s = create(source, caps)
        body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
        plan = body["pending_action"]
        pol = policy(client, body["session_id"]).json()
        assert approve(client, body["session_id"]).status_code == 200
        client.post(f"/api/sessions/{body['session_id']}/action-result", json={"action_id": plan["action_id"], "succeeded": True, "detail": "done"})
        done = verify(client, body["session_id"], plan["action_id"], storage=[{"key": "operon_demo_cache", "present": False, "parse_status": "empty"}], console=[], network=[]).json()
        results[source] = (body["issue_category"], plan["action_id"], plan["parameters"], pol["policy"]["decision"], done["phase"], done["verification_state"]["outcome"])
    assert results["sdk"] == results["extension"] == ("storage_corruption", "clear_storage_key", {"key": "operon_demo_cache"}, "REQUIRE_APPROVAL", "RESOLVED", "passed")


def test_an_sdk_session_cannot_get_an_action_it_did_not_declare():
    s = create("sdk", ["inspect_page", "console_errors"])  # no clear_storage_key
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    assert body["pending_action"] is None and body["phase"] == "ESCALATED"


def test_the_sdk_cannot_claim_the_verdict_or_skip_approval():
    s = create("sdk", SDK_CAPS)
    body = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    sid = body["session_id"]
    assert client.post(f"/api/sessions/{sid}/action-result", json={"action_id": "clear_storage_key", "succeeded": True}).status_code == 409
    policy(client, sid)
    assert client.post(f"/api/sessions/{sid}/action-result", json={"action_id": "clear_storage_key", "succeeded": True}).status_code == 409  # not approved yet
    approve(client, sid)
    client.post(f"/api/sessions/{sid}/action-result", json={"action_id": "clear_storage_key", "succeeded": True})
    forged = client.post(f"/api/sessions/{sid}/verify", json={"action_id": "clear_storage_key", "observation": {"console": [], "network": []}, "passed": True})
    assert forged.status_code == 422
