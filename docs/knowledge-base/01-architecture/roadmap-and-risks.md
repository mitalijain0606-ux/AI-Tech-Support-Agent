# Implementation roadmap, stack recommendation, risks

*Everything in this document is **Design** — engineering judgment, not
GitHub fact — except statements tagged `[src:…]`.*

## Guiding decision: read-first, write-gated

The safest path to a useful GitHub agent is to earn trust with
read-only diagnosis, then add writes one risk tier at a time. Every
tier ships only after its evaluation scenarios (see
`09-evaluation/`) pass, because a diagnosis agent that is wrong wastes
time, but a *write* agent that is wrong changes a customer's repository.

## Roadmap

### MVP — "Explain the failure" (read-only)
- GitHub App (read-only permissions), single tenant, installation-token
  auth with caching and pre-emptive renewal (tokens live 1 hour
  [src:app-installation-auth]).
- Webhook receiver with signature validation, delivery-id dedup, queue
  [src:webhook-validation][src:webhook-best-practices].
- Tools: repo/file/commit reads, workflow run/job/log reads,
  check-run reads. No write tools registered at all.
- One playbook end to end: failed Actions run → root cause + evidence
  → *proposed* patch shown as a diff, not applied.
- Reuse the existing `SupportSession` state machine; new
  `EvidenceBundle` type for API evidence (log excerpts, status codes,
  headers) instead of browser evidence.
- Exit criteria: ≥ N benchmark scenarios diagnosed with correct root
  cause and *correct refusal* on the red-team set; zero secret leakage
  in audit logs.

### V1 — "Fix with approval" (low/medium writes)
- Add write tools by tier: issue/PR comment (low), branch + commit +
  PR (medium). Every write goes through the policy engine and, for
  medium+, a human approval card.
- Deterministic verification predicates per action (PR exists on the
  expected branch with the expected diff; CI on the PR reaches a
  terminal state).
- Idempotency: before any retried write, re-read GitHub state (see
  `08-agent/`). No blind retries of writes.
- Permission-aware planner: an action whose required permission the
  installation lacks is *never proposed as executable* — it becomes
  "ask the user to grant X" or "here is a patch to apply manually".
- Exit criteria: fix-PR flow verified against sandbox orgs incl. branch
  protection, required checks, CODEOWNERS.

### V2 — "Operate" (multi-repo, incidents, RAG breadth)
- Repository index (dependency/import graph, incremental re-index on
  `push` webhooks), hybrid retrieval, historical-resolution retrieval.
- Incident-response mode; deployment/environment diagnosis.
- Rerun/cancel workflow tools (medium/high depending on environment).
- Full observability dashboards and an automated eval gate in CI for
  prompt/model/KB changes.

### Enterprise
- Multi-tenancy with hard isolation (per-tenant credentials, per-tenant
  vector namespaces, row-level security), SSO, GHES/GHEC support, audit
  export, customer-managed keys, data-residency options.
- Formal threat model, pen test, SOC 2-style controls.

## Technology stack recommendation (Design)

| Concern | Recommendation | Why | Main alternative & when to switch |
|---|---|---|---|
| Language | TypeScript (Node) for the GitHub-facing service; Python for the reasoning/eval side (matches the existing backend) | Octokit is GitHub's first-party SDK; the existing codebase is Python/FastAPI | All-Python with `githubkit`/`PyGithub` if the team wants one language; accept less first-party SDK parity |
| GitHub client | Octokit + throttling/retry plugins, wrapped behind the tool registry | Central place to enforce rate-limit and idempotency rules | Raw REST for endpoints the SDK lags on |
| DB | PostgreSQL | Relational integrity for audit/approvals, RLS for tenancy, `pgvector` for retrieval in one system | MongoDB adds no needed capability here |
| Vector search | `pgvector` first | One less system to operate at MVP/V1 scale; the current repo already stores embeddings in a table designed for a pgvector move | Qdrant/OpenSearch when corpus or QPS outgrows Postgres, or when hybrid BM25+vector is needed at scale |
| Queue | Postgres-backed queue or Redis + BullMQ at MVP | Webhook fan-out + retries with dedup by delivery id | SQS/Kafka once multi-region or > moderate throughput |
| LLM | Choose per *stage*, not globally: a cheaper fast model for classification/log triage, a stronger reasoning/coding model for diagnosis and patch generation | Cost/latency differ 10×+ across stages | **Model names and benchmarks were deliberately not researched in this release** — pick with the evaluation harness on *your* scenarios, not public leaderboards |
| Secrets | Cloud KMS/Secrets Manager; App private key never in the app DB | See `08-agent/` secret rules | — |

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Agent misdiagnoses and "fixes" the wrong thing | Wrong PRs, lost trust | Evidence-cited diagnoses only; write actions gated by approval; deterministic verification; eval gate |
| Prompt injection via repo content (README, issues, PR comments, logs) | Token theft, unauthorized writes | Repo content is untrusted data; closed action enum; no tool can exfiltrate secrets; policy engine independent of model output |
| Over-broad App permissions | Blast radius | Least-privilege permissions; per-installation token scoping via `repositories`/`permissions` body params [src:app-installation-auth] |
| Token expiry mid-task | Half-finished writes | Renew before expiry (1 h tokens); persist state per step; re-read state before resuming |
| Rate limits / secondary limits | Stalls, possible integration ban | Serialize requests, ≥ 1 s between mutations, honor `retry-after`, ETags [src:rest-best-practices][src:rest-rate-limits] |
| Webhook duplicates / reordering | Double actions | Dedup on `X-GitHub-Delivery`; treat ordering as not guaranteed; always re-read current state before acting |
| Stale knowledge (GitHub changes) | Wrong guidance | Freshness metadata, weekly OpenAPI/changelog diff, staleness cap on confidence |
| Fetcher-summarised sources (this KB's own weakness) | Wrong numbers hard-coded | Registry `unverified` list; move to OpenAPI-derived generation |
| Cross-tenant leakage | Catastrophic | Tenant id on every row and vector namespace; RLS; per-tenant credentials |
| Cost blow-up on long logs | Budget | Log normalisation + extraction before LLM; per-session LLM call budget (already a hard limit in the existing session design) |

## Production-readiness checklist (skeleton)

- [ ] App permissions minimal and documented against the permission matrix
- [ ] Webhook secret set; signature validation on the raw body; constant-time compare
- [ ] Delivery-id dedup store with TTL ≥ GitHub redelivery window (verify)
- [ ] Installation-token cache with pre-emptive renewal
- [ ] Rate-limit-aware client (serial mutations, retry-after, ETag conditional GETs)
- [ ] Every write tool has idempotency + verification predicate
- [ ] Immutable audit log for every tool call
- [ ] Prompt-injection and cross-tenant red-team suites green in CI
- [ ] Dead-letter queue + alerting
- [ ] Knowledge-refresh job running; no article > 90 days unverified
