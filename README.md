# Operon — AI technical-support agent (GitHub slice)

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
       evidence → understanding → retrieval → diagnosis → decision
       decision = NEED_INFORMATION (a new, specific request)
                | ACTION_PROPOSED (a grounded remediation plan)
                | ESCALATED (no safe action, limits reached, repeats)
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
  `reload`, `clear_storage_key`, `unregister_service_worker`. It never emits
  code or selectors. Every action goes through `policy.py`. The destructive
  ones always need approval.
- **Grounding.** A diagnosis must cite evidence the model was actually shown
  (and retrieved knowledge it was actually given). A proposed action must cite
  evidence, and its target must appear in that evidence. An invalid answer is
  regenerated once, then escalated. It is never acted on.
- **Backend authority.** The backend decides verification from the evidence
  the plan cited. A client cannot send `passed`/`outcome`, cannot report a
  result for an action that wasn't approved, and cannot replay an evidence
  request. Inputs are size-bounded.
- **Credentials.** Collectors never read cookie or storage values. The
  extension redacts credential-shaped strings before upload
  (`extension/src/lib/sanitize.ts`). The backend tripwire (`tripwire.py`)
  rejects any evidence payload that still contains one, and redacts the
  user's own text, action-result details, activity entries and knowledge-base
  history. A Git commit SHA is kept only where it is unambiguous context:
  never in a URL query, fragment or userinfo, or after a secret-ish word.
- **Page content is untrusted data.** Evidence, retrieved knowledge and user
  text are given to the model as data, never as instructions.

## Repository layout

```text
backend/                 FastAPI + SQLAlchemy (SQLite by default)
  operon_backend/        session_service, investigation, evidence, planning,
                         verification, policy, tripwire, llm, retrieval,
                         embeddings, knowledge, activity, state_machine, ...
  scripts/               seed_kb.py (refresh the KB index), validate_services.py
  tests/                 offline suite; tests/live/ for real Groq / embeddings
extension/               MV3, TypeScript + React, esbuild per target
  src/                   background.ts, content.ts, popup/, lib/{types,sanitize}.ts
  targets/               github.json (real), e2e-local.json (local fixtures), fake-saas.json (unset)
  tests/                 node:test unit tests against the real bundled source
  e2e/                   browser E2E: deterministic local suite + live github.com check
docs/                    plan/, knowledge-base/, archive/, TESTING.md
```

[`PROJECT_STRUCTURE.md`](PROJECT_STRUCTURE.md) has the per-file breakdown.

## Local setup

### Backend

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env              # then set GROQ_API_KEY (optional, see below)
uvicorn operon_backend.main:app --reload --port 8000
curl localhost:8000/health        # {"status":"ok"}
```

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY` | empty | Groq key. **Empty → the labelled offline `rule_based` engine** diagnoses the known scenarios, and every diagnosis records which engine produced it. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq chat model (JSON mode) |
| `GROQ_TIMEOUT_SECONDS` | `30` | per-request timeout |
| `EMBEDDING_RETRY_COOLDOWN_SECONDS` | `60` | after the embedding model fails to load, how long before trying again |
| `DATABASE_URL` | `sqlite:///./operon.db` | any SQLAlchemy URL |

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
the popup, **Seed demo bug** plants the corrupted key and **Ask Operon**
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
```

What each suite covers, what is stubbed, and the latest validation results
are in [`docs/TESTING.md`](docs/TESTING.md).

## Status

| Area | Status |
|---|---|
| SupportSession lifecycle, evidence requests, bounded loop, grounding, planning, policy, approval, server-side verification, retry, escalation, activity | **Done** (unit, API and browser E2E tested) |
| Extension against real github.com | **Done**, validated read-only on a public page (`npm run e2e:github`) |
| Credential redaction (extension + backend) and Git SHA handling | **Done** (red-team matrix + E2E) |
| Groq | **Done**: validated against the live model (`validate_services.py`, 6/6 live tests). The free tier's 8,000 tokens/min can rate-limit a multi-cycle session. |
| Embeddings / retrieval | **Done**: the real MiniLM model, the KB indexed automatically at startup, and retrieval validated live (10/10 live tests, browser E2E) |
| Free-text user Q&A, live activity stream | Not implemented |
| Deployment, production auth, Postgres/Redis, observability, learning loop evaluation, `eval.py` | Not implemented (later milestones) |
| Phase 2 fake-SaaS target | Not started |
