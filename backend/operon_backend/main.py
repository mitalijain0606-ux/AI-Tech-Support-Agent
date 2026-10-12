import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import ValidationError
from sqlalchemy.orm import Session as DBSession

from sqlalchemy import text

from operon_backend import embeddings
from operon_backend.auth import Principal, current_principal, require_session_access
from operon_backend.config import settings
from operon_backend.db import SessionLocal, get_db, init_db
from operon_backend.db_models import SessionRecord
from operon_backend.events import sse_stream
from operon_backend.evidence import EvidenceRejected
from operon_backend.investigation import run_cycle
from operon_backend.knowledge import ensure_knowledge_base
from operon_backend.llm import LLMError, diagnose
from operon_backend.logging_config import RequestLogMiddleware, configure_logging
from operon_backend.policy import evaluate
from operon_backend.ratelimit import rate_limited
from operon_backend.retrieval import knowledge_index_size
from operon_backend.schemas import (
    ActionResultRequest,
    AnswerRequest,
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
    record_answer,
    record_approval,
    record_verification,
)
from operon_backend.state_machine import IllegalTransition, SessionPhase
from operon_backend.tripwire import TripwireHit, redact_free_text, scan_raw_payload

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


def check_configuration() -> None:
    """Logs every configuration problem; in production an "error" refuses to start."""
    errors = []
    for level, message in settings.problems():
        (logger.error if level == "error" else logger.warning)("configuration: %s", message)
        if level == "error":
            errors.append(message)
    if errors and settings.environment == "production":
        raise RuntimeError("Refusing to start with an unsafe configuration: " + "; ".join(errors))


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging(settings.log_level, settings.log_format)
    check_configuration()
    init_db()
    await run_in_threadpool(initialize_knowledge_base)
    yield


def api_docs_urls(environment: str) -> dict[str, str | None]:
    """Interactive API documentation and the OpenAPI schema are a development aid.
    In production they are not served at all (a 404, not an authenticated page): the
    schema lists every route and field, which an anonymous caller has no need for."""
    if environment == "production":
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {"docs_url": "/docs", "redoc_url": "/redoc", "openapi_url": "/openapi.json"}


app = FastAPI(title="Operon Backend", lifespan=lifespan, **api_docs_urls(settings.environment))

def configure_cors(target: FastAPI, origins: list[str]) -> None:
    """CORS applies to page JavaScript only. The extension is not subject to it
    (its manifest lists the backend origin in host_permissions), so the default
    is no cross-origin access at all; origins are opt-in via CORS_ALLOW_ORIGINS."""
    if not origins:
        return
    target.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID", "Retry-After"],
        allow_credentials=False,
    )


configure_cors(app, settings.cors_origins)
app.add_middleware(RequestLogMiddleware)


@app.get("/health")
async def health():
    """Liveness: the process is up. Cheap and dependency-free, so an orchestrator
    can restart on failure without a flapping database taking the service down."""
    return {"status": "ok"}


async def readiness_viewer(request: Request, db: DBSession = Depends(get_db)) -> Principal | None:
    """Who is asking /ready: nobody (no credentials sent) or an authenticated
    principal. This is the normal authentication — a bad key is the same 401 and
    counts toward the same failed-attempt throttle — it is just not *required*,
    because an anonymous probe is allowed to get the minimal answer."""
    if not request.headers.get("authorization"):
        return None
    return await current_principal(request, db)


def may_see_readiness_detail(principal: Principal | None) -> bool:
    """Detail is for an authenticated admin. Outside production there is nothing to
    protect (development and test environments), so it is shown to everyone."""
    if settings.environment != "production":
        return True
    return principal is not None and principal.role == "admin"


@app.get("/ready")
async def ready(viewer: Principal | None = Depends(readiness_viewer)):
    """Readiness: can this instance do useful work right now?

    Anonymous callers in production get a generic answer only — `{"status": "ok"}`
    (200) or `{"status": "unavailable"}` (503, the database cannot be reached) — and
    nothing else: no database type, counts, model state, model name, configuration
    problems or error detail. A degraded-but-serving instance (empty knowledge
    base, embedding model not loaded) is still "ok" to them. An authenticated admin
    key (or any caller outside production) gets the full diagnostics: "ready" /
    "degraded" / "unavailable" with the individual checks. Values of secrets are never
    reported to anyone — only whether they are configured.

    Orchestrator health checks should use /health, which needs no credentials."""
    checks: dict[str, object] = {}
    db_ok = True
    db = SessionLocal()
    try:
        db.execute(text("SELECT 1"))
        checks["database"] = {"status": "ok", "kind": db.get_bind().dialect.name}
        checks["knowledge_base"] = {"curated_chunks": knowledge_index_size(db)}
    except Exception as exc:  # noqa: BLE001 — any driver error means "not ready"
        db_ok = False
        checks["database"] = {"status": "error", "error": type(exc).__name__}
    finally:
        db.close()
    status_code = 200 if db_ok else 503
    if not may_see_readiness_detail(viewer):
        return JSONResponse(status_code=status_code, content={"status": "ok" if db_ok else "unavailable"})
    checks["embeddings"] = embeddings.status()
    checks["groq"] = {"configured": bool(settings.groq_api_key.strip()), "model": settings.groq_model}
    checks["environment"] = settings.environment
    degraded = db_ok and (
        checks.get("knowledge_base", {}).get("curated_chunks", 0) == 0 or checks["embeddings"]["unavailable"]  # type: ignore[union-attr, index]
    )
    status = "unavailable" if not db_ok else "degraded" if degraded else "ready"
    return JSONResponse(
        status_code=status_code,
        content={"status": status, "checks": checks, "config_problems": [m for _, m in settings.problems()]},
    )


# ---- Legacy stateless endpoints — unchanged, kept for backward compat -----


@app.post("/api/policy", response_model=PolicyDecision)
async def policy_endpoint(request: PolicyRequest, _principal: Principal = Depends(rate_limited())):
    return evaluate(
        action_id=request.action_id,
        params=request.params,
        provider_capabilities=request.provider_capabilities,
    )


@app.post("/api/diagnose", response_model=Diagnosis)
async def diagnose_endpoint(request: Request, _principal: Principal = Depends(rate_limited("llm"))):
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
        diagnosis = await diagnose(redact_free_text(diagnose_req.message)[0], diagnose_req.bundle)
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
        source=session.source,
        provider_capabilities=list((session.environment_context or {}).get("provider_capabilities") or []),
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


def _get_session_or_404(db: DBSession, session_id: str, principal: Principal, *, write: bool = False) -> SessionRecord:
    """The session, only if `principal` may see it (tenant and owner checked
    on the server). Anything else — absent, another tenant's, another user's —
    is the same 404."""
    return require_session_access(get_session(db, session_id), principal, write=write, session_id=session_id)


def _conflict(exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


@app.post("/api/sessions", response_model=SessionOut)
async def create_session_endpoint(
    body: CreateSessionRequest, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    if not principal.can_write:
        raise HTTPException(status_code=403, detail="This API key is read-only")
    session = create_session(db, body.user_issue, body.source, body.provider_capabilities, body.collectors, principal)
    return _serialize(session)


@app.get("/api/sessions/{session_id}", response_model=SessionOut)
async def get_session_endpoint(session_id: str, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())):
    session = _get_session_or_404(db, session_id, principal)
    return _serialize(session)


@app.get("/api/sessions/{session_id}/events")
async def session_events_endpoint(
    session_id: str, request: Request, after: int = 0, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    """Live progress for one session as Server-Sent Events: every activity entry
    and pipeline stage boundary as it happens. Resume with `?after=<id>` or the
    `Last-Event-ID` header. Progress, not truth: re-read the session for the
    committed state."""
    _get_session_or_404(db, session_id, principal)
    last_event_id = request.headers.get("last-event-id")
    if last_event_id and last_event_id.isdigit():
        after = max(after, int(last_event_id))

    def is_terminal() -> bool:
        fresh = SessionLocal()
        try:
            row = get_session(fresh, session_id)
            return row is None or row.phase in (SessionPhase.RESOLVED.value, SessionPhase.ESCALATED.value)
        finally:
            fresh.close()

    return StreamingResponse(
        sse_stream(session_id, max(after, 0), is_terminal=is_terminal, is_disconnected=request.is_disconnected),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


@app.post("/api/sessions/{session_id}/investigate")
async def session_investigate_endpoint(
    session_id: str, request: Request, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited("llm"))
):
    """Submits the evidence the session asked for and runs one bounded
    investigation cycle (understanding → retrieval → diagnosis → decision)."""
    session = _get_session_or_404(db, session_id, principal, write=True)

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
async def session_diagnose_endpoint(
    session_id: str, request: Request, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited("llm"))
):
    return await session_investigate_endpoint(session_id, request, db, principal)


@app.post("/api/sessions/{session_id}/policy")
async def session_policy_endpoint(
    session_id: str, body: SessionPolicyRequest, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    session = _get_session_or_404(db, session_id, principal, write=True)
    try:
        decision = apply_policy(db, session, body)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return {"policy": decision, "session": _serialize(session)}


@app.post("/api/sessions/{session_id}/answer")
async def session_answer_endpoint(
    session_id: str, request: Request, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    """The user's free-text reply to the question attached to the outstanding
    evidence request. Tripwire-scanned like all untrusted input."""
    session = _get_session_or_404(db, session_id, principal, write=True)
    raw_body = (await request.body()).decode("utf-8", errors="replace")
    try:
        scan_raw_payload(raw_body)
    except TripwireHit as exc:
        return JSONResponse(status_code=422, content={"detail": f"Security Tripwire Triggered: {exc.detail}"})
    try:
        body = AnswerRequest.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return JSONResponse(status_code=422, content={"detail": f"Invalid request body: {exc}"})
    try:
        session = record_answer(db, session, body.request_id, body.answer, principal)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/approve")
async def session_approve_endpoint(
    session_id: str, body: ApprovalRequest, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    # Authorization happens here, on the server: the caller must own this
    # session (or administer its tenant) and hold a key that may write.
    session = _get_session_or_404(db, session_id, principal, write=True)
    try:
        session = record_approval(db, session, body.approved, principal, body.proposal_id)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/action-result")
async def session_action_result_endpoint(
    session_id: str, body: ActionResultRequest, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    session = _get_session_or_404(db, session_id, principal, write=True)
    try:
        session = record_action_result(db, session, body.action_id, body.succeeded, body.detail)
    except (IllegalTransition, RequestMismatch) as exc:
        return _conflict(exc)
    return _serialize(session)


@app.post("/api/sessions/{session_id}/verify")
async def session_verify_endpoint(
    session_id: str, request: Request, db: DBSession = Depends(get_db), principal: Principal = Depends(rate_limited())
):
    """The provider reports what it observed after the action; the backend
    decides whether the cited problem is gone."""
    session = _get_session_or_404(db, session_id, principal, write=True)
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
