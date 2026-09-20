# Knowledge-domain taxonomy

The brief lists 100 knowledge domains. They are organised here into
clusters, each mapped to a Part in the table of contents and given a
**primary retrieval key** — the thing an agent query is most likely to
match on. Retrieval keys matter because the KB is consumed by a
retrieval system (see `11-integration/`), not read cover to cover.

Domains are addressed by a stable id `gh.<cluster>.<topic>` so articles,
tools, and eval scenarios can cross-reference them.

| Cluster | Domains (brief numbering) | Part(s) | Primary retrieval key | Coverage now |
|---|---|---|---|---|
| `gh.platform` | 1 fundamentals, 3 repositories, 4 organizations, 5 users & teams, 13 discussions, 14 projects | II | object names, ownership/visibility | — |
| `gh.git` | 2 Git fundamentals, 5–8 branches/commits/tags/releases, 47–51 HTTPS/SSH/credentials/LFS/submodules, 80–83 history/conflicts/rebase/detached HEAD, 84 force push, 22 Git ops | III, XVII | git error strings, command names | — |
| `gh.collab` | 9 issues, 11 pull requests, 12 reviews, 85–89 protected branches / CODEOWNERS / required checks / merge queue / branch policies | IX, X | PR/issue state, merge blockers | P (merge codes) |
| `gh.actions` | 15–19 Actions/runs/jobs/steps, 20–21 checks, 22–24 artifacts/caches/runners, 25 deployments, 26 environments, 27–28 secrets/variables, 90 protection rules | XI, XII, XIII | log lines, exit codes, trigger config | P |
| `gh.security` | 29 Dependabot, 30–32 code/secret scanning & repo security, 78 security incidents | XIV | alert types, secret patterns | — |
| `gh.artifacts` | 33 Pages, 34–35 Packages/registries | XIII, XV | publish/registry errors | — |
| `gh.identity` | 36 Apps, 37 OAuth, 38–40 authn/authz/permissions, 41 installation tokens, 42 user tokens, 79 (auth failures 76–77) | V, VI | 401/403/404, "Resource not accessible…" | P |
| `gh.events` | 43 webhooks | VII | event name, delivery headers | P |
| `gh.api` | 44 REST, 45 GraphQL, 46 CLI, 54 rate limits, 55 pagination, 56 API errors | IV, XVI, XVIII | status codes, headers | P |
| `gh.availability` | 57 outages, 58–59 GHEC / GHES | IV, XXXVII | githubstatus, version differences | — |
| `gh.build` | 60–75 CI/CD, dependency, build, test, Docker, Node, Python, Java, Go, Rust, .NET, frontend/backend build, DB-in-CI, cloud deploy | XII, XV | tool error strings per ecosystem | — |
| `gh.repo-scale` | 52 monorepos, 53 large repos, 79 repository corruption | III, VIII | size/perf symptoms | — |
| `gh.agent` | 91 AI-agent safety, 92 agent execution, 93 tool permissions, 94 human approval, 95 audit, 96 observability, 97 reliability, 98 rate-limit management, 99 retry strategies, 100 disaster recovery | XX–XXVIII, XXXVII | risk class, tool name | D / P |

## Cross-cutting facets (every article is tagged with these)

- **Subsystem**: platform · git · api · auth · actions · deploy · security · agent
- **Failure class**: permission · configuration · dependency · environment · transient/infra · code defect · policy/branch-protection · rate-limit · data-integrity
- **Action risk ceiling**: read-only · low-write · medium-write · high-risk (see `08-agent/`)
- **Resolvable by agent?**: auto · with-approval · user-action · escalate

Facet tags are what let the diagnostic loop retrieve *"permission-class
API failures that are resolvable with user action"* rather than
keyword-matching error text alone.
