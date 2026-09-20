# Agent architecture (Design)

Everything here is an engineering recommendation, not GitHub fact.

## 1. Component view

```text
                       ┌───────────────┐
                       │  User / UI    │  approval cards, evidence timeline
                       └───────┬───────┘
                               │
                       ┌───────▼───────┐        ┌──────────────────┐
  GitHub webhooks ───► │ Agent API     │◄──────►│ Postgres         │
  (validated, deduped) └───────┬───────┘        │ sessions, evid., │
                               │                │ actions, audit   │
                       ┌───────▼────────┐       └──────────────────┘
                       │ Orchestrator   │  owns the state machine; LLM only recommends
                       └──┬──────┬────┬─┘
             ┌────────────┘      │    └─────────────┐
     ┌───────▼──────┐   ┌────────▼───────┐   ┌──────▼────────┐
     │ Context      │   │ Policy engine  │   │ Tool executor │
     │ engine (RAG, │   │ risk • perms • │   │ registry-only │
     │ log/code     │   │ approval •     │   │ GitHub client │
     │ retrieval)   │   │ idempotency    │   │ + rate limiter│
     └───────┬──────┘   └────────────────┘   └──────┬────────┘
             │                                       │
        Knowledge base                            GitHub APIs
```

Trust rule: **the model never touches GitHub.** It emits a structured
request `{tool, arguments, intent, reason}`; the policy engine (plain
code) validates it; the executor (plain code) performs it. This is the
same "LLM proposes, backend disposes" split the existing browser-agent
uses, with `github.*` tools in place of browser actions.

## 2. State: reuse the `SupportSession` machine

The existing backend already implements the state machine this agent
needs (`UNDERSTANDING → KNOWLEDGE_LOOKUP → NEED_INFORMATION →
INVESTIGATING → HYPOTHESIS_FORMED → DIAGNOSING → ACTION_PROPOSED →
WAITING_FOR_APPROVAL → EXECUTING → VERIFYING → RESOLVED / ESCALATED`,
see `backend/operon_backend/state_machine.py`). Map GitHub concepts onto
it rather than inventing a second lifecycle:

| Existing concept | GitHub-agent meaning |
|---|---|
| `EvidenceBundle` | Typed API evidence: run/job/step records, log excerpts (scrubbed), headers, status codes, file hashes, PR/branch state — every item gets a stable `ev_` id |
| `Hypothesis` | Candidate root cause + the *falsifier*: which cheap read would disprove it |
| `RemediationProposal` | `{diagnosis, evidence_ids, tool, arguments, expected_effect, risk, verification_predicate, requires_approval}` |
| Policy engine `ALLOW / REQUIRE_APPROVAL / DENY` | Same, with risk tier + permission check (see safety doc) |
| Verification predicate | Deterministic check against GitHub state (see safety doc) |

## 3. Single agent vs. multi-agent

| Option | Strength | Weakness | Verdict |
|---|---|---|---|
| Single agent + deterministic workflow | Simple, debuggable, cheap; the *state machine* already provides structure | One prompt must cover many domains | **MVP/V1 default** |
| Router + specialist prompts (CI, Git, auth, deps) | Sharper domain prompts, smaller contexts | Routing errors; more eval surface | V2, once the CI playbooks show prompt bloat |
| Supervisor/worker multi-agent | Parallel investigation | Non-determinism, cost, audit complexity, harder to bound loops | Avoid until a measured need |
| Event-driven (webhook → investigation) | Natural fit for CI failures | Needs dedup/idempotency discipline | Use as the *trigger* layer regardless of the above |

Recommendation: **deterministic orchestration with LLM reasoning inside
bounded stages**, specialised by *knowledge retrieval* (facet tags in
`01-architecture/taxonomy.md`) rather than by separate agents. The
"Repository Analyst / CI Expert / Security Analyst…" roles in the brief
become *retrieval filters and prompt sections*, not processes, until
evaluation shows they need to be separate.

## 4. Bounded loop (limits are part of the design)

Reuse the existing hard limits (steps, tool calls, LLM calls, action
attempts). GitHub-specific additions: a per-investigation **API
budget** (requests and estimated rate-limit points), a per-investigation
**log-byte budget** before summarisation, and a wall-clock ceiling that
accounts for the 1-hour installation-token lifetime.

## 5. Data the orchestrator persists

`Conversation, Investigation, Repository, Issue/PR/Workflow refs,
Hypotheses, Evidence, Actions, Approvals, ToolCalls, Results, Failures,
Verification, Resolution` — the existing `sessions` table already holds
most of these as JSON columns; the GitHub-specific additions are
tenant/installation columns and an **append-only audit table** (see
`agent-safety-and-execution.md` §9). Full schemas: Appendix S
(**PLANNED**).
