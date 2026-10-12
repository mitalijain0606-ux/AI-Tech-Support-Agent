# Documentation index

Two folders, two different jobs — don't mix content between them.

- **[`plan/`](plan/)** — what we are *actually* building, right now, in the
  order we're building it. This is the only place to look for current
  scope. If something here contradicts an older conversation or an
  archived doc, this folder wins.
- **[`archive/`](archive/)** — the original planning documents, kept
  verbatim for historical reference. Both are **superseded** by `plan/` in
  places (different demo strategy, different LLM provider, different
  provider-count) — they're kept because the reasoning behind long-term
  ideas (Playwright, multi-tenant, the full 12-bug catalogue) is still
  useful when we get there, not because they're still accurate top to
  bottom.

## Reading order

1. [`plan/00-overview.md`](plan/00-overview.md) — current architecture,
   in one page.
2. [`plan/01-phase-1-github.md`](plan/01-phase-1-github.md) — the GitHub
   target: what's done, what's validated live, what's still manual.
3. [`plan/production-architecture.md`](plan/production-architecture.md) —
   active: persistence, RAG, and the real five-stage pipeline, built on
   top of Phase 1's working loop.
4. [`plan/github-scenarios.md`](plan/github-scenarios.md) — every diagnosable
   scenario on the `github` target, seeded and real, with evidence
   signatures. Add new scenarios here.
5. [`knowledge-base/`](knowledge-base/README.md) — source-verified GitHub
   knowledge base and engineering spec for an API-based GitHub agent
   (a second provider on the same agent spine). Foundation release.
6. [`plan/02-phase-2-fake-saas.md`](plan/02-phase-2-fake-saas.md) — the
   second app; built in reduced form as `buggy-cloud/`, not deployed.
7. [`plan/03-roadmap.md`](plan/03-roadmap.md) — real future work, not active.
8. `archive/` — only when you want the original reasoning behind something
   in the roadmap.

## Running it locally

- [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md) — one command (`node scripts/dev-local.mjs`) starts the backend and
  Buggy Cloud; how to load the extension in Chrome; ports, health checks, troubleshooting.

## Current state, deployment and security

- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) — what is done,
  partial, not started and blocked, what was verified, what was not, the
  review findings and the progress log. Start here.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — Render + Neon (+ Redis, Groq): every
  manual step, environment variables, known limits. Nothing is deployed.
- [`DEMO_REHEARSAL.md`](DEMO_REHEARSAL.md) — the pre-demo checklist.
- [`SDK_VS_EXTENSION.md`](SDK_VS_EXTENSION.md) — how app-specific fixes work
  and why a page cannot widen what Operon may do.

## Testing and validation status

[`TESTING.md`](TESTING.md) — every test suite, what's stubbed vs real, the
real-service validation results (Groq, embeddings, github.com), and known
limitations.

## Status tracking

There's no separate tracker file — each phase doc in `plan/` carries its
own checklist inline, next to the milestone it belongs to. Update the
checkbox in the phase doc when a milestone actually ships.
