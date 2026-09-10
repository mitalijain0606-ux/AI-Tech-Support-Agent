from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="Operon Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    pass


@app.post("/api/diagnose")
async def diagnose_endpoint():
    pass


@app.post("/api/policy")
async def policy_endpoint():
    pass
