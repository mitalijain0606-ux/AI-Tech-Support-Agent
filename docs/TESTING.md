# Testing and real-service validation

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
| Embedding model `sentence-transformers/all-MiniLM-L6-v2` (fastembed, ONNX, 384-d) | downloaded on first use; `EMBEDDING_RETRY_COOLDOWN_SECONDS` | knowledge retrieval, session-history ingestion | retrieval recorded as `error` (`EmbeddingUnavailable`), investigation continues; history ingestion skipped | real model if it can load, otherwise those tests fail with the cause (see below) |
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
  cooldown, and the investigation degrading cleanly.
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

### Static

`ruff check .` (backend), `python docs/knowledge-base/scripts/kb_lint.py`,
`npm audit`, `pip-audit -r backend/requirements.txt`.

## Validation results (validation milestone, 2026-10-04)

| Check | Result |
|---|---|
| Backend, real environment (`pytest`) | 398 passed, 16 skipped (live, with reasons), **15 failed/errored**: every one needs the real embedding model, which can't be downloaded here (`EmbeddingUnavailable: ProxyError 403`) |
| Backend, stand-in embedder (offline suite, `tests/live` excluded) | 411 passed, 2 failed: two semantic-ranking assertions a bag-of-words stand-in can't satisfy. They need the real model. |
| New suites | safety matrix 158, API contract 35, Groq HTTP client 28, embedding failure 9, failure injection 4, tripwire 40: all pass |
| `tests/live` with `OPERON_REQUIRE_LIVE=all` | 16 errors, as designed: both services are unavailable here and the gate refuses to skip them |
| `validate_services.py` | embeddings **BLOCKED**, groq **BLOCKED** (see below) |
| Extension unit tests | 52 passed (sanitizer 17) |
| TypeScript | clean |
| Builds | `github` (default and custom backend URL), `e2e-local`. `fake-saas` and a backend URL with a query string are correctly refused. The manifest is scoped to `https://github.com/*`. |
| Browser E2E, deterministic (`npm run e2e`) | **52/52**, three runs in a row |
| Browser E2E, live github.com (`npm run e2e:github`) | **17/17** |
| ruff | 4 findings, all present before this milestone, none new |
| KB lint | ok: 19 sources, 17 error entries, 14 tools |
| pip-audit | no known vulnerabilities |
| npm audit | 4 high findings, all present before this milestone and dev-only: `braces`/`micromatch` via the Tailwind CLI's file watcher (`@tailwindcss/cli` → `@parcel/watcher`). They're used only at build time and not shipped in the extension. |

### Real services

| Service | Status | Evidence |
|---|---|---|
| **Embeddings** (MiniLM via fastembed) | **BLOCKED** | The validation environment's egress policy denies `huggingface.co` (gateway 403 on CONNECT). fastembed's fallback bucket on `storage.googleapis.com` returns 403. The model never loaded, so retrieval was recorded as `error (EmbeddingUnavailable)` in every E2E run. The pipeline, failure path and cooldown are tested (MOCKED stand-in), and the live tests and `validate_services.py` are ready to run where the model can load. |
| **Groq** | **BLOCKED** | No `GROQ_API_KEY` was available, and `api.groq.com` is also denied by the same egress policy. The real HTTP client is tested against a local OpenAI-compatible server (stubbed endpoint). Live model behaviour is unverified. |
| **github.com** | **DONE** (read-only) | The actual `github` build in Chromium on `https://github.com/octocat/Hello-World` (anonymous, nothing approved). The content script loaded, real evidence (cookie metadata, page state) reached the backend with provenance, the investigation stayed grounded (no citations without evidence), a healthy page ended in NEED_INFORMATION (twice, bounded), and there were no extension runtime errors. |

### What the deterministic E2E covers (52 checks)

Session creation, the evidence request, request-driven collection,
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

## Known limitations

- Live Groq and the live embedding model are **unverified** in this
  environment (blocked, see above). Both validation paths are in the repo.
- Session approval is not bound to a user identity: there is no production
  auth yet.
- Sessions created before the core-functionality milestone (no
  `evidence_request` / provenance) are read leniently but are not migrated.
- The browser E2E suites run the offline diagnosis engine, so they validate
  the system around the model, not the model's answers.
- After a service-worker restart, Playwright gives no handle to the new
  worker, so the restart scenarios run last and drive the popup instead.
- `npm audit` reports 4 dev-only findings (see above).
