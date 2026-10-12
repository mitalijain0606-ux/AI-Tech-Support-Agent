# Implementation status

Single source of truth for what exists, what was actually verified, and what
is left. Status words: **DONE** (implemented and exercised against the real
thing), **PARTIAL**, **NOT STARTED**, **BLOCKED** (needs something only the
owner can supply), **UNVERIFIED** (written, never run in its real
environment). Last updated 2026-10-10. All work described here is
**uncommitted** in the working tree; nothing was committed, pushed or
deployed.

## Phase 1 — GitHub demo and deployment readiness

| Item | Status | Evidence / note |
|---|---|---|
| Approved fix on real github.com (seed → diagnose → approval → fix → backend verification) | **DONE** | `npm run e2e:demo`: 21/21 on `github.com/octocat/Hello-World`, offline engine and again with the real Groq model |
| Rejected action is not executed | **DONE** | same run: deny → `declined_by_user`, no attempt recorded, key untouched |
| Live activity stream | **DONE** | SSE `GET /api/sessions/{id}/events` (replay + live, tenant-scoped, heartbeat, deadline); popup shows progress while the model call runs; tested against a real server thread, not a buffering test client |
| Vercel vs Render | **DONE** (decision) | Render; Vercel files removed; reasoning in `docs/DEPLOYMENT.md` |
| Config validation, `/health`, `/ready`, production start guard | **DONE** | tests in `test_deploy_readiness.py` |
| Env/db docs, `.env.example`, `render.yaml` | **DONE** (written) / **UNVERIFIED** (Render never ran it) | |
| Rehearsal checklist | **DONE** | `docs/DEMO_REHEARSAL.md` |
| Actually deploying | **BLOCKED** | needs the owner's Render, Neon and Groq accounts; manual steps in `docs/DEPLOYMENT.md` |

## Phase 2 — production hardening

| Item | Status | Evidence / note |
|---|---|---|
| Postgres + Alembic migrations | **DONE** | baseline + pgvector revisions; applied to SQLite and to real Postgres (`pgserver`); production refuses a database behind head |
| pgvector retrieval | **DONE** (local) | candidate search in SQL with tenant filter, exact scoring in Python; real Postgres + pgvector tests |
| Redis (shared rate limits, event bus) | **DONE** (local) / **UNVERIFIED** managed | real `redis-server` tests; fail-open on Redis errors |
| Auth / authorization | **DONE** | API keys (hashed), tenants, roles; 404 (not 403) across tenants/users; approval bound to principal and `proposal_id`; failed-auth throttle |
| CORS | **DONE** (default off; cross-origin page access is not needed by the extension) | off by default; extension uses manifest host permissions; `*` refused in production |
| Rate limiting | **DONE** | per caller, stricter for model calls; trusted-proxy aware (rightmost XFF) |
| Structured logging / request ids | **DONE** | JSON logs, redacted, generic 500s with request id |
| CI | **PARTIAL** — written and YAML-validated; **UNVERIFIED**, never run on GitHub | `.github/workflows/ci.yml` has never run on GitHub |
| Dependency pinning | **DONE** | hash-locked `requirements*.txt` from `.in` files; `pip-audit` clean; `npm audit --omit=dev` clean |

## Phase 3 — agent quality

| Item | Status | Evidence / note |
|---|---|---|
| Free-text clarifying questions | **DONE** (the browser-side redaction gap found in review is fixed, see "Fixes after the review") | model may attach one question to an information request; validated by `question_problems` (length, links, secret requests, AI-addressed text); max 3 per session; `POST /api/sessions/{id}/answer` (tripwire-scanned, redacted, bounded, once per question, tenant/role-checked); the answer reaches the model only as data inside `investigation_history`; popup shows the question and an answer box |
| Pipeline split into classify / investigate / diagnose / plan / verify | **DONE** | `stages.py` (deterministic `classify`), stage events from `investigation.py` and `session_service.py`; classify is also the offline engine's brain and a hint to the model |
| Tenant isolation | **DONE** | sessions, answers, events, knowledge history; cross-tenant test over every endpoint (including `/answer`) |
| Tests: permissions, invalid input, malformed evidence, failure, cross-tenant | **DONE** | backend suite, 608 tests (see below) |
| `eval.py` with ground-truth fixtures and measured results | **DONE** | see "Measured evaluation" |

## Phase 4 — second application (Buggy Cloud)

| Item | Status | Evidence / note |
|---|---|---|
| Standalone app, ≥5 deterministic bugs, `?bug=N` | **DONE** | 7 bugs; `buggy-cloud/`; separate bug definitions, activation, UI, API helpers, mock data, server |
| Smallest compatible SDK integration | **DONE** | `sdk/operon-sdk.js` (one file); extension discovers the page's action names and intersects them with a closed list |
| `reset_user_preference` end to end | **DONE** | backend policy (allowlist, approval), grounding (preference must appear in cited evidence, action must be in the session's declared capabilities), planning + verification, extension executor, app handler |
| Expected-diagnosis fixtures | **DONE** | ground truth in `buggy-cloud/src/bugs.js`; mirrored in `backend/eval_data/fixtures.json` |
| Proof Operon works on a second app | **DONE** | `npm run e2e:buggy`: 57/57 (7 bugs + healthy control; three fixed with backend-verified resolution, three diagnosed with no action, one `service_worker_stale` fixed) |

## Phase 5 — SDK vs. extension

**DONE** (design + implementation): `docs/SDK_VS_EXTENSION.md`. One pipeline;
the SDK is one dependency-free file that only declares action names; the
extension is always the carrier; no duplicated packages; no new extension
permission. The GitHub API agent remains a separate, unstarted product.

## Measured evaluation (`backend/eval.py`)

21 fixtures (`backend/eval_data/fixtures.json`): storage corruption (2), client
blocking, HTTP 500, CORS, 401 / expired session, runtime error, stale service
worker, chunk error without a worker, a quiet page, three prompt-injection
cases (in console text, next to a real error, in the user's message), invalid
timezone/locale/currency, a preference with no resettable action, and
three console-only captures from Buggy Cloud.

| Engine | Classify | Category | Action | Parameters | Cited ids valid / relevant | Unsafe actions |
|---|---|---|---|---|---|---|
| offline `rule_based` | 21/21 | 21/21 | 21/21 | 21/21 | 100% / 100% | 0 |
| Groq `openai/gpt-oss-120b`, final run (21 fixtures) | 21/21 | 20/21 | 21/21 | 20/21 | 100% / 100% | 0 |

Groq runs, in the order they happened (temperature 0.1; the model is not
deterministic, so runs differ):

| Run | Prompt | Result |
|---|---|---|
| 1 | first version of the new rules (18 fixtures) | 16 answered; 2 fixtures hit the free tier's 429 rate limit (not model faults; re-run separately and correct); 1 miss (`runtime-error`: no action instead of `reload`) |
| 2 | same (21 fixtures) | category 21/21, action 20/21, **1 unsafe**: it proposed `reload` for a 401 |
| 3 | + rule "a 401/403 is `auth_failure`, no action" | category 19/21, **1 unsafe**: it proposed `reload` for an HTTP 500 |
| 4 (final) | + rule "`reload` only for a runtime error in the page's own code" | category 20/21, action 21/21, parameters 20/21, **0 unsafe**; the one miss is `console-failed-to-fetch`, which the model called `insufficient_evidence` (cautious, no action) |

Runs 3 and 4 were taken after reading run 2/3 failures and changing the prompt,
so they are *not* held-out measurements; the unsafe-action count of 0 is for one
run and is not a guarantee. An "unsafe" action here means one the ground truth
does not call for. All of them were inside the closed action set and
low-risk (`reload` needs no approval), and none could have bypassed policy.

The offline engine is hand-written rules checked against fixtures written by
the same people: its 100% shows the rules are consistent with the fixtures, not
that they generalize. The Groq numbers are a single temperature-0.1 run per
fixture on a small set; treat them as a sanity check, not a benchmark.

## Verification run (2026-10-10, working tree, uncommitted)

| Check | Result |
|---|---|
| Backend (`pytest --ignore=tests/live`), incl. real Postgres + pgvector and real Redis | **621 passed** (hash-locked environment; 584 before the review fixes) |
| Extension unit tests / `tsc` / builds (`github`, `e2e-local`) | 87 passed / clean / ok |
| Buggy Cloud unit tests | 10 passed |
| Browser E2E, deterministic local suite (`npm run e2e`, auth ON) | **63/63** |
| Browser E2E, Buggy Cloud (`npm run e2e:buggy`) | **57/57** |
| Browser E2E, real github.com demo (`npm run e2e:demo`) | **21/21** |
| Browser E2E, wire test (`npm run e2e:wire`) | **11/11** |
| `ruff check`, KB lint | clean, ok |
| `pip-audit` (locked), `npm audit --omit=dev` | no known vulnerabilities |

## What was not verified

- `render.yaml` on Render, Neon as a host, the GitHub Actions workflow on GitHub,
  and the Redis event bus against a managed Redis: written and tested locally only.
- The extension against a deployed backend over the internet (every E2E ran the
  backend on localhost).
- Live-Groq behaviour beyond the 21-fixture evaluation above and the earlier live
  tests; the free tier's 8,000 tokens/minute limits multi-cycle sessions.
- Multi-instance behaviour (more than one backend process) beyond the Redis tests.

## Remaining work, in priority order

1. **Owner actions** (blocked on credentials): create the Neon database and the
   Render service, mint the first API key, build the extension with
   `OPERON_BACKEND_URL`, run `docs/DEMO_REHEARSAL.md` against it; push the branch so
   CI runs for the first time and fix whatever it finds.
2. **Review and commit** this working tree (nothing is committed).
3. Key management beyond the CLI: rotation, expiry, an admin API.
4. A larger, independently written evaluation set (the current 21 fixtures were
   written alongside the rules and prompt) and a recorded Groq baseline over
   several runs.
5. Browser coverage: only Chromium is exercised; Edge/Firefox are untested.
6. More SDK actions (each needs a backend policy entry, a closed-list entry in
   the extension and the SDK, verification, and tests); a published SDK package.
7. Learning loop evaluation (does the history of resolved sessions improve later
   diagnoses?), and per-tenant knowledge curation.
8. The GitHub API agent — separate product, not started.

## Progress log

- **Session 1–2**: documentation/code audit; core investigation architecture
  (evidence requests, bounded loop, grounding, planning, policy, approval,
  server-side verification); validation against real Groq, real embeddings and
  real github.com; knowledge-base startup fix.
- **This milestone** (autonomous execution): live SSE progress; API-key auth with
  tenants/roles and server-enforced approval; rate limits, CORS policy, structured
  logging; Alembic + Postgres/pgvector + Redis; hash-locked dependencies and CI;
  Render decision and deployment docs; verified approve/deny demo on github.com;
  staged pipeline and deterministic classifier; free-text questions with an answer
  endpoint; `eval.py` and fixtures; Buggy Cloud (7 bugs), the SDK and
  `reset_user_preference`; second-app E2E. Defects found by this work and fixed:
  `/ready` reported the wrong database kind on Postgres; rate-limit `Retry-After`
  was off by one; `X-Forwarded-For` was spoofable; Buggy Cloud's first E2E run
  showed the classifier labelled console-reported HTTP errors and failed fetches as
  code defects and proposed a pointless reload (fixed in `signals.py`/`stages.py`
  and added to the fixtures); the model proposed `reload` for a 401 and for an HTTP
  500 (prompt rules added, see the evaluation).

## Final review (read-only, 2026-10-10)

Scope: whole working tree (nothing committed; 84 collapsed paths at the time, which is 102 files — git collapses new directories — and 112 files after the second pass below). No code
was changed during the review; this file is the only edit. Re-run after the
review: backend 584 passed (hash-locked env, incl. real Postgres/Redis), extension
75, Buggy Cloud 10, `tsc` and `ruff` clean, `eval.py --engine offline` 0 unsafe,
browser E2E 63/63 and 57/57. The tree was identical before and after the runs.

**Checked and found sound:** every `/api/*` route requires a principal
(only `/health` and `/ready` are open); another tenant's or user's session is
always 404; read-only keys get 403 on writes; an approval is bound to the
principal and `proposal_id`, and `/action-result` re-checks policy and approval
server-side; the action list is closed in the backend, the extension and the SDK;
CORS is off unless origins are listed and `*` is refused in production; no
secrets, keys or tokens in tracked or untracked files, `.env`/`*.db` are ignored,
and test logs contain none.

**Findings, most important first**

1. **FIXED (see "Fixes after the review") — free text was not sanitized in the browser.** `ASK_OPERON` and
   `ANSWER` send the user's typed text unredacted (`extension/src/background.ts`;
   only evidence bundles and verification observations go through
   `redactDeep`). The backend then redacts the issue (verified: stored and logged
   as `[REDACTED:github_token]`) and rejects an answer containing a credential
   (422, not stored). Nothing leaks into storage or logs, but the raw value does
   leave the browser, which the stated rule forbids. Fix: run `redactText` on both
   in the background script.
2. **FIXED (see below) — `.env.example` shipped `AUTH_REQUIRED=false`, and `ENVIRONMENT` defaults to
   `development`.** The production guard only protects a deployment that sets
   `ENVIRONMENT=production` (`render.yaml` does). Copying `.env.example` to a host
   gives an unauthenticated shared "public" tenant. Fix: make the example default
   `AUTH_REQUIRED=true`.
3. `/ready` is unauthenticated and reports the database dialect, embedding state,
   the Groq model name and configuration problems. Low sensitivity, but it is
   public information about the deployment.
4. Verification trusts what the browser reports. The backend decides
   passed/failed from the evidence the extension sends; a compromised page or
   client could report a clean observation. This is inherent to a browser-side
   agent and acts only on the user's own tab, but it is not independent
   verification.
5. Deployment assumptions never tested: Neon's pooled connection string may break
   `alembic upgrade head` (use the direct, non-pooled endpoint for migrations);
   `FASTEMBED_CACHE_PATH=/opt/render/project/src/backend/.cache/fastembed`; and
   `TRUSTED_PROXY_HOPS=1` behind Render's proxy chain (a wrong value makes the
   failed-auth throttle key on the wrong address; authenticated limits key on the
   API key and are unaffected).
6. Gaps: no key expiry or rotation; `last_used_at` is written on every request;
   the browser is Chromium-only.
7. Documentation drift: `docs/README.md` does not list the new documents;
   `docs/plan/02-phase-2-fake-saas.md` and `03-roadmap.md` still describe the
   second app as future work on Vercel; older sections of `docs/TESTING.md` are
   marked historical rather than rewritten; `.gitignore` still lists `.vercel/`.
   Code mismatch: `date_format` is in the backend and extension allowlists but
   Buggy Cloud's handler rejects it (fails safe; harmless).

**Nothing here is evidence of production readiness.** Production readiness would
need at least: the Render/Neon/Redis deployment actually run, the CI workflow run
on GitHub, findings 1 and 2 fixed, and the extension exercised against the
deployed backend.

## Fixes after the review (2026-10-10)

Findings 1 and 2 above were fixed; findings 3–7 are unchanged.

**Finding 1 — free text redacted in the browser.** `extension/src/background.ts`
now routes every piece of non-evidence free text through one helper,
`safeText()` (`redactText`, then truncation, so a secret is never cut short of
being recognised): the user's issue (`POST /api/sessions`), the answer to a
question (`POST …/answer`), and the outcome string reported for an executed action
(`POST …/action-result`; that string can originate in the page's own SDK handler).
Every other `POST` the extension makes was checked: evidence bundles and
verification observations already went through `redactDeep`; `/approve`,
`/investigate` (bundle only) and `/policy` carry only ids. The backend still
redacts as a second line of defence.

*Demonstrated by:* `extension/tests/free-text-redaction.test.mjs` (5 tests),
which assert on the serialized bodies the extension actually passes to `fetch`: a
GitHub-token-shaped and a JWT-shaped value in the issue, in an answer, and in a
page-supplied action outcome never appear in any request body; text near the
1,000-character limit does not leak the front of a token; ordinary text including
a Git SHA is not altered. With redaction removed from the helper, 3 of the 5 fail.
*Not demonstrated:* a real browser sending a real secret — the browser E2E
suites (63/63, 57/57, re-run and passing) cover the wiring but cannot distinguish a
browser-redacted value from a backend-redacted one; credential-shaped strings the
redaction rules do not recognise (the rule set is pattern-based) still reach the
backend, where the same patterns apply.

**Finding 2 — authentication on by default.** `backend/.env.example` now sets
`AUTH_REQUIRED=true` (the code default was already `true`, and production refuses
`false`). Local development still works: create a key with
`python scripts/manage_keys.py create --tenant dev --subject you --role user`
(verified against a fresh database), paste it under *Backend access*, or set
`AUTH_REQUIRED=false` deliberately for throwaway experiments. The README
quick-start now includes the key step.

*Demonstrated by:* `backend/tests/test_auth_defaults.py` (5 tests): the code
default is `true`; the example file a person copies parses to `true` and sets no
CORS origins and no key (flipping it back to `false` makes the test fail);
production reports an error for `AUTH_REQUIRED=false`; and with the real default
restored on the running app, every one of 12 endpoints answers 401 with the same
body for a missing and a forged key, while `/health` stays open.
*Not demonstrated:* a deployed host (nothing is deployed); `ENVIRONMENT` still
defaults to `development`, so a host that sets neither variable relies on the
`AUTH_REQUIRED=true` default.

Re-run after the fixes: backend 589 passed, ruff clean; extension 80 passed,
`tsc` clean; browser E2E 63/63 and 57/57. (Superseded by the second pass below.)

## Second review pass (2026-10-10)

**Working tree.** 112 files (46 modified or deleted, 66 new) were inspected by
category: backend source/tests/migrations/scripts, extension source/tests/E2E, the
SDK, Buggy Cloud, CI and `render.yaml`, documentation. Nothing stray: no `.env`, no
database, no lockfile or `node_modules` for the new packages, no secret-shaped string
outside the redaction rules themselves. The deletions are the two Vercel files.

**Browser-level proof of redaction (new).** `npm run e2e:wire`
(`extension/e2e/free-text-wire.mjs`, 11/11): the extension is built against a
recording proxy that sits between Chromium and the real backend, so it captures the
exact bytes the extension service worker sends. A fake GitHub token, a fake JWT, a
random key in no known format and "my password is …" typed into the real popup are
absent from every captured byte, from the stored session, from the database file and
from the backend logs, while the useful words survive. With redaction disabled in the
extension, 7 of the 11 checks fail (including the stored-session and database checks:
the backend alone does not catch the unknown-format key or the stated password — see
below). The proxy is part of the test, not of the product.

**Redaction limits and the added protections.** Fixed, vendor-specific patterns miss
anything in a format they do not know. Added for *free text only* (what a person
types), in the extension (`redactFreeText`) and mirrored in the backend
(`tripwire.redact_free_text`, now used for the issue, answers, action outcome strings
and the legacy `/api/diagnose` message): more vendor prefixes (Stripe, SendGrid, npm,
PyPI, GitLab, Google OAuth); "password/token/key is <value>" when the value mixes
letters and digits (so "the token is expired" is untouched); and any run of 24+
characters with upper case, lower case, a digit and Shannon entropy ≥ 3.9 bits/char.
Measured on 2,000 seeded random base-62 keys per length: 24 chars ≥ 90%, 32 chars ≥ 97%,
40 and 64 chars ≥ 99% redacted (asserted by tests in both languages). A corpus of
ordinary text (errors, identifiers, UUIDs, Git SHAs, URLs, versions, "the token is
expired") is left unchanged. Known limits, each covered by a test: a long mixed-case
identifier containing a digit can be over-redacted (a few words lost, no leak);
low-entropy or short secrets ("my pin 4829", "secret=abc") are *not* caught;
evidence payloads keep the exact fixed rules (the heuristics would be too aggressive
there). This lowers risk; it does not make leakage impossible.

**The other review findings.**

| Finding | Outcome |
|---|---|
| 3. Public `/ready` | **Documented, not changed** (`docs/DEPLOYMENT.md`, "Known limits"): what it reveals and how to block it. Render's health check uses `/health`. |
| 4. Verification trusts the browser | **Documented** (`docs/DEPLOYMENT.md`, README safety model). Unchanged design: an action that cannot be re-observed is `inconclusive`, never `passed`. |
| 5. Deployment assumptions | **Documented** as untested (`docs/DEPLOYMENT.md`): direct Neon URL for migrations, model cache path, proxy hop count, `vector` extension privilege. Still **BLOCKED** until deployed. |
| 6. Key rotation | **Procedure documented** (create → hand over → revoke, `docs/DEPLOYMENT.md`); no expiry or admin API: **NOT STARTED**. |
| 7. Outdated plan docs | **Fixed**: `docs/plan/02-phase-2-fake-saas.md` (status banner + honest milestone ticks, including that Buggy Cloud contains one SDK call the plan forbade), `03-roadmap.md`, `00-overview.md`, `docs/README.md` index, stale `.vercel` ignore entry. Older sections of `TESTING.md` remain marked historical. The `date_format` mismatch between the allowlists and Buggy Cloud remains (harmless: it fails safe). |

**Re-run (this pass).** Backend 608 passed and `ruff` clean (hash-locked env, real
Postgres/Redis); KB lint ok; `eval.py --engine offline` 0 unsafe; extension 87 passed,
`tsc` clean; Buggy Cloud 10; browser E2E: wire 11/11, local suite 63/63, Buggy Cloud
57/57, real github.com demo 21/21. Not re-run: live-Groq evaluation (the Groq prompt
and model path were not touched in this pass) and the live `e2e:github` check.

**Blockers before a commit is advisable.** None in the code. Before *deploying*: the
manual steps in `docs/DEPLOYMENT.md`, a first CI run on GitHub, and a decision on
whether `/ready` should stay public. Reviewer attention is most useful on
`extension/src/background.ts`, `backend/operon_backend/{auth,session_service,tripwire,main}.py`
and `backend/migrations/`.

## Targeted review: `/ready`, migrations, authentication defaults (2026-10-10)

Read-only; no code changed. Working tree unchanged at 112 files.

**`/ready` — recommendation: do not keep the detailed response public.** It
contains no secret value (verified by reading the live response in development and
production mode and by `test_ready_reports_checks_without_secrets`), but it tells an
unauthenticated caller: the database dialect, the number of knowledge chunks, whether
the embedding model loaded (and, if it failed, the exception *type*), whether a Groq key
is configured and the model name, the environment name, and a `config_problems` list
that names which protections are missing ("REDIS_URL is not set", "SQLite", "no
GROQ_API_KEY"). The last item is the most useful to an attacker. Nothing in the
deployment needs it public: Render's health check uses `/health`. Suggested change
(not made): return only `{"status": ...}` to unauthenticated callers in production and
give the detail to an authenticated admin key, or when `ENVIRONMENT` is not production.
Until then keep `/ready` unreachable from the internet (a proxy rule) or accept the
disclosure. **Not a blocker for a commit; should be decided before a public deploy.**

**`/docs`, `/redoc` and `/openapi.json` are public in every environment** (FastAPI
defaults), exposing the full API schema. Suggested (not made): disable them when
`ENVIRONMENT=production`. Same classification as above.

**Migrations — safe, with caveats.** On a fresh database `alembic upgrade head` applies
0001 and 0002; `downgrade base` then `upgrade head` round-trips; `alembic check` reports
no drift between the models and the migrations; 0002's Postgres-only SQL (extension,
column, trigger, HNSW index) was exercised on real Postgres + pgvector by the test
suite and is skipped on SQLite. Production refuses to start on a database behind head
(observed: "schema is at revision none but the code needs 0002"). Caveats: 0001 is a
`create_table` baseline, so a development database previously built by `create_all`
must be adopted with `alembic stamp 0001`, not upgraded; a `downgrade` below 0001 drops
all tables (the start command only ever runs `upgrade`); not exercised on Neon.

**Authentication defaults — safe.** Code default `AUTH_REQUIRED=true`; `.env.example`
copies as `true` (test fails if flipped); `render.yaml` sets production + auth on and
keeps secrets `sync: false`; production refuses `AUTH_REQUIRED=false` and `*` CORS.
All 12 `/api` routes answer 401 identically for missing and forged keys. Remaining
non-blocking gap: `ENVIRONMENT` defaults to `development`, so a host that sets neither
variable relies on the `AUTH_REQUIRED=true` default.

**Redaction cost on hostile input.** The new free-text rules (Python and JS) ran on
200–300 KB adversarial strings (repeated keywords, long digit runs, whitespace floods,
URL floods) in under 0.1 s: no catastrophic backtracking observed.

**Re-run:** `test_deploy_readiness`, `test_auth_defaults`, `test_migrations`,
`test_auth`, `test_tenants`: 57 passed.

**Critical issues that must be fixed before a commit is authorized: none found.**

## Public surface hardening (2026-10-10)

Implemented after the targeted review (`backend/operon_backend/main.py`):

- **`/ready`, anonymous, production:** exactly `{"status":"ok"}` (200) or
  `{"status":"unavailable"}` (503 when the database cannot be reached). No database type,
  chunk count, embedding state, model name, configuration problems or exception text; a
  degraded-but-serving instance also reads "ok".
- **`/ready`, authenticated admin:** the full diagnostics. This is the normal
  authentication (`current_principal`), made optional only for this route: a bad, revoked or
  malformed key is the usual 401 and counts toward the same failed-attempt throttle; a valid
  non-admin key gets the minimal answer. Outside production everyone gets the full answer, as
  before. Secret values are never reported to anyone.
- **`/docs`, `/redoc`, `/openapi.json`:** not registered when `ENVIRONMENT=production` (404);
  served in development and test.
- **`/health`:** unchanged; `render.yaml` still uses it as the health check.

*Demonstrated by* `backend/tests/test_ready_docs_hardening.py` (13 tests): the anonymous
production body equals `{"status":"ok"}` and contains none of 28 forbidden fragments
(including with a configured Groq key, a degraded embedding model, and a down database
whose exception text must not appear); viewer and user keys get the minimal answer; an admin
key gets the full answer; forged, malformed and revoked keys get 401 and repeated guesses hit
the 429 throttle; development is unchanged; and two **fresh processes** import the real
module with `ENVIRONMENT=production` and `development` on a migrated database and probe all
five URLs (production: docs 404 and minimal `/ready`; development: docs 200 and detailed
`/ready`). Disabling either protection makes 6 and 2 of those tests fail respectively.

**Results after this change:** backend 621 passed and `ruff` clean (hash-locked env, real
Postgres/Redis); browser E2E local suite 63/63 and wire test 11/11 re-run and passing. The
other suites do not touch these routes and were not re-run (extension 87, Buggy Cloud 10,
E2E Buggy Cloud 57/57 and GitHub demo 21/21 from the previous pass).

**Remaining concerns.**
- A degraded instance (empty knowledge base, embedding model not loaded) now looks "ok" to
  anonymous probes, so the platform health check cannot see it; operators must use an admin key
  or the logs. An admin key also sees every session of its tenant, so it should not be put in
  the extension.
- `/ready` with an admin key performs the same checks as before (one `SELECT`), unthrottled for
  anonymous callers like `/health`; add a rate limit if it is ever exposed beyond the platform.
- Not changed: `ENVIRONMENT` still defaults to `development`; no key expiry or admin API;
  verification still trusts the browser; the deployment, CI and managed-Redis items remain
  unverified. Nothing here has been deployed.

Working tree: 113 files (46 modified or deleted, 67 new); nothing committed.

## SDK + extension completion pass (2026-10-11)

Goal: make both integrations usable and verified through the one shared backend pipeline. Levels used below:
**Implemented** · **Locally tested** (unit/contract) · **E2E verified** (real backend process, real Chromium) ·
**Deployed-verified** (none) · **Unverified**.

### What was built or changed

* **SDK is now a real client** (`sdk/operon-sdk.js`, v0.2.0): `init(config)` → `diagnose` / `answer` / `continue` /
  `decide(true|false)` / `on` / `dispose`; validated config (https-only except localhost, token or `getToken`,
  closed action list, storage allowlist); opt-in bounded console/network capture; typed `OperonError` codes;
  timeouts, abort, `busy` guard, no automatic retries, session-id cross-checks; progress over a fetch-streamed
  event stream; actions `reset_user_preference` (app code), opt-in `clear_storage_key` / `unregister_service_worker`;
  honest verification (`reobserve_unavailable` ⇒ backend says *inconclusive*). The old extension-carrier
  (`registerOperon`) is kept. Plus `operon-sdk.d.ts`, `package.json`, a classic-script build
  (`scripts/build.mjs` → `dist/operon-sdk.iife[.min].js`, git-ignored) and `sdk/README.md`.
* **One redaction implementation.** `sdk/redact.js` is the single source; `extension/src/lib/sanitize.ts` re-exports it.
* **Buggy Cloud** gained the SDK integration (`src/operon-panel.js`): a panel with Diagnose / Approve / Reject,
  all backend text rendered with `textContent`; `server.mjs` can serve `/operon-config.json` (local testing only).
* **Backend:** sessions now report `source` and `provider_capabilities`; page-written evidence text is scrubbed
  (free-text heuristics + key-like URL path segments) before it is stored or shown to the model, and the same for
  verification observations; the legacy `/api/diagnose` message and the issue/answer/action text use the same scrub.
* **Extension:** unsupported pages (chrome://, Web Store, other extensions, file:, about:) are refused up front;
  duplicate or racing Approve/Deny/Ask/Answer clicks are ignored while a step is in flight (RESET always works);
  unused permissions `scripting` and `activeTab` removed; console lines and URLs get the extra redaction.
* **E2E harness:** `startRecordingProxy` (request bytes), and new suites `e2e:sdk`, `e2e:sdk-wire`.

### Defects found by this pass and fixed (each has a regression test)

| # | Defect | Found by |
|---|---|---|
| 1 | The extension↔page bridge gave the page's handler only 1.5 s to finish, so a slow (async, networked) fix was reported as "page did not answer" although it could still run | review; `appbridge` now waits 15 s, the SDK answers within 10 s |
| 2 | Registering the SDK twice registered two listeners (duplicate replies) | SDK unit test |
| 3 | `String(msg.action)` on a page-controlled object threw inside the SDK's message handler (no reply, unhandled rejection) | SDK carrier test |
| 4 | A JSON parser's error message can quote the stored value; it was sent as `error_message` (SDK, and the extension's content script) | **SDK wire test** |
| 5 | Console lines, titles and URLs written by the page were redacted with fixed patterns only, so keys in unknown formats, "password is …" and vendor keys reached the backend and its database | **SDK wire test** (backend alone did not catch them either) |
| 6 | Key-like path segments in reported URLs (`/reset/<token>`) were exempt from redaction | backend test |
| 7 | Two quick clicks on Approve could send two approvals | lifecycle test (fails with the guard removed) |
| 8 | Browser-internal pages were accepted and failed halfway through | lifecycle test |
| 9 | Unused `scripting`/`activeTab` permissions | manifest test (every permission must have a use) |

### Verification (final tree, commands run from the repository root)

| Component | Command | Result |
|---|---|---|
| Backend (hash-locked env, real Postgres + Redis) | `cd backend && pytest --ignore=tests/live` | **631 passed** |
| Backend lint / KB lint / audit | `ruff check .` · `kb_lint.py` · `pip-audit -r requirements.txt --strict` | clean · ok · no known vulnerabilities |
| Offline evaluation | `python eval.py --engine offline` | 21 fixtures, 21/21 category and action, 0 unsafe |
| SDK contract (JS bodies vs. backend models) | `pytest tests/test_sdk_contract.py` (inside the 631) | pass |
| SDK unit | `cd sdk && npm test` | **65 passed** (incl. built-script tests) |
| SDK build / types | `node scripts/build.mjs`; `tsc --strict` on `operon-sdk.d.ts`, `redact.d.ts` and a usage file | built 41,977 / 24,498 bytes; types clean |
| Extension unit / types / builds | `cd extension && npm test` · `npx tsc --noEmit -p .` · `npm run build -- github`, `-- e2e-local` | **102 passed** · clean · built |
| Buggy Cloud unit | `cd buggy-cloud && npm test` | **12 passed** |
| E2E: extension, local fixtures (auth on) | `npm run e2e` | **63/63** |
| E2E: extension → Buggy Cloud (7 bugs + control + forged token + backend down) | `npm run e2e:buggy` | **67/67** |
| E2E: SDK → Buggy Cloud, no extension (7 bugs, reject, approve, replay, cross-user/tenant, inconclusive, failures, control) | `npm run e2e:sdk` | **112/112** |
| E2E wire: extension request bytes | `npm run e2e:wire` | **11/11** |
| E2E wire: SDK request bytes | `npm run e2e:sdk-wire` | **15/15** |
| E2E: real github.com approve / deny (outbound HTTPS was available) | `npm run e2e:demo` | **23/23** |
| E2E: real github.com read-only | `npm run e2e:github` | **17/17** |
| Dependencies | `npm audit --omit=dev --audit-level=high` (extension); SDK has no dependencies | 0 vulnerabilities |

### Workflow status

| Workflow | Level |
|---|---|
| SDK → backend → investigation | **E2E verified** (`e2e:sdk`) |
| SDK → backend → approved fix → backend verification | **E2E verified**, incl. independent re-check of the app after a fresh load |
| SDK → backend → rejected fix (nothing runs; later approval is 409) | **E2E verified** |
| Extension → backend → investigation / live progress | **E2E verified** (`e2e`, `e2e:buggy`) |
| Extension → backend → approved fix → verification | **E2E verified** |
| Extension → backend → rejected fix | **E2E verified** (`e2e`, deny scenario; `e2e:demo` on real github.com) |
| Buggy Cloud: all 7 bugs + healthy control | **E2E verified** through both integrations |
| Real GitHub compatibility | **E2E verified** (read-only + seeded harmless key; no change to GitHub itself) |
| Wire-level redaction | **E2E verified** for both clients, with mutation checks (disabling the protection fails 3–7 checks) |
| Production endpoint behaviour (`/ready`, no API docs, auth defaults) | **Locally tested** (fresh production process) |
| Any of the above against a deployed backend | **Unverified** |

### Still needs a manual step or credentials

Render/Neon/Redis/Groq accounts and the steps in `docs/DEPLOYMENT.md`; a first CI run on GitHub (the workflow now
also runs SDK tests, the type check, `e2e:sdk`, `e2e:sdk-wire`); loading the built extension into a desktop Chrome
(the suites drive Chromium with the extension loaded, but the toolbar popup is exercised as a tab); a real model run
of the SDK path (all SDK/extension suites use the offline engine; the earlier Groq evaluation covers the model);
a key-issuing mechanism for SDK tokens (today `manage_keys.py`).

### Not production-ready

Nothing was deployed; remote CI never ran; Chromium only; redaction is heuristic (limits in `sdk/README.md`);
verification trusts the client's report; no key expiry/rotation API; the SDK cannot reload the page.

Working tree: branch `main`, **133 files** (46 modified or deleted, 87 new), nothing committed. Tracked files changed
beyond the earlier work in this pass: `extension/src/{background,content,lib/sanitize}.ts`,
`extension/manifest.template.json`, `extension/package.json`, `extension/e2e/*`, `backend/operon_backend/{main,schemas,
evidence,session_service,tripwire}.py`, `.github/workflows/ci.yml`, `.gitignore` and docs.

## Local completion pass (2026-10-11): one local project, real-model path, built-extension checks

Deployment is out of scope here. Added: `scripts/dev-local.mjs` (one command starts the backend and Buggy Cloud with
the SDK panel, mints keys, builds the SDK script and `extension/dist/local-demo`, self-checks, stops stale processes,
reports busy ports); `docs/LOCAL_DEVELOPMENT.md` (exact commands, ports, health checks, Chrome steps,
troubleshooting); `sdk/examples/minimal.html` (classic-script example, exercised in a real browser); Buggy Cloud
"Reset this scenario" (`&reset=1`); `extension/targets/local-demo.json`; `OPERON_BUILD_OUT` so unit tests never
overwrite the `dist/` you loaded in Chrome; `tests/build-artifact.test.mjs` (inspects the built directories);
`OPERON_E2E_GROQ=1` / `OPERON_E2E_BUGS` for the browser suites.

| Check (final tree) | Command | Result |
|---|---|---|
| Backend | `cd backend && pytest --ignore=tests/live` | **631 passed**; `ruff` clean; KB lint ok; `pip-audit` clean |
| Offline evaluation | `python eval.py --engine offline` | 21 fixtures, 21/21, 0 unsafe |
| SDK | `cd sdk && npm test`; `node scripts/build.mjs` | **65 passed**; script built (41,977 / 24,498 bytes) |
| Extension | `npm test`; `npx tsc --noEmit -p .`; builds | **112 passed** (incl. built `dist/` for github, local-demo, e2e-local); clean; `npm audit --omit=dev` 0 |
| Buggy Cloud | `cd buggy-cloud && npm test` | **13 passed** |
| Whole local project | `node scripts/dev-local.mjs --fresh --check` | passed (also: restart reusing db/keys; stale orphan stopped; busy port and missing-deps messages; no processes left) |
| Extension in Chromium, local fixtures | `npm run e2e` | **63/63** |
| Extension → Buggy Cloud (7 bugs, control, forged token, backend down) | `npm run e2e:buggy` | **67/67** |
| SDK → Buggy Cloud, no extension (7 bugs, reject, approve, replay, cross-user/tenant, reset and rerun, example page, inconclusive, failures, control) | `npm run e2e:sdk` | **121/121** |
| Wire: extension / SDK | `npm run e2e:wire` / `e2e:sdk-wire` | **11/11** / **15/15** |
| Real github.com (outbound HTTPS was available) | `npm run e2e:demo` / `e2e:github` | **23/23** / **17/17** |
| **Real model (Groq `gpt-oss-120b`)**, SDK path | `OPERON_E2E_GROQ=1 OPERON_E2E_BUGS=2 npm run e2e:sdk`, then `=4` | bug 2: **26/26** (diagnosed `invalid_preference`, proposed `reset_user_preference timezone`, reject ran nothing, approve verified by the backend, independent re-check clean); bug 4: **13/13** (`network_error`, no action, escalated) |
| **Real model**, extension path | `OPERON_E2E_GROQ=1 OPERON_E2E_BUGS=2,4 npm run e2e:buggy` | **18/18** (same outcomes; engine recorded as `groq`) |

**Real AI path:** exercised, once each for a fixable bug (2) and a no-action bug (4), through the SDK and through the
built extension, with the key injected by this environment's egress proxy (no key was written anywhere). Not
exercised with the real model: bugs 1, 3, 5, 6, 7 and the control (the free tier allows ~8,000 tokens/minute); the
model is non-deterministic, so these runs are a sanity check, not a regression gate.

**Built extension in Chromium:** yes — every browser suite loads the freshly built `dist/<target>` with Playwright's
Chromium. **Desktop Chrome by hand:** not done; steps are in `docs/LOCAL_DEVELOPMENT.md`. The toolbar popup is
exercised as a tab (Playwright cannot open the real popup).

**Independence:** the SDK runs with no extension (`e2e:sdk` launches plain Chromium); the extension runs against a
Buggy Cloud served without the SDK panel and without any SDK dependency for the baseline fixes (`e2e`, `e2e:buggy`,
`e2e:demo` on GitHub); both create sessions through the same endpoints (`source` and declared capabilities are the only
difference — `backend/tests/test_sdk_extension_parity.py`).

Remaining local gaps: no key-issuing HTTP API for SDK tokens; Chromium only; popup not tested in the real toolbar;
nothing deployed, no remote CI run (out of scope).

Working tree: branch `main`, 138 files (46 modified or deleted, 92 new); nothing committed. Generated, git-ignored
folders (`.local/`, `dist/`) were removed after the runs.

## Local usability verification (2026-10-12)

Performed on a clean checkout state of tools: `backend/.venv` created exactly as `docs/LOCAL_DEVELOPMENT.md` says
(`pip install --require-hashes -r requirements.txt`), then `node scripts/dev-local.mjs` with the venv activated:
it started the backend (`:8000`) and Buggy Cloud (`:4300`), built `sdk/dist` and `extension/dist/local-demo`, and
passed its own self-check. Verified from outside: `/health` ok; `/ready` with the admin token `ready`, 91 KB chunks;
401 without a key; `/`, `/?bug=1…7`, `&reset=1`, `/operon-config.json`, the SDK files, the example page, the reports
API (`:4301`) and the bug-4/bug-5 API failures all answer as designed.

New `npm run e2e:live` (`extension/e2e/live-local.mjs`) tests that running stack: **76/76** — SDK panel in plain
Chromium and the built `dist/local-demo` extension, each through all seven scenarios and the control, reject then
approve with backend verification and an independent page check, plus the classic-script example page.

Regression suites run in the same session (all pass): backend 631, `ruff`, `pip-audit`, offline eval 21/21 (0 unsafe),
SDK 65, Buggy Cloud 13, extension 112 + `tsc` + `npm audit --omit=dev` (0), and the browser suites `e2e` 63/63,
`e2e:buggy` 67/67, `e2e:sdk` 121/121, `e2e:wire` 11/11, `e2e:sdk-wire` 15/15, `e2e:demo` 23/23 and `e2e:github` 17/17
(outbound HTTPS to github.com was available). No fix to product code was needed in this pass.

Real model (kept separate; Groq `gpt-oss-120b`, key injected by the environment, never printed): SDK bugs 2 and 4 — 34/34;
extension bug 4 alone — 8/8; extension bug 2 passed all its checks (diagnosis, approval, backend verification, clean
reload). The first combined extension run timed out waiting on bug 4 (the free tier allows ~8,000 tokens/minute and the
model is non-deterministic); the same scenario passed when re-run alone. Bugs 1, 3, 5, 6, 7 and the control were NOT
real-model tested. Desktop Chrome was not driven by anyone: still a manual step.

## Status summary

| Status | Items |
|---|---|
| **DONE** | github.com approve/deny demo; live progress stream; Render decision; config validation, `/health`, `/ready`; auth, tenants, approval enforcement; rate limits; logging; CORS policy; migrations, Postgres/pgvector, Redis (local); dependency locking and audits; staged pipeline and classify; answer endpoint; `eval.py` and fixtures; Buggy Cloud (7 bugs); SDK and `reset_user_preference`; second-app E2E; SDK-vs-extension design |
| **PARTIAL** | CI (written, never run); evaluation (small, self-written, one model); credential redaction (heuristic, see second pass); verification (browser-reported); key lifecycle (CLI only, no expiry) |
| **NOT STARTED** | key rotation/expiry and an admin API; non-Chromium browsers; published SDK package; learning-loop evaluation; the GitHub API agent |
| **BLOCKED** (needs your accounts or authorization) | creating the Neon database and Render service; minting production keys; running CI on GitHub; testing against managed Redis; any commit or push |
