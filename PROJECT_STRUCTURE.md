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

- **Phase 1:** backend plus the `github` target, end to end against real github.com.
- **Phase 2 (built as `buggy-cloud/`):** a small app we control, with seven seeded
  bugs and an SDK-provided fix, showing the same core works on a second product.
  It is tested through the `e2e-local` build; `targets/fake-saas.json` is still unset.

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
│   ├── requirements.in, requirements-dev.in   inputs; requirements*.txt are hash-locked (uv)
│   ├── alembic.ini, migrations/  baseline schema, pgvector (Postgres-only), tickets revisions
│   ├── eval.py, eval_data/       measured evaluation against ground-truth fixtures
│   ├── operon_backend/
│   │   ├── main.py               HTTP API: /api/sessions/* (incl. /answer, /events), /api/tickets/*, /dashboard, legacy /api/diagnose + /api/policy, /health, /ready
│   │   ├── auth.py               API keys, tenants, roles; 404-not-403 isolation; client_ip
│   │   ├── ratelimit.py          per-caller limits (memory / Redis, fail-open)
│   │   ├── events.py             EventBus / RedisEventBus, SSE stream
│   │   ├── logging_config.py     JSON logs, request ids, generic 500s (pure ASGI)
│   │   ├── signals.py            pattern helpers: injection, CORS, HTTP/fetch failures, preferences, question safety
│   │   ├── stages.py             PIPELINE_STAGES, deterministic classify, stage() reporting
│   │   ├── config.py             typed settings from env / .env
│   │   ├── schemas.py            evidence, requests, plans, observations — bounded, verify requests forbid extra fields
│   │   ├── db.py, db_models.py   SQLAlchemy; SessionRecord (the SupportSession), KnowledgeChunk, ApiKey, Ticket
│   │   ├── state_machine.py      phases and legal transitions (backend is the sole authority)
│   │   ├── session_service.py    create, policy, approval, action result, verification, escalation
│   │   ├── investigation.py      one bounded cycle: evidence → understanding → retrieval → diagnosis → decision
│   │   ├── evidence.py           evidence requests, ingestion/provenance, evidence window, understanding
│   │   ├── budget.py             evidence budgeting before the prompt: filter, dedupe, truncate, prune, redact, token cap
│   │   ├── loop_driver.py        hard limits, hypothesis model, escalate() (opens the ticket)
│   │   ├── tickets.py            escalation tickets: redacted report, visibility, admin triage
│   │   ├── dashboard/            read-only support dashboard (static HTML/JS/CSS, strict CSP)
│   │   ├── llm.py                Groq client + grounding validation + regeneration; offline rule_based engine
│   │   ├── staged.py             LLM_PIPELINE=staged: classify / plan prompts and parsing
│   │   ├── planning.py           grounded diagnosis → structured remediation plan + verification plan
│   │   ├── verification.py       server-side passed / failed / inconclusive decision
│   │   ├── policy.py             closed action set + ALLOW / REQUIRE_APPROVAL / DENY
│   │   ├── tripwire.py           credential detection, rejection and redaction (+ Git SHA rules)
│   │   ├── embeddings.py         MiniLM via fastembed, with load-failure cooldown
│   │   ├── retrieval.py          cosine search over knowledge_chunks; KnowledgeIndexEmpty for an unindexed KB
│   │   ├── knowledge.py          KB ingestion, ensure_knowledge_base (startup); resolved-session history (redacted)
│   │   └── activity.py           append-only, redacted activity log
│   ├── scripts/
│   │   ├── manage_keys.py        create / list / revoke API keys
│   │   ├── warm_model.py         download the embedding model at build time
│   │   ├── seed_kb.py            refresh the KB index (startup indexes an empty database itself)
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
│   │   ├── lib/sanitize.ts       re-exports sdk/redact.js (one redaction implementation for SDK and extension)
│   │   ├── lib/progress.ts       backend progress events → popup lines
│   │   ├── lib/appbridge.ts      discover / invoke the page's Operon SDK actions over postMessage
│   │   └── popup/                React popup (App.tsx)
│   ├── targets/
│   │   ├── local-demo.json       local demo against Buggy Cloud (http://127.0.0.1/*) — never ship
│   │   ├── github.json           Phase 1 — https://github.com/*
│   │   ├── e2e-local.json        local E2E fixtures only (http://127.0.0.1/*) — never shipped
│   │   └── fake-saas.json        Phase 2 — not configured, refuses to build
│   ├── scripts/build.mjs         esbuild + tailwind → dist/<target>/; OPERON_BACKEND_URL at build time
│   ├── tests/                    node:test against the real bundled source in a fake browser
│   ├── e2e/                      browser E2E (see e2e/README.md)
│   │   ├── run.mjs               deterministic: built extension + real backend + Chromium + fixtures
│   │   ├── github-live.mjs       live, read-only check on a public github.com page
│   │   ├── github-demo.mjs       live approve / deny demo on github.com
│   │   ├── buggy-cloud.mjs       second app: 7 seeded bugs + healthy control
│   │   ├── free-text-wire.mjs    records the extension's real network bytes; fake secrets must be absent
│   │   ├── buggy-cloud-sdk.mjs   Buggy Cloud through the SDK (no extension): approve / reject / failures
│   │   ├── sdk-wire.mjs          recording proxy in front of the backend: SDK request bytes
│   │   ├── lib/harness.mjs       backend/fixture/browser plumbing
│   │   └── fixtures/             local pages with deliberate, harmless defects
│   └── dist/                     build output, gitignored
│
├── sdk/                          the Operon SDK (not published): operon-sdk.js (client + extension carrier),
│                                 redact.js (redaction, shared with the extension), *.d.ts, scripts/build.mjs
│                                 (classic-script build), tests/ (node:test), README.md
├── buggy-cloud/                  the second application (see its README)
├── scripts/dev-local.mjs         one command: local backend + Buggy Cloud + builds + self-check
├── scripts/reproduce-ticket.mjs  local-only sandbox reproduction of an escalated ticket (tests: scripts/tests/)
├── render.yaml                   Render blueprint — written, never deployed
├── .github/workflows/ci.yml      CI — written, never run on GitHub
│
└── docs/
    ├── IMPLEMENTATION_STATUS.md  what is done / verified / left; progress log
    ├── DEPLOYMENT.md, DEMO_REHEARSAL.md, SDK_VS_EXTENSION.md
    ├── TESTING.md                test suites, real-service validation, status, limitations
    ├── plan/                     phased plan, production architecture, scenarios
    ├── knowledge-base/           troubleshooting KB (ingested by knowledge.py) + kb_lint.py
    └── archive/                  original planning documents
```

## What's intentionally not here yet

- No deployment has been made: `render.yaml` and the CI workflow are untested
  on their platforms (see `docs/DEPLOYMENT.md`).
- No `packages/operon-core` shared package: the SDK is one file and the
  extension reuses its own sanitizer/types.
- No GitHub API agent: a separate future product.
