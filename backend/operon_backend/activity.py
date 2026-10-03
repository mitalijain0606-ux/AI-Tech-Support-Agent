"""Append-only activity history for a SupportSession.

Every pipeline stage records one entry, so a session can be reconstructed
after the fact: what evidence arrived, what was retrieved, what the model
concluded, what policy decided, what the user approved, what ran, what
verification found, and why it retried or escalated.

Entries are secret-free by construction: every string is passed through the
same credential redaction the tripwire uses, and callers only pass ids,
counts, decisions and short summaries — never raw evidence or page content.
"""

from datetime import UTC, datetime
from typing import Any

from operon_backend.tripwire import redact_credentials

MAX_ACTIVITY_ENTRIES = 300


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return redact_credentials(value)[0][:500]
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_scrub(v) for v in value][:50]
    return value


def record_activity(session, kind: str, summary: str, **data: Any) -> None:
    entries = list(session.activity or [])
    if len(entries) >= MAX_ACTIVITY_ENTRIES:
        return
    entries.append(
        {
            "seq": len(entries) + 1,
            "at": datetime.now(UTC).isoformat(),
            "kind": kind,
            "phase": session.phase,
            "summary": _scrub(summary),
            "data": _scrub(data),
        }
    )
    session.activity = entries
