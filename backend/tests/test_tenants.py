"""Tenant isolation and approval authorization, enforced on the server.

The rule under test: a caller can only ever see or change a session that
belongs to their tenant AND was created by them (admins: any session of their
tenant). Anything else is a 404 — indistinguishable from a session that does
not exist — so ids cannot be probed across tenants or users.
"""

import json

import pytest
from starlette.testclient import TestClient

from auth_helpers import mint
from flow_helpers import CAPABILITIES, corrupt_storage
from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def start(headers, issue="my dashboard is broken"):
    res = client.post("/api/sessions", json={"user_issue": issue, "provider_capabilities": CAPABILITIES}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def propose(headers):
    """A session in WAITING_FOR_APPROVAL, owned by `headers`."""
    s = start(headers)
    sid = s["session_id"]
    bundle = {"url": "https://github.com/o/r", "timestamp": 1, "request_id": s["evidence_request"]["request_id"], "storage": [corrupt_storage()]}
    body = client.post(f"/api/sessions/{sid}/investigate", json={"bundle": bundle}, headers=headers).json()
    assert body["session"]["phase"] == "ACTION_PROPOSED", body
    assert client.post(f"/api/sessions/{sid}/policy", json={}, headers=headers).status_code == 200
    return sid, body["session"]["pending_action"]["proposal_id"]


# ---- cross-tenant -----------------------------------------------------------------------------------------


def test_another_tenant_cannot_touch_any_session_endpoint():
    alice = mint("acme", "alice")
    mallory = mint("evil", "mallory")
    sid, proposal = propose(alice)
    before = client.get(f"/api/sessions/{sid}", headers=alice).json()

    attempts = [
        ("get", f"/api/sessions/{sid}", None),
        ("get", f"/api/sessions/{sid}/events", None),
        ("post", f"/api/sessions/{sid}/investigate", {"bundle": {"url": "u", "timestamp": 1}}),
        ("post", f"/api/sessions/{sid}/diagnose", {"bundle": {"url": "u", "timestamp": 1}}),
        ("post", f"/api/sessions/{sid}/policy", {}),
        ("post", f"/api/sessions/{sid}/answer", {"request_id": "req_x", "answer": "hello"}),
        ("post", f"/api/sessions/{sid}/approve", {"approved": True, "proposal_id": proposal}),
        ("post", f"/api/sessions/{sid}/action-result", {"action_id": "clear_storage_key", "succeeded": True}),
        ("post", f"/api/sessions/{sid}/verify", {"action_id": "clear_storage_key", "observation": {"console": [], "network": []}}),
    ]
    for method, path, body in attempts:
        res = getattr(client, method)(path, headers=mallory, **({"json": body} if body is not None else {}))
        assert res.status_code == 404, (path, res.status_code, res.text[:120])
        assert res.json() == client.get("/api/sessions/does-not-exist", headers=mallory).json() | {"detail": f"No session '{sid}'"}
    assert client.get(f"/api/sessions/{sid}", headers=alice).json() == before  # nothing changed


def test_a_foreign_session_is_indistinguishable_from_a_missing_one():
    alice = mint("acme", "alice")
    mallory = mint("evil", "mallory")
    sid = start(alice)["session_id"]
    foreign = client.get(f"/api/sessions/{sid}", headers=mallory)
    missing = client.get("/api/sessions/00000000-0000-0000-0000-000000000000", headers=mallory)
    assert foreign.status_code == missing.status_code == 404
    assert set(foreign.json()) == set(missing.json())


def test_the_session_list_of_ids_is_not_enumerable():
    # There is no listing endpoint at all, and a wrong tenant learns nothing from probing.
    assert client.get("/api/sessions", headers=mint("acme", "alice")).status_code in (404, 405)


# ---- approval authorization ----------------------------------------------------------------------------------


def test_only_the_owner_or_an_admin_of_the_tenant_can_approve():
    alice = mint("acme", "alice")
    bob = mint("acme", "bob")  # same tenant, different user
    admin = mint("acme", "carol", "admin")
    sid, proposal = propose(alice)

    assert client.post(f"/api/sessions/{sid}/approve", json={"approved": True}, headers=bob).status_code == 404
    assert client.get(f"/api/sessions/{sid}", headers=alice).json()["phase"] == "WAITING_FOR_APPROVAL"

    ok = client.post(f"/api/sessions/{sid}/approve", json={"approved": True, "proposal_id": proposal}, headers=admin)
    assert ok.status_code == 200 and ok.json()["phase"] == "EXECUTING"
    assert ok.json()["approval"]["approved_by"] == "carol" and ok.json()["approval"]["approved_by_role"] == "admin"


def test_the_owner_is_recorded_as_the_approver():
    alice = mint("acme", "alice")
    sid, proposal = propose(alice)
    res = client.post(f"/api/sessions/{sid}/approve", json={"approved": True, "proposal_id": proposal}, headers=alice).json()
    assert res["approval"]["approved_by"] == "alice"
    assert "decided_by" in json.dumps(res["activity"]) and "alice" in res["activity"][-1]["summary"]


def test_an_approval_for_a_replaced_plan_is_rejected():
    alice = mint("acme", "alice")
    sid, _ = propose(alice)
    res = client.post(f"/api/sessions/{sid}/approve", json={"approved": True, "proposal_id": "prop_stale"}, headers=alice)
    assert res.status_code == 409
    assert client.get(f"/api/sessions/{sid}", headers=alice).json()["phase"] == "WAITING_FOR_APPROVAL"


def test_a_read_only_key_cannot_approve_even_its_own_session():
    sid, proposal = propose(mint("acme", "alice"))
    viewer = mint("acme", "alice", "viewer")
    res = client.post(f"/api/sessions/{sid}/approve", json={"approved": True, "proposal_id": proposal}, headers=viewer)
    assert res.status_code == 403


def test_the_client_cannot_skip_approval_by_calling_later_endpoints():
    alice = mint("acme", "alice")
    sid, _ = propose(alice)
    res = client.post(f"/api/sessions/{sid}/action-result", json={"action_id": "clear_storage_key", "succeeded": True}, headers=alice)
    assert res.status_code == 409  # still WAITING_FOR_APPROVAL: nothing may execute


# ---- the same tenant, different users ----------------------------------------------------------------------------


def test_users_of_one_tenant_do_not_see_each_others_sessions():
    alice, bob = mint("acme", "alice"), mint("acme", "bob")
    sid = start(alice)["session_id"]
    assert client.get(f"/api/sessions/{sid}", headers=bob).status_code == 404
    assert client.get(f"/api/sessions/{sid}", headers=mint("acme", "carol", "admin")).status_code == 200


def test_an_admin_of_another_tenant_has_no_reach_here():
    sid = start(mint("acme", "alice"))["session_id"]
    assert client.get(f"/api/sessions/{sid}", headers=mint("evil", "root", "admin")).status_code == 404


# ---- stored ownership --------------------------------------------------------------------------------------------


def test_sessions_record_their_tenant_and_creator():
    alice = mint("acme", "alice")
    sid = start(alice)["session_id"]
    db = SessionLocal()
    try:
        row = db.get(SessionRecord, sid)
        assert (row.tenant_id, row.created_by) == ("acme", "alice")
        assert row.user_context["tenant_id"] == "acme"
    finally:
        db.close()


# ---- learned history stays inside its tenant --------------------------------------------------------------------


def test_resolved_session_history_is_retrievable_only_within_its_tenant():
    from operon_backend import knowledge
    from operon_backend.retrieval import search

    alice = mint("acme", "alice")
    sid, proposal = propose(alice)
    client.post(f"/api/sessions/{sid}/approve", json={"approved": False, "proposal_id": proposal}, headers=alice)  # declined -> RESOLVED -> history

    db = SessionLocal()
    try:
        row = db.get(SessionRecord, sid)
        chunk = knowledge.record_resolved_session_to_kb(db, row, tenant_id="acme")
        assert chunk
        stored = db.get(KnowledgeChunk, chunk)
        assert stored.chunk_metadata["tenant_id"] == "acme"
        assert stored.source_type == "history"
        visible = {c.chunk_id for c in search(db, "my dashboard is broken", tenant_id="acme", source_types=["history"], similarity_floor=-1.0)}
        hidden = {c.chunk_id for c in search(db, "my dashboard is broken", tenant_id="evil", source_types=["history"], similarity_floor=-1.0)}
        assert chunk in visible and chunk not in hidden
    finally:
        db.query(KnowledgeChunk).filter(KnowledgeChunk.source_type == "history").delete()
        db.commit()
        db.close()
