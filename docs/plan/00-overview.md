# Overview — current architecture

## What Operon is

An AI technical-support agent that lives in the browser, diagnoses why a
web app is broken for a specific user from evidence alone, and — only
through a policy-gated, closed set of actions — fixes what it safely can,
asks the user to do what it can't, and escalates to a human what it
shouldn't touch on its own.

## The product shape, concretely

Operon is not one universal browser extension that works on any site.
Each customer gets **their own extension build**, generated from one
shared source, with its permissions locked to exactly their domain. This
is both the security story (a customer's diagnostic tool can't reach
anywhere outside their own product) and the demo story (the same core,
unmodified, produces two different locked-down builds).

```text
                    ┌─────────────────────────────┐
                    │   Backend (FastAPI + Groq)    │
                    │   classify → diagnose →       │
                    │   plan → policy → verify       │
                    │   target-agnostic               │
                    └──────────────┬───────────────┘
                                   │ EvidenceBundle in,
                                   │ {diagnosis, action_id} out
                    ┌──────────────┴───────────────┐
                    │  extension/  (shared source)   │
                    │  background.ts, content.ts,    │
                    │  popup — generic, no domain     │
                    │  hardcoded anywhere in code     │
                    └──────────────┬───────────────┘
                                   │ build step reads a
                                   │ per-target config
                    ┌──────────────┴───────────────┐
                    │  targets/                      │
                    │   github.json   → github.com    │
                    │   fake-saas.json → (Phase 2)    │
                    └──────┬──────────────┬─────────┘
                           ▼              ▼
              dist/github/          dist/fake-saas/
              locked to github.com  locked to the fake
              only                  SaaS app's domain only
```

See [`PROJECT_STRUCTURE.md`](../../PROJECT_STRUCTURE.md) at the repo root
for the literal file tree — this doc doesn't repeat it.

## The three contracts (still true, unchanged from the original plan)

1. **EvidenceBundle** — the only shape browser data enters the system in.
   Derived facts only, never credentials. An expired session is reported
   as `jwt_expired: true`, never the token.
2. **CapabilityProvider** — the agent calls a protocol, not a specific
   provider. Right now there is exactly one implementation (the
   extension); an SDK-based provider is roadmap, not active (see
   [`03-roadmap.md`](03-roadmap.md)).
3. **Policy Engine** — the model only ever emits an `action_id` from a
   closed enum. Every action is checked against provider support and an
   ALLOW / REQUIRE_APPROVAL / DENY decision before anything executes.

## What's different from the original plan

| | Original plan | Current plan |
|---|---|---|
| LLM | Gemini | **Groq** |
| Providers | SDK + Extension + Playwright | **Extension only**, for now |
| Persistence | Postgres + Redis from Week 1 | **Stateless** — extension carries context between calls |
| Pipeline | 5 separate LLM calls | **1 combined call** (classify+diagnose+plan) for now |
| First demo app | A purpose-built fake SaaS ("Buggy Cloud") | **A real site (GitHub)**, fake SaaS moved to Phase 2 |
| Extension scope | One extension, broad/shared | **One extension per customer**, built from shared source, locked to one domain |

None of the right-hand column is a rejection of the left — it's
sequencing. The full picture is still where this is headed; see
[`03-roadmap.md`](03-roadmap.md) for what's deferred and why.

## Phasing

- **[Phase 1](01-phase-1-github.md)** (active): backend + the `github`
  target, working end-to-end against real github.com.
- **[Phase 2](02-phase-2-fake-saas.md)** (blocked on Phase 1): a small
  fake SaaS app we control, proving the same core generalizes.
