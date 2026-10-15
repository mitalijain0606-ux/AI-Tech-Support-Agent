# Roadmap — real future work, not active

Everything here is a genuine next step, not a rejected idea. It's listed
separately from `01-phase-1-github.md` and `02-phase-2-fake-saas.md`
specifically so it stops competing for attention with what's actually
being built right now — mixing "someday" with "this week" is what made
the project structure confusing before.

Nothing in this file should be started before Phase 2 is done, unless a
specific decision changes that.

**Persistence and RAG moved out of this file** — they graduated from
"someday" to "designed": see
[`production-architecture.md`](production-architecture.md).

## SDK provider + `packages/operon-core`

> **Status:** a *minimal* SDK exists ([`sdk/operon-sdk.js`](../../sdk/operon-sdk.js)):
> an app declares closed-list action names and the extension carries them through the
> same pipeline. It is not the full provider described below (no calls into the app's
> backend, no extracted `operon-core`, not published). See
> [`../SDK_VS_EXTENSION.md`](../SDK_VS_EXTENSION.md).

A second `CapabilityProvider` implementation — a JS/TS SDK a customer
installs directly in their app, which can call their own backend APIs
(something the extension fundamentally can't do, since it sits outside
the app's trust boundary). Once this exists, the collector and sanitizer
logic that's currently just inside `extension/` gets extracted into a
shared `packages/operon-core` package, imported by both. Not worth
extracting before there's a second consumer.

## Evidence budgeting as its own module

> **Status: done** — [`backend/operon_backend/budget.py`](../../backend/operon_backend/budget.py)
> runs every cycle before the prompt (filter → dedupe → truncate → prune → redact → cap at
> `EVIDENCE_TOKEN_BUDGET`, default ~8k tokens, dropping the least informative items first and
> never rewriting evidence ids); each cycle records what it did as an `evidence_budget`
> activity entry. Tests: `backend/tests/test_budget.py`.

Filter → dedupe → truncate → prune-DOM-to-skeleton → redact → cap at
~8k tokens, as a standalone pipeline stage rather than inline in the
collector. Matters once evidence bundles get big enough that raw evidence
would blow the token budget — not an issue yet at Phase 1/2 scale.

## Playwright as a sandbox-reproduction tool

> **Status: done, local only** — [`scripts/reproduce-ticket.mjs`](../../scripts/reproduce-ticket.mjs)
> opens an escalated ticket's page in a disposable headless Chromium (fresh profile, no
> sign-in, other hosts blocked, explicit host allowlist), compares what it observes with the
> ticket's evidence and says whether the failure reproduces without the customer's own state.
> Tests: `node --test scripts/tests/*.test.mjs`, `cd extension && npm run e2e:reproduce`.

Not a browser-access method (the SDK and extension cover that) — a
headless-browser tool for reproducing an escalated bug in a disposable
sandbox so a human engineer can debug it without touching the customer's
real session. Local-only; never deployed, per the original plan's own
free-tier constraints (Chromium doesn't fit in 512MB serverless RAM).

## `eval.py` — the fixture scoring harness

> **Status:** a first version exists (`backend/eval.py`, 21 fixtures, results in
> [`../IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md)). What remains is the
> description below at larger scale: more, independently written fixtures and repeated
> model runs.

Once there are enough seeded bugs across both demo targets, a script that
runs the pipeline against captured `EvidenceBundle` fixtures and scores
classification/diagnosis/action accuracy — the mechanism for proving
"stable performance across repeated test cases" with real numbers instead
of a single lucky demo run.

## Escalation service + support-agent dashboard

> **Status: done** — every escalation opens a ticket (`tickets` table, migration `0003`) with a
> structured, redacted report: user message, evidence, diagnoses, hypotheses, attempted
> actions, policy decision, verification, timeline. Diagnoses below `MIN_ACTION_CONFIDENCE`
> escalate instead of acting. API: `GET /api/tickets`, `GET /api/tickets/{id}`, `POST
> /api/tickets/{id}/status` (admin), tenant-scoped. Read-only dashboard at `/dashboard`
> (strict CSP, text-only rendering, key kept in memory). See
> [`backend/operon_backend/tickets.py`](../../backend/operon_backend/tickets.py).

A structured report (user message, evidence, diagnosis, attempted actions,
verification result) handed to a human when the Policy Engine returns
DENY or confidence is too low, plus a read-only dashboard to browse open
tickets. Needs the persistence layer from
[`production-architecture.md`](production-architecture.md) to exist first.

## Explicitly cut (from the original plan, still cut)

- A desktop agent (stays a roadmap slide, not a deliverable)
- Multi-tenant org management (tenants, API keys and roles now exist for isolation; there is still no org-management UI or admin API)
- A staging environment
- Container scanning
- Predictive detection

These were cut in the original 6-week plan for scope reasons that still
apply — revisit only if the product's actual direction changes.
