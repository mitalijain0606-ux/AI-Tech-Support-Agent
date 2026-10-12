"""Evidence requests, ingestion, and the evidence window.

The backend decides what evidence it needs (an EvidenceRequest); the
provider collects exactly that and submits an EvidenceBundle answering it.
This module validates and stores bundles with provenance, keeps evidence
ids unique per session so citations are unambiguous, enforces the evidence
budget, and builds the deterministic "understanding" of what was observed.

Evidence window: diagnosis only ever sees (and may only cite) evidence
collected since the most recent remediation attempt, so a retry is decided
on the page's current state rather than on symptoms an action already
changed.
"""

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from operon_backend.activity import record_activity
from operon_backend.loop_driver import MAX_EVIDENCE_ITEMS, evidence_item_count
from operon_backend.policy import evaluate
from operon_backend.signals import question_problems
from operon_backend.tripwire import redact_free_text, scrub_url
from operon_backend.schemas import (
    COLLECTORS,
    CitedEvidence,
    EvidenceBundle,
    EvidenceRequest,
    EvidenceRequestParams,
)

# Per-bundle caps — the provider truncates to these; the backend rejects more.
KIND_CAPS = {"console": 40, "network": 40, "cookies": 40, "storage": 25, "page": 3}

# Every collector is gated by the policy engine like any other action.
COLLECTOR_POLICY_ACTION = {
    "console": "console_errors",
    "network": "network_requests",
    "storage": "inspect_page",
    "cookies": "inspect_page",
    "page": "inspect_page",
    "reload_observe": "reload",
}

DEFAULT_COLLECTORS = ["console", "network", "storage", "cookies", "page"]
RECOLLECT_COLLECTORS = ["console", "network", "storage", "page"]

_EVIDENCE_ID_RE = re.compile(r"^ev_[A-Za-z0-9_-]{1,32}$")


class EvidenceRejected(Exception):
    """The submitted bundle can't be accepted as-is (HTTP 422/409)."""

    def __init__(self, detail: str, conflict: bool = False):
        super().__init__(detail)
        self.detail = detail
        self.conflict = conflict


class EvidenceBudgetExhausted(Exception):
    pass


# ---- Requests ---------------------------------------------------------------------


MAX_QUESTIONS = 3  # free-text questions the agent may put to the user in one session


def provider_profile(session) -> dict[str, list[str]]:
    env = session.environment_context or {}
    return {
        "capabilities": list(env.get("provider_capabilities") or []),
        "collectors": list(env.get("collectors") or COLLECTORS),
    }


def allowed_collectors(session, requested: list[str]) -> tuple[list[str], list[str]]:
    """Splits requested collectors into (allowed, refused-with-reason)."""
    profile = provider_profile(session)
    allowed: list[str] = []
    refused: list[str] = []
    for name in dict.fromkeys(requested):
        if name not in COLLECTORS:
            refused.append(f"{name}: unknown collector")
            continue
        if name not in profile["collectors"]:
            refused.append(f"{name}: not supported by this provider")
            continue
        if profile["capabilities"]:
            decision = evaluate(COLLECTOR_POLICY_ACTION[name], {}, profile["capabilities"])
            if decision.decision == "DENY":
                refused.append(f"{name}: {decision.reason}")
                continue
        allowed.append(name)
    return allowed, refused


def bounded_params(params: dict[str, Any] | None) -> EvidenceRequestParams:
    params = params or {}
    keys = [str(k)[:200] for k in (params.get("storage_keys") or []) if isinstance(k, str | int)][:10]
    selector = params.get("selector")
    selector = str(selector)[:200] if isinstance(selector, str) and selector.strip() else None
    observe_ms = params.get("observe_ms", 4000)
    observe_ms = min(8000, max(1000, int(observe_ms))) if isinstance(observe_ms, int | float) else 4000
    return EvidenceRequestParams(storage_keys=keys, selector=selector, observe_ms=observe_ms)


def build_request(
    session,
    *,
    purpose: str,
    collectors: list[str],
    params: dict[str, Any] | None,
    reason: str,
    requires_user_action: bool,
    question: str | None = None,
) -> tuple[EvidenceRequest | None, list[str]]:
    allowed, refused = allowed_collectors(session, collectors)
    if not allowed:
        return None, refused
    # A free-text question is allowed only within limits and only if it passes
    # the same scrutiny as any model output. One that does not is dropped (the
    # evidence request still goes out) and the reason is noted.
    if question is not None:
        problems = question_problems(question)
        if sum(1 for st in (session.diagnostic_steps or []) if st.get("question")) >= MAX_QUESTIONS:
            problems.append(f"the session already asked {MAX_QUESTIONS} question(s)")
        if problems:
            refused = [*refused, "question dropped: " + "; ".join(problems)]
            question = None
    request = EvidenceRequest(
        request_id=f"req_{uuid.uuid4().hex[:10]}",
        purpose=purpose,
        collectors=allowed,
        params=bounded_params(params),
        reason=reason[:500],
        requires_user_action=requires_user_action,
        cycle=(session.investigation_cycle or 0) + 1,
        question=question.strip() if question else None,
    )
    return request, refused


def request_signature(request: dict[str, Any] | EvidenceRequest) -> str:
    data = request.model_dump() if isinstance(request, EvidenceRequest) else request
    key = {"collectors": sorted(data.get("collectors") or []), "params": data.get("params") or {}}
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()[:16]


def times_requested(session, request: EvidenceRequest) -> int:
    """How many times an identical request (same collectors and params) was
    already issued in this session."""
    signature = request_signature(request)
    return sum(1 for step in (session.diagnostic_steps or []) if step.get("request_signature") == signature)


def issue_request(session, request: EvidenceRequest, refused: list[str] | None = None) -> None:
    """Makes `request` the session's outstanding evidence request, and
    records it (with its signature, for repeat detection) as a tool call."""
    session.evidence_request = request.model_dump()
    session.diagnostic_steps = [
        *(session.diagnostic_steps or []),
        {
            "intent": request.purpose,
            "reason": request.reason,
            "tool": "collect_evidence:" + ",".join(request.collectors),
            "expected_information": ", ".join(request.collectors),
            "request_id": request.request_id,
            "request_signature": request_signature(request),
            "question": request.question,
            "answer": None,
            "at": datetime.now(UTC).isoformat(),
        },
    ]
    session.tool_call_count = (session.tool_call_count or 0) + len(request.collectors)
    record_activity(
        session,
        "evidence_requested",
        request.reason,
        request_id=request.request_id,
        purpose=request.purpose,
        collectors=request.collectors,
        params=request.params.model_dump(),
        requires_user_action=request.requires_user_action,
        refused=refused or [],
    )


# ---- Ingestion ---------------------------------------------------------------------


def _scrub(items, fields: tuple[str, ...]):
    out = []
    for item in items:
        update = {}
        for name in fields:
            value = getattr(item, name, None)
            if isinstance(value, str) and value:
                cleaned = redact_free_text(value)[0]
                if name == "url":
                    cleaned = scrub_url(cleaned)
                if cleaned != value:
                    update[name] = cleaned
        out.append(item.model_copy(update=update) if update else item)
    return out


def scrub_bundle(bundle: EvidenceBundle) -> EvidenceBundle:
    """Second line of defence behind the client's own redaction: text the PAGE wrote (console lines,
    URLs, titles, parser messages) is redacted with the free-text heuristics before it is stored or
    shown to the model. Fixed credential patterns are still rejected outright by the tripwire; this
    catches formats no fixed pattern knows. Heuristic: see tripwire.redact_free_text."""
    return bundle.model_copy(
        update={
            "console": _scrub(bundle.console, ("text", "url")),
            "network": _scrub(bundle.network, ("url", "status_text", "failure_reason")),
            "storage": _scrub(bundle.storage, ("error_message",)),
            "page": _scrub(bundle.page, ("title",)),
        }
    )


def scrub_observation(observation):
    """The same protection for what a provider observed after an action."""
    return observation.model_copy(
        update={
            "console": _scrub(observation.console, ("text", "url")),
            "network": _scrub(observation.network, ("url", "status_text", "failure_reason")),
        }
    )


def ingest_bundle(session, bundle: EvidenceBundle) -> dict[str, Any]:
    """Validates a bundle against the outstanding request and the session's
    evidence so far, then stores it with provenance. Returns the stored
    record. Raises EvidenceRejected / EvidenceBudgetExhausted."""
    bundle = scrub_bundle(bundle)
    pending = session.evidence_request or None
    if pending and bundle.request_id and bundle.request_id != pending.get("request_id"):
        raise EvidenceRejected(
            f"Bundle answers request '{bundle.request_id}', but the outstanding request is '{pending.get('request_id')}'.",
            conflict=True,
        )

    for kind, item in bundle.items():
        if not _EVIDENCE_ID_RE.match(item.id):
            raise EvidenceRejected(f"Invalid evidence id '{item.id}' (expected ev_<id>).")
    for kind, cap in KIND_CAPS.items():
        if len(getattr(bundle, kind)) > cap:
            raise EvidenceRejected(f"Too many {kind} items ({len(getattr(bundle, kind))} > {cap}).")

    ids = [item.id for _, item in bundle.items()]
    duplicates_in_bundle = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates_in_bundle:
        raise EvidenceRejected(f"Duplicate evidence ids in bundle: {duplicates_in_bundle}")
    already = session_evidence_ids(session) & set(ids)
    if already:
        raise EvidenceRejected(
            f"Evidence ids already used earlier in this session: {sorted(already)[:10]}", conflict=True
        )

    if evidence_item_count(session) + len(ids) > MAX_EVIDENCE_ITEMS:
        raise EvidenceBudgetExhausted(
            f"evidence budget exhausted ({evidence_item_count(session)} + {len(ids)} > {MAX_EVIDENCE_ITEMS} items)"
        )

    if pending and not bundle.request_id:
        bundle = bundle.model_copy(update={"request_id": pending.get("request_id")})
    if not bundle.bundle_id:
        bundle = bundle.model_copy(update={"bundle_id": f"bun_{uuid.uuid4().hex[:10]}"})

    record = {
        "bundle_id": bundle.bundle_id,
        "request_id": bundle.request_id,
        "purpose": (pending or {}).get("purpose"),
        "cycle": (session.investigation_cycle or 0) + 1,
        "after_attempt": session.action_attempt_count or 0,
        "collectors": bundle.collectors or list((pending or {}).get("collectors") or []),
        "collection_errors": bundle.collection_errors,
        "received_at": datetime.now(UTC).isoformat(),
        "item_count": len(ids),
        "bundle": bundle.model_dump(),
    }
    session.collected_evidence = [*(session.collected_evidence or []), record]
    session.evidence_request = None
    return record


def _bundles(session) -> list[dict[str, Any]]:
    # Tolerates bundles stored before provenance records existed.
    return [r if "bundle" in r else {"bundle": r, "after_attempt": 0} for r in (session.collected_evidence or [])]


def session_evidence_ids(session) -> set[str]:
    ids: set[str] = set()
    for record in _bundles(session):
        ids |= EvidenceBundle.model_validate(record["bundle"]).all_evidence_ids()
    return ids


def evidence_window(session) -> EvidenceBundle:
    """All evidence collected since the latest remediation attempt, merged
    into one bundle (ids are unique per session, so merging is safe)."""
    attempt = session.action_attempt_count or 0
    window = [EvidenceBundle.model_validate(r["bundle"]) for r in _bundles(session) if r.get("after_attempt", 0) == attempt]
    if not window:
        return EvidenceBundle(url="", timestamp=0)
    merged = window[-1].model_copy(deep=True)
    for kind in KIND_CAPS:
        setattr(merged, kind, [item for b in window for item in getattr(b, kind)])
    merged.collection_errors = sorted({e for b in window for e in b.collection_errors})
    merged.collectors = sorted({c for b in window for c in b.collectors})
    merged.bundle_id = None
    merged.request_id = None
    return merged


def cited_evidence(bundle: EvidenceBundle, ids: list[str]) -> CitedEvidence:
    wanted = set(ids)
    return CitedEvidence(**{kind: [i for i in getattr(bundle, kind) if i.id in wanted] for kind in KIND_CAPS})


# ---- Understanding -------------------------------------------------------------------


def understand(bundle: EvidenceBundle) -> dict[str, Any]:
    """Deterministic summary of what the evidence shows — the anomalies worth
    reasoning about, with their ids — computed without an LLM call."""
    anomalies: list[dict[str, str]] = []
    for s in bundle.storage:
        if s.present and s.parse_status not in ("valid_json", "empty"):
            anomalies.append({"id": s.id, "kind": "storage", "summary": f"storage key '{s.key}' is {s.parse_status}"})
    for n in bundle.network:
        if n.status == 0 and "blocked" in (n.status_text or "").lower():
            anomalies.append({"id": n.id, "kind": "network", "summary": f"{n.method} {n.url[:120]} blocked by client"})
        elif n.status >= 400:
            anomalies.append({"id": n.id, "kind": "network", "summary": f"{n.method} {n.url[:120]} -> {n.status}"})
    for c in bundle.console:
        if c.level == "error":
            anomalies.append({"id": c.id, "kind": "console", "summary": c.text[:160]})
    # Page state is context, not a fault: plenty of healthy sites run a
    # service worker.
    context = [
        {
            "id": p.id,
            "kind": "page",
            "summary": f"{p.url_path} ready_state={p.ready_state}"
            + (f", service worker scopes {p.service_worker_scopes}" if p.service_worker_scopes else ""),
        }
        for p in bundle.page
    ]
    return {
        "anomalies": anomalies[:60],
        "context": context,
        "counts": {kind: len(getattr(bundle, kind)) for kind in KIND_CAPS},
        "collection_errors": bundle.collection_errors,
        "has_anomalies": bool(anomalies),
    }
