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
