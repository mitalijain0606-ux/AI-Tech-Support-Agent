"""Escalation tickets: every escalation hands a structured, redacted report to a
human, visible only within the session's tenant, triaged only by an admin, and
shown in a read-only dashboard that renders data as text under a strict CSP."""

import json
import re
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from auth_helpers import mint
from flow_helpers import CAPABILITIES, corrupt_storage
from operon_backend import tickets as ticket_service
from operon_backend.config import settings
from operon_backend.db import SessionLocal
from operon_backend.db_models import SessionRecord, Ticket
from operon_backend.main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_required", True)
    monkeypatch.setattr(settings, "groq_api_key", "")
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


def start(headers, issue="the dashboard shows an error", capabilities=CAPABILITIES):
    res = client.post("/api/sessions", json={"user_issue": issue, "provider_capabilities": capabilities}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def submit(headers, session, **items):
    bundle = {"url": "https://github.com/o/r", "timestamp": 1, "request_id": session["evidence_request"]["request_id"], **items}
    res = client.post(f"/api/sessions/{session['session_id']}/investigate", json={"bundle": bundle}, headers=headers)
    assert res.status_code == 200, res.text
    return res.json()["session"]


SERVER_ERROR = {"id": "ev_n1", "url": "https://github.com/o/r/api/data", "method": "GET", "status": 500, "status_text": "Internal Server Error"}


def escalated_session(headers, issue="the dashboard shows an error"):
    """A session that escalates because no browser action can fix a 500."""
    s = submit(headers, start(headers, issue), network=[SERVER_ERROR])
    assert s["phase"] == "ESCALATED", s["phase"]
    return s


# ---- opening ----------------------------------------------------------------------------------


def test_an_escalation_opens_one_ticket_with_the_full_report():
    alice = mint("acme", "alice")
    s = escalated_session(alice)
    ticket_id = s["escalation_state"]["ticket_id"]
    assert ticket_id.startswith("tkt_")
    escalated = [a for a in s["activity"] if a["kind"] == "escalated"]
    assert escalated and escalated[-1]["data"]["ticket_id"] == ticket_id

    res = client.get(f"/api/tickets/{ticket_id}", headers=alice)
    assert res.status_code == 200, res.text
    t = res.json()
    assert t["status"] == "open" and t["session_id"] == s["session_id"]
    assert t["resolution_state"] == "escalated_no_action_available"
    report = t["report"]
    assert report["user_message"] == "the dashboard shows an error"
    assert report["escalation"]["reason"]
    assert report["summary"]["category"] == "network_error"
    assert report["diagnoses"] and report["diagnoses"][-1]["evidence_ids"] == ["ev_n1"]
    assert report["evidence"][0]["items"]["network"][0]["status"] == 500
    assert any(a["kind"] == "escalated" for a in report["activity"])
    assert report["phase_history"]

    db = SessionLocal()
    try:
        assert db.query(Ticket).filter(Ticket.session_id == s["session_id"]).count() == 1
    finally:
        db.close()


def test_opening_is_idempotent_per_session():
    alice = mint("acme", "alice")
    s = escalated_session(alice)
    db = SessionLocal()
    try:
        session = db.get(SessionRecord, s["session_id"])
        again = ticket_service.open_ticket(db, session)
        db.commit()
        assert again.id == s["escalation_state"]["ticket_id"]
        assert db.query(Ticket).filter(Ticket.session_id == s["session_id"]).count() == 1
    finally:
        db.close()


def test_a_policy_deny_opens_a_ticket():
    alice = mint("acme", "alice")
    s = start(alice, capabilities=["inspect_page", "console_errors", "network_requests", "reload"])
    sid = s["session_id"]
    body = submit(alice, s, storage=[corrupt_storage()])
    if body["phase"] == "ACTION_PROPOSED":
        res = client.post(f"/api/sessions/{sid}/policy", json={}, headers=alice)
        assert res.json()["policy"]["decision"] == "DENY"
        body = res.json()["session"]
    assert body["phase"] == "ESCALATED"
    ticket = client.get(f"/api/tickets/{body['escalation_state']['ticket_id']}", headers=alice).json()
    assert ticket["status"] == "open"
    assert ticket["resolution_state"].startswith("escalated_")


def test_a_low_confidence_diagnosis_escalates_instead_of_acting(monkeypatch):
    monkeypatch.setattr(settings, "min_action_confidence", 0.99)
    alice = mint("acme", "alice")
    s = submit(alice, start(alice), storage=[corrupt_storage()])
    assert s["phase"] == "ESCALATED"
    assert s["resolution_state"] == "escalated_low_confidence"
    assert s["pending_action"] is None
    ticket = client.get(f"/api/tickets/{s['escalation_state']['ticket_id']}", headers=alice).json()
    assert "confidence" in ticket["reason"]


def test_the_default_threshold_still_lets_a_confident_fix_through():
    alice = mint("acme", "alice")
    s = submit(alice, start(alice), storage=[corrupt_storage()])
    assert s["phase"] == "ACTION_PROPOSED"


def test_the_report_is_redacted_again():
    alice = mint("acme", "alice")
    secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
    s = escalated_session(alice, issue=f"broken after I pasted token {secret} into settings")
    raw = json.dumps(client.get(f"/api/tickets/{s['escalation_state']['ticket_id']}", headers=alice).json())
    assert secret not in raw
    assert "REDACTED" in raw


def test_report_cleaning_redacts_and_bounds_any_string():
    secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIz"
    cleaned = ticket_service._clean({"a": [secret, "x" * 10_000], "nested": {"b": f"Bearer {'z' * 40}"}})
    flat = json.dumps(cleaned)
    assert secret not in flat and "z" * 40 not in flat
    assert len(cleaned["a"][1]) == ticket_service.MAX_STRING


# ---- access -----------------------------------------------------------------------------------


def test_another_tenant_cannot_see_or_change_a_ticket():
    alice = mint("acme", "alice")
    mallory = mint("evil", "mallory", "admin")
    ticket_id = escalated_session(alice)["escalation_state"]["ticket_id"]
    assert client.get(f"/api/tickets/{ticket_id}", headers=mallory).status_code == 404
    assert client.post(f"/api/tickets/{ticket_id}/status", json={"status": "closed"}, headers=mallory).status_code == 404
    assert all(t["ticket_id"] != ticket_id for t in client.get("/api/tickets?status=", headers=mallory).json()["tickets"])
    assert client.get(f"/api/tickets/{ticket_id}", headers=alice).json()["status"] == "open"


def test_users_see_their_own_tickets_and_admins_see_the_tenant():
    alice = mint("acme2", "alice")
    bob = mint("acme2", "bob")
    admin = mint("acme2", "carol", "admin")
    a = escalated_session(alice)["escalation_state"]["ticket_id"]
    b = escalated_session(bob)["escalation_state"]["ticket_id"]

    def ids(headers):
        return {t["ticket_id"] for t in client.get("/api/tickets", headers=headers).json()["tickets"]}

    assert ids(alice) == {a}
    assert ids(bob) == {b}
    assert ids(admin) >= {a, b}
    assert client.get(f"/api/tickets/{b}", headers=alice).status_code == 404


def test_tickets_need_authentication():
    assert client.get("/api/tickets").status_code == 401
    assert client.get("/api/tickets/tkt_whatever").status_code == 401


def test_only_an_admin_triages_and_it_is_recorded():
    alice = mint("acme3", "alice")
    viewer = mint("acme3", "alice", "viewer")
    admin = mint("acme3", "root", "admin")
    ticket_id = escalated_session(alice)["escalation_state"]["ticket_id"]

    assert client.post(f"/api/tickets/{ticket_id}/status", json={"status": "closed"}, headers=alice).status_code == 403
    assert client.post(f"/api/tickets/{ticket_id}/status", json={"status": "closed"}, headers=viewer).status_code == 403
    assert client.post(f"/api/tickets/{ticket_id}/status", json={"status": "bogus"}, headers=admin).status_code == 422
    assert client.post(f"/api/tickets/{ticket_id}/status", json={"status": "closed", "extra": 1}, headers=admin).status_code == 422

    res = client.post(f"/api/tickets/{ticket_id}/status", json={"status": "acknowledged", "note": "looking"}, headers=admin)
    assert res.status_code == 200
    t = res.json()
    assert t["status"] == "acknowledged"
    assert t["status_history"][-1] | {"at": None} == {"from": "open", "to": "acknowledged", "by": "root", "note": "looking", "at": None}

    open_ids = {x["ticket_id"] for x in client.get("/api/tickets?status=open", headers=admin).json()["tickets"]}
    ack_ids = {x["ticket_id"] for x in client.get("/api/tickets?status=acknowledged", headers=admin).json()["tickets"]}
    assert ticket_id not in open_ids and ticket_id in ack_ids
    assert client.get("/api/tickets?status=nonsense", headers=admin).status_code == 422


# ---- dashboard --------------------------------------------------------------------------------


def test_the_dashboard_is_served_under_a_strict_csp():
    res = client.get("/dashboard")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/html")
    csp = res.headers["content-security-policy"]
    for directive in ("default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"):
        assert directive in csp
    assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
    assert res.headers["x-content-type-options"] == "nosniff"
    for name in ("dashboard.js", "dashboard.css"):
        assert client.get(f"/dashboard/{name}").status_code == 200


@pytest.mark.parametrize("path", ["/dashboard/../main.py", "/dashboard/main.py", "/dashboard/%2e%2e%2fmain.py", "/dashboard/x.html"])
def test_the_dashboard_serves_only_its_own_files(path):
    assert client.get(path).status_code == 404


def test_the_dashboard_renders_data_as_text_only():
    folder = Path(ticket_service.__file__).resolve().parent / "dashboard"
    js = (folder / "dashboard.js").read_text()
    html = (folder / "index.html").read_text()
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage"):
        assert sink not in js, sink
    assert "<script>" not in html and not re.search(r"\son[a-z]+\s*=", html)  # no inline script or handlers
