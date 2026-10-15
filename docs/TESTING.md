# Testing and real-service validation

> **Newer results** (auth, Postgres/Redis, SSE, staged pipeline, questions, the
> evaluation, Buggy Cloud) are in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md);
> the section "Autonomous-execution milestone" below summarises how to run them.
> The "Validation results" and "Known limitations" sections further down describe
> the earlier validation milestone and are kept as history where marked.

This page says what each test suite exercises, what is stubbed and what is
real, and what was actually validated against real services in the
validation milestone. Status words mean:

- **DONE**: implemented and exercised against the real thing.
- **PARTIAL**: implemented, some of it exercised for real.
- **MOCKED**: exercised only against a stand-in.
- **BLOCKED**: could not be exercised here, for the reason given. Nothing is
  claimed.
- **UNVERIFIED**: implemented but not exercised.
- **NOT IMPLEMENTED**: does not exist yet.

## External dependencies

| Dependency | Configured by | Used for | Fallback when unavailable | In the offline suite |
|---|---|---|---|---|
| Groq chat/completions (`openai/gpt-oss-120b`, JSON mode) | `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_SECONDS` | diagnosis | labelled offline `rule_based` engine (no key), or a clean 400 that consumes nothing (key set, call failed) | `FakeGroq` (replaces only the network call) and `groq_stub.py` (a local OpenAI-compatible server driving the real HTTP client) |
| Embedding model `sentence-transformers/all-MiniLM-L6-v2` (fastembed, ONNX, 384-d) | downloaded on first use from `huggingface.co` / `*.hf.co`; `EMBEDDING_RETRY_COOLDOWN_SECONDS` | indexing the KB at startup, knowledge retrieval, session-history ingestion | startup logs `Knowledge base not initialized` and keeps serving; retrieval is recorded as `empty_index` (nothing indexed) or `error` (`EmbeddingUnavailable`), never `no_match`; the investigation continues; history ingestion is skipped | the real model (tests that need it fail with the cause when it can't load) |
| github.com | `extension/targets/github.json` | the target site | — | local fixture pages (`extension/e2e/fixtures`) |
| Database | `DATABASE_URL` (default SQLite) | SupportSession, knowledge chunks | — | a throwaway SQLite file |

## Suites

### Backend (`cd backend && pytest`)

- **Unit/flow tests** (`tests/test_*.py`): state machine, evidence requests and
  provenance, the investigation pipeline, grounding and regeneration,
  planning, policy, approval, server-side verification, retry, escalation,
  limits, activity, the KB.
- **`test_api_contract.py`**: malformed, mismatched, stale, oversized and forged
  requests to every session endpoint. Every rejection is a 4xx and leaves the
  session unchanged. Covers wrong or reused `request_id`, unknown collectors,
  oversized input, malformed evidence, an unsupported or different action, a
  mismatched `action_id`, a finished session, missing fields, an invalid
  observation, and a client sending `passed`/`outcome`.
- **`test_safety_matrix.py`**: 32 secret kinds (API keys, GitHub tokens, JWTs,
  bearer/basic auth, cookie headers, passwords, connection strings, private
  key fragments, URL userinfo/query/fragment, hex in token context) and 17
  benign look-alikes. It checks detection, redaction, and end-to-end
  non-leakage into the database, the model prompt, the retrieval query, the
  knowledge base, activity, API responses and logs. It also covers the
  Git-SHA exemption. Secrets are assembled at runtime from fragments.
- **`test_failure_injection.py`**: every collector failing, a page that never
  yields evidence, a model that keeps failing, and the LLM-call budget.
- **`test_groq_http_client.py`**: the **real** Groq client over HTTP against a
  local server. Covers the request contract, 429/5xx/401, non-JSON and empty
  responses, timeout, unreachable host, regeneration, normalization of fenced
  or null fields (never of grounding), and escalation. A stubbed endpoint, not
  live validation.
- **`test_embeddings_failure.py`**: model-load failure becomes
  `EmbeddingUnavailable` with its cause, the cooldown, retry after the
  cooldown, and the investigation degrading cleanly. An empty index raises
  `KnowledgeIndexEmpty` instead of returning "no results".
- **`test_knowledge_startup.py`**: the real FastAPI startup on a fresh
  database indexes the curated KB with real 384-d vectors. Restarts are
  idempotent (same chunks, nothing re-embedded). An existing KB is never
  overwritten, and history alone doesn't count as an initialized KB. A
  concurrent seed by another process isn't an error, and startup survives an
  unavailable model. It also covers retrieval after startup (corrupted-cache
  hit), a genuine `no_match`, and `empty_index` reported for an empty KB.
- **`tests/live/`**: **real** services, skipped with the reason when
  unavailable. `OPERON_REQUIRE_LIVE=embeddings|groq|all` turns a skip into a
  failure. The live embedding tests refuse to run against a stand-in.
- **`scripts/validate_services.py`**: a human-readable PASS/FAIL/BLOCKED report
  for real embeddings (load, dimension, unit length, semantic ordering, KB
  indexing, retrieval of known scenarios, empty result for an unrelated
  query, persistence) and real Groq (grounded diagnosis, no action without
  evidence, injected page text treated as data). `--require all` exits
  non-zero on BLOCKED. The key is never printed.

### Extension (`cd extension`)

- `npm test`: node:test against the real bundled `background.ts` /
  `sanitize.ts` in a simulated browser (collection, execution, observation,
  resync, resilience, redaction).
- `npx tsc --noEmit -p .`: typecheck.
- `npm run build -- <target>`: per-target build. `OPERON_BACKEND_URL` is
  validated at build time.
- `npm run e2e` / `npm run e2e:github`: browser E2E against the actual
  build and the real backend. See [`../extension/e2e/README.md`](../extension/e2e/README.md).
- `npm run e2e:github-escalation`: real github.com, two genuine server-side
  failures (a 404 for a missing repository, a 401 for an anonymous request to
  `api.github.com/user`) must be diagnosed, not acted on, escalated, and
  ticketed. Anonymous and read-only; exit 2 = BLOCKED.
- `npm run e2e:dashboard`: the support dashboard in Chromium against the real
  backend — markup planted in a ticket renders as inert text, no script runs,
  the key stays out of storage and the URL, tenants and users see only their
  own tickets, the page is read-only.
- `npm run e2e:reproduce`: `scripts/reproduce-ticket.mjs` against real tickets —
  a server-side failure reproduces, a client-state failure does not (and does
  with `--recreate-storage`), other hosts are blocked in the sandbox, an
  unlisted host and another tenant's key are refused, the key never appears in
  the output.
- `npm run e2e:screens`: Buggy Cloud's five screens under every seeded bug and
  the healthy control, plus the hidden diagnostics control.

### Backend additions (2026-10-14)

- `test_tickets.py`: a ticket per escalation (no-action, policy DENY, low
  confidence), idempotent, report content and re-redaction, cross-tenant and
  cross-user 404s, admin-only triage, the dashboard's CSP and file allowlist,
  text-only rendering.
- `test_budget.py`: dedupe, truncation, redaction, the token cap keeping the
  explanatory evidence, determinism, and the `evidence_budget` activity entry.
- `test_staged_pipeline.py`: the three staged calls, their prompts and inputs,
  discarded diagnose-stage actions, plan regeneration and fail-safe, the
  deterministic classification fallback, a session driven to a proposal.
- `test_eval.py`: per-stage scoring for both pipelines.
- `test_migrations.py`: migration `0003` up and down on SQLite and PostgreSQL.

### Static

`ruff check .` (backend), `python docs/knowledge-base/scripts/kb_lint.py`,
`npm audit`, `pip-audit -r backend/requirements.txt`.

## Validation results

Latest full run: 2026-10-05, after the knowledge-base startup fix. Network
access then allowed `api.groq.com`, `huggingface.co` and its download hosts.

| Check | Result |
|---|---|
| Backend, offline suite with the real embedding model (`pytest --ignore=tests/live`) | **422/422 passed**, twice. This was 413/413 before the startup fix, which added the 9 `test_knowledge_startup.py` tests. |
| Retrieval / RAG / session-flow / startup / embedding-failure tests | 44/44 passed |
| `tests/live` with `OPERON_REQUIRE_LIVE=all` | **16/16 passed**: 10 embedding tests in one batch, 6 Groq tests run a minute apart (see the rate-limit note) |
| `validate_services.py --require all` | exit 0: embeddings **PASS** (9 checks), Groq **PASS** (3 checks) |
| Extension unit tests | 52/52 passed (sanitizer 17) |
| TypeScript | clean |
| Builds | `github` (default and custom backend URL), `e2e-local`. `fake-saas` and a backend URL with a query string are correctly refused. The manifest is scoped to `https://github.com/*`. |
| Browser E2E, deterministic (`npm run e2e`) | **54/54**, twice. This was 52/52 before the startup fix, which added 2 checks: startup indexed a fresh database, and the corrupted-cache cycle retrieved its KB entry. |
| Browser E2E, model unavailable (empty model cache + `HF_HUB_OFFLINE=1`, lifecycle scenario) | 13/13: startup logs why the KB isn't indexed, and retrieval is recorded as `empty_index` |
| Browser E2E, live github.com (`npm run e2e:github`) | **17/17** |
| ruff | 4 findings, all present before this milestone, none new |
| KB lint | ok: 19 sources, 17 error entries, 14 tools |
| pip-audit (2026-10-04) | no known vulnerabilities |
| npm audit (2026-10-04) | 4 high findings, all present before this milestone and dev-only: `braces`/`micromatch` via the Tailwind CLI's file watcher (`@tailwindcss/cli` → `@parcel/watcher`). They're used only at build time and not shipped in the extension. |

### Real services

| Service | Status | Evidence |
|---|---|---|
| **Groq** (`openai/gpt-oss-120b`) | **PASS** | `validate_services.py`: a grounded diagnosis citing only collected evidence, no action without evidence, and instructions planted in page text ignored. Live tests 6/6: grounded diagnosis, citing only the knowledge shown, no confident answer without evidence, an unsupported claim in the user's text can't produce an action, page-text instructions not followed, and the full pipeline with policy and approval enforced. In the validation environment the key is injected by the egress proxy, so the backend ran with a non-secret placeholder `GROQ_API_KEY` and the real key never entered the container. |
| **Embeddings** (MiniLM via fastembed) | **PASS** | The real model downloads and loads (384-d, unit vectors). Semantic ordering is correct, and the persisted vectors reload unchanged. Live tests 10/10. |
| **Retrieval** | **PASS** | Startup indexes 91 curated chunks into a fresh database. A corrupted-cache query retrieves `kb_kb_corrupted_cache` first, a blocked-request query retrieves `kb_kb_blocked_by_client`, and an unrelated query matches nothing. In the browser E2E the corrupted-cache cycle retrieves its entry through the full extension → backend path. |
| **github.com** | **DONE** (read-only) | The actual `github` build in Chromium on `https://github.com/octocat/Hello-World` (anonymous, nothing approved). The content script loaded, and real evidence reached the backend with provenance. The investigation stayed grounded, a healthy page ended in NEED_INFORMATION (bounded), and there were no extension runtime errors. |

**Groq rate limit (free tier).** 8,000 tokens per minute against roughly
1.6–1.9k tokens per diagnosis. Running all live Groq tests back to back
produces HTTP 429s, which the backend turns into a clean 400 that consumes
nothing and reports the retry-after. The live tests pass when spaced about a
minute apart. A multi-cycle session can hit the same limit within a minute.

### What the deterministic E2E covers (54 checks)

Backend startup on a fresh database (the backend indexes the knowledge base
itself, and the corrupted-cache cycle retrieves its entry), session creation, the evidence request, request-driven collection,
investigation, retrieval recorded honestly, NEED_INFORMATION, the plan,
policy, approval, execution, and server-side verification through to
RESOLVED. Then: a fix that doesn't stick (verification fails, an automatic
retry refuses to repeat it, escalation), a reload that doesn't help, a
reload that does, deny, bounded escalation, a stale or replayed request id,
credential redaction from a real page (the raw value is absent from the API
and the database file, a commit SHA kept, the tripwire still rejecting
unredacted payloads), an unsupported action or a client-declared verdict
sent from the extension's origin, the content script's closed message set
and a real service worker, Reset on an unreachable tab, and a
service-worker restart both while awaiting approval and mid-verification
(reported as `interrupted`, never a pass). It also checks for runtime
errors.

## Bugs found and fixed in this milestone

| # | Class | Bug | Fix | Regression test |
|---|---|---|---|---|
| 1 | product | The tripwire missed 22 of 27 credential kinds (GitHub/Groq/OpenAI/Slack/AWS/Google keys, private keys, connection strings, URL userinfo/query/fragment credentials, cookie headers, password assignments). | New rules. Benign look-alikes still pass. | `test_safety_matrix.py` |
| 2 | product | A JSON object logged to the console (`{"password": "…"}`) arrives escaped inside the evidence payload, and the JSON-field rule didn't match the escaped form. | The rule accepts `\"`. | `test_safety_matrix.py` |
| 3 | product | The extension sent evidence unredacted, so a token on a real page made the backend reject the whole cycle (422). | `extension/src/lib/sanitize.ts` redacts bundles and verification observations and fills `redaction_applied`. | `sanitize.test.mjs`, `verification-flow.test.mjs`, E2E |
| 4 | product | `/verify` silently ignored unknown fields, so a client `"passed": true` or `"outcome"` was accepted (though not trusted). | `extra="forbid"` on the request and the observation. | `test_api_contract.py`, E2E |
| 5 | product | No size bounds on provider strings: a 200 KB console line was stored and sent to the model. | Bounded fields (2,000 chars text, 200 short, 64 ids) and list caps; over the limit → 422, nothing stored. | `test_api_contract.py` |
| 6 | product | Groq errors weren't distinguished (timeout vs transport vs status vs shape), and fenced or null-field JSON answers were rejected outright. | Distinct errors, configurable timeout, redacted error bodies, a shape-only normalization. Grounding is unchanged. | `test_groq_http_client.py` |
| 7 | product | An unavailable embedding model was retried, by re-downloading, on every retrieval, and failed with a generic error. | `EmbeddingUnavailable` with the cause, plus a cooldown. The retrieval record carries a redacted `error_detail`. | `test_embeddings_failure.py` |
| 8 | product | Found in final review, after fix 5: the extension never capped the tab URL, page path, service-worker scopes or storage key names, so a long real URL would have the whole cycle rejected (422). | The extension truncates context strings (after redaction, so a secret is never cut short of being recognised) and drops over-long identifiers (storage keys, scopes) rather than truncating them, because a truncated key could make a re-check falsely report "gone". | `collection.test.mjs` |
| 9 | harness | The E2E harness was outside the repo, in scratch space. | `extension/e2e/` with fixtures, docs and npm scripts. | — |
| 10 | harness | Popup Reset cleared the fixture's planted key after page load (order-dependent failure). The fixture page's own service worker was mistaken for the extension's. | Reset before the fixture loads. Filter workers by `chrome-extension://`. | E2E |
| 11 | product | Found during live validation: startup never indexed the knowledge base, so a fresh database searched an empty index. Every search was recorded as `no_match` ("no knowledge chunk scored above the similarity floor"), which can't be told apart from a real search that found nothing. | Startup indexes the curated KB when none is indexed (idempotent, never overwrites an existing one, survives an unavailable model). `search()` raises `KnowledgeIndexEmpty` on an unindexed KB, recorded as `empty_index`. | `test_knowledge_startup.py`, `test_embeddings_failure.py`, E2E |

## Known limitations

- Groq's free tier (8,000 tokens/min) can rate-limit a multi-cycle session.
  The session isn't damaged, but the user sees an error and must retry.
- If the embedding model can't load at startup, the KB stays empty until the
  next restart with the model reachable (retrieval says `empty_index` until
  then).
- First startup on a cold cache waits for the model download and KB indexing
  (seconds) before serving.
- Session approval is not bound to a user identity: there is no production
  auth yet.
- Sessions created before the core-functionality milestone (no
  `evidence_request` / provenance) are read leniently but are not migrated.
- The browser E2E suites run the offline diagnosis engine, so they validate
  the system around the model, not the model's answers.
- After a service-worker restart, Playwright gives no handle to the new
  worker, so the restart scenarios run last and drive the popup instead.
- `npm audit` reports 4 dev-only findings (see above).

## Autonomous-execution milestone (2026-10-10)

| Suite | Command | Count | Notes |
|---|---|---|---|
| Backend | `cd backend && pytest --ignore=tests/live` | 631 | includes real Postgres + pgvector (`pgserver`) and a real `redis-server` (skipped, with a reason, if the binaries are unavailable); hash-locked environment |
| Staged pipeline / classify / questions / evaluation | `tests/test_classify.py`, `test_questions.py`, `test_eval.py` | 29 + 15 + 3 | questions: unsafe-question regeneration, answer endpoint (validation, once-only, wrong phase, cross-tenant), reset_user_preference grounding |
| Auth, tenants, rate limits, logging, CORS, migrations | `test_auth_defaults.py` (auth required by default), `test_auth.py`, `test_tenants.py`, `test_rate_limit.py`, `test_logging_cors_keys.py`, `test_migrations.py` | | cross-tenant attempts on every session endpoint |
| Live progress | `test_events.py` | | streaming asserted against a real server thread; Starlette's `TestClient` and httpx's `ASGITransport` buffer whole responses and cannot show streaming |
| Extension | `cd extension && npm test` | 102 | adds `lifecycle`, `progress`, `auth`, `appbridge`, `free-text-redaction` (asserts on the bytes passed to `fetch`) and `free-text-heuristics` suites |
| Buggy Cloud | `cd buggy-cloud && npm test` | 12 | |
| SDK | `cd sdk && npm test` | 65 | config, transport, evidence, flow, carrier, built script; `tests/contract-emit.mjs` feeds `backend/tests/test_sdk_contract.py` |
| Browser E2E | `npm run e2e` / `e2e:buggy` / `e2e:sdk` / `e2e:demo` / `e2e:wire` / `e2e:sdk-wire` / `e2e:github` | 63 / 67 / 112 / 23 / 11 / 15 / 17 | authentication ON; offline engine unless `OPERON_E2E_GROQ=1` |
| Evaluation | `cd backend && python eval.py --engine offline` (or `groq`) | 21 fixtures | results and caveats in `IMPLEMENTATION_STATUS.md` |

Superseded statements in the sections below: "Session approval is not bound to
a user identity" is no longer true (approval is bound to the authenticated
principal and the proposal id); the ruff finding count is now zero; the
extension unit count is 102 and the deterministic E2E is 63.
