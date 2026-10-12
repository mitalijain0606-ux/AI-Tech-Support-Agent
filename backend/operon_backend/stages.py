"""The diagnosis pipeline as explicit stages.

    classify → investigate → diagnose → plan → verify

classify     what kind of problem is this?              (deterministic, here)
investigate  gather what is needed: evidence, anomalies, (investigation.py,
             knowledge                                   evidence.py, retrieval.py)
diagnose     what is the cause, and what could fix it?   (llm.py)
plan         turn that into a checkable remediation     (planning.py)
verify       did it work?                               (verification.py)

Each stage has one module, one input and one output, and is reported as a
`stage` event with its duration while it runs (events.py), so a client can show
progress and an evaluation (eval.py) can score each stage on its own.

Only `diagnose` involves a language model. `classify` is deliberately plain code:
cheap, predictable, auditable, and it gives the model a labelled starting point
rather than a blank page — a hint it may disagree with, never evidence.
"""

import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from operon_backend.events import emit_stage
from operon_backend.schemas import EvidenceBundle
from operon_backend.signals import (
    invalid_preference,
    is_auth_failure,
    is_cors_failure,
    is_fetch_failure,
    is_http_failure,
    is_stale_asset_error,
    looks_like_injection,
)

PIPELINE_STAGES = ("classify", "investigate", "diagnose", "plan", "verify")

CATEGORIES = (
    "storage_corruption",
    "auth_failure",
    "network_error",
    "blocked_by_client",
    "dom_error",
    "service_worker_stale",
    "invalid_preference",
    "suspicious_content",
    "insufficient_evidence",
    "unknown",
)


@dataclass
class Classification:
    category: str
    confidence: float
    signals: list[str] = field(default_factory=list)  # evidence ids that led here
    reasons: list[str] = field(default_factory=list)
    detail: dict[str, Any] = field(default_factory=dict)  # e.g. {"preference": "timezone"}

    def as_hint(self) -> dict[str, Any]:
        return {"category": self.category, "confidence": self.confidence, "signals": self.signals, "reasons": self.reasons}


def classify(user_issue: str, bundle: EvidenceBundle) -> Classification:
    """The most specific category the evidence supports, with the evidence ids
    that support it. Text that tries to instruct an AI is a finding about the
    page ("suspicious_content"), never an instruction, and is excluded from the
    evidence used for every other category."""
    injected = [c for c in bundle.console if looks_like_injection(c.text)]
    injected_ids = {c.id for c in injected}
    console = [c for c in bundle.console if c.id not in injected_ids and c.level == "error"]

    corrupted = [s for s in bundle.storage if s.present and s.parse_status == "syntax_error"]
    if corrupted:
        related = [c.id for c in console if "syntaxerror" in c.text.lower() or "json" in c.text.lower()]
        return Classification(
            "storage_corruption",
            0.95 if related else 0.85,
            [corrupted[0].id, *related],
            [f"storage key '{corrupted[0].key}' does not parse as JSON"],
            {"key": corrupted[0].key},
        )

    blocked = [n for n in bundle.network if n.status == 0 and "blocked" in (n.status_text or "").lower()]
    if blocked:
        return Classification("blocked_by_client", 0.85, [n.id for n in blocked], ["requests were cancelled client-side"])

    for c in console:
        preference = invalid_preference(c.text)
        if preference:
            return Classification("invalid_preference", 0.9, [c.id], [f"the app reports an invalid {preference}"], {"preference": preference})

    scopes = [(p.id, scope) for p in bundle.page for scope in p.service_worker_scopes]
    stale = [c for c in console if is_stale_asset_error(c.text)]
    if stale and scopes:
        return Classification(
            "service_worker_stale",
            0.85,
            [stale[0].id, scopes[0][0]],
            ["a stale-asset error while a service worker controls the page"],
            {"scope": scopes[0][1]},
        )

    cors = [c for c in console if is_cors_failure(c.text)]
    if cors:
        return Classification("network_error", 0.8, [cors[0].id], ["a cross-origin (CORS) failure — a server-side configuration problem"], {"cors": True})

    auth = [n for n in bundle.network if n.status in (401, 403)]
    if auth or any(is_auth_failure(c.text) for c in console):
        ids = [n.id for n in auth] or [c.id for c in console if is_auth_failure(c.text)][:1]
        return Classification("auth_failure", 0.8, ids, ["the server refused the request as unauthenticated or forbidden"])

    failed = [n for n in bundle.network if n.status >= 400]
    if failed:
        return Classification("network_error", 0.85, [failed[0].id], [f"request to {failed[0].url[:80]} returned {failed[0].status}"])

    # The app reported a failed request in its console even though no network
    # entry was collected: still a network problem, not a code defect.
    http = [c for c in console if is_http_failure(c.text)]
    if http:
        return Classification("network_error", 0.75, [http[0].id], ["the console reports an HTTP error response"])
    fetch_failed = [c for c in console if is_fetch_failure(c.text)]
    if fetch_failed:
        return Classification("network_error", 0.7, [fetch_failed[0].id], ["a request failed before any response (offline, blocked or cross-origin)"], {"fetch_failed": True})

    if console:
        return Classification("dom_error", 0.7, [console[0].id], ["a runtime error was logged to the console"])

    if injected:
        return Classification(
            "suspicious_content",
            0.8,
            [c.id for c in injected],
            ["page content contains text addressed to an AI agent; it was treated as data, not obeyed"],
        )

    return Classification("insufficient_evidence", 0.3, [], ["no anomaly was observed"])


# ---- stage reporting ----------------------------------------------------------------------


@contextmanager
def stage(session_id: str, name: str) -> Iterator[dict[str, Any]]:
    """Reports a pipeline stage: `started` now, `finished` (with its duration and
    whatever the body put in the yielded dict) when the block ends.

        with stage(session.id, "diagnose") as s:
            ...
            s["engine"] = run.engine
    """
    if name not in PIPELINE_STAGES:
        raise ValueError(f"unknown pipeline stage '{name}'")
    emit_stage(session_id, name, "started")
    info: dict[str, Any] = {}
    started = time.perf_counter()
    try:
        yield info
    except BaseException:
        emit_stage(session_id, name, "failed", ms=round((time.perf_counter() - started) * 1000, 1))
        raise
    emit_stage(session_id, name, "finished", ms=round((time.perf_counter() - started) * 1000, 1), **info)
