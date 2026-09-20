# Table of contents — full planned knowledge base

Status key: **W** = written in this release (see file), **D** = design
content written (engineering recommendation, not GitHub fact), **P** =
partially written, **—** = planned, not started. A "W" chapter can still
contain `UNVERIFIED` rows; see `00-methodology/source-registry.yaml`.

| Part | Title | Status | Where / what is covered now |
|---|---|---|---|
| I | Executive Architecture | D | `README.md`, `01-architecture/roadmap-and-risks.md`, `08-agent/` |
| II | GitHub Platform Fundamentals | — | Objects and hierarchy (users/orgs/repos/teams) not yet written |
| III | Git & Git Internals | — | Git docs not fetched this pass |
| IV | GitHub APIs | P | `02-platform/rest-graphql-fundamentals.md` (versions, limits, pagination, conditional requests, timeouts). No per-endpoint reference yet — see Appendix A plan |
| V | Authentication & Authorization | P | `03-auth/authentication-architecture.md` (Apps, JWT, installation/user tokens, GITHUB_TOKEN; PAT/SSH/deploy-key rows UNVERIFIED) |
| VI | GitHub Apps | P | Same file + `07-tools/permission-matrix.md`. Registration, event-subscription, uninstall behavior not yet written |
| VII | Webhooks | P | `04-webhooks/webhook-architecture.md` (validation, headers, 10 s rule, queue design, dedup). Per-event payload reference not yet written |
| VIII | Repository Intelligence | — | Indexing pipeline designed at outline level in `11-integration/` only |
| IX | Issues | — | Tools listed in registry; no article |
| X | Pull Requests | P | Merge/create status codes in `06-errors/`; tools in registry. No review/CODEOWNERS/merge-queue article |
| XI | GitHub Actions | P | `05-actions/actions-troubleshooting.md` |
| XII | CI/CD Troubleshooting | P | `10-playbooks/failed-actions-run.md` |
| XIII | GitHub Deployments | — | Environments/protection rules: endpoints named in registry sources only |
| XIV | GitHub Security | — | Prompt-injection/secret-handling design is in `08-agent/`; GitHub security features (code scanning, secret scanning, Dependabot) not written |
| XV | Dependency & Build Troubleshooting | — | Ecosystem-specific (npm/pip/Maven/…) chapters not started |
| XVI | GitHub CLI | — | Not fetched |
| XVII | Git Operations | — | Not fetched |
| XVIII | Error Intelligence | P | `06-errors/error-intelligence.md` + `06-errors/errors.yaml` (schema + verified REST/Actions entries). Thousands of entries is the long-run target; this release has the schema and the verified seed set |
| XIX | Troubleshooting Playbooks | P | `10-playbooks/` (2 full playbooks). Target: the 21 listed in the brief |
| XX | AI Agent Architecture | D | `08-agent/agent-architecture.md` |
| XXI | RAG & Knowledge Systems | D | `11-integration/operon-integration.md` (reuses existing retrieval) — repository-aware/AST/hybrid retrieval not written |
| XXII | Tool Calling | P | `07-tools/tool-registry.yaml` (first 14 tools) |
| XXIII | Agent Planning | D | permission-aware planning in `08-agent/agent-safety-and-execution.md` |
| XXIV | Agent Safety | D | `08-agent/agent-safety-and-execution.md` |
| XXV | Human-in-the-Loop | D | same file |
| XXVI | Autonomous Remediation | D | same file + failed-Actions playbook |
| XXVII | Verification | D | same file |
| XXVIII | Observability | — | Metric list only, in `09-evaluation/` |
| XXIX | Evaluation | P | `09-evaluation/evaluation-and-redteam.md` (schema, metrics, seed scenarios) |
| XXX | Red Teaming | P | same file (initial scenario set) |
| XXXI | Production Infrastructure | — | Outline in roadmap only |
| XXXII | Multi-Tenancy | — | Requirements stated in `08-agent/`; no schema |
| XXXIII | Data Architecture | — | Existing `SupportSession` schema referenced in `11-integration/` |
| XXXIV | API Architecture | — | Not written |
| XXXV | Frontend Architecture | — | Approval-card contents specified in `08-agent/`; no UI spec |
| XXXVI | Testing | P | Strategy outline inside `09-evaluation/` |
| XXXVII | Disaster Recovery | — | Recovery loop in `08-agent/` covers agent failures only |
| XXXVIII | Incident Response | — | Not written |
| XXXIX | Real-World Case Studies | — | 1 worked scenario embedded in the Actions playbook |
| XL | Production Readiness | P | Checklist skeleton in `01-architecture/roadmap-and-risks.md` |

## Appendices

| App. | Title | Status | Note |
|---|---|---|---|
| A | REST endpoint index | — | **Generate from GitHub's OpenAPI description**, do not hand-write |
| B | GraphQL reference | — | Limits only, in `02-platform/` |
| C | GitHub App permission matrix | P | `07-tools/permission-matrix.md` (verified subset, truncation-flagged) |
| D | Webhook event matrix | — | Not written |
| E | HTTP error reference | P | `06-errors/` |
| F | Git error reference | — | Git docs not fetched |
| G | Actions error reference | P | `05-actions/`, `06-errors/` |
| H | Common CI/CD errors | — | Not written |
| I | Agent tool registry | P | `07-tools/tool-registry.yaml` |
| J | Risk classification matrix | D | `08-agent/` |
| K | Approval matrix | D | `08-agent/` |
| L | Security threat model | P | Threat list + trust boundaries in `08-agent/`; no STRIDE-style full model |
| M | Prompt-injection test cases | P | `09-evaluation/` |
| N | Agent evaluation benchmark | P | `09-evaluation/` |
| O | Production runbooks | — | Not written |
| P | Incident-response runbooks | — | Not written |
| Q | API examples | P | Inline in chapters |
| R | Webhook payload examples | — | Not written |
| S | Database schemas | — | See existing `SupportSession` |
| T | Architecture diagrams | P | ASCII diagrams inline |

## What "1000+ pages" requires from here

The unwritten rows above are the honest backlog. Roughly, the
breadth-heavy parts (IV per-endpoint reference, VII per-event payloads,
XV ecosystem troubleshooting, XVIII error corpus, XIX playbooks, XXIX
scenarios, Appendices A/C/D/E/F/G/H) are where volume legitimately
lives, and most of them are best **generated from primary machine-readable
sources** (OpenAPI description, webhook event schemas) plus reviewed
prose, rather than written by hand. That is the recommended path to
scale; see `README.md` "Growth plan".
