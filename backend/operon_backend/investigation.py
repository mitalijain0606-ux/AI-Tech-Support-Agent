"""The investigation pipeline — one bounded cycle per evidence submission.

    evidence (requested by the backend, collected by the provider)
      → understanding   deterministic anomaly summary of the evidence window
      → retrieval       real knowledge search, recorded honestly (ok / no_match /
                        empty_index / error / skipped) — never fabricated
      → diagnosis       LLM (or the labelled offline engine), grounding-validated
      → decision:
          need more evidence → a bounded EvidenceRequest, phase NEED_INFORMATION
          a fixable cause    → remediation plan, phase ACTION_PROPOSED
          no safe action     → ESCALATED with guidance

The session phase is the only authority on where an investigation is. The
state machine whitelist is enforced on every transition, and every stage
records activity. Policy, approval, execution and verification continue in
session_service.py.
"""

import hashlib
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session as DBSession
from starlette.concurrency import run_in_threadpool

from operon_backend.activity import record_activity
from operon_backend.budget import budget_evidence
from operon_backend.config import settings
from operon_backend.db_models import KnowledgeChunk, SessionRecord
from operon_backend.events import emit_stage
from operon_backend.stages import classify
from operon_backend.evidence import (
    EvidenceBudgetExhausted,
    allowed_collectors,
    build_request,
    evidence_window,
    ingest_bundle,
    issue_request,
    times_requested,
    understand,
)
from operon_backend.llm import (
    BASE_ACTIONS,
    DEFAULT_INFORMATION_REQUEST,
    LLMError,
    UngroundedDiagnosis,
    run_diagnosis,
)
from operon_backend.loop_driver import (
    CLOSED_HYPOTHESIS_STATUSES,
    MAX_IDENTICAL_REQUESTS,
    MAX_INVESTIGATION_CYCLES,
    MAX_LLM_CALLS,
    MAX_RETRIEVALS,
    MAX_TOOL_CALLS,
    LimitExceeded,
    check_limits,
    escalate,
    escalate_for_limit,
    update_or_create_hypothesis,
)
from operon_backend.planning import build_proposal
from operon_backend.retrieval import KnowledgeIndexEmpty, RetrievedChunk, build_query, search
from operon_backend.schemas import COLLECTORS, Diagnosis, EvidenceBundle
from operon_backend.state_machine import IllegalTransition, SessionPhase, transition
from operon_backend.tripwire import redact_credentials

# Phases in which the session is waiting for evidence.
INVESTIGABLE_PHASES = (SessionPhase.UNDERSTANDING.value, SessionPhase.NEED_INFORMATION.value)

def _tenant(session: SessionRecord) -> str | None:
    return (session.user_context or {}).get("tenant_id") if isinstance(session.user_context, dict) else None


def remediation_previously_failed(session: SessionRecord, action_id: str, params: dict) -> bool:
    """True if this exact action (same id and params) was already attempted
    in this session and either failed to execute or failed verification."""
    for attempt in session.attempted_actions or []:
        if attempt.get("action_id") != action_id or (attempt.get("params") or {}) != (params or {}):
            continue
        if attempt.get("succeeded") is False or attempt.get("verified") is False:
            return True
    return False


def next_cycle_blocked(session: SessionRecord, extra_tool_calls: int) -> LimitExceeded | None:
    """Would issuing another evidence request run past a hard limit?"""
    if (session.investigation_cycle or 0) >= MAX_INVESTIGATION_CYCLES:
        return LimitExceeded("max_investigation_cycles", session.investigation_cycle, MAX_INVESTIGATION_CYCLES)
    if (session.tool_call_count or 0) + extra_tool_calls > MAX_TOOL_CALLS:
        return LimitExceeded("max_tool_calls", session.tool_call_count + extra_tool_calls, MAX_TOOL_CALLS)
    if (session.llm_call_count or 0) >= MAX_LLM_CALLS:
        return LimitExceeded("max_llm_calls", session.llm_call_count, MAX_LLM_CALLS)
    return None


# ---- Retrieval --------------------------------------------------------------------


def _load_chunks(db: DBSession, record: dict[str, Any]) -> list[RetrievedChunk]:
    chunks: list[RetrievedChunk] = []
    for chunk_id, score in zip(record.get("chunk_ids", []), record.get("scores", []), strict=False):
        row = db.get(KnowledgeChunk, chunk_id)
        if row is not None:
            chunks.append(RetrievedChunk(chunk_id, row.source_type, row.source_id, row.content_text, score, row.chunk_metadata or {}))
    return chunks


async def retrieve(db: DBSession, session: SessionRecord, query: str) -> tuple[list[RetrievedChunk], dict[str, Any]]:
    """Real knowledge search for this cycle's evidence. Re-runs whenever the
    evidence changed the query; reuses the previous result when it didn't;
    records an error as an error, distinct from "nothing relevant found"."""
    previous = list(session.retrievals or [])
    performed = [r for r in previous if r["status"] in ("ok", "no_match", "error")]
    fingerprint = hashlib.sha256(query.encode()).hexdigest()[:16]
    last_good = next((r for r in reversed(previous) if r["status"] in ("ok", "no_match")), None)
    record: dict[str, Any] = {
        "seq": len(previous) + 1,
        "cycle": session.investigation_cycle,
        "query_fingerprint": fingerprint,
        "at": datetime.now(UTC).isoformat(),
        "chunk_ids": [],
        "scores": [],
        "error": None,
    }

    chunks: list[RetrievedChunk] = []
    if last_good and last_good["query_fingerprint"] == fingerprint:
        chunks = _load_chunks(db, last_good)
        record.update(status="skipped_unchanged", reused_from=last_good["seq"])
        reason = f"evidence unchanged since knowledge lookup #{last_good['seq']}; reusing its {len(chunks)} chunk(s)"
    elif len(performed) >= MAX_RETRIEVALS:
        record.update(status="skipped_budget")
        reason = "knowledge search budget exhausted; continuing without a new lookup"
    else:
        try:
            chunks = await run_in_threadpool(search, db, query, tenant_id=_tenant(session))
        except KnowledgeIndexEmpty:
            # Nothing was searched — never report this as "no match".
            record.update(status="empty_index")
            reason = "knowledge base is empty (not initialized); nothing was searched — continuing without retrieved precedent"
        except Exception as exc:  # noqa: BLE001 — any embedder/store failure (network, ONNX, OS, DB)
            record.update(status="error", error=type(exc).__name__, error_detail=redact_credentials(str(exc))[0][:200])
            reason = f"knowledge search unavailable ({type(exc).__name__}); continuing without retrieved precedent"
        else:
            if chunks:
                record.update(status="ok")
                summary = ", ".join(f"{r.chunk_id} ({r.score:.2f})" for r in chunks)
                reason = f"found {len(chunks)} relevant knowledge chunk(s): {summary}"
            else:
                record.update(status="no_match")
                reason = "no knowledge chunk scored above the similarity floor"
    if chunks:
        record.update(chunk_ids=[c.chunk_id for c in chunks], scores=[round(c.score, 4) for c in chunks])
    record["reason"] = reason
    session.retrievals = [*previous, record]
    record_activity(session, "knowledge_search", reason, status=record["status"], chunk_ids=record["chunk_ids"])
    return chunks, record


# ---- History for the model ---------------------------------------------------------------


PROPOSABLE_ACTIONS = ("clear_storage_key", "reload", "unregister_service_worker", "inspect_page", "reset_user_preference")


def _available_actions(session: SessionRecord) -> list[str]:
    """The remediation actions this session's provider declared it can perform.
    A provider that declared nothing gets the browser baseline."""
    declared = (session.environment_context or {}).get("provider_capabilities") or []
    actions = [a for a in PROPOSABLE_ACTIONS if a in declared]
    return actions or list(BASE_ACTIONS)


def investigation_history(session: SessionRecord) -> dict[str, Any]:
    return {
        "cycle": session.investigation_cycle,
        "previous_diagnoses": [
            {k: d.get(k) for k in ("cycle", "category", "root_cause", "evidence_ids", "outcome")}
            for d in (session.diagnoses or [])[-4:]
        ],
        "evidence_requests": [
            {
                "purpose": s.get("intent"),
                "collectors": s.get("expected_information"),
                "reason": s.get("reason"),
                # The user's reply is DATA (redacted and length-bounded), never an instruction.
                "question_asked": s.get("question"),
                "user_answer": s.get("answer"),
            }
            for s in (session.diagnostic_steps or [])
            if s.get("request_id")
        ][-6:],
        "attempted_actions": [
            {k: a.get(k) for k in ("action_id", "params", "succeeded", "verified", "detail")}
            for a in (session.attempted_actions or [])
        ],
        "last_verification": (session.verification_state or {}).get("message"),
    }


# ---- The cycle -------------------------------------------------------------------------


async def run_cycle(db: DBSession, session: SessionRecord, bundle: EvidenceBundle) -> Diagnosis | None:
    """Runs one investigation cycle on newly submitted evidence. Returns the
    diagnosis (or None if the session was escalated before one existed).
    Raises IllegalTransition, EvidenceRejected, or LLMError (after recording
    the failed call; the evidence is not consumed, so it can be resubmitted)."""
    if session.phase not in INVESTIGABLE_PHASES:
        raise IllegalTransition(
            f"Evidence can only be submitted in UNDERSTANDING or NEED_INFORMATION, session is in {session.phase}"
        )
    limit = check_limits(session)
    if limit:
        escalate_for_limit(db, session, limit)
        return None

    # 1. Evidence
    emit_stage(session.id, "investigate", "started")
    try:
        record = ingest_bundle(session, bundle)
    except EvidenceBudgetExhausted as exc:
        emit_stage(session.id, "investigate", "failed")
        escalate(db, session, "escalated_evidence_budget_exhausted", f"Investigation halted: {exc}")
        return None
    session.investigation_cycle = (session.investigation_cycle or 0) + 1
    record_activity(
        session,
        "evidence_received",
        f"bundle {record['bundle_id']} ({record['item_count']} item(s)) for request {record['request_id']}",
        bundle_id=record["bundle_id"],
        request_id=record["request_id"],
        collectors=record["collectors"],
        item_count=record["item_count"],
        collection_errors=record["collection_errors"],
    )
    if session.phase == SessionPhase.NEED_INFORMATION.value:
        transition(session, SessionPhase.INVESTIGATING, f"requested evidence received ({record['request_id']})")

    # 2. Understanding
    # The model reasons over (and may only cite) the budgeted window — see budget.py.
    window, budget_report = budget_evidence(evidence_window(session), settings.evidence_token_budget)
    record_activity(
        session,
        "evidence_budget",
        f"{budget_report['items_after']}/{budget_report['items_before']} item(s), ~{budget_report['tokens_after']} token(s) "
        f"(budget {budget_report['token_budget']})",
        **{k: v for k, v in budget_report.items() if k != "token_budget"},
    )
    understanding = understand(window)
    record_activity(
        session,
        "understanding",
        f"{len(understanding['anomalies'])} anomaly(ies) across {sum(understanding['counts'].values())} evidence item(s)",
        anomalies=[a["id"] for a in understanding["anomalies"]],
        collection_errors=understanding["collection_errors"],
    )

    # 3. Retrieval (real, every cycle the evidence changes)
    chunks, retrieval = await retrieve(db, session, build_query(session.user_issue, window))
    emit_stage(session.id, "investigate", "finished", retrieval=retrieval["status"])
    transition(session, SessionPhase.KNOWLEDGE_LOOKUP, retrieval["reason"])
    transition(session, SessionPhase.INVESTIGATING, f"reasoning over {len(window.all_evidence_ids())} evidence item(s)")

    # 4. Diagnosis
    emit_stage(session.id, "classify", "started")
    classification = classify(session.user_issue, window)
    emit_stage(session.id, "classify", "finished", category=classification.category, confidence=classification.confidence)
    emit_stage(session.id, "diagnose", "started")
    knowledge_context = [{"chunk_id": c.chunk_id, "content": c.content_text, "score": round(c.score, 3)} for c in chunks]
    try:
        run = await run_diagnosis(
            session.user_issue,
            window,
            knowledge_context,
            history=investigation_history(session),
            understanding=understanding,
            available_collectors=allowed_collectors(session, list(COLLECTORS))[0],
            available_actions=_available_actions(session),
        )
    except UngroundedDiagnosis as exc:
        session.llm_call_count = (session.llm_call_count or 0) + exc.llm_calls
        session.diagnoses = [
            *(session.diagnoses or []),
            {"seq": len(session.diagnoses or []) + 1, "cycle": session.investigation_cycle, "outcome": "rejected",
             "problems": exc.problems, "at": datetime.now(UTC).isoformat()},
        ]
        record_activity(session, "diagnosis_rejected", "; ".join(exc.problems), llm_calls=exc.llm_calls)
        escalate(
            db, session, "escalated_ungrounded_diagnosis",
            "The diagnosis could not be grounded in the collected evidence after one regeneration; "
            "no action will be taken on an unsupported claim.",
        )
        return None
    except LLMError as exc:
        db.rollback()
        db.refresh(session)
        session.llm_call_count = (session.llm_call_count or 0) + max(exc.llm_calls, 1)
        record_activity(session, "diagnosis_failed", str(exc)[:200], llm_calls=max(exc.llm_calls, 1))
        db.commit()
        raise

    diagnosis = run.diagnosis
    session.llm_call_count = (session.llm_call_count or 0) + run.llm_calls
    session.confidence = diagnosis.confidence
    session.issue_category = diagnosis.category
    session.knowledge_references = list(diagnosis.knowledge_refs)

    session.diagnoses = [
        *(session.diagnoses or []),
        {
            "seq": len(session.diagnoses or []) + 1,
            "cycle": session.investigation_cycle,
            "engine": run.engine,
            "pipeline": run.pipeline,
            "stages": run.stages,
            "llm_calls": run.llm_calls,
            "rejected_answers": run.rejected,
            "category": diagnosis.category,
            "root_cause": diagnosis.root_cause,
            "reasoning": diagnosis.reasoning[:1000],
            "evidence_ids": diagnosis.evidence_ids,
            "knowledge_refs": diagnosis.knowledge_refs,
            "confidence": diagnosis.confidence,
            "proposed_action": diagnosis.proposed_action.model_dump() if diagnosis.proposed_action else None,
            "information_request": diagnosis.information_request.model_dump() if diagnosis.information_request else None,
            "outcome": None,
            "at": datetime.now(UTC).isoformat(),
        },
    ]
    record_activity(
        session,
        "diagnosis",
        f"[{run.engine}] {diagnosis.category}: {diagnosis.root_cause}",
        evidence_ids=diagnosis.evidence_ids,
        knowledge_refs=diagnosis.knowledge_refs,
        confidence=diagnosis.confidence,
        regenerated=bool(run.rejected),
    )

    # 5. Decision
    emit_stage(session.id, "diagnose", "finished", engine=run.engine)
    emit_stage(session.id, "plan", "started")
    outcome = _decide(db, session, diagnosis, window)
    emit_stage(session.id, "plan", "finished", outcome=outcome)
    diagnoses = [dict(d) for d in session.diagnoses]
    diagnoses[-1]["outcome"] = outcome
    session.diagnoses = diagnoses
    db.commit()
    db.refresh(session)
    return diagnosis


def _decide(db: DBSession, session: SessionRecord, diagnosis: Diagnosis, window: EvidenceBundle) -> str:
    """Turns a grounded diagnosis into the next phase. Returns the outcome."""
    action = diagnosis.proposed_action
    wants_information = diagnosis.category == "insufficient_evidence" or (
        action is None and diagnosis.information_request is not None
    )

    if wants_information:
        update_or_create_hypothesis(
            session,
            description=diagnosis.root_cause,
            confidence=diagnosis.confidence,
            status="candidate",
            supporting_evidence_ids=diagnosis.evidence_ids,
        )
        info = diagnosis.information_request or DEFAULT_INFORMATION_REQUEST
        request, refused = build_request(
            session,
            purpose="information",
            collectors=info.collectors,
            params=info.params,
            reason=info.reason,
            requires_user_action=info.requires_user_action,
            question=info.question,
        )
        if request is None:
            escalate(db, session, "escalated_requested_evidence_unavailable",
                     f"The investigation needs evidence this provider can't collect ({'; '.join(refused)}).",
                     guidance=diagnosis.reasoning)
            return "escalated"
        if times_requested(session, request) >= MAX_IDENTICAL_REQUESTS:
            escalate(db, session, "escalated_repeated_information_request",
                     f"The same evidence ({', '.join(request.collectors)}) was already requested "
                     f"{MAX_IDENTICAL_REQUESTS} time(s) without revealing the cause.",
                     guidance=diagnosis.reasoning)
            return "escalated"
        blocked = next_cycle_blocked(session, len(request.collectors))
        if blocked:
            escalate_for_limit(db, session, blocked)
            return "escalated"
        issue_request(session, request, refused)
        transition(session, SessionPhase.NEED_INFORMATION, f"more evidence needed: {request.reason}")
        return "need_information"

    if action is not None:
        already_failed = remediation_previously_failed(session, action.action_id, action.params)
        hyp = update_or_create_hypothesis(
            session,
            description=diagnosis.root_cause,
            confidence=diagnosis.confidence,
            status="confirmed" if diagnosis.resolvable_automatically else "supported",
            supporting_evidence_ids=diagnosis.evidence_ids,
        )
        # Never re-propose a remediation that already failed, and never
        # advance a hypothesis that verification already refuted.
        if already_failed:
            escalate(db, session, "escalated_remediation_already_failed",
                     f"proposed remediation '{action.action_id}' with params {action.params} already failed in this "
                     f"session; not retrying it unchanged", guidance=diagnosis.reasoning)
            return "escalated"
        if hyp.status in CLOSED_HYPOTHESIS_STATUSES:
            escalate(db, session, "escalated_hypothesis_contradicted",
                     f"evidence still points to {hyp.hypothesis_id}, which was already {hyp.status}; "
                     f"no alternative explanation found", guidance=diagnosis.reasoning)
            return "escalated"
        if diagnosis.confidence < settings.min_action_confidence:
            escalate(db, session, "escalated_low_confidence",
                     f"the diagnosis proposes '{action.action_id}' with confidence {diagnosis.confidence:.2f}, below the "
                     f"{settings.min_action_confidence:.2f} needed to act automatically; a human should confirm the cause",
                     guidance=diagnosis.reasoning)
            return "escalated"

        transition(session, SessionPhase.HYPOTHESIS_FORMED, f"formed {hyp.hypothesis_id} from the diagnosis")
        transition(session, SessionPhase.DIAGNOSING, "evaluating the hypothesis against the evidence")
        proposal = build_proposal(
            diagnosis,
            window,
            attempt=(session.action_attempt_count or 0) + 1,
            previous=session.pending_action,
            last_verification=session.verification_state,
        )
        session.pending_action = proposal.model_dump()
        session.policy_decision = None
        session.approval = None
        transition(session, SessionPhase.ACTION_PROPOSED, f"proposed {proposal.action_id} ({proposal.proposal_id})")
        record_activity(
            session,
            "action_proposed",
            f"{proposal.action_id} {proposal.parameters} — expected: {proposal.expected_effect}",
            proposal_id=proposal.proposal_id,
            action_id=proposal.action_id,
            target=proposal.target,
            attempt=proposal.attempt,
            retry_of=proposal.retry_of,
            verification=proposal.verification.strategy if proposal.verification else None,
        )
        return "action_proposed"

    hyp = update_or_create_hypothesis(
        session,
        description=diagnosis.root_cause,
        confidence=diagnosis.confidence,
        status="supported" if diagnosis.evidence_ids else "candidate",
        supporting_evidence_ids=diagnosis.evidence_ids,
    )
    transition(session, SessionPhase.HYPOTHESIS_FORMED, f"formed {hyp.hypothesis_id} from the diagnosis")
    transition(session, SessionPhase.DIAGNOSING, "evaluating the hypothesis against the evidence")
    escalate(db, session, "escalated_no_action_available", diagnosis.reasoning, guidance=diagnosis.reasoning)
    return "no_action"
