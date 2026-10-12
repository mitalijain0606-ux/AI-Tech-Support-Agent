"""Contract test: every request body the SDK (JavaScript) sends is accepted by the backend's own
models (Python). The SDK is run by Node on a fake browser; its bodies are validated here."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from operon_backend.schemas import (
    ActionResultRequest,
    AnswerRequest,
    ApprovalRequest,
    CreateSessionRequest,
    SessionPolicyRequest,
    SubmitEvidenceRequest,
    VerifyRequest,
)

SDK = Path(__file__).resolve().parents[2] / "sdk"


@pytest.fixture(scope="module")
def bodies():
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed; the SDK contract test needs it")
    out = subprocess.run([node, str(SDK / "tests" / "contract-emit.mjs")], capture_output=True, text=True, check=True, cwd=SDK)
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_every_body_validates_against_the_backend_models(bodies):
    CreateSessionRequest.model_validate(bodies["create"])
    SubmitEvidenceRequest.model_validate(bodies["investigate"])
    AnswerRequest.model_validate(bodies["answer"])
    SessionPolicyRequest.model_validate(bodies["policy"])
    ApprovalRequest.model_validate(bodies["approve"])
    ActionResultRequest.model_validate(bodies["action-result"])
    VerifyRequest.model_validate(bodies["verify"])  # extra="forbid": no verdict field can ride along


def test_the_sdk_declares_only_what_it_can_do(bodies):
    assert bodies["create"]["source"] == "sdk"
    caps = set(bodies["create"]["provider_capabilities"])
    assert caps == {"inspect_page", "console_errors", "network_requests", "reset_user_preference", "clear_storage_key"}
    assert "reload" not in caps and "cookies" not in bodies["create"]["collectors"]
    assert set(bodies["create"]["collectors"]) == {"storage", "page", "console", "network"}


def test_the_evidence_is_shaped_for_the_backend_and_carries_no_values(bodies):
    bundle = SubmitEvidenceRequest.model_validate(bodies["investigate"]).bundle
    assert bundle.request_id == "req1"
    assert [s.key for s in bundle.storage] == ["app_settings"] and bundle.storage[0].parse_status == "syntax_error"
    assert "{bad" not in json.dumps(bodies["investigate"])  # the stored value never leaves
    assert any("Failed to load settings" in c.text for c in bundle.console)
    assert bundle.cookies == []


def test_approval_names_the_proposal_and_verification_carries_only_an_observation(bodies):
    assert bodies["approve"] == {"approved": True, "proposal_id": "prop1"}
    verify = VerifyRequest.model_validate(bodies["verify"])
    assert verify.action_id == "reset_user_preference"
    assert any("late error" in c.text for c in verify.observation.console)
