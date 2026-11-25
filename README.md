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

The main demo target is **NexaDesk** ([`buggy-cloud/`](buggy-cloud/)), a realistic SaaS app with
eight reproducible faults, a presenter **demo console** (`/demo`) and the Operon **support widget**
built on the SDK ([`sdk/`](sdk/)); the same scenarios also run through the extension. **Running the
demo: [`docs/HACKATHON_DEMO_GUIDE.md`](docs/HACKATHON_DEMO_GUIDE.md).** Feature-by-feature
verification evidence is in [`docs/FEATURE_AUDIT_REPORT.md`](docs/FEATURE_AUDIT_REPORT.md).

How every part is tested, and what has been validated against real services, is in
[`docs/TESTING.md`](docs/TESTING.md). The investigation design is in
[`AGENT_ARCHITECTURE.md`](AGENT_ARCHITECTURE.md).

## Why Operon

When a web app breaks for one user, support usually starts with a vague report
("the dates are missing"). Reproducing it means back-and-forth for screenshots,
console logs and browser details, and the cause is often state that only exists
in that user's browser: a corrupted saved setting, an invalid preference, a stale
service worker. Fixes get suggested as generic steps ("clear all your data"),
and nobody checks afterwards whether the problem is actually gone.

Operon collects the evidence itself, explains the likely root cause with the
evidence it is based on, proposes one narrow fix, runs it only with the user's
approval, and confirms the result on the server. Problems it cannot fix from the
browser, such as a failing API, are handed to a person as a ticket that already
contains everything collected.

## Features

- **Evidence collection on request.** Console errors, failed network requests,
  storage and cookie *metadata*, page state and a reload observation, collected
  only when the backend asks for them, and redacted before upload.
- **Diagnosis with cited evidence.** Each diagnosis names the root cause, the
  evidence it relies on and the knowledge-base entries it used. It comes from a
  Groq-hosted model when `GROQ_API_KEY` is set, or from a deterministic offline
  rule-based engine otherwise. Every diagnosis records which engine produced it.
  A Groq rate limit (429) or overload (503) is retried after the wait Groq asks
  for, within set bounds.
- **Grounded guidance.** The explanation shown to the user is checked for dangerous
  instructions, certainty claims, contradictions of the cited knowledge, and — when
  it gives numbered steps — the order and completeness of the cited procedure.
- **Knowledge retrieval.** A curated troubleshooting knowledge base
  ([`docs/knowledge-base/`](docs/knowledge-base/)) is searched with local
  MiniLM embeddings (`fastembed`), with pgvector support on Postgres.
- **Approval-gated fixes.** Fixes come from a closed set of actions, pass a
  server-side policy check, and destructive ones run only after the user approves.
  Approval can be declined; nothing changes.
- **Server-side verification and retries.** After a fix, the page is observed
  again and the backend decides whether the cited problem is gone. A failed fix
  is retried with a different one, or escalated.
- **One problem at a time, none lost.** A complaint describing several problems is
  split: Operon investigates the first and lists the others for the user to report
  separately. A failing request in the evidence that the diagnosis does not explain
  is listed the same way.
- **Escalation tickets and a support dashboard.** A structured, redacted report
  for a human, with a read-only dashboard and a local reproduction tool.
- **Two ways in.** A Chrome extension for any configured site, and an SDK with a
  support widget for apps you control (including session recovery after a page
  reload).
- **Live progress.** Investigation stages and activity are streamed to the
  popup and widget (Server-Sent Events).
- **Multi-tenant API.** API keys with user, viewer and admin roles, optional key
  expiry, an admin API to list, create, rotate and revoke keys, tenant isolation,
  rate limits and request-size limits.
- **Bounded sessions.** Every session has budgets (cycles, evidence, model calls —
  including a call cut off by a backend restart), and an unfinished session left
  idle expires without changing anything.

## Architecture

| Component | Responsibility | Technology |
|---|---|---|
| Backend ([`backend/`](backend/)) | Sessions and their state machine, evidence requests, retrieval, diagnosis and grounding checks, policy, verification, escalation tickets, key management, the support dashboard | Python, FastAPI, SQLAlchemy, Alembic; SQLite or Postgres (+ pgvector); optional Redis for rate limits and events; `fastembed`; optional Groq API |
| Chrome extension ([`extension/`](extension/)) | Collects the evidence the backend asks for (via `chrome.debugger`), redacts it, shows the popup, executes an approved action on the investigated tab only | Manifest V3, TypeScript, React, esbuild |
| SDK ([`sdk/`](sdk/)) | The same session flow for a site that embeds Operon; the site registers which fixes it supports | Plain JavaScript with TypeScript declarations |
| NexaDesk ([`buggy-cloud/`](buggy-cloud/)) | Demo SaaS app with eight reproducible faults, the SDK support widget and a presenter console | Plain JavaScript modules, Node static/mock-API server |

The backend is the authority: the extension and the SDK only collect what they
are asked for and run what was approved, and the backend decides the diagnosis,
the policy and the verification result.

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
  migrations/            Alembic (baseline, pgvector, tickets, session version, key expiry / idle sessions)
  scripts/               manage_keys.py, seed_kb.py, validate_services.py, warm_model.py
  eval.py, eval_data/    measured evaluation against ground-truth fixtures
  tests/                 offline suite; tests/live/ for real Groq / embeddings
extension/               MV3, TypeScript + React, esbuild per target
  src/                   background.ts, content.ts, popup/, lib/{types,sanitize,progress,appbridge}.ts
  targets/               github.json (real), e2e-local.json (local fixtures), fake-saas.json (unset)
  tests/                 node:test unit tests against the real bundled source
  e2e/                   browser E2E: local suite, github.com demo, Buggy Cloud
sdk/                     Operon SDK for sites you control: client (init/diagnose/resume/answer/decide), shared redaction, types, build
buggy-cloud/             NexaDesk, the demo SaaS app: 8 reproducible scenarios, support widget, /demo console
scripts/                 dev-local.mjs (one-command local stack), reproduce-ticket.mjs
docs/                    IMPLEMENTATION_STATUS, DEPLOYMENT, DEMO_REHEARSAL, SDK_VS_EXTENSION,
                         TESTING, plan/, knowledge-base/, archive/
render.yaml, .github/    Render deployment blueprint and CI workflow
```

[`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) has the per-file breakdown.

## Quick start (everything local, one command)

```bash
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install --require-hashes -r requirements.txt && cd ..
cd extension && npm ci && cd ..
node scripts/dev-local.mjs        # backend + NexaDesk + support widget + demo console; prints URLs, tokens and the Chrome steps
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
| `LLM_PIPELINE` | `combined` | `staged` runs Classify, Diagnose and Plan as three model calls (more calls, per-stage scoring in `eval.py`) |
| `MIN_ACTION_CONFIDENCE` | `0.5` | a diagnosis less confident than this escalates to a human instead of proposing a fix |
| `MAX_REQUEST_BODY_BYTES` | `2000000` | larger request bodies are refused with 413 before they are read |
| `EVIDENCE_TOKEN_BUDGET` | `8000` | approximate token cap on the evidence shown to the model per cycle |
| `GROQ_RATE_LIMIT_RETRIES` / `GROQ_RATE_LIMIT_MAX_WAIT_SECONDS` | `2` / `20` | on a Groq 429/503, how many times to retry and the longest wait accepted |
| `EMBEDDING_RETRY_COOLDOWN_SECONDS` | `60` | after the embedding model fails to load, how long before trying again |
| `KB_STARTUP_WAIT_SECONDS` | `30` | how long startup waits for knowledge-base indexing before it starts serving anyway |
| `SESSION_IDLE_EXPIRY_HOURS` | `24` | an unfinished session idle this long is closed as expired (`0` disables) |
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
cold cache; if it takes longer than `KB_STARTUP_WAIT_SECONDS`, the backend
starts serving and finishes indexing in the background. An already-indexed
knowledge base is left untouched, so a restart never duplicates, re-embeds or
overwrites anything.

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
npm run e2e:buggy                       # NexaDesk through the extension: every scenario
npm run e2e:sdk                         # the same app through the SDK (no extension)
npm run e2e:sdk-wire                    # SDK request bytes: fake secrets must not appear
npm run e2e:wire                        # fake secrets typed into the popup never reach the network (recording proxy)
npm run e2e:journey                     # the hackathon demo journey through the SDK widget AND the extension
npm run e2e:completion                  # multi-issue complaints, session expiry, admin key API (real browser)
npm run e2e:screens                     # NexaDesk's screens under every seeded scenario
npm run e2e:dashboard                   # escalation tickets in the read-only support dashboard (XSS, isolation)
npm run e2e:reproduce                   # sandbox reproduction of escalated tickets
npm run e2e:github-escalation           # real 404 / 401 from github.com escalate with a ticket
cd ../sdk && npm test                   # SDK unit tests
cd .. && node --test scripts/tests/*.test.mjs        # reproduction tool unit tests
cd backend && python eval.py --engine offline       # measured evaluation (--engine groq [--pipeline staged] for the model)
python eval.py --engine offline --set holdout       # the independently written held-out set (--set all: both)
```

## Escalation tickets and the support dashboard

When Operon stops — policy denies the fix, the diagnosis is not confident
enough (`MIN_ACTION_CONFIDENCE`), a fix failed verification, a limit was hit,
or nothing in the browser can fix the problem — it opens a **ticket** with a
structured, redacted report for a human: the user's message, the evidence,
every diagnosis, the attempted actions and their outcomes, the verification
result and the timeline.

- API: `GET /api/tickets`, `GET /api/tickets/{id}` (an admin key sees its
  tenant's tickets, a user key its own), `POST /api/tickets/{id}/status`
  (admin only: `open` / `acknowledged` / `closed`).
- Dashboard: open `http://localhost:8000/dashboard`, paste an admin key (kept in
  the tab's memory only) and browse tickets. It is read-only and renders every
  value as text under a strict Content-Security-Policy.
- Reproduction (local only): `OPERON_API_KEY=<admin key> node
  scripts/reproduce-ticket.mjs --ticket tkt_… --allow-host 127.0.0.1` replays the ticket's page in a
  disposable headless Chromium and reports whether the failure reproduces
  without the customer's own browser state. `--allow-host` names the host it may
  open and is required even for localhost (a ticket's URL comes from a customer's
  page); `--recreate-storage` plants a synthetic invalid value under a reported
  corrupted key.

What each suite covers, what is stubbed, and the latest validation results
are in [`docs/TESTING.md`](docs/TESTING.md).

## API keys

`python scripts/manage_keys.py create --tenant <t> --subject <s> --role admin [--expires-days 90]`
creates the first admin key (the token is printed once; only its hash is stored). After
that, a tenant's admins manage keys over the API:

| Call | What it does |
|---|---|
| `GET /api/admin/keys` | the tenant's keys: subject, role, label, state (active / expired / revoked), dates — never a token or hash |
| `POST /api/admin/keys` `{subject, role, label?, expires_in_days?}` | a new key; the token is in the response, once |
| `POST /api/admin/keys/{id}/rotate` `{expires_in_days?}` | a new key with the same identity; the old one is revoked in the same step |
| `POST /api/admin/keys/{id}/revoke` | stops the key at once |

Only admin keys may call these, only for their own tenant (another tenant's key id is the
same 404 as an unknown one), and an admin cannot revoke or rotate the key it is using.

## Deployment

Operon runs locally today. A Render blueprint ([`render.yaml`](render.yaml)) and
the production configuration it expects (Postgres, auth, CORS, rate limits) are
described in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md); there is no hosted
instance.
