from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session as DBSession

from operon_backend.db import get_db, init_db
from operon_backend.db_models import SessionRecord
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
    SubmitEvidenceRequest,
    VerifyRequest,
)
from operon_backend.session_service import (
    create_session,
    get_session,
    record_action_result,
    record_approval,
    record_diagnosis,
    record_policy,
    record_verification,
)
from operon_backend.state_machine import IllegalTransition
from operon_backend.tripwire import TripwireHit, scan_raw_payload


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
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


# ---- SupportSession API — AGENT_ARCHITECTURE.md Phase 1 --------------------


def _serialize(session: SessionRecord) -> SessionOut:
    return SessionOut(
        session_id=session.id,
        phase=session.phase,
        user_issue=session.user_issue,
        issue_category=session.issue_category,
        hypotheses=session.hypotheses,
        current_hypothesis_id=session.current_hypothesis_id,
        pending_action=session.pending_action,
        verification_state=session.verification_state,
        resolution_state=session.resolution_state,
        confidence=session.confidence,
        phase_history=session.phase_history,
        diagnostic_steps=session.diagnostic_steps,
        attempted_actions=session.attempted_actions,
        step_count=session.step_count,
        tool_call_count=session.tool_call_count,
        llm_call_count=session.llm_call_count,
        action_attempt_count=session.action_attempt_count,
    )


def _get_session_or_404(db: DBSession, session_id: str) -> SessionRecord:
    session = get_session(db, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"No session '{session_id}'")
    return session


@app.post("/api/sessions", response_model=SessionOut)
async def create_session_endpoint(body: CreateSessionRequest, db: DBSession = Depends(get_db)):
    session = create_session(db, body.user_issue, body.source)
    return _serialize(session)


@app.get("/api/sessions/{session_id}", response_model=SessionOut)
async def get_session_endpoint(session_id: str, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/diagnose")
async def session_diagnose_endpoint(session_id: str, request: Request, db: DBSession = Depends(get_db)):
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
        diagnosis = await diagnose(session.user_issue, evidence_req.bundle)
    except LLMError as exc:
        return JSONResponse(status_code=400, content={"detail": f"Diagnosis failed: {exc}"})

    try:
        session = record_diagnosis(db, session, evidence_req.bundle, diagnosis)
    except IllegalTransition as exc:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    return {"diagnosis": diagnosis, "session": _serialize(session)}


@app.post("/api/sessions/{session_id}/policy")
async def session_policy_endpoint(session_id: str, request: PolicyRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    decision = evaluate(
        action_id=request.action_id,
        params=request.params,
        provider_capabilities=request.provider_capabilities,
    )
    try:
        session = record_policy(db, session, decision)
    except IllegalTransition as exc:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    return {"policy": decision, "session": _serialize(session)}


@app.post("/api/sessions/{session_id}/approve")
async def session_approve_endpoint(session_id: str, body: ApprovalRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        session = record_approval(db, session, body.approved)
    except IllegalTransition as exc:
        return JSONResponse(status_code=409, content={"detail": str(exc)})
    return _serialize(session)


@app.post("/api/sessions/{session_id}/action-result")
async def session_action_result_endpoint(session_id: str, body: ActionResultRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        session = record_action_result(db, session, body.succeeded, body.detail)
    except IllegalTransition as exc:
        return JSONResponse(status_code=409, content={"detail": str(exc)})
    return _serialize(session)


@app.post("/api/sessions/{session_id}/verify")
async def session_verify_endpoint(session_id: str, body: VerifyRequest, db: DBSession = Depends(get_db)):
    session = _get_session_or_404(db, session_id)
    try:
        session = record_verification(db, session, body.passed, body.message)
    except IllegalTransition as exc:
        return JSONResponse(status_code=409, content={"detail": str(exc)})
    return _serialize(session)
