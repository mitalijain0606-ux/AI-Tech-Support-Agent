---
doc_id: kb_gh_permission_matrix
title: GitHub App permission matrix for agent capabilities
severity: critical
sources: [rest-permissions-apps, rest-workflow-runs, rest-contents, rest-pulls, app-installation-auth, rest-troubleshooting]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: versioned
confidence: low
---

# GitHub App permission matrix

> **Confidence is `low` on purpose.** The only source that maps endpoints
> to *App* permissions is GitHub's "Permissions required for GitHub Apps"
> page, and the page fetcher reported it as **truncated**
> [src:rest-permissions-apps]. The REST reference pages, when fetched,
> showed *classic-token* scope language and hid the fine-grained sections
> [src:rest-workflow-runs]. So: a row here is *verified* only if that
> page listed it; **absence from this table means "not checked", never
> "no permission needed".** Regenerate this matrix from GitHub's OpenAPI
> description before enforcing it.

Access levels are `read` / `write`. GitHub permission names below are
those exactly as listed on the permissions page.

## Matrix (verified rows)

| Agent capability | Endpoint | App permission | Access | Status |
|---|---|---|---|---|
| Read repository metadata | `GET /repos/{owner}/{repo}` | Metadata | read | verified |
| List collaborators | `GET /repos/{owner}/{repo}/collaborators` | Metadata | read | verified |
| Read source / files | `GET /repos/{owner}/{repo}/contents/{path}` | Contents | read | verified |
| Modify files | `PUT /repos/{owner}/{repo}/contents/{path}` | Contents | write | verified + extra permissions **UNVERIFIED** |
| Delete file | `DELETE /repos/{owner}/{repo}/contents/{path}` | Contents | write | verified + extra permissions **UNVERIFIED** |
| Create commit (Git data) | `POST /repos/{owner}/{repo}/git/commits` | Contents | write | verified |
| Modify workflow files | `PUT …/contents/.github/workflows/*` | Contents write **and** the *Workflows* permission | write | **UNVERIFIED** name/level — classic tokens need the `workflow` scope [src:rest-contents]; the page listed a "Workflows" row but didn't expand it |
| Create pull request | `POST /repos/{owner}/{repo}/pulls` | Pull requests | write | verified; whether Contents *read* is also required is **UNVERIFIED** |
| Merge pull request | `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` | Pull requests | write | verified |
| Create review | `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews` | Pull requests | write | verified |
| Create issue | `POST /repos/{owner}/{repo}/issues` | Issues | write | verified |
| Update issue | `PATCH /repos/{owner}/{repo}/issues/{issue_number}` | Issues | write | verified + extra permissions **UNVERIFIED** |
| Comment on issue/PR | `POST …/issues/{issue_number}/comments` | Issues | write | verified + extra permissions **UNVERIFIED** |
| List workflow runs | `GET /repos/{owner}/{repo}/actions/runs` | Actions | read | verified |
| Rerun workflow | `POST …/actions/runs/{run_id}/rerun` | Actions | write | verified |
| Cancel workflow | `POST …/actions/runs/{run_id}/cancel` | Actions | write | verified |
| List / read artifacts | `GET …/actions/artifacts` | Actions | read | verified |
| Delete artifact | `DELETE …/actions/artifacts/{artifact_id}` | Actions | write | verified |
| Create check run | `POST /repos/{owner}/{repo}/check-runs` | Checks | write | verified |
| Read check run | `GET /repos/{owner}/{repo}/check-runs/{check_run_id}` | Checks | read | verified |
| List deployments | `GET /repos/{owner}/{repo}/deployments` | Deployments | read | verified |
| Create deployment | `POST /repos/{owner}/{repo}/deployments` | Deployments | write | verified |
| Update repo settings | `PATCH /repos/{owner}/{repo}` | Administration | write | verified |
| Delete repository | `DELETE /repos/{owner}/{repo}` | Administration | write | verified — **never a tool** |

### Inferred rows (not on the fetched page; treat as hypotheses)

| Capability | Endpoint | Presumed permission | Why only inferred |
|---|---|---|---|
| Get one workflow run | `GET …/actions/runs/{run_id}` | Actions read | Same Actions-read family; row not returned |
| Download run logs | `GET …/actions/runs/{run_id}/logs` | Actions read | Same |
| Re-run failed jobs | `POST …/actions/runs/{run_id}/rerun-failed-jobs` | Actions write | Same |
| Force-cancel run | `POST …/actions/runs/{run_id}/force-cancel` | Actions write | Same |
| Approve pending deployment | `POST …/runs/{run_id}/pending_deployments` | Deployments/Actions (unclear) | Ambiguous — **do not expose** until verified |
| Create branch | `POST /repos/{owner}/{repo}/git/refs` | Contents write | Endpoint not on the fetched page |

## How the planner must use this (Design)

1. The **tool registry** names the required permission per tool
   (`07-tools/tool-registry.yaml`); this matrix is the human-readable
   audit of that data.
2. At plan time the planner intersects *required permissions* with the
   installation's **granted** permissions (fetched from GitHub, never
   from the model). Missing ⇒ the action is **not executable**; the
   planner emits one of: *ask the owner to grant X*, *ask the user to do
   it*, or *produce a patch without executing*.
3. Mint installation tokens with an explicit `permissions` body limited
   to what the current task needs; omitting it inherits **all** of the
   App's permissions [src:app-installation-auth].
4. On a `403 Resource not accessible by integration`, read
   `X-Accepted-GitHub-Permissions` — comma-separated = all required;
   semicolon-separated groups = any one group suffices
   [src:rest-troubleshooting] — and record the *actual* requirement into
   the audit event so this matrix can be corrected from real behavior.
5. **Least privilege by tier.** Ship the MVP App with only
   *Metadata: read, Contents: read, Actions: read, Checks: read, Pull
   requests: read (if reviews are read), Issues: read*. Add each write
   permission only when its tool passes evaluation. GitHub Apps show
   permission changes to installers for approval — every increase is a
   customer-visible event, so batch them deliberately.

## Permissions the agent must never hold by default

Administration (write), repository/organization security settings,
deployment-protection approvals, secrets/variables write, and any
"delete" surface. If a future capability needs one, it is a separate
product decision with its own approval policy, not a tool addition.

## Verification backlog

- Pull GitHub's OpenAPI description and generate this matrix
  programmatically (per-operation permission + access level).
- Confirm the *Workflows* permission name/level for `.github/workflows`
  writes.
- Confirm the "additional permissions" for Contents PUT/DELETE and
  Issues PATCH/comment.
- Confirm exact permission for `pending_deployments` approval.
