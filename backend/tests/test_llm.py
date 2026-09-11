import json

import pytest
from starlette.testclient import TestClient

from operon_backend.config import settings
from operon_backend.llm import LLMError, diagnose
from operon_backend.main import app
from operon_backend.schemas import (
    ConsoleEvidence,
    CookieSignal,
    EvidenceBundle,
    StorageSignal,
)


@pytest.fixture
def sample_bundle():
    return EvidenceBundle(
        url="https://github.com",
        timestamp=1726000000.0,
        console=[
            ConsoleEvidence(
                id="ev_001",
                level="error",
                text="SyntaxError: Unexpected token in JSON at position 0",
            )
        ],
        storage=[
            StorageSignal(
                id="ev_002",
                key="operon_demo_cache",
                present=True,
                parse_status="syntax_error",
                error_message="Unexpected token",
            )
        ],
        cookies=[
            CookieSignal(
                id="ev_003",
                name="user_session",
                domain="github.com",
                secure=True,
                http_only=True,
            )
        ],
    )


@pytest.mark.asyncio
async def test_rule_based_diagnosis(sample_bundle):
    # Without Groq API key, rule-based diagnosis should fire
    settings.groq_api_key = ""
    diagnosis = await diagnose("GitHub feels broken", sample_bundle)

    assert diagnosis.category == "storage_corruption"
    assert "operon_demo_cache" in diagnosis.root_cause
    assert "ev_002" in diagnosis.evidence_ids
    assert diagnosis.resolvable_automatically is True
    assert diagnosis.proposed_action is not None
    assert diagnosis.proposed_action.action_id == "clear_storage_key"
    assert diagnosis.proposed_action.params == {"key": "operon_demo_cache"}


@pytest.mark.asyncio
async def test_evidence_citation_guardrail_rejects_hallucinations(sample_bundle, monkeypatch):
    settings.groq_api_key = "fake-key"

    # Mock Groq API returning a diagnosis that cites a non-existent ID "ev_999"
    class MockResponse:
        status_code = 200

        def json(self):
            return {
                "choices": [
                    {
                        "message": {
                            "content": json.dumps(
                                {
                                    "category": "storage_corruption",
                                    "root_cause": "Corrupted key",
                                    "reasoning": "Parse failed",
                                    "evidence_ids": ["ev_001", "ev_999"],  # ev_999 does not exist!
                                    "confidence": 0.9,
                                    "resolvable_automatically": True,
                                    "proposed_action": {
                                        "action_id": "clear_storage_key",
                                        "params": {"key": "operon_demo_cache"},
                                    },
                                }
                            )
                        }
                    }
                ]
            }

    class MockAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc_val, exc_tb):
            pass

        async def post(self, *args, **kwargs):
            return MockResponse()

    monkeypatch.setattr("httpx.AsyncClient", lambda **kwargs: MockAsyncClient())

    with pytest.raises(LLMError) as exc_info:
        await diagnose("my page is broken", sample_bundle)

    assert "hallucinated evidence IDs" in str(exc_info.value)
    assert "ev_999" in str(exc_info.value)


def test_api_health():
    client = TestClient(app)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_api_policy_endpoint():
    client = TestClient(app)
    response = client.post(
        "/api/policy",
        json={
            "action_id": "clear_storage_key",
            "params": {"key": "operon_demo_cache"},
            "provider_capabilities": ["clear_storage_key", "reload"],
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["decision"] == "REQUIRE_APPROVAL"
    assert data["validated_params"]["key"] == "operon_demo_cache"


def test_api_diagnose_endpoint_clean_bundle(sample_bundle):
    settings.groq_api_key = ""  # Rule-based fallback
    client = TestClient(app)

    response = client.post(
        "/api/diagnose",
        json={
            "message": "My page is broken",
            "bundle": sample_bundle.model_dump(),
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["category"] == "storage_corruption"
    assert data["proposed_action"]["action_id"] == "clear_storage_key"


def test_api_diagnose_endpoint_tripwire_rejection():
    client = TestClient(app)

    fake_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.do_not_leak_this"
    payload = {
        "message": "help me",
        "bundle": {
            "url": "https://github.com",
            "timestamp": 1726000000.0,
            "console": [{"id": "ev_001", "level": "error", "text": f"Leaked token {fake_jwt}"}],
        },
    }

    response = client.post("/api/diagnose", json=payload)
    assert response.status_code == 422
    assert "Security Tripwire Triggered" in response.json()["detail"]
