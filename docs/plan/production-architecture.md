# Production architecture — RAG + full persistence

This supersedes the "stateless MVP" framing in
[`01-phase-1-github.md`](01-phase-1-github.md). That doc's scope decision
(no database, one combined LLM call) was right for proving the loop worked
at all. It stops being right once the goal is a real product: diagnoses
that improve from experience, sessions that survive a backend restart, and
a five-stage pipeline that can be scored stage-by-stage instead of judged
as one opaque call.

Still zero-budget. Still extension-first — this pass upgrades the backend,
not the provider count (SDK/Playwright stay designed-but-not-built, same
as before).

## What's actually new here

1. **Persistence** — Postgres (sessions, evidence, diagnoses, actions,
   tickets) + Redis (live session cache).
2. **RAG** — retrieval over past diagnosed cases and a curated
   knowledge base, feeding the Diagnose stage real precedent instead of
   reasoning from nothing every time.
3. **The real five-stage pipeline** — Classify, Investigate, Retrieve,
   Diagnose, Plan as distinct calls (Retrieve isn't from the original
   plan — see below for why it's a real sixth stage, not a rename).
4. **A session-oriented API** — the extension talks to a `session_id`,
   not a stateless fire-and-forget request.

## Why RAG, concretely — not just "add a vector DB"

Without retrieval, every diagnosis reasons from zero — the model has never
"seen" a corrupted-cache bug before, even after Operon has correctly
diagnosed the exact same pattern fifty times. RAG is what lets the fifty-first
diagnosis be informed by the previous fifty, and what lets a curated
knowledge base (starting from
[`github-scenarios.md`](github-scenarios.md)) act as a
seeded head start before any real history exists.

Two source types get embedded into the same table:

- **`kb` — curated knowledge.** Structured entries describing a known
  failure signature and its correct response, seeded from the scenario
  playbook. This is deliberately hand-authored, not learned — it's how the
  system starts knowing about the ad-blocker pattern and the seeded
  storage-corruption pattern on day one, not after fifty real occurrences.
- **`history` — resolved sessions.** After Stage 5 (Verify) completes on
  any real session — resolved *or* escalated, both are informative — the
  user's message, the evidence summary, the diagnosis, and the actual
  outcome get embedded and stored. This is the actual learning loop: real
  usage makes future retrieval better, without retraining anything.

### What retrieval does and does not get to do

Retrieved context is **precedent, not evidence**. The evidence-citation
guardrail from Part 4 of the original plan (`evidence_ids` must exist in
the *current* bundle) is unchanged and still absolute — retrieval augments
the model's reasoning about what a pattern probably means, it never
substitutes for observing that pattern in the current bundle. Concretely:
a new `knowledge_refs` field lets the model cite which retrieved case
informed its confidence, kept entirely separate from `evidence_ids`, and
the prompt is explicit that a `knowledge_ref` can raise confidence in an
interpretation but can never justify citing evidence that isn't actually
in front of it.

### RAG-specific guardrails

- **Retrieved content is untrusted, same as evidence.** A `history` entry
  is built from a real user's message and a real page's evidence — both
  already passed through the sanitizer and the server-side tripwire before
  they were ever stored, but the prompt still treats retrieved text as
  data to reason about, never as instructions (same framing already
  applied to evidence — extended here, not invented here).
- **Never embed a bundle that hasn't passed the tripwire.** The ingestion
  hook only ever runs on bundles already in `evidence_bundles` — which by
  construction means Contract 1a's layer 3 already cleared them. There is
  no second, separate path into the embedding pipeline that could skip it.
- **A prompt-injection attempt that gets stored doesn't get more dangerous
  by being retrieved later** — it's still just untrusted text under the
  same "data, not instructions" framing, and it still can't produce an
  action outside the closed enum no matter how it's phrased or how many
  times it's retrieved.

### Embedding + retrieval mechanics

- **Model:** `sentence-transformers/all-MiniLM-L6-v2`, 384-dim, run
  locally in the backend — free, offline, no per-call cost. This is the
  same model the original plan named; it just never got wired to anything
  before.
- **Store:** Postgres + the `pgvector` extension (Neon supports it) — one
  `knowledge_chunks` table, not a separate vector database. Zero-budget
  means one fewer service to run, not a worse retrieval quality for this
  scale.
- **Query:** embed `user_message + evidence_summary` (the same budgeted
  text summary already built for the LLM prompt), cosine-similarity search
  via pgvector's `<=>` operator, top-K (start at 5) above a similarity
  floor, formatted as a labeled context block (`kb_001`, `hist_014`, …)
  injected into the Diagnose prompt alongside the evidence.
- **Runtime note:** `sentence-transformers` pulls in `torch`, which is
  large enough to strain a serverless function's size/cold-start budget.
  Use `fastembed` (ONNX runtime, no torch, same MiniLM weights) instead if
  the backend stays serverless — see the deployment section below for why
  this project is moving off serverless anyway.

## The pipeline, in full

```text
1. CLASSIFY     — user message + one-line evidence summary
                  → {category, confidence, needs_investigation}

2. INVESTIGATE  — (conditional, capped at 3 calls) model requests specific
                  additional evidence within the provider's declared
                  capabilities

3. RETRIEVE     — embed(message + evidence summary) → pgvector search
                  → top-K knowledge_chunks (kb + history)
                  [this is genuinely new — not in the original 5-stage
                  design, which had no memory at all]

4. DIAGNOSE     — evidence + retrieved context
                  → {root_cause, reasoning, evidence_ids, knowledge_refs,
                     confidence, resolvable_automatically}
                  same evidence-citation guardrail as before, unchanged

5. PLAN         — root cause + capabilities → {action_id, params}
                  (split back out from the current combined call, per
                  "not a minimal pipeline")

   POLICY       — deterministic, Contract 3, unchanged — ALLOW /
                  REQUIRE_APPROVAL / DENY

   EXECUTE      — provider-side (ExtensionProvider today), unchanged

6. VERIFY       — deterministic predicate, unchanged — AND now the
                  ingestion hook: write {message, evidence, diagnosis,
                  outcome} into `resolved_sessions` + `knowledge_chunks`
```

Steps 1–5 are five separate LLM calls with five separate prompts and
schemas, matching the original plan's own reasoning for why one big call
doesn't work: each stage gets its own accuracy score in `eval.py`, and a
bad prompt change in one stage can't silently break another.

## Persistence

### Postgres schema (Neon, `pgvector` enabled)

| Table | Purpose |
|---|---|
| `sessions` | id, created_at, source, user_message, status, current_phase |
| `evidence_bundles` | id, session_id, collected_at, raw_bundle (jsonb, post-sanitizer/tripwire), redaction_applied |
| `diagnoses` | id, session_id, category, root_cause, reasoning, evidence_ids (jsonb), knowledge_refs (jsonb), confidence, resolvable_automatically, model_used, prompt_version, created_at |
| `actions` | id, session_id, action_id, params (jsonb), policy_decision, policy_reason, executed_at, result |
| `verifications` | id, session_id, predicate, passed, checked_at |
| `tickets` | id, session_id, report (jsonb — the full escalation bundle from the original plan's spec), status, created_at |
| `knowledge_chunks` | id, source_type (`kb`\|`history`), source_id, content_text, embedding vector(384), metadata (jsonb), created_at |

Alembic migrations for all of the above — this is the Week 1 task from the
original plan that the stateless MVP correctly deferred and now needs to
actually happen.

### Redis (Upstash)

Live in-progress session state — `session:{id}` → the current
`SessionState` JSON, TTL'd (sessions are short-lived, an hour is generous).
This is what makes the backend safe to restart or run as more than one
instance: today, `background.ts` is the *only* place session state lives,
which works for a single-developer demo and stops being fine the moment
this is a real backend with real uptime expectations.

### API surface (session-oriented, replacing today's fire-and-forget calls)

```text
POST /api/sessions                    — create a session
POST /api/sessions/{id}/evidence      — submit a collected bundle
POST /api/sessions/{id}/diagnose      — run classify→investigate→retrieve→diagnose→plan
POST /api/sessions/{id}/policy        — evaluate the proposed action
POST /api/sessions/{id}/verify        — record the verification result
GET  /api/sessions/{id}               — current state (for reconnecting, or a future dashboard)
```

`background.ts` changes from "carry all context in each request" to
"create a session once, then reference it" — a real refactor, not just a
backend-side change.

## Deployment — one real change, and why

**Backend moves off Vercel serverless onto Render's free persistent web
service.** The stateless MVP fit serverless well; a backend that holds a
Postgres connection pool, a Redis client, and (if not using `fastembed`)
a loaded embedding model doesn't — cold-starting an embedding model on
every invocation is slow and wasteful, and `sentence-transformers` +
`torch` risks Vercel's function size limits outright. This is exactly the
reasoning the original plan already gave for picking Render over Vercel
for the backend; the stateless MVP just didn't have a component yet that
made the difference matter.

| Layer | Pick | Unchanged from before? |
|---|---|---|
| Backend | Render free web service | **Changed** — was Vercel serverless |
| Postgres | Neon, `pgvector` enabled | Same service, new extension |
| Redis | Upstash | New usage — was unused in the stateless MVP |
| LLM | Groq | Unchanged |
| Embeddings | `sentence-transformers`/`fastembed`, local | New |
| Extension | Same MV3 build pipeline | Unchanged |

## Phased build order

This is large enough that it needs sequencing, the same way Phase 1 vs.
Phase 2 did. Proposed order, each phase independently useful and testable:

- **Phase A — Persistence foundation.** Postgres schema, Alembic
  migrations, session-oriented API replacing the stateless calls. No RAG
  yet. Gate: a session survives a backend restart.
- **Phase B — Knowledge base.** `pgvector` extension, `knowledge_chunks`
  table, a seed script embedding `github-scenarios.md`'s entries. No
  retrieval wired into diagnosis yet. Gate: a similarity query against the
  seeded KB returns sensible neighbors for a hand-written test query.
- **Phase C — Retrieve stage.** Wire retrieval into the Diagnose prompt,
  add `knowledge_refs`, add the ingestion hook writing real outcomes back
  into `knowledge_chunks`. Gate: diagnosing the same seeded bug twice
  produces a `knowledge_ref` citing the first run on the second.
- **Phase D — Extension refactor.** `background.ts` moves from
  fire-and-forget calls to the session-oriented API. Gate: the full
  seed→diagnose→approve→verify loop still works end to end, now backed by
  Postgres/Redis instead of in-memory extension state.
- **Phase E — Five-stage split.** Classify/Investigate/Plan become their
  own calls (Diagnose and Retrieve already are, from Phase C). Gate:
  `eval.py` can score each stage independently.

Each phase is a real, working increment — not a partial rewrite you can't
ship until the whole thing lands.
