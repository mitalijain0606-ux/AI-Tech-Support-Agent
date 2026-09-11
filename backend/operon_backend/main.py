from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from operon_backend.llm import LLMError, diagnose
from operon_backend.policy import evaluate
from operon_backend.schemas import DiagnoseRequest, Diagnosis, PolicyDecision, PolicyRequest
from operon_backend.tripwire import TripwireHit, scan_raw_payload

app = FastAPI(title="Operon Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/policy", response_model=PolicyDecision)
async def policy_endpoint(request: PolicyRequest):
    return evaluate(
        action_id=request.action_id,
        params=request.params,
        provider_capabilities=request.provider_capabilities,
    )


@app.post("/api/diagnose", response_model=Diagnosis)
async def diagnose_endpoint(request: Request):
    # 1. Read raw body and execute Contract 1a tripwire scanner
    body_bytes = await request.body()
    raw_body = body_bytes.decode("utf-8", errors="replace")

    try:
        scan_raw_payload(raw_body)
    except TripwireHit as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": f"Security Tripwire Triggered: {exc.detail}"},
        )

    # 2. Parse into DiagnoseRequest
    try:
        diagnose_req = DiagnoseRequest.model_validate_json(raw_body)
    except (ValidationError, ValueError) as exc:
        return JSONResponse(
            status_code=422,
            content={"detail": f"Invalid request body: {exc}"},
        )

    # 3. Call LLM diagnosis and enforce guardrails
    try:
        diagnosis = await diagnose(diagnose_req.message, diagnose_req.bundle)
        return diagnosis
    except LLMError as exc:
        return JSONResponse(
            status_code=400,
            content={"detail": f"Diagnosis failed: {exc}"},
        )
