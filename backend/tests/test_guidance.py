"""Deterministic checks on the free-text guidance a diagnosis shows to people (guidance.py)."""

import json

import pytest

from flow_helpers import FakeGroq, answer
from operon_backend.guidance import guidance_problems
from operon_backend.llm import UngroundedDiagnosis, run_diagnosis
from operon_backend.schemas import EvidenceBundle

KB = [{"chunk_id": "kb_corrupted_cache", "score": 0.9, "content": "Clear only the specific key. Never clear all storage — only the key showing a parse failure."}]


@pytest.mark.parametrize("text", [
    "Clear all localStorage to be safe.",
    "Please delete every cookie for this site.",
    "Reinstall your browser and try again.",
    "Disable your antivirus temporarily.",
    "Send us your password so we can check.",
    "Paste this script into the developer console.",
    "Delete your account and sign up again.",
])
def test_dangerous_instructions_are_rejected(text):
    assert guidance_problems("root cause", text)


@pytest.mark.parametrize("text", ["This is guaranteed to fix it.", "It will definitely work.", "100% fixed after this."])
def test_certainty_claims_are_rejected(text):
    assert any("certainty" in p for p in guidance_problems("x", text))


@pytest.mark.parametrize("text", [
    "Storage signal indicates 'buggycloud_settings' failed JSON parsing. Clearing this key will resolve the parse error on page load.",
    "3 request(s) were cancelled client-side. Check your ad blocker / privacy extension settings for this site, then ask again.",
    "A 401/403 response was observed. Signing in again is the user's step; Operon never handles credentials.",
    "Disable your ad blocker for this site, then reload.",
    "The app cleared its cache during the last deploy.",
    "The server must allow this origin; it cannot be fixed from the browser.",
])
def test_ordinary_guidance_is_accepted(text):
    assert guidance_problems("root cause", text) == []


def test_contradicting_a_cited_knowledge_rule_is_named():
    problems = guidance_problems("x", "Per the knowledge base, clear all storage.", KB, ["kb_corrupted_cache"])
    assert any("contradicts kb_corrupted_cache" in p for p in problems)
    assert not any("contradicts" in p for p in guidance_problems("x", "Per the knowledge base, clear all storage.", KB, []))


BUNDLE = EvidenceBundle.model_validate({"url": "u", "timestamp": 1, "storage": [{"id": "ev_002", "key": "operon_demo_cache", "present": True, "parse_status": "syntax_error"}]})
CLEAR = {"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}}


@pytest.mark.asyncio
async def test_dangerous_guidance_is_regenerated_then_fails_safe(monkeypatch):
    bad = answer(evidence_ids=["ev_002"], action=CLEAR) | {"reasoning": "Clear all your cookies and site data; guaranteed fix."}
    FakeGroq(monkeypatch, [bad, bad])
    with pytest.raises(UngroundedDiagnosis) as exc:
        await run_diagnosis("dashboard blank", BUNDLE, KB)
    assert exc.value.llm_calls == 2
    assert any("wipes all browser data" in p for p in exc.value.problems)


@pytest.mark.asyncio
async def test_a_regenerated_answer_without_the_problem_is_used(monkeypatch):
    bad = answer(evidence_ids=["ev_002"], action=CLEAR) | {"reasoning": "Reinstall the browser."}
    good = answer(evidence_ids=["ev_002"], action=CLEAR)
    fake = FakeGroq(monkeypatch, [bad, good])
    run = await run_diagnosis("dashboard blank", BUNDLE, KB)
    assert run.diagnosis.proposed_action.action_id == "clear_storage_key"
    assert run.rejected and "reinstalls the browser" in run.rejected[0][0]
    assert "rejected" in fake.calls[-1][-1]["content"]


def test_every_offline_engine_answer_passes_the_guidance_checks():
    import importlib.util
    from pathlib import Path

    from operon_backend.llm import _rule_based_diagnosis

    spec = importlib.util.spec_from_file_location("operon_eval", Path(__file__).resolve().parent.parent / "eval.py")
    ev = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ev)
    for f in ev.load_fixtures():
        d = _rule_based_diagnosis(f["issue"], EvidenceBundle.model_validate(f["bundle"]), f["available_actions"])
        assert guidance_problems(d.root_cause, d.reasoning) == [], (f["id"], d.reasoning)
    json.dumps({})


# ---- procedure order: numbered guidance against a cited, ordered knowledge procedure ----------------

PROC = [{"chunk_id": "kb_proc", "content": "Clearing a corrupted cache. 1. Open the site settings in the browser. "
         "2. Find the stored data for the site. 3. Delete only the corrupted cache entry. "
         "4. Reload the page and confirm the error is gone."}]
ERR = [{"chunk_id": "err_scopes", "content": "GitHub Error: Forbidden\nDiagnostic steps: Check the token scopes; "
        "Verify the SSO authorization; Retry the request with a new token"}]


def test_guidance_that_follows_the_procedure_in_order_is_accepted():
    text = "1. Open the site settings in your browser. 2. Find the stored data for this site. 3. Delete only the corrupted cache entry. 4. Reload the page."
    assert guidance_problems("corrupted cache", text, PROC, ["kb_proc"]) == []


def test_steps_out_of_order_are_named():
    text = "1. Delete the corrupted cache entry. 2. Open the site settings in the browser. 3. Reload the page and confirm."
    problems = guidance_problems("x", text, PROC, ["kb_proc"])
    assert any("out of order" in p and "kb_proc" in p for p in problems)


def test_a_skipped_required_step_is_named():
    text = "1. Open the site settings in the browser. 2. Reload the page and confirm the error is gone."
    problems = guidance_problems("x", text, PROC, ["kb_proc"])
    assert any("skips required step 2" in p and "step 3" in p for p in problems)


def test_semicolon_procedures_from_error_entries_are_checked_too():
    problems = guidance_problems("x", "1. Retry the request with a new token. 2. Check the token scopes.", ERR, ["err_scopes"])
    assert any("out of order" in p for p in problems)


@pytest.mark.parametrize("text", [
    "The cache entry is corrupted; clearing that one entry fixes the error.",  # no numbered steps
    "1. Open the site settings in the browser. 2. Note the time. 3. Find the stored data for the site.",  # an extra, explanatory step
    "1. Restart your computer. 2. Try again later.",  # matches no procedure step: not this procedure
])
def test_guidance_without_a_procedure_violation_is_accepted(text):
    assert guidance_problems("x", text, PROC, ["kb_proc"]) == []


def test_only_cited_procedures_are_checked():
    text = "1. Delete the corrupted cache entry. 2. Open the site settings in the browser."
    assert guidance_problems("x", text, PROC, []) == []


@pytest.mark.asyncio
async def test_an_out_of_order_answer_is_regenerated_and_the_ordered_one_used(monkeypatch):
    kb = [{"chunk_id": "kb_proc", "content": PROC[0]["content"], "score": 0.9}]
    bad = answer(evidence_ids=["ev_002"], action=CLEAR, refs=["kb_proc"]) | {
        "reasoning": "1. Delete only the corrupted cache entry. 2. Open the site settings in the browser."}
    good = answer(evidence_ids=["ev_002"], action=CLEAR, refs=["kb_proc"]) | {
        "reasoning": "1. Open the site settings in the browser. 2. Find the stored data for the site. 3. Delete only the corrupted cache entry."}
    fake = FakeGroq(monkeypatch, [bad, good])
    run = await run_diagnosis("dashboard blank", BUNDLE, kb)
    assert run.rejected and "out of order" in run.rejected[0][0]
    assert run.diagnosis.reasoning.startswith("1. Open the site settings")
    assert len(fake.calls) == 2
