"""The real Groq client over HTTP (local OpenAI-compatible stub server).

STUBBED ENDPOINT — these prove the client code is correct against the
chat/completions contract. They do not prove the live model behaves; see
tests/live/test_live_groq.py (skipped without GROQ_API_KEY).
"""

import json

import pytest
from starlette.testclient import TestClient

from flow_helpers import answer, corrupt_storage, new_session, submit
from groq_stub import STUB_KEY, Reply, StubGroqServer, completion
from operon_backend import llm
from operon_backend.config import settings
from operon_backend.llm import SYSTEM_PROMPT, _parse
from operon_backend.main import app

client = TestClient(app)
CLEAR = {"action_id": "clear_storage_key", "params": {"key": "operon_demo_cache"}}


@pytest.fixture
def groq(monkeypatch):
    server = StubGroqServer().start()
    monkeypatch.setattr(llm, "GROQ_API_URL", server.url)
    monkeypatch.setattr(settings, "groq_api_key", STUB_KEY)
    monkeypatch.setattr(settings, "groq_timeout_seconds", 2.0)
    monkeypatch.setattr("operon_backend.investigation.search", lambda *a, **k: [])
    yield server
    server.stop()


def investigate(storage=True):
    s = new_session(client)
    res = submit(client, s, storage=[corrupt_storage()] if storage else [])
    return s, res


# ---- request contract ---------------------------------------------------------------------


def test_request_matches_the_chat_completions_contract(groq):
    groq.reply(answer(action=CLEAR))
    _, res = investigate()
    assert res.status_code == 200 and res.json()["session"]["phase"] == "ACTION_PROPOSED"
    assert res.json()["diagnosis"]["engine"] == "groq"

    [req] = groq.requests
    assert req["path"].endswith("/chat/completions")
    assert req["headers"]["authorization"] == f"Bearer {STUB_KEY}"
    assert req["headers"]["content-type"].startswith("application/json")
    body = req["body"]
    assert set(body) == {"model", "messages", "temperature", "response_format"}
    assert body["model"] == settings.groq_model == "openai/gpt-oss-120b"
    assert body["temperature"] == 0.1
    assert body["response_format"] == {"type": "json_object"}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]
    assert body["messages"][0]["content"] == SYSTEM_PROMPT
    assert "JSON" in SYSTEM_PROMPT  # json_object mode requires the word in the prompt
    payload = json.loads(body["messages"][1]["content"])
    assert {"allowed_evidence_ids", "allowed_knowledge_ids", "available_collectors", "investigation_history"} <= set(payload)
    assert STUB_KEY not in req["raw_body"]  # the key travels only in the header


def test_plan_comes_from_the_model_answer_and_stays_grounded(groq):
    groq.reply(answer(action=CLEAR, confidence=0.82))
    _, res = investigate()
    session = res.json()["session"]
    plan = session["pending_action"]
    assert (plan["action_id"], plan["parameters"]) == ("clear_storage_key", {"key": "operon_demo_cache"})
    assert plan["evidence_ids"] == ["ev_002"]
    assert plan["verification"]["cited_evidence"]["storage"][0]["key"] == "operon_demo_cache"
    assert session["confidence"] == 0.82


# ---- transport and service failures ----------------------------------------------------------


@pytest.mark.parametrize(
    "reply,expect",
    [
        (Reply({"error": {"message": "rate limit"}}, status=429, headers={"retry-after": "3"}), "status 429, retry after 3s"),
        (Reply({"error": {"message": "boom"}}, status=500), "status 500"),
        (Reply({"error": {"message": "overloaded"}}, status=503), "status 503"),
        (Reply({"error": {"message": "bad key"}}, status=401), "status 401"),
        (Reply(raw="<html>gateway error</html>"), "Unexpected Groq response shape"),
        (Reply({"choices": []}), "Unexpected Groq response shape"),
        (Reply({"unexpected": True}), "Unexpected Groq response shape"),
    ],
)
def test_service_failures_become_a_clean_400_and_do_not_consume_evidence(groq, reply, expect):
    groq.reply(reply)
    s, res = investigate()
    assert res.status_code == 400
    assert expect in res.json()["detail"]
    assert STUB_KEY not in res.text
    after = client.get(f"/api/sessions/{s['session_id']}").json()
    assert after["phase"] == "UNDERSTANDING" and after["evidence_bundles"] == []
    assert after["llm_call_count"] == 1
    assert after["activity"][-1]["kind"] == "diagnosis_failed"
    assert STUB_KEY not in json.dumps(after)


def test_timeout_is_reported_as_a_timeout(groq, monkeypatch):
    monkeypatch.setattr(settings, "groq_timeout_seconds", 0.2)
    groq.reply(Reply(completion(answer(action=CLEAR)), delay=1.0))
    _, res = investigate()
    assert res.status_code == 400 and "timeout" in res.json()["detail"]


def test_unreachable_service_is_reported_without_a_stack_trace(groq, monkeypatch):
    groq.stop()
    monkeypatch.setattr(llm, "GROQ_API_URL", "http://127.0.0.1:9/openai/v1/chat/completions")  # discard port
    _, res = investigate()
    assert res.status_code == 400 and "Failed to reach the model" in res.json()["detail"]


def test_session_can_resubmit_after_a_transient_failure(groq):
    groq.reply(Reply({"error": {"message": "boom"}}, status=503), answer(action=CLEAR))
    s, first = investigate()
    assert first.status_code == 400
    after = client.get(f"/api/sessions/{s['session_id']}").json()
    second = submit(client, after, storage=[corrupt_storage()]).json()
    assert second["session"]["phase"] == "ACTION_PROPOSED"
    assert second["session"]["llm_call_count"] == 2


# ---- malformed output, normalization, grounding over the real client ---------------------------------


def test_malformed_output_is_regenerated_with_the_problem_stated(groq):
    groq.reply("this is not json", answer(action=CLEAR))
    _, res = investigate()
    session = res.json()["session"]
    assert session["phase"] == "ACTION_PROPOSED" and session["llm_call_count"] == 2
    assert len(groq.requests) == 2
    roles = [m["role"] for m in groq.requests[1]["body"]["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert groq.requests[1]["body"]["messages"][-1]["content"].startswith("Your previous answer was rejected")
    assert session["diagnoses"][0]["rejected_answers"]


def test_code_fenced_and_null_field_answers_are_normalized_but_still_validated(groq):
    sloppy = "```json\n" + json.dumps({**answer(action=CLEAR), "knowledge_refs": None, "information_request": {}}) + "\n```"
    groq.reply(sloppy)
    _, res = investigate()
    assert res.json()["session"]["phase"] == "ACTION_PROPOSED"
    assert len(groq.requests) == 1  # normalized, not regenerated


def test_normalization_never_lets_an_ungrounded_answer_through(groq):
    ungrounded = "```json\n" + json.dumps(answer(evidence_ids=("ev_999",), action=CLEAR)) + "\n```"
    groq.reply(ungrounded, answer(action=CLEAR))
    _, res = investigate()
    session = res.json()["session"]
    assert session["llm_call_count"] == 2
    assert any("hallucinated evidence IDs" in p for p in session["diagnoses"][0]["rejected_answers"][0])


def test_invalid_answer_twice_escalates_without_acting(groq):
    bad = answer(action={"action_id": "run_javascript", "params": {"code": "alert(1)"}})
    groq.reply(bad, bad)
    _, res = investigate()
    body = res.json()
    assert body["diagnosis"] is None
    assert body["session"]["resolution_state"] == "escalated_ungrounded_diagnosis"
    assert body["session"]["pending_action"] is None and body["session"]["llm_call_count"] == 2
    assert len(groq.requests) == 2


def test_model_asking_for_more_evidence_creates_a_bounded_request(groq):
    info = {"collectors": ["storage", "page"], "params": {"storage_keys": ["k"] * 30}, "reason": "check", "requires_user_action": False}
    groq.reply(answer("insufficient_evidence", evidence_ids=(), info=info, confidence=0.2))
    s = new_session(client)
    body = submit(client, s).json()
    request = body["session"]["evidence_request"]
    assert body["session"]["phase"] == "NEED_INFORMATION"
    assert request["collectors"] == ["storage", "page"] and len(request["params"]["storage_keys"]) == 10


# ---- _parse unit cases -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,ok",
    [
        (json.dumps(answer(action=CLEAR)), True),
        ("```\n" + json.dumps(answer(action=CLEAR)) + "\n```", True),
        (json.dumps({**answer(), "evidence_ids": None}), True),
        (json.dumps({**answer(action={"action_id": "reload", "params": None})}), True),
        (json.dumps({**answer(), "proposed_action": {}}), True),
        ("[]", False),
        ("null", False),
        ("{", False),
        (json.dumps({**answer(), "confidence": 85}), False),
        (json.dumps({"category": "x"}), False),
    ],
)
def test_parse_shapes(raw, ok):
    if ok:
        assert _parse(raw).category
    else:
        with pytest.raises((ValueError, TypeError, AttributeError)):
            _parse(raw)


def test_model_cannot_set_the_engine_label():
    parsed = _parse(json.dumps({**answer(), "engine": "rule_based"}))
    assert parsed.engine == "groq"  # the default; the model's value was discarded
