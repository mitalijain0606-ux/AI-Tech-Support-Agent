"""One problem per investigation, and the others are not lost.

A session investigates exactly one problem: it has one pending fix and one verification,
and "resolved" must mean that problem is gone. A complaint often describes several
problems, though ("the dates are missing, and also the reports page won't load"), and
the evidence can show a second fault the diagnosis did not explain (corrupted storage
plus a failing API). Before this module both were silently dropped, and a verified fix
marked the whole complaint resolved.

Now:
- `split_complaint` splits a complaint into separate problem statements. The session
  investigates the first; the rest are recorded as additional issues.
- `uncited_faults` finds server errors and blocked requests in the evidence that the
  diagnosis did not cite, when the diagnosis is not about the network at all. Console
  errors are not counted: they are usually the symptom of the fault that was diagnosed.
- Additional issues are returned with the session, shown by the widget and the popup
  ("report this separately"), and included in an escalation ticket.

Deterministic, no model call: a wrong split only means the user is told about an extra
problem, never that a fix is applied for it.
"""

import re
from typing import Any

# Words that make a clause a problem statement rather than context ("I was on the
# account page").
_PROBLEM = re.compile(
    r"\b(not|no|n't|never|cannot|can't|won't|doesn't|isn't|aren't|didn't|broken|break|breaks|error|errors|fail|fails|failed|failing|"
    r"missing|blank|empty|crash|crashes|crashed|stuck|slow|disabled|wrong|unavailable|unable|freez\w*|hang\w*|down|"
    r"500|404|401|403|timeout|timed out|logged out|signed out)\b",
    re.I,
)
# Where one problem ends and another begins.
_SPLIT = re.compile(
    r"(?:\n\s*(?:[-*•]|\d+[.)])\s*)"                       # a new bullet or numbered line
    r"|(?:\s*;\s*)"                                          # a semicolon
    r"|(?:[.!?]\s+(?=(?:also|additionally|another|plus|and also|on top of that|separately|second(?:ly)?|besides)\b))"
    r"|(?:,?\s+(?:and also|and additionally|also|plus|as well as that|on top of that)\s+)",
    re.I,
)
MIN_WORDS = 3
MAX_ISSUES = 5


def _clean(part: str) -> str:
    part = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", part).strip(" ,.;:-\n\t")
    part = re.sub(r"^(?:also|additionally|another (?:problem|issue|thing)(?: is)?|plus|and|second(?:ly)?|besides|separately),?\s+", "", part, flags=re.I)
    return part[:1].upper() + part[1:] if part else part


def split_complaint(text: str) -> list[str]:
    """The separate problems in a complaint, first one first. A complaint about one
    problem comes back as a single item (the original text, unchanged)."""
    parts = [_clean(p) for p in _SPLIT.split(text or "") if p and p.strip()]
    problems = [p for p in parts if len(p.split()) >= MIN_WORDS and _PROBLEM.search(p)]
    if len(problems) < 2:
        return [text]
    return problems[:MAX_ISSUES]


def uncited_faults(understanding: dict[str, Any] | None, cited_ids: list[str], category: str | None) -> list[dict[str, str]]:
    """Server errors and blocked requests the diagnosis did not cite, when the diagnosis
    cited no network evidence and is not itself about the network."""
    anomalies = (understanding or {}).get("anomalies") or []
    by_id = {a.get("id"): a for a in anomalies}
    cited = set(cited_ids or [])
    if any((by_id.get(i) or {}).get("kind") == "network" for i in cited):
        return []
    if category and any(word in category for word in ("network", "auth", "cors", "server", "blocked")):
        return []
    faults = []
    for a in anomalies:
        if a.get("kind") != "network" or a.get("id") in cited:
            continue
        summary = a.get("summary", "")
        if re.search(r"-> 5\d\d\b|blocked by client", summary):
            faults.append({"text": f"The page also shows a failing request: {summary}", "source": "evidence", "evidence_id": a.get("id")})
    return faults[:MAX_ISSUES]


def merge(existing: list[dict] | None, new: list[dict]) -> list[dict]:
    """Adds new issues, skipping ones already recorded (same text or evidence id)."""
    out = list(existing or [])
    seen = {(i.get("evidence_id") or i.get("text")) for i in out}
    for issue in new:
        key = issue.get("evidence_id") or issue.get("text")
        if key not in seen:
            out.append(issue)
            seen.add(key)
    return out[:MAX_ISSUES]
