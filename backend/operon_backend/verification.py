"""Deterministic remediation verification — decided by the backend.

The provider only reports what it observed after an action
(VerificationObservation). This module decides, from the evidence the
remediation plan *cited*, whether that specific problem is gone:

- every cited console/network signal must not reappear;
- every cited storage key must now be absent or valid JSON;
- a service-worker remediation's scope must no longer be registered;
- anything cited that the observation cannot speak to is "inconclusive",
  which never counts as success.

Only a plan with nothing cited may pass on a clean observation window —
and the planner never produces such a plan (proposals must cite evidence).
"""

import re
from dataclasses import dataclass
from typing import Literal

from operon_backend.schemas import (
    ConsoleEvidence,
    NetworkEvidence,
    VerificationObservation,
    VerificationPlan,
)

Outcome = Literal["passed", "failed", "inconclusive"]


@dataclass
class VerificationResult:
    outcome: Outcome
    message: str

    @property
    def passed(self) -> bool:
        return self.outcome == "passed"


def _normalize_text(text: str) -> str:
    # Numbers (line/col, ids, timestamps) vary between occurrences of the
    # same error; the rest of the message identifies it.
    return re.sub(r"\s+", " ", re.sub(r"\d+", "#", text)).strip().lower()


def _strip_query(url: str) -> str:
    return re.split(r"[?#]", url, maxsplit=1)[0]


def signature_of(item: ConsoleEvidence | NetworkEvidence) -> str:
    """A stable identity for "the same signal", independent of its ev_ id."""
    if isinstance(item, ConsoleEvidence):
        return f"console:{item.level}:{_normalize_text(item.text)}"
    return f"network:{item.method.upper()} {_strip_query(item.url)} {item.status}"


def _inconclusive(reason: str) -> VerificationResult:
    return VerificationResult("inconclusive", f"Verification inconclusive — {reason}")


def evaluate(plan: VerificationPlan | None, after: VerificationObservation) -> VerificationResult:
    if plan is None:
        return _inconclusive("the remediation has no verification plan.")
    if after.error:
        return _inconclusive(f"the provider could not observe the page after the action ({after.error}).")

    cited = plan.cited_evidence
    if cited.is_empty() and not plan.storage_keys:
        errors = sum(1 for c in after.console if c.level == "error") + len(after.network)
        if errors:
            return VerificationResult(
                "failed",
                f"Verification failed — no cited evidence to compare against, and {errors} error signal(s) "
                f"were observed after the action.",
            )
        return VerificationResult("passed", "Verified — no console errors or failed requests were observed after the action.")

    if cited.cookies:
        return _inconclusive(f"cookie evidence ({', '.join(c.id for c in cited.cookies)}) can't be re-checked after this action.")

    failures: list[str] = []

    observed = {signature_of(i) for i in [*after.console, *after.network]}
    for item in [*cited.console, *cited.network]:
        if signature_of(item) in observed:
            failures.append(f"{item.id} reappeared")

    keys = list(dict.fromkeys([*(s.key for s in cited.storage), *plan.storage_keys]))
    if keys:
        if after.storage is None:
            return _inconclusive(f"storage ({', '.join(keys)}) was not re-checked after the action.")
        states = {s.key: s for s in after.storage}
        for key in keys:
            state = states.get(key)
            if state is None:
                return _inconclusive(f"storage key '{key}' was not reported after the action.")
            if state.present and state.parse_status != "valid_json":
                cited_id = next((s.id for s in cited.storage if s.key == key), key)
                failures.append(f"{cited_id} ('{key}') is still {state.parse_status}")

    if plan.strategy == "service_worker_recheck":
        if after.service_worker_scopes is None:
            return _inconclusive("service worker registrations were not re-checked after the action.")
        if plan.service_worker_scope and plan.service_worker_scope in after.service_worker_scopes:
            failures.append(f"service worker scope '{plan.service_worker_scope}' is still registered")
    elif cited.page:
        return _inconclusive(f"page evidence ({', '.join(p.id for p in cited.page)}) can't be re-checked by this action.")

    total = len(cited.console) + len(cited.network) + len(keys) + (1 if plan.strategy == "service_worker_recheck" else 0)
    if failures:
        return VerificationResult(
            "failed",
            f"Verification failed — {len(failures)} of {total} cited signal(s) still present after the action "
            f"({'; '.join(failures)}).",
        )
    return VerificationResult("passed", f"Verified — none of the {total} cited signal(s) are present after the action.")
