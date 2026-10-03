"""Remediation planning: a grounded diagnosis becomes a structured plan —
action, target, rationale, expected result, approval requirement, and the
verification that will decide whether it worked. Planning never executes
anything and never decides policy; policy.py does that next."""

import uuid

from operon_backend.evidence import cited_evidence
from operon_backend.policy import ACTION_POLICIES
from operon_backend.schemas import (
    Diagnosis,
    EvidenceBundle,
    RemediationProposal,
    VerificationPlan,
)

_RISK = {"ALLOW": "low", "REQUIRE_APPROVAL": "destructive_or_sensitive", "DENY": "not_permitted"}


def build_proposal(
    diagnosis: Diagnosis,
    window: EvidenceBundle,
    *,
    attempt: int,
    previous: dict | None,
    last_verification: dict | None,
) -> RemediationProposal:
    action = diagnosis.proposed_action
    assert action is not None
    params = dict(action.params)
    cited = cited_evidence(window, diagnosis.evidence_ids)

    if action.action_id == "clear_storage_key":
        key = params.get("key")
        target = {"storage_key": key}
        expected = f"storage key '{key}' is absent or parses as valid JSON after reload, and the cited errors no longer appear"
        verification = VerificationPlan(strategy="storage_recheck", cited_evidence=cited, storage_keys=[key])
    elif action.action_id == "unregister_service_worker":
        scope = params.get("scope")
        target = {"service_worker_scope": scope}
        expected = f"no service worker is registered for scope '{scope}' and the cited errors no longer appear after reload"
        verification = VerificationPlan(
            strategy="service_worker_recheck",
            cited_evidence=cited,
            service_worker_scope=scope,
            storage_keys=[s.key for s in cited.storage],
        )
    else:  # reload, inspect_page
        target = {"page": window.page[-1].url_path if window.page else window.url}
        if action.action_id == "inspect_page":
            target["selector"] = params.get("selector")
        expected = "the cited signals do not reappear when the page is reloaded and observed"
        verification = VerificationPlan(
            strategy="reobserve_cited", cited_evidence=cited, storage_keys=[s.key for s in cited.storage]
        )

    cited_ids = ", ".join(diagnosis.evidence_ids)
    return RemediationProposal(
        proposal_id=f"prop_{uuid.uuid4().hex[:10]}",
        diagnosis=diagnosis.root_cause,
        evidence_ids=list(diagnosis.evidence_ids),
        knowledge_refs=list(diagnosis.knowledge_refs),
        action_id=action.action_id,
        parameters=params,
        target=target,
        rationale=diagnosis.reasoning,
        expected_effect=expected,
        risk=_RISK.get(ACTION_POLICIES.get(action.action_id, "DENY"), "unknown"),
        verification_predicate=f"[{verification.strategy}] none of the cited evidence ({cited_ids}) is present after the action",
        verification=verification,
        requires_approval=ACTION_POLICIES.get(action.action_id) == "REQUIRE_APPROVAL",
        attempt=attempt,
        retry_of=(previous or {}).get("proposal_id") if attempt > 1 else None,
        retry_reason=(last_verification or {}).get("message") if attempt > 1 else None,
    )
