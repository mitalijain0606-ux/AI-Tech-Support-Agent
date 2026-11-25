"""One problem per investigation, and the others are not lost (issues.py).

Covers the audit's probe: a complaint describing a blank settings page AND a failing
reports API, with evidence for both, used to be diagnosed as storage corruption only;
the server error vanished and a verified fix marked the whole complaint resolved."""

import pytest
from starlette.testclient import TestClient

from flow_helpers import corrupt_storage, new_session, submit
from operon_backend.issues import merge, split_complaint, uncited_faults
from operon_backend.main import app

client = TestClient(app)
SERVER_500 = {"id": "ev_n1", "method": "GET", "url": "https://app.example/api/reports", "status": 500, "status_text": "Server Error"}


@pytest.fixture(autouse=True)
def no_retrieval(monkeypatch):
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])


# ---- splitting a complaint ---------------------------------------------------------------------


@pytest.mark.parametrize("text,expected", [
    ("The dates are missing on my account page, and also the reports page will not load",
     ["The dates are missing on my account page", "The reports page will not load"]),
    ("Project search is disabled. Also the project list never loads.", ["Project search is disabled", "The project list never loads"]),
    ("1. settings page is blank\n2. reports API fails with 500", ["Settings page is blank", "Reports API fails with 500"]),
    ("The settings page is blank; the reports never load", ["The settings page is blank", "The reports never load"]),
])
def test_a_complaint_with_several_problems_is_split(text, expected):
    assert split_complaint(text) == expected


@pytest.mark.parametrize("text", [
    "Dates are missing and an error banner appears",  # one problem, described twice
    "my dashboard is broken",
    "Something is wrong on this page.",
    "I opened the account page; nothing happened",    # context + one problem
    "",
])
def test_one_problem_is_never_split(text):
    assert split_complaint(text) == [text]


def test_at_most_five_problems_are_kept():
    text = "; ".join(f"widget {i} is broken" for i in range(9))
    assert len(split_complaint(text)) == 5


# ---- faults in the evidence the diagnosis did not explain ------------------------------------------


UNDERSTANDING = {"anomalies": [
    {"id": "ev_s", "kind": "storage", "summary": "storage key 'settings' is invalid_json"},
    {"id": "ev_n1", "kind": "network", "summary": "GET https://app/api/reports -> 500"},
    {"id": "ev_n2", "kind": "network", "summary": "GET https://ads/x blocked by client"},
    {"id": "ev_n3", "kind": "network", "summary": "GET https://app/api/me -> 404"},
    {"id": "ev_c", "kind": "console", "summary": "SyntaxError: Unexpected token"},
]}


def test_uncited_server_errors_and_blocked_requests_are_reported():
    faults = uncited_faults(UNDERSTANDING, ["ev_s", "ev_c"], "storage_corruption")
    assert [f["evidence_id"] for f in faults] == ["ev_n1", "ev_n2"]  # not the 404, not the console symptom
    assert all(f["source"] == "evidence" for f in faults)


def test_nothing_is_reported_when_the_diagnosis_is_about_the_network():
    assert uncited_faults(UNDERSTANDING, ["ev_n1"], "network_error") == []
    assert uncited_faults(UNDERSTANDING, ["ev_s"], "network_error") == []


def test_merge_skips_duplicates():
    a = [{"text": "x", "source": "complaint"}]
    b = [{"text": "y", "source": "evidence", "evidence_id": "ev_1"}, {"text": "y again", "source": "evidence", "evidence_id": "ev_1"}]
    assert len(merge(a, b)) == 2


# ---- through the API -------------------------------------------------------------------------------


def test_the_session_investigates_the_first_problem_and_keeps_the_others():
    s = new_session(client, "The settings page is blank; also the reports page never loads")
    assert s["user_issue"] == "The settings page is blank"
    assert s["additional_issues"] == [{"text": "The reports page never loads", "source": "complaint"}]
    got = client.get(f"/api/sessions/{s['session_id']}").json()
    assert got["additional_issues"] == s["additional_issues"]
    from operon_backend.db import SessionLocal
    from operon_backend.db_models import SessionRecord

    db = SessionLocal()
    try:  # the user's full words are kept
        assert db.get(SessionRecord, s["session_id"]).conversation_history[0]["content"].endswith("never loads")
    finally:
        db.close()


def test_the_audit_probe_storage_fault_plus_server_error_is_no_longer_lost():
    s = new_session(client, "my settings page is blank")
    body = submit(client, s, storage=[corrupt_storage()], network=[SERVER_500]).json()
    session = body["session"]
    assert session["phase"] == "ACTION_PROPOSED"
    assert session["pending_action"]["action_id"] == "clear_storage_key"  # still fixes the first problem
    extra = session["additional_issues"]
    assert len(extra) == 1 and extra[0]["source"] == "evidence" and "-> 500" in extra[0]["text"]
    assert any(a["kind"] == "additional_issues" for a in session["activity"])


def test_a_single_problem_session_has_no_additional_issues():
    s = new_session(client, "my dashboard looks corrupted")
    session = submit(client, s, storage=[corrupt_storage()]).json()["session"]
    assert session["additional_issues"] == []


def test_an_escalation_ticket_carries_the_additional_issues():
    from operon_backend.db import SessionLocal
    from operon_backend.db_models import SessionRecord
    from operon_backend.loop_driver import escalate
    from operon_backend.tickets import build_report

    s = new_session(client, "Login is broken. Also the export button fails with an error")
    db = SessionLocal()
    try:
        row = db.get(SessionRecord, s["session_id"])
        escalate(db, row, "escalated_test", "test escalation")
        report = build_report(db.get(SessionRecord, s["session_id"]))
    finally:
        db.close()
    assert report["additional_issues"] == [{"text": "The export button fails with an error", "source": "complaint"}]
