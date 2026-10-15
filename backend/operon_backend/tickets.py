"""Escalation tickets: the hand-off to a human when Operon stops.

Every escalation (policy DENY, an ungrounded or low-confidence diagnosis, a
remediation that failed verification, a hard limit, a problem no browser action
can fix) opens exactly one ticket for its session. The ticket carries a
structured report — the user's message, the evidence, every diagnosis, the
hypotheses, the attempted actions and their outcomes, the policy decision, the
verification result and the activity timeline — so a support engineer can pick
the case up without re-running anything or asking the user to repeat it.

What a report may contain: only what the session already stored, which has
already passed the tripwire and the free-text redaction on the way in. The
report is built from those stored values and redacted once more (defense in
depth), and bounded in size. It never contains cookie values, tokens, request
bodies or page HTML — the evidence model has no field that could hold them.

Access: a ticket belongs to its session's tenant and is visible to exactly the
principals that can see the session (auth.can_access) — an admin sees every
ticket of their tenant, a user their own. Only an admin may change a ticket's
status. A ticket of another tenant does not exist for the caller (404).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session as DBSession

from operon_backend.auth import Principal
from operon_backend.db_models import SessionRecord, Ticket
from operon_backend.tripwire import redact_free_text

REPORT_VERSION = 1
TICKET_STATUSES = ("open", "acknowledged", "closed")

# Bounds, so one runaway session cannot produce a multi-megabyte ticket.
MAX_REPORT_EVIDENCE_BUNDLES = 10
MAX_REPORT_ITEMS_PER_KIND = 40
MAX_REPORT_ACTIVITY = 150
MAX_STRING = 2000


def _clean(value: Any, depth: int = 0) -> Any:
    """Redacts every string again and bounds lengths and nesting."""
    if depth > 8:
        return None
    if isinstance(value, str):
        return redact_free_text(value)[0][:MAX_STRING]
    if isinstance(value, dict):
        return {str(k)[:100]: _clean(v, depth + 1) for k, v in list(value.items())[:100]}
    if isinstance(value, list | tuple):
        return [_clean(v, depth + 1) for v in list(value)[:200]]
    if isinstance(value, bool | int | float) or value is None:
        return value
    return _clean(str(value), depth + 1)


def _evidence_section(session: SessionRecord) -> list[dict[str, Any]]:
    bundles = [r for r in (session.collected_evidence or []) if isinstance(r, dict) and "bundle" in r]
    out = []
    for record in bundles[-MAX_REPORT_EVIDENCE_BUNDLES:]:
        bundle = record.get("bundle") or {}
        out.append(
            {
                "bundle_id": record.get("bundle_id"),
                "request_id": record.get("request_id"),
                "purpose": record.get("purpose"),
                "cycle": record.get("cycle"),
                "after_attempt": record.get("after_attempt"),
                "collectors": record.get("collectors"),
                "collection_errors": record.get("collection_errors"),
                "received_at": record.get("received_at"),
                "url": bundle.get("url"),
                "items": {
                    kind: list(bundle.get(kind) or [])[:MAX_REPORT_ITEMS_PER_KIND]
                    for kind in ("console", "network", "storage", "cookies", "page")
                },
            }
        )
    return out


def build_report(session: SessionRecord) -> dict[str, Any]:
    """The structured escalation report for `session` (already redacted)."""
    escalation = session.escalation_state or {}
    diagnoses = list(session.diagnoses or [])
    latest = next((d for d in reversed(diagnoses) if d.get("root_cause")), None)
    report = {
        "report_version": REPORT_VERSION,
        "session_id": session.id,
        "source": session.source,
        "created_at": session.created_at.isoformat() if session.created_at else None,
        "user_message": session.user_issue,
        "issue_category": session.issue_category,
        "confidence": session.confidence or 0.0,
        "escalation": {
            "reason": escalation.get("reason"),
            "resolution_state": session.resolution_state,
            "from_phase": escalation.get("from_phase"),
            "guidance": escalation.get("guidance"),
            "at": escalation.get("at"),
        },
        "summary": {
            "root_cause": (latest or {}).get("root_cause"),
            "category": (latest or {}).get("category"),
            "engine": (latest or {}).get("engine"),
            "investigation_cycles": session.investigation_cycle or 0,
            "evidence_bundles": len(session.collected_evidence or []),
            "llm_calls": session.llm_call_count or 0,
            "action_attempts": session.action_attempt_count or 0,
        },
        "provider": {
            "capabilities": list((session.environment_context or {}).get("provider_capabilities") or []),
            "collectors": list((session.environment_context or {}).get("collectors") or []),
        },
        "evidence": _evidence_section(session),
        "diagnoses": diagnoses,
        "hypotheses": list(session.hypotheses or []),
        "knowledge_references": list(session.knowledge_references or []),
        "questions": [
            {k: s.get(k) for k in ("request_id", "question", "answer", "answered_by")}
            for s in (session.diagnostic_steps or [])
            if isinstance(s, dict) and s.get("question")
        ],
        "pending_action": session.pending_action,
        "policy_decision": session.policy_decision,
        "approval": session.approval,
        "attempted_actions": list(session.attempted_actions or []),
        "verification": session.verification_state,
        "phase_history": list(session.phase_history or []),
        "activity": list(session.activity or [])[-MAX_REPORT_ACTIVITY:],
    }
    return _clean(report)


def new_ticket_id(db: DBSession, session: SessionRecord) -> str:
    """The id the session's ticket has (or will have once opened)."""
    existing = db.query(Ticket).filter(Ticket.session_id == session.id).one_or_none()
    return existing.id if existing is not None else f"tkt_{uuid.uuid4().hex[:16]}"


def open_ticket(db: DBSession, session: SessionRecord, ticket_id: str | None = None) -> Ticket:
    """Opens the ticket for an escalated session (idempotent: one per session).
    Does not commit — called inside escalate(), which commits."""
    existing = db.query(Ticket).filter(Ticket.session_id == session.id).one_or_none()
    report = build_report(session)
    now = datetime.now(UTC)
    if existing is not None:
        existing.report = report
        existing.updated_at = now
        return existing
    escalation = session.escalation_state or {}
    ticket = Ticket(
        id=ticket_id or f"tkt_{uuid.uuid4().hex[:16]}",
        session_id=session.id,
        tenant_id=session.tenant_id or "public",
        created_by=session.created_by,
        status="open",
        resolution_state=session.resolution_state,
        reason=redact_free_text(str(escalation.get("reason") or ""))[0][:500],
        category=session.issue_category,
        report=report,
        created_at=now,
        updated_at=now,
    )
    db.add(ticket)
    return ticket


# ---- access ----------------------------------------------------------------------------------


def visible_tickets(db: DBSession, principal: Principal, *, status: str | None = None, limit: int = 50, offset: int = 0) -> list[Ticket]:
    """Tickets `principal` may see: own tenant only; all of it for an admin,
    otherwise only tickets of sessions the principal created. Newest first."""
    query = db.query(Ticket).filter(Ticket.tenant_id == principal.tenant_id)
    if principal.role != "admin":
        query = query.filter(Ticket.created_by == principal.subject)
    if status:
        query = query.filter(Ticket.status == status)
    return query.order_by(Ticket.created_at.desc(), Ticket.id).offset(max(offset, 0)).limit(max(1, min(limit, 200))).all()


def get_visible_ticket(db: DBSession, principal: Principal, ticket_id: str) -> Ticket | None:
    ticket = db.get(Ticket, ticket_id)
    if ticket is None or ticket.tenant_id != principal.tenant_id:
        return None
    if principal.role != "admin" and ticket.created_by != principal.subject:
        return None
    return ticket


def set_status(db: DBSession, ticket: Ticket, status: str, principal: Principal, note: str | None = None) -> Ticket:
    if status not in TICKET_STATUSES:
        raise ValueError(f"status must be one of {TICKET_STATUSES}")
    if principal.role != "admin":
        raise PermissionError("Only an admin may change a ticket's status.")
    history = list(ticket.status_history or [])
    history.append(
        {
            "from": ticket.status,
            "to": status,
            "by": principal.subject,
            "note": redact_free_text(note or "")[0][:500] or None,
            "at": datetime.now(UTC).isoformat(),
        }
    )
    ticket.status = status
    ticket.status_history = history
    ticket.updated_at = datetime.now(UTC)
    db.commit()
    db.refresh(ticket)
    return ticket


def summary(ticket: Ticket) -> dict[str, Any]:
    report = ticket.report or {}
    return {
        "ticket_id": ticket.id,
        "session_id": ticket.session_id,
        "status": ticket.status,
        "resolution_state": ticket.resolution_state,
        "reason": ticket.reason,
        "category": ticket.category,
        "user_message": (report.get("user_message") or "")[:200],
        "created_by": ticket.created_by,
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
        "updated_at": ticket.updated_at.isoformat() if ticket.updated_at else None,
    }


def detail(ticket: Ticket) -> dict[str, Any]:
    return {**summary(ticket), "status_history": list(ticket.status_history or []), "report": ticket.report or {}}
