# Deployment

**Status: nothing has been deployed.** The configuration here (`render.yaml`,
the CI workflow, the migrations) is written and has been exercised locally,
but no Render service, Neon database or GitHub Actions run exists yet. Every
step that creates something on an external service is a manual step below.

## Decision: Render (a long-lived web service), not Vercel

The repository used to ship `backend/vercel.json` and `backend/api/index.py`
(a serverless entry point). They were removed, because the backend is not a
fit for a serverless function:

| Backend behaviour | Why serverless is wrong |
|---|---|
| `GET /api/sessions/{id}/events` holds a Server-Sent-Events connection open for minutes | function time limits, and no streaming guarantees |
| In-process event bus (Redis-backed when `REDIS_URL` is set) | per-invocation processes cannot share it |
| Loads a ~90 MB ONNX embedding model (MiniLM) | cold start of seconds on every scale-from-zero |
| Runs `alembic upgrade head` before serving, guards the schema at boot | needs a process lifecycle, not a request handler |

Render runs it as one ordinary web service. Neon provides Postgres with
pgvector. Redis (Upstash or Render Key Value) is only needed once there is
more than one instance.

## What the blueprint does (`render.yaml`)

- Build: `pip install --require-hashes -r requirements.txt` (every package is
  pinned and hash-locked; see `backend/requirements.in`) then
  `python scripts/warm_model.py`, which downloads the embedding model into the
  build so the first request does not.
- Start: `alembic upgrade head && uvicorn operon_backend.main:app --host 0.0.0.0 --port $PORT`.
- Health check: `/health` (process is up; says only `{"status":"ok"}`).
- `/ready` has two answers. **Anonymous, in production:** `{"status":"ok"}` (200) or
  `{"status":"unavailable"}` (503, database unreachable) and nothing else. **An
  authenticated admin key** (`Authorization: Bearer <admin token>`, the ordinary
  authentication): full diagnostics — database type, knowledge-chunk count, embedding
  model state, Groq configured and model name, configuration problems, and
  `ready` / `degraded` / `unavailable`. Outside production the full answer is given to
  everyone. The schema revision is checked once, at startup, by the production guard.
- `/docs`, `/redoc` and `/openapi.json` are not served in production (404); they are in
  development.
- `ENVIRONMENT=production`: the backend refuses to start with
  `AUTH_REQUIRED=false`, a `*` CORS origin, or a database that is behind its
  migrations. It only warns for a missing `REDIS_URL`, SQLite, or no
  `GROQ_API_KEY`.

## Environment variables

Placeholders only live in `backend/.env.example`; real values are entered in
the Render dashboard and never committed.

| Variable | Production value | Notes |
|---|---|---|
| `ENVIRONMENT` | `production` | enables the startup guard |
| `AUTH_REQUIRED` | `true` | API keys, tenants, roles |
| `DATABASE_URL` | Neon connection string | `postgresql://…`; run migrations first |
| `GROQ_API_KEY` | secret | empty → the labelled offline engine, not a model |
| `GROQ_MODEL`, `GROQ_TIMEOUT_SECONDS` | defaults | |
| `CORS_ALLOW_ORIGINS` | empty | the extension does not need CORS; never `*` |
| `TRUST_FORWARDED_FOR`, `TRUSTED_PROXY_HOPS` | `true`, `1` | Render's proxy appends the client address |
| `REDIS_URL` | secret, optional | shared rate limits + live events for >1 instance |
| `RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_LLM_PER_MINUTE`, `RATE_LIMIT_AUTH_FAILURES_PER_MINUTE` | 120 / 20 / 10 | |
| `LOG_FORMAT`, `LOG_LEVEL` | `json`, `INFO` | |
| `FASTEMBED_CACHE_PATH` | set by the blueprint | so the model downloaded at build time is deployed |

## Manual steps (only you can do these)

1. **Neon**: create a project and a database; enable the `vector` extension
   (the migration also does `CREATE EXTENSION IF NOT EXISTS vector`, which
   needs a role allowed to). Copy the connection string.
2. **Render**: New → Blueprint → select this repository. Render reads
   `render.yaml`; enter `DATABASE_URL` and `GROQ_API_KEY` (and `REDIS_URL` if
   used) when prompted. A paid instance type is configured (`starter`); a free
   instance sleeps and loses its disk, which is not suitable for the demo.
3. **First API keys** (run in the Render shell, once each):
   `python scripts/manage_keys.py create --tenant demo --subject <you> --role user`
   for using the extension, and
   `python scripts/manage_keys.py create --tenant demo --subject <you>-ops --role admin`
   if you want to read `/ready` diagnostics (an admin also sees every session of its tenant,
   so keep it out of the extension). Tokens are printed once; only their hashes are stored.
4. **Build the extension against the deployed backend**:
   `cd extension && npm ci && OPERON_BACKEND_URL=https://<service>.onrender.com npm run build -- github`
   then load `extension/dist/github/` unpacked in Chrome. The build puts the
   backend origin into the manifest's `host_permissions` (no CORS needed).
5. Open the popup → *Backend access* → paste the token.
6. **Verify the deployment** with `docs/DEMO_REHEARSAL.md`.

## Verified vs. not verified

| Claim | State |
|---|---|
| Migrations create the schema on SQLite and on real Postgres + pgvector (local `pgserver`) | verified |
| Full approve → verify lifecycle on real Postgres + pgvector | verified (local) |
| Rate limits and the live event bus against a real Redis server | verified (local `redis-server`) |
| Production start guard, `/health`, minimal anonymous `/ready`, admin-only detail, no API docs in production | verified (unit/integration tests, including a fresh production process) |
| `render.yaml` is valid YAML with the intended fields | verified |
| Render accepts the blueprint and the service builds/starts | **not verified, never deployed** |
| Neon specifics (extension permission, pooled connection strings) | **not verified** |
| GitHub Actions workflow (`.github/workflows/ci.yml`) | **not verified, never run on GitHub** |
| Redis event bus against a managed Redis (TLS, eviction) | **not verified** |

## Using the SDK against a deployed backend

The extension is not subject to CORS (its manifest lists the backend origin). A **web page** using the SDK is:
set `CORS_ALLOW_ORIGINS=https://your-app.example` (comma-separated, exact origins, never `*`) on the Render service,
or every SDK request will fail as `network_error`. The SDK requires an `https://` backend URL (plain `http` only
for localhost). The page gets a token from your own backend's `getToken()` — there is no key-issuing HTTP API yet,
so for now tokens are created with `scripts/manage_keys.py` and handed to your backend by you. Do not paste a
long-lived key into page source. None of this has been tried against a real deployment.

## Known limits and operational notes

These are accepted for a demo-scale deployment and recorded so nobody discovers them in production.

**`/ready` detail and the API docs are closed in production.** Anonymous callers get only
`{"status":"ok"|"unavailable"}`; diagnostics need an admin key; `/docs`, `/redoc` and
`/openapi.json` return 404. A degraded instance (empty knowledge base, embedding model not
loaded) looks "ok" to anonymous probes, so a platform health check cannot detect it: use the
admin view (or the logs) for that. A wrong or revoked key sent to `/ready` is the usual 401 and
counts toward the failed-authentication throttle.

**Verification trusts the browser.** The backend decides "passed / failed / inconclusive"
from the observation the extension sends after the action. A compromised page or client
could report a clean observation. The action only ever affects the user's own tab and was
approved by that user, and an action that cannot be re-observed is `inconclusive`, never
`passed`; but this is not independent, server-side verification of the page.

**Rotating or revoking an API key** (there is no expiry and no admin API):
1. `python scripts/manage_keys.py create --tenant <t> --subject <s> --role <r>` — new token, shown once.
2. Give it to the user (popup → *Backend access*).
3. `python scripts/manage_keys.py list --tenant <t>` to find the old key id, then
   `python scripts/manage_keys.py revoke <key-id>`. A revoked key gets the same 401 as a forged one.

**Assumptions that have not been tested on the real services**
- Neon: use the *direct* (non-pooled) connection string for `alembic upgrade head`; a
  transaction-pooling endpoint can break DDL and prepared statements. If you use a pooled
  URL for the running service, run migrations separately with the direct one.
- Render: `FASTEMBED_CACHE_PATH` in `render.yaml` assumes the build and the running service
  share `/opt/render/project/src`. If the first request is slow or retrieval reports
  `error`, the model was not found at runtime; check `/ready` with an admin key.
- Render: `TRUSTED_PROXY_HOPS=1` assumes Render's proxy appends one `X-Forwarded-For` entry.
  A wrong value only affects the failed-authentication throttle (keyed by address); normal
  rate limits are keyed by API key.
- The first deploy will run `alembic upgrade head` against an empty Neon database and the
  `vector` extension must be creatable by the connecting role.
