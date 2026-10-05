import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session as DBSession

from operon_backend.db import SessionLocal, get_db, init_db
from operon_backend.db_models import SessionRecord
from operon_backend.evidence import EvidenceRejected
from operon_backend.investigation import run_cycle
from operon_backend.knowledge import ensure_knowledge_base
from operon_backend.llm import LLMError, diagnose
from operon_backend.policy import evaluate
from operon_backend.schemas import (
    ActionResultRequest,
    ApprovalRequest,
    CreateSessionRequest,
    DiagnoseRequest,
    Diagnosis,
    PolicyDecision,
    PolicyRequest,
    SessionOut,
    SessionPolicyRequest,
    SubmitEvidenceRequest,
    VerifyRequest,
)
from operon_backend.session_service import (
    RequestMismatch,
    apply_policy,
    create_session,
    get_session,
    record_action_result,
    record_approval,
    record_verification,
)
from operon_backend.state_machine import IllegalTransition, SessionPhase
from operon_backend.tripwire import TripwireHit, scan_raw_payload

logger = logging.getLogger(__name__)


def initialize_knowledge_base() -> dict | None:
    """Indexes the curated knowledge base on a fresh database (a no-op when it
    is already indexed). Never fatal: if the embedding model can't load, the
    backend still serves, and retrieval reports the index as empty/unavailable
    instead of pretending it searched."""
    db = SessionLocal()
    try:
        result = ensure_knowledge_base(db)
    except Exception as exc:  # noqa: BLE001 — embedder/network/disk; retrieval reports it per session
        db.rollback()
        logger.warning("Knowledge base not initialized (%s: %s); retrieval will report it", type(exc).__name__, str(exc)[:200])
        return None
    finally:
        db.close()
    logger.info("Knowledge base %s: %d curated chunk(s)", result["status"], result["chunks"])
    return result


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    await run_in_threadpool(initialize_knowledge_base)
    yield


app = FastAPI(title="Operon Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


# ---- Legacy stateless endpoints — unchanged, kept for backward compat -----


@app.post("/api/policy", response_model=PolicyDecision)
async def policy_endpoint(request: PolicyRequest):
    return evaluate(
        action_id=request.action_id,
        params=request.params,
        provider_capabilities=request.provider_capabilities,
    )


@app.post("/api/diagnose", response_model=Diagnosis)
async def diagnose_endpoint(request: Request):
    body_bytes = await request.body()
    raw_body = body_bytes.decode("utf-8", errors="replace")

    try:
        scan_raw_payload(raw_body)
    except TripwireHit as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": f"Security Tripwire Triggered: {exc.detail}"},
        )

    try:
        diagnose_req = DiagnoseRequest.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": f"Invalid request body: {exc}"},
        )

    try:
        diagnosis = await diagnose(diagnose_req.message, diagnose_req.bundle)
        return diagnosis
    except LLMError as exc:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Diagnosis failed: {exc}"},
        )


# ---- SupportSession API ------------------------------------------------------------


def _serialize(session: SessionRecord) -> SessionOut:
    return SessionOut(
        session_id=session.id,
        phase=session.phase,
        user_issue=session.user_issue,
        issue_category=session.issue_category,
        hypotheses=session.hypotheses or [],
        current_hypothesis_id=session.current_hypothesis_id,
        knowledge_references=session.knowledge_references or [],
        evidence_request=session.evidence_request,
        evidence_bundles=[
            {k: r.get(k) for k in ("bundle_id", "request_id", "purpose", "cycle", "after_attempt", "collectors",
                                   "collection_errors", "item_count", "received_at")}
            for r in (session.collected_evidence or [])
            if "bundle" in r
        ],
        investigation_cycle=session.investigation_cycle or 0,
        diagnoses=session.diagnoses or [],
        retrievals=session.retrievals or [],
        pending_action=session.pending_action,
        policy_decision=session.policy_decision,
        approval=session.approval,
        verification_state=session.verification_state,
        escalation_state=session.escalation_state,
        resolution_state=session.resolution_state,
        confidence=session.confidence or 0.0,
        phase_history=session.phase_history or [],
        diagnostic_steps=session.diagnostic_steps or [],
        attempted_actions=session.attempted_actions or [],
        activity=session.activity or [],
        step_count=session.step_count or 0,
        tool_call_count=session.tool_call_count or 0,
        llm_call_count=session.llm_call_count or 0,
        action_attempt_count=session.action_attempt_count or 0,
    )


def _get_session_or_404(db: DBSession, session_id: str) -> SessionRecord:
    session = get_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No session '{session_id}'")
    return session


def _conflict(exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.post("/api/sessions", response_model=SessionOut)
async def create_session_endpoint(body: CreateSessionRequest, db: DBSession = Depends(get_db)):
    session = create_session(db, body.user_issue, body.source, body.provider_capabilities, body.collectors)
    return _serialize(session)


@app.get("/api/sessions/{session_id}", response_model=SessionOut)
async def get_session_endpoint(session_id: str, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/investigate")
async def session_investigate_endpoint(session_id: str, request: Request, db: DBSession = Depends(get_db)):
    """Submits the evidence the session asked for and runs one bounded
    investigation cycle (understanding → retrieval → diagnosis → decision)."""
    session = _get_session_or_404(db, session_id)

    body_bytes = await request.body()
    raw_body = body_bytes.decode("utf-8", errors="replace")

    try:
        scan_raw_payload(raw_body)
    except TripwireHit as exc:
        return JSONResponse(status_code=422, content={"detail": f"Security Tripwire Triggered: {exc.detail}"})

    try:
        evidence_req = SubmitEvidenceRequest.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return JSONResponse(status_code=422, content={"detail": f"Invalid request body: {exc}"})

    try:
        diagnosis = await run_cycle(db, session, evidence_req.bundle)
    except IllegalTransition as exc:
        return _conflict(exc)
    except EvidenceRejected as exc:
        return JSONResponse(status_code=409 if exc.conflict else 422, content={"detail": exc.detail})
    except LLMError as exc:
        return JSONResponse(status_code=400, content={"detail": f"Diagnosis failed: {exc}"})

    db.refresh(session)
    # The response must agree with the session: a proposed action is only
    # returned when the session actually reached ACTION_PROPOSED.
    if diagnosis is not None and diagnosis.proposed_action is not None and session.phase != SessionPhase.ACTION_PROPOSED.value:
        diagnosis = diagnosis.model_copy(update={"proposed_action": None, "resolvable_automatically": False})
    return {"diagnosis": diagnosis, "session": _serialize(session)}


# Kept as an alias of /investigate for existing clients.
@app.post("/api/sessions/{session_id}/diagnose")
async def session_diagnose_endpoint(session_id: str, request: Request, db: DBSession = Depends(get_db)):
    return await session_investigate_endpoint(session_id, request, db)


@app.post("/api/sessions/{session_id}/policy")
async def session_policy_endpoint(session_id: str, body: SessionPolicyRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        decision = apply_policy(db, session, body)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return {"policy": decision, "session": _serialize(session)}


@app.post("/api/sessions/{session_id}/approve")
async def session_approve_endpoint(session_id: str, body: ApprovalRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        session = record_approval(db, session, body.approved)
    except IllegalTransition as exc:
        return _conflict(exc)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/action-result")
async def session_action_result_endpoint(session_id: str, body: ActionResultRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        session = record_action_result(db, session, body.action_id, body.succeeded, body.detail)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/verify")
async def session_verify_endpoint(session_id: str, request: Request, db: DBSession = Depends(get_db)):
    """The provider reports what it observed after the action; the backend
    decides whether the cited problem is gone."""
    session = _get_session_or_404(db, session_id)
    raw_body = (await request.body()).decode("utf-8", errors="replace")
    try:
        scan_raw_payload(raw_body)
    except TripwireHit as exc:
        return JSONResponse(status_code=422, content={"detail": f"Security Tripwire Triggered: {exc.detail}"})
    try:
        body = VerifyRequest.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return JSONResponse(status_code=422, content={"detail": f"Invalid request body: {exc}"})
    try:
        session = record_verification(db, session, body.action_id, body.observation)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return _serialize(session)
