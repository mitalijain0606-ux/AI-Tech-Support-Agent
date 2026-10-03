"""Shared helpers for driving a SupportSession through the HTTP API.

FakeGroq replaces only the network call (`llm._call_groq`): prompt building,
JSON parsing, grounding validation and regeneration all run for real. Tests
that use it are *stubbed-model* tests, not live-model tests.
"""

import json
from typing import Any

from operon_backend.config import settings

CAPABILITIES = [
    "inspect_page",
    "reload",
    "clear_storage_key",
    "unregister_service_worker",
    "console_errors",
    "network_requests",
]


def new_session(client, issue: str = "my dashboard is broken", capabilities=None, collectors=None) -> dict:
    body: dict[str, Any] = {"user_issue": issue, "provider_capabilities": CAPABILITIES if capabilities is None else capabilities}
    if collectors is not None:
        body["collectors"] = collectors
    res = client.post("/api/sessions", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def submit(client, session: dict, **items) -> Any:
    """Answers the session's outstanding evidence request."""
    request = session.get("evidence_request") or {}
    bundle = {"url": "https://github.com/octo/repo", "timestamp": 1726000000.0, "request_id": request.get("request_id")}
    bundle.update(items)
    return client.post(f"/api/sessions/{session['session_id']}/investigate", json={"bundle": bundle})


def policy(client, session_id: str, **body) -> Any:
    return client.post(f"/api/sessions/{session_id}/policy", json=body)


def approve(client, session_id: str, approved: bool = True) -> Any:
    return client.post(f"/api/sessions/{session_id}/approve", json={"approved": approved})


def action_result(client, session_id: str, action_id: str, succeeded: bool = True, detail: str = "done") -> Any:
    return client.post(
        f"/api/sessions/{session_id}/action-result",
        json={"action_id": action_id, "succeeded": succeeded, "detail": detail},
    )


def verify(client, session_id: str, action_id: str, *, console=(), network=(), storage=None, sw=None, error=None) -> Any:
    observation: dict[str, Any] = {"console": list(console), "network": list(network)}
    if storage is not None:
        observation["storage"] = storage
    if sw is not None:
        observation["service_worker_scopes"] = sw
    if error is not None:
        observation["error"] = error
    return client.post(f"/api/sessions/{session_id}/verify", json={"action_id": action_id, "observation": observation})


def corrupt_storage(ev="ev_002", key="operon_demo_cache") -> dict:
    return {"id": ev, "key": key, "present": True, "parse_status": "syntax_error", "error_message": "Unexpected token"}


def storage_state(key="operon_demo_cache", present=False, status="empty") -> dict:
    return {"key": key, "present": present, "parse_status": status}


class FakeGroq:
    """Scripted model answers in order; records every message list sent."""

    def __init__(self, monkeypatch, answers: list[Any]):
        self.answers = list(answers)
        self.calls: list[list[dict[str, str]]] = []
        monkeypatch.setattr(settings, "groq_api_key", "test-key-not-a-real-key")
        monkeypatch.setattr("operon_backend.llm._call_groq", self._call)

    async def _call(self, messages):
        self.calls.append(messages)
        if not self.answers:
            raise AssertionError("FakeGroq ran out of scripted answers")
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer if isinstance(answer, str) else json.dumps(answer)

    def user_payload(self, call_index: int = -1) -> dict:
        return json.loads(self.calls[call_index][1]["content"])


def answer(category="storage_corruption", evidence_ids=("ev_002",), action=None, info=None, refs=(), confidence=0.9) -> dict:
    return {
        "category": category,
        "root_cause": f"root cause for {category}",
        "reasoning": f"reasoning for {category}",
        "evidence_ids": list(evidence_ids),
        "knowledge_refs": list(refs),
        "confidence": confidence,
        "resolvable_automatically": action is not None,
        "proposed_action": action,
        "information_request": info,
    }
