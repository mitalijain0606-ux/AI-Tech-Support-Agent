# Operon — AI technical-support agent

Operon is a Chrome extension plus a backend that investigates a broken web
page the way a support engineer would. It asks the browser for specific
evidence, reasons over it, proposes the smallest safe fix, gets the user's
approval when policy requires it, runs the fix, and then **verifies on the
server** whether the problem is actually gone. When it can't do that safely,
it escalates and says why.

The first target is real **github.com**. GitHub has no convenient
reproducible bug, so the demo plants one itself: a namespaced, corrupted
`localStorage` value (`operon_demo_cache`) that GitHub never reads.
Everything downstream is genuine: real `chrome.debugger` capture, a real
policy gate, a real fix in the live tab, and a real re-observation.

A second application, [`buggy-cloud/`](buggy-cloud/), shows it is not
GitHub-only: seven seeded bugs (`?bug=N`), an app-specific fix
(`reset_user_preference`) through the Operon SDK ([`sdk/`](sdk/)) — usable either
directly by the app (`init`) or carried by the extension — and end-to-end tests of both paths. What exists, what is verified and what is left:
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

Planning and phase tracking live in [`docs/`](docs/). How every part is
tested, and what has actually been validated against real services, is in
[`docs/TESTING.md`](docs/TESTING.md). The investigation design is in
[`AGENT_ARCHITECTURE.md`](AGENT_ARCHITECTURE.md).

## How a session works

```text
popup "Ask Operon"
  → POST /api/sessions                    SupportSession + first EvidenceRequest
  → extension collects exactly what was requested (console, network, storage,
    cookies [metadata only], page, reload_observe), redacts anything
    credential-shaped, and submits it
  → POST /api/sessions/{id}/investigate   one bounded cycle:
       investigate (evidence, understanding, retrieval) → classify → diagnose → plan
       plan = NEED_INFORMATION (optionally with one safe free-text question) (a new, specific request)
                | ACTION_PROPOSED (a grounded remediation plan)
                | ESCALATED (no safe action, limits reached, repeats)
  → POST /api/sessions/{id}/answer       optional: the user's reply to that question
  → POST /api/sessions/{id}/policy        ALLOW / REQUIRE_APPROVAL / DENY for the pending plan
  → POST /api/sessions/{id}/approve       when required
  → extension executes the one approved action
  → POST /api/sessions/{id}/action-result
  → POST /api/sessions/{id}/verify        extension reports what it observed; the
                                          backend decides passed / failed / inconclusive
       passed → RESOLVED · failed/inconclusive → retry with a different fix, or ESCALATED
```

`/api/sessions/{id}/diagnose` is an alias of `/investigate`. The legacy
stateless `/api/diagnose` and `/api/policy` endpoints are still served.

## Safety model

- **Closed action set.** The model can only name one of `inspect_page`,
  `reload`, `clear_storage_key`, `unregister_service_worker`, and (only where
  the app's SDK offers it) `reset_user_preference`. It never emits
  code or selectors. Every action goes through `policy.py`. The destructive
  ones always need approval.
- **Grounding.** A diagnosis must cite evidence the model was actually shown
  (and retrieved knowledge it was actually given). A proposed action must cite
  evidence, and its target must appear in that evidence. An invalid answer is
  regenerated once, then escalated. It is never acted on.
- **Backend authority.** The backend decides verification from the evidence
  the plan cited — which is evidence the browser reports, so a compromised
  client could report a clean page (see `docs/DEPLOYMENT.md`, "Known limits"). A client cannot send `passed`/`outcome`, cannot report a
  result for an action that wasn't approved, and cannot replay an evidence
  request. Inputs are size-bounded.
- **Credentials.** Collectors never read cookie or storage values. The
  extension redacts credential-shaped strings before upload
  (`extension/src/lib/sanitize.ts`) — evidence, verification observations, and
  also the free text the user types (the issue, answers to questions) and
  outcome strings reported for an executed action. The backend tripwire (`tripwire.py`)
  rejects any evidence payload that still contains one, and redacts the
  user's own text, action-result details, activity entries and knowledge-base
  history. A Git commit SHA is kept only where it is unambiguous context:
  never in a URL query, fragment or userinfo, or after a secret-ish word.
- **Page content is untrusted data.** Evidence, retrieved knowledge and user
  text are given to the model as data, never as instructions.

## Repository layout

```text
backend/                 FastAPI + SQLAlchemy (SQLite, or Postgres + pgvector)
  operon_backend/        session_service, investigation, stages (classify), evidence,
                         planning, verification, policy, auth, ratelimit, events,
                         tripwire, llm, retrieval, embeddings, knowledge, ...
  migrations/            Alembic (baseline + pgvector)
  scripts/               manage_keys.py, seed_kb.py, validate_services.py, warm_model.py
  eval.py, eval_data/    measured evaluation against ground-truth fixtures
  tests/                 offline suite; tests/live/ for real Groq / embeddings
extension/               MV3, TypeScript + React, esbuild per target
  src/                   background.ts, content.ts, popup/, lib/{types,sanitize,progress,appbridge}.ts
  targets/               github.json (real), e2e-local.json (local fixtures), fake-saas.json (unset)
  tests/                 node:test unit tests against the real bundled source
  e2e/                   browser E2E: local suite, github.com demo, Buggy Cloud
sdk/                     Operon SDK for sites you control: client (init/diagnose/decide), shared redaction, types, build
buggy-cloud/             the second application: 7 seeded bugs
docs/                    IMPLEMENTATION_STATUS, DEPLOYMENT, DEMO_REHEARSAL, SDK_VS_EXTENSION,
                         TESTING, plan/, knowledge-base/, archive/
render.yaml, .github/    deployment blueprint (never deployed) and CI (never run on GitHub)
```

[`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) has the per-file breakdown.

## Quick start (everything local, one command)

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install --require-hashes -r requirements.txt && cd ..
cd extension && npm ci && cd ..
node scripts/dev-local.mjs        # backend + Buggy Cloud + SDK panel; prints your token and the Chrome steps
```

Full guide, ports, Chrome instructions and troubleshooting: [`docs/LOCAL_DEVELOPMENT.md`](docs/LOCAL_DEVELOPMENT.md).

## Local setup

### Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env              # then set GROQ_API_KEY (optional, see below)
python scripts/manage_keys.py create --tenant dev --subject you --role user   # prints your token ONCE
uvicorn operon_backend.main:app --reload --port 8000
curl localhost:8000/health        # {"status":"ok"}
```

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | empty | Groq key. **Empty → the labelled offline `rule_based` engine** diagnoses the known scenarios, and every diagnosis records which engine produced it. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq chat model (JSON mode) |
| `GROQ_TIMEOUT_SECONDS` | `30` | per-request timeout |
| `EMBEDDING_RETRY_COOLDOWN_SECONDS` | `60` | after the embedding model fails to load, how long before trying again |
| `DATABASE_URL` | `sqlite:///./operon.db` | any SQLAlchemy URL; for Postgres run `alembic upgrade head` first |
| `AUTH_REQUIRED` | `true` (also in `.env.example`) | API keys (`python scripts/manage_keys.py create …`) pasted into the popup under *Backend access*. Set `false` only for throwaway local experiments; `ENVIRONMENT=production` refuses to start without auth |
| `ENVIRONMENT` | `development` | `production` refuses an unsafe configuration |

The rest (CORS, rate limits, Redis, logging) is in `backend/.env.example` and
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

Retrieval uses `sentence-transformers/all-MiniLM-L6-v2` via `fastembed`
(384-dimensional), downloaded on first use. Downloading it needs outbound
access to `huggingface.co` and its download hosts (`*.hf.co`).

**The knowledge base is indexed automatically at startup.** On a database
with no curated knowledge chunks, the backend indexes the curated KB before
it starts serving. That takes a few seconds, plus the model download on a
cold cache. An already-indexed knowledge base is left untouched, so a restart
never duplicates, re-embeds or overwrites anything.

If the model can't be loaded at startup, the backend still starts and logs
`Knowledge base not initialized`. Each investigation then records retrieval
as `empty_index` (nothing was searched) or `error`, never as `no_match`, and
continues without precedent. Restart once the model is reachable.
`python scripts/seed_kb.py [--force]` is only needed to refresh an existing
index after editing the KB sources.

### Extension

```bash
cd extension
npm ci
npm run build -- github                                     # → dist/github/, backend http://localhost:8000
OPERON_BACKEND_URL=https://api.example.com npm run build -- github   # another backend, no source edit
```

Then go to `chrome://extensions`, turn on Developer mode, choose **Load
unpacked**, and select `extension/dist/github/`. Open a github.com page. In
the popup, paste your token under **Backend access**, then **Seed demo bug** plants the corrupted key and **Ask Operon**
starts a session. Approve or deny the proposed fix and watch the result
being verified. **Reset** clears the demo key.

## Testing

```bash
cd backend && pytest                    # offline suite (live tests skip with a reason)
python scripts/validate_services.py     # real Groq + real embeddings: PASS / FAIL / BLOCKED
cd extension && npm test                # unit tests
npx tsc --noEmit -p .                   # typecheck
npm run e2e                             # built extension + real backend + Chromium, local fixtures
npm run e2e:github                      # same, against a real public github.com page (read-only)
npm run e2e:demo                        # the approve / deny demo on a real github.com page
npm run e2e:buggy                       # the second app through the extension: 7 seeded bugs
npm run e2e:sdk                         # the same app through the SDK (no extension)
npm run e2e:sdk-wire                    # SDK request bytes: fake secrets must not appear
cd ../sdk && npm test                   # SDK unit tests
npm run e2e:wire                        # fake secrets typed into the popup never reach the network (recording proxy)
cd ../backend && python eval.py --engine offline   # measured evaluation (add --engine groq for the model)
```

What each suite covers, what is stubbed, and the latest validation results
are in [`docs/TESTING.md`](docs/TESTING.md).

## Status

The authoritative table, with evidence and what was *not* verified, is
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). In short:
the investigation core, auth/tenancy, live progress, Postgres/Redis support,
the second app and the evaluation are implemented and tested locally; the
Render deployment and the CI workflow are written but **have never been run**.
