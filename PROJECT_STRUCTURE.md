# Operon — Project Structure

## The architecture, in one paragraph

There is one backend and one extension **source**, and both are
target-agnostic: neither contains a reference to a specific customer's site.
Each target (each demo, later each customer) gets its own **built**
extension package from that shared source, with its permissions locked to
one domain. Two built packages share nothing at runtime. The backend is
the authority over every session: it decides what evidence to collect,
whether a diagnosis is grounded, whether an action may run, and whether the
fix worked. The extension collects, executes and reports.

## Phasing

- **Phase 1 (current):** backend plus the `github` target, end to end against
  real github.com.
- **Phase 2 (later):** a small fake SaaS app and its own `fake-saas` target,
  showing the same core works on a product we control.

## Folder structure

```text
operon/
├── README.md                     overview, setup, status
├── PROJECT_STRUCTURE.md          this file
├── AGENT_ARCHITECTURE.md         investigation design + "as implemented"
│
├── backend/                      FastAPI, target-agnostic, stateful (SupportSession)
│   ├── pyproject.toml            package metadata, ruff + pytest config (markers: live_embeddings, live_groq)
│   ├── requirements.txt
│   ├── .env.example              GROQ_API_KEY, GROQ_MODEL — documented, never committed with values
│   ├── vercel.json, api/index.py legacy serverless entry point (not deployed in this milestone)
│   ├── operon_backend/
│   │   ├── main.py               HTTP API: /api/sessions/*, legacy /api/diagnose + /api/policy, /health
│   │   ├── config.py             typed settings from env / .env
│   │   ├── schemas.py            evidence, requests, plans, observations — bounded, verify requests forbid extra fields
│   │   ├── db.py, db_models.py   SQLAlchemy; SessionRecord (the SupportSession), KnowledgeChunk
│   │   ├── state_machine.py      phases and legal transitions (backend is the sole authority)
│   │   ├── session_service.py    create, policy, approval, action result, verification, escalation
│   │   ├── investigation.py      one bounded cycle: evidence → understanding → retrieval → diagnosis → decision
│   │   ├── evidence.py           evidence requests, ingestion/provenance, evidence window, understanding
│   │   ├── loop_driver.py        hard limits, hypothesis model
│   │   ├── llm.py                Groq client + grounding validation + regeneration; offline rule_based engine
│   │   ├── planning.py           grounded diagnosis → structured remediation plan + verification plan
│   │   ├── verification.py       server-side passed / failed / inconclusive decision
│   │   ├── policy.py             closed action set + ALLOW / REQUIRE_APPROVAL / DENY
│   │   ├── tripwire.py           credential detection, rejection and redaction (+ Git SHA rules)
│   │   ├── embeddings.py         MiniLM via fastembed, with load-failure cooldown
│   │   ├── retrieval.py          cosine search over knowledge_chunks
│   │   ├── knowledge.py          KB ingestion; resolved-session history (redacted)
│   │   └── activity.py           append-only, redacted activity log
│   ├── scripts/
│   │   ├── seed_kb.py            index the knowledge base
│   │   └── validate_services.py  real Groq + real embeddings report: PASS / FAIL / BLOCKED
│   └── tests/                    offline suite (pytest)
│       ├── flow_helpers.py       drive a session over HTTP; FakeGroq (replaces only the network call)
│       ├── groq_stub.py          local OpenAI-compatible server for the real Groq client
│       ├── live_gate.py          skip-with-reason / OPERON_REQUIRE_LIVE fail gating
│       ├── live/                 REAL services: test_live_groq.py, test_live_embeddings.py
│       └── test_*.py             unit, API-contract, safety-matrix, failure-injection, lifecycle tests
│
├── extension/                    MV3 — one shared source, TypeScript + React
│   ├── package.json              build, test, e2e, e2e:github scripts
│   ├── manifest.template.json    host_permissions / matches filled per target
│   ├── src/
│   │   ├── background.ts         service worker: request-driven collection, backend calls,
│   │   │                         approved-action execution, observation, resync after restart
│   │   ├── content.ts            storage shape (never values), page inspection, SW unregister
│   │   ├── lib/types.ts          wire types shared with the backend contract
│   │   ├── lib/sanitize.ts       client-side credential redaction (mirrors the backend tripwire)
│   │   └── popup/                React popup (App.tsx)
│   ├── targets/
│   │   ├── github.json           Phase 1 — https://github.com/*
│   │   ├── e2e-local.json        local E2E fixtures only (http://127.0.0.1/*) — never shipped
│   │   └── fake-saas.json        Phase 2 — not configured, refuses to build
│   ├── scripts/build.mjs         esbuild + tailwind → dist/<target>/; OPERON_BACKEND_URL at build time
│   ├── tests/                    node:test against the real bundled source in a fake browser
│   ├── e2e/                      browser E2E (see e2e/README.md)
│   │   ├── run.mjs               deterministic: built extension + real backend + Chromium + fixtures
│   │   ├── github-live.mjs       live, read-only check on a public github.com page
│   │   ├── lib/harness.mjs       backend/fixture/browser plumbing
│   │   └── fixtures/             local pages with deliberate, harmless defects
│   └── dist/                     build output, gitignored
│
└── docs/
    ├── TESTING.md                test suites, real-service validation, status, limitations
    ├── plan/                     phased plan, production architecture, scenarios
    ├── knowledge-base/           troubleshooting KB (ingested by knowledge.py) + kb_lint.py
    └── archive/                  original planning documents
```

## What's intentionally not here yet

- No deployment configuration for this milestone. SQLite is the default
  database. Postgres/Redis are a `DATABASE_URL` change plus later work.
- No `packages/operon-core` shared package: there's only one consumer.
- No `providers/` or SDK provider: the extension is the only capability
  provider.
- No `fake-saas-app/`: Phase 2 starts after Phase 1.
