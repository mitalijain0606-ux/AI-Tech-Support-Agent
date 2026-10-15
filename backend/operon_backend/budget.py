"""Evidence budgeting: what the model is shown, as its own pipeline stage.

    filter → dedupe → truncate → prune → redact → cap

The evidence window (evidence.evidence_window) can hold a few hundred items; a
prompt should not. This stage turns the window into the bundle the diagnose
stage reasons over and may cite from:

filter    keep the most recent N items of each kind (PROMPT_CAPS)
dedupe    collapse repeats — the same console message logged 40 times is one
          item with count=40; the same request failing repeatedly is one item
truncate  bound every free-text field (console text, URLs, titles)
prune     reduce page state to its skeleton (path, ready state, service-worker
          scopes, selector match) — no titles beyond a short prefix
redact    the free-text credential redaction once more (defense in depth; the
          bundle was already scrubbed on ingest)
cap       estimate tokens and, while over budget, drop the least informative
          items first: non-error console lines, successful requests, cookies,
          healthy storage, then the oldest anomalies

The result is deterministic. Evidence ids are never rewritten, so whatever the
model cites still names a real item of the window; the grounding validator and
the planner are given this same budgeted bundle, so the model can only cite
what it was actually shown.
"""

import json
from typing import Any

from operon_backend.evidence import scrub_bundle
from operon_backend.schemas import EvidenceBundle

# How much of the evidence window the model is shown (most recent first).
PROMPT_CAPS = {"console": 60, "network": 60, "cookies": 40, "storage": 25, "page": 5}

# Free-text field bounds, in characters.
TEXT_LIMITS = {"console.text": 600, "console.url": 300, "network.url": 300, "network.failure_reason": 300, "storage.error_message": 300, "page.title": 80, "page.url_path": 300}

# ~4 characters per token for JSON-ish English text — an estimate, deliberately
# on the generous side; the cap is a guard rail, not an exact accounting.
CHARS_PER_TOKEN = 4
DEFAULT_TOKEN_BUDGET = 8000


def estimate_tokens(bundle: EvidenceBundle) -> int:
    return len(json.dumps(bundle.model_dump(exclude={"bundle_id", "request_id", "redaction_applied"}), separators=(",", ":"))) // CHARS_PER_TOKEN + 1


def _truncate(value: str | None, limit: int) -> tuple[str | None, bool]:
    if value is None or len(value) <= limit:
        return value, False
    return value[: limit - 1] + "…", True


def _dedupe_console(items):
    seen: dict[tuple, int] = {}
    out = []
    for item in items:
        key = (item.level, item.text, item.url)
        if key in seen:
            kept = out[seen[key]]
            out[seen[key]] = kept.model_copy(update={"count": (kept.count or 1) + (item.count or 1)})
            continue
        seen[key] = len(out)
        out.append(item)
    return out, len(items) - len(out)


def _dedupe_network(items):
    # The most recent occurrence of the same method + URL + status is kept.
    latest: dict[tuple, int] = {}
    for i, item in enumerate(items):
        latest[(item.method, item.url, item.status)] = i
    keep = sorted(latest.values())
    return [items[i] for i in keep], len(items) - len(keep)


def _drop_order(bundle: EvidenceBundle) -> list[tuple[str, str]]:
    """(kind, id) of every item, least informative first."""
    order: list[tuple[str, str]] = []
    order += [("console", c.id) for c in bundle.console if c.level != "error"]
    order += [("network", n.id) for n in bundle.network if 0 < n.status < 400]
    order += [("cookies", c.id) for c in bundle.cookies]
    order += [("storage", s.id) for s in bundle.storage if not s.present or s.parse_status in ("valid_json", "empty")]
    order += [("page", p.id) for p in bundle.page[:-1]]  # the latest page state stays
    # Then anomalies, oldest first, alternating kinds so no single kind is wiped out.
    anomalies = [
        [("console", c.id) for c in bundle.console if c.level == "error"],
        [("network", n.id) for n in bundle.network if n.status == 0 or n.status >= 400],
        [("storage", s.id) for s in bundle.storage if s.present and s.parse_status not in ("valid_json", "empty")],
    ]
    while any(anomalies):
        for queue in anomalies:
            if queue:
                order.append(queue.pop(0))
    return order


def budget_evidence(window: EvidenceBundle, token_budget: int = DEFAULT_TOKEN_BUDGET) -> tuple[EvidenceBundle, dict[str, Any]]:
    """The bundle the model is shown, and a report of what budgeting did."""
    report: dict[str, Any] = {"tokens_before": estimate_tokens(window), "token_budget": token_budget}

    # filter
    bundle = window.model_copy(deep=True)
    filtered = 0
    for kind, cap in PROMPT_CAPS.items():
        items = getattr(window, kind)
        filtered += max(0, len(items) - cap)
        setattr(bundle, kind, items[-cap:])

    # dedupe
    bundle.console, dup_console = _dedupe_console(bundle.console)
    bundle.network, dup_network = _dedupe_network(bundle.network)

    # truncate + prune
    truncated = 0
    for kind in ("console", "network", "storage", "page"):
        updated = []
        for item in getattr(bundle, kind):
            changes = {}
            for name, limit in TEXT_LIMITS.items():
                k, field = name.split(".")
                if k != kind:
                    continue
                value, cut = _truncate(getattr(item, field, None), limit)
                if cut:
                    changes[field] = value
                    truncated += 1
            if kind == "page" and len(item.service_worker_scopes) > 5:
                changes["service_worker_scopes"] = item.service_worker_scopes[:5]
                truncated += 1
            updated.append(item.model_copy(update=changes) if changes else item)
        setattr(bundle, kind, updated)

    # redact
    bundle = scrub_bundle(bundle)

    # cap
    dropped: dict[str, int] = {}
    if estimate_tokens(bundle) > token_budget:
        for kind, item_id in _drop_order(bundle):
            items = getattr(bundle, kind)
            if len(bundle.all_evidence_ids()) <= 1:
                break
            setattr(bundle, kind, [i for i in items if i.id != item_id])
            dropped[kind] = dropped.get(kind, 0) + 1
            if estimate_tokens(bundle) <= token_budget:
                break

    report.update(
        tokens_after=estimate_tokens(bundle),
        items_before=len(window.items()),
        items_after=len(bundle.items()),
        filtered=filtered,
        deduplicated=dup_console + dup_network,
        truncated_fields=truncated,
        dropped=dropped,
        within_budget=estimate_tokens(bundle) <= token_budget,
    )
    return bundle, report
