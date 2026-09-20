---
doc_id: kb_gh_playbook_failed_actions_run
title: "Playbook: failed GitHub Actions run"
severity: high
symptoms:
  - "CI check is red on a PR or a push"
  - "A workflow run shows conclusion failure"
  - "Expected workflow run never appeared"
causes:
  - "Trigger/filter did not match, or event was created by GITHUB_TOKEN"
  - "Job blocked by runner/billing/approval"
  - "A step failed: dependency, toolchain/version, test, build, lint, network, permission, timeout, resource exhaustion"
  - "Toolchain version drift between workflow and repository requirements"
diagnostic_checks:
  - "Classify: trigger / gating / execution / downstream"
  - "Fetch the run, failed job, failed step, then scrubbed log excerpt around the FIRST failing line"
  - "Compare workflow YAML at the failing commit with repository requirement files"
evidence_patterns:
  - "run.conclusion == failure with a failed step name and exit code"
  - "no run exists for the head SHA"
  - "log line 'Resource not accessible by integration' inside a step"
recommended_actions:
  - github.get_workflow_run
  - github.get_workflow_logs
  - github.get_file
  - github.create_or_update_file
  - github.create_pull_request
  - github.rerun_failed_jobs
prerequisites:
  - "Actions: read, Contents: read (diagnosis). Contents: write and Pull requests: write for a fix PR. Workflow-file edits need the Workflows permission (UNVERIFIED name)."
contraindications:
  - "Never re-run a workflow that deploys to a protected environment without high-risk approval"
  - "Never run workflows from untrusted forks as part of diagnosis"
  - "Never treat a green rerun of a flaky test as a fix"
verification_predicates:
  - "The previously failing check concludes success on the fix PR's head SHA"
  - "Exactly one fix PR exists for this investigation, with the approved diff"
escalation_conditions:
  - "Cause is a billing/permission setting only an org admin can change"
  - "Failure is in the customer's application logic, not the pipeline configuration"
  - "Two verification attempts failed"
sources: [actions-troubleshooting, actions-debug-logging, actions-github-token, rest-workflow-runs, rest-contents, rest-pulls, rest-permissions-apps]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: volatile
confidence: medium
---

# Playbook: failed GitHub Actions run

## Problem

"My CI is failing." The agent's job is to decide *which of four different
problems this is*, prove the cause from evidence, and — only if
authorised — fix it and prove the fix worked.

## Prerequisites and permissions

| Phase | Needs (App permission) | Status |
|---|---|---|
| Diagnose | Actions: read, Contents: read (Metadata is implicit) | Actions/Contents rows verified; run/log rows inferred (see permission matrix) |
| Fix PR | Contents: write, Pull requests: write | verified; extras UNVERIFIED |
| Edit `.github/workflows/*` | + Workflows permission | **UNVERIFIED** name/level |

If a needed permission is missing the plan degrades to "deliver the
patch for manual application" — see `08-agent/`.

## Diagnostic procedure

1. **Understand.** Extract repo, workflow, run id/attempt, branch, head
   SHA, PR number, the user's stated symptom, recent changes. Ask only
   for what the API cannot supply.
2. **Classify (read-only).**
   - `list_workflow_runs` for the head SHA. *No run* → **trigger** branch.
   - Run exists but no job started / queued / waiting → **gating** branch.
   - A job/step failed → **execution** branch.
   - All green but outcome wrong → **downstream** branch.
3. **Evidence collection (execution branch).**
   `get_workflow_run` → failed job → failed step →
   `get_workflow_logs` (follow the 1-minute redirect immediately;
   [src:rest-workflow-runs]) → normalise (ANSI strip, step split) →
   extract the **first** failing line and ±N context lines → scrub
   credentials → store as `ev_` items.
4. **Hypotheses (≥ 2), each with a falsifier.**

   | Hypothesis | Falsifier (cheap read) |
   |---|---|
   | Toolchain version mismatch | Compare workflow `node-version`/`python-version` with repo requirement (`engines`, `pyproject`, `.nvmrc`, `go.mod`) |
   | Dependency/lockfile drift | Diff lockfile vs manifest in the last commits |
   | Flaky test / infra | Same commit's earlier attempts (`run_attempt`), same test on earlier commits |
   | Permission failure | Look for `Resource not accessible…` / 403 in the step; effective `permissions:` |
   | Network/registry outage | Error signature (ECONNRESET/ETIMEDOUT/DNS) + githubstatus |
   | Resource exhaustion | "No space left on device" / OOM markers |
   | Code defect from the last commit | Failing test/file appears in the commit's diff |
5. **Root cause** — accept a hypothesis only when ≥ 2 independent
   signals agree *and* the leading alternative was falsified. Otherwise
   confidence is Low → say what's missing (e.g. re-run with
   `ACTIONS_STEP_DEBUG` [src:actions-debug-logging] — a medium-risk write
   needing approval; or ask the user).
6. **Remediation plan** — smallest safe change; state risk tier; run
   permission resolution; produce the approval card.
7. **Execute (after approval)** — in this order, serially, each step
   verified before the next:
   1. Create branch from the *approved* base SHA (tool planned; see
      registry `planned_tools`).
   2. `create_or_update_file` (needs the file's current blob `sha` when
      updating; **never parallel with other contents writes**
      [src:rest-contents]).
   3. `create_pull_request` (`422 already_exists` ⇒ reuse existing).
8. **Verify** — poll CI for the PR head SHA with backoff and a timeout.
   - Terminal `success` on the previously failing check → **RESOLVED**.
   - No run started → likely the `GITHUB_TOKEN` no-recursion rule
     [src:actions-github-token]: report it, switch identity or dispatch
     (needs its own approval); do **not** call it a success.
   - `failure` again → record attempt, update hypotheses using the new
     log, continue within limits; max 2 fix attempts, then escalate.
9. **Document** — root cause, evidence ids, actions, approvals, result,
   prevention recommendation (e.g. pin toolchain versions; set
   `engines`; add CI check for lockfile drift).

## Decision tree

```text
Run exists for head SHA?
├─ NO ─→ workflow disabled? ─→ event/branch/path filter? (3,000-file limit) ─→ event created by GITHUB_TOKEN?
│        └─ each is a cheap read; first hit wins, else escalate with what was ruled out
└─ YES
   ├─ jobs never started (queued/waiting/skipped)?
   │     ├─ approval/environment pending?  → report; approval is a HUMAN action
   │     ├─ runner labels/availability or billing/storage? → report; admin action
   │     └─ skipped by condition/commit annotation/merge conflict? → read job `system.txt` Evaluating/Expanded/Result
   └─ a step failed
         ├─ permission/403 in log  → auth branch (06-errors: resource_not_accessible)
         ├─ network signature      → check status + retry via re-run (approval)
         ├─ toolchain/dependency   → compare workflow vs manifests → fix PR
         ├─ test/lint/build error  → is the failing file in the last diff? yes → code defect (escalate or PR w/ approval) / no → flaky/infra
         └─ resource exhaustion    → runner/config change (usually escalate)
```

## Decision rules the agent must obey

- **First error is the cause; later errors are cascade** unless evidence
  says otherwise.
- **Green re-run ≠ fixed.** If a re-run passes with no change, classify
  as *flaky* and say so; it is not a resolution.
- **Skipped ≠ passed** for required checks.
- **Read-only first.** No write before Root Cause is established and the
  risk/permission/approval steps are done.

## Worked scenario — "Next.js build fails after a dependency update"

*Illustrative sequence; no real repository behind it.*

1. Run 812, job `build`, step `npm ci` failed, exit code 1. Log's first
   error: `npm ERR! engine … required: {"node":">=20"} actual: v18`.
   → `ev_003`.
2. `get_file package.json` at the failing SHA: `"engines":{"node":">=20"}`
   (added by the dependency bump commit) → `ev_007`.
3. Workflow uses `node-version: 18` → `ev_008`.
4. Falsify the alternatives: same step passed on the previous commit
   (before the bump) ⇒ not infra; no 403/network signature ⇒ not
   permission/network.
5. Root cause: Node version mismatch — **High** confidence (3 signals,
   two alternatives falsified).
6. Proposal: change `node-version: 18` → `20` in `ci.yml` on branch
   `fix/node-20`. Risk: **high** (workflow file). Permission check: needs
   Contents write and Workflows permission → if not granted, deliver the
   diff for manual application.
7. After approval: branch, single-file commit, PR.
8. Verify: `build` on the PR head concludes `success` → RESOLVED. If the
   PR was created with `GITHUB_TOKEN`, no run appears → report, do not
   claim success.

## Common mistakes

- Downloading logs then storing the expiring redirect URL.
- Diagnosing from the *last* error line.
- Re-running to "see if it passes" and stopping when it does.
- Editing the workflow on the default branch instead of a PR branch.
- Creating the fix PR with `GITHUB_TOKEN` and never noticing CI didn't run.

## Related

`06-errors/errors.yaml`: `actions.trigger.path_filter_3000`,
`actions.token.no_recursive_runs`, `actions.gating.billing_blocked`,
`rest.403.resource_not_accessible.integration`,
`rest.contents.409_conflict`. Chapter: `05-actions/actions-troubleshooting.md`.
