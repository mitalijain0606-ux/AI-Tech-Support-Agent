---
doc_id: kb_gh_actions_troubleshooting
title: GitHub Actions troubleshooting — diagnostic paths and log access
severity: high
sources: [actions-troubleshooting, actions-debug-logging, actions-github-token, rest-workflow-runs, rest-rate-limits, rest-best-practices]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: volatile
confidence: medium
---

# GitHub Actions troubleshooting

CI failure is the highest-value thing this agent diagnoses. This
chapter records **what GitHub documents** about diagnosing workflows
and how to get at the evidence via API. Ecosystem-specific failures
(npm, pip, Maven, Docker…) are Part XV and are **PLANNED**, not covered
here.

## 1. The first question: what kind of failure is it?

A "failed workflow" is at least four different problems with different
evidence. Ask in this order — each answer eliminates whole branches:

```text
Workflow "failed"?
│
├─ Did a run get created at all?
│    ├─ NO  ─→ TRIGGER problem  (§2)
│    └─ YES
│
├─ Did the run start executing jobs?
│    ├─ NO / stuck queued / skipped ─→ GATING problem  (§3)
│    └─ YES
│
├─ Did a job/step fail?
│    ├─ YES ─→ EXECUTION problem: read logs  (§4)
│    └─ NO (all green)
│
└─ CI green but the *outcome* is wrong (deploy didn't happen, PR not created)
     └─ DOWNSTREAM/SEMANTIC problem  (§6)
```

## 2. Trigger problems (no run was created) [src:actions-troubleshooting]

| Cause | Evidence to collect | Notes |
|---|---|---|
| Workflow is disabled | Workflow object state | "A disabled workflow does not respond to its triggers." |
| `on:` doesn't match the event | Workflow YAML at the *triggering commit's ref* | Read the file from the ref that triggered, not the default branch |
| Event only runs from the default branch | Event type vs. branch | e.g. `issues`, `schedule` run only from the default branch |
| Path filter miss | Files changed in the push/PR | **Diff evaluation is limited to the first 3,000 files**; if changed files outside the first 3,000 match your filter, the workflow does not run |
| Skip annotation in commit message | Commit message | Runs are skipped for skip annotations |
| PR has a merge conflict | PR `mergeable` state | Runs are skipped when the PR has a merge conflict |
| Event caused by `GITHUB_TOKEN` | Actor of the triggering push/PR | Events triggered with `GITHUB_TOKEN` don't create runs, except `workflow_dispatch` and `repository_dispatch`; `pull_request` opened/synchronize/reopened create runs awaiting approval [src:actions-github-token]. This is the classic "my bot's PR never ran CI" |
| Invalid YAML / expression | Workflow parse error surfaced in the UI / API | GitHub's troubleshooting page defers YAML syntax to the workflow-syntax reference — **detailed YAML diagnostics UNVERIFIED here** |

## 3. Gating problems (run exists, jobs don't run) [src:actions-troubleshooting]

- **Billing / storage blocked:** billing errors are a documented
  category; "setting an Actions budget may help immediately unblock
  workflows failing due to billing or storage errors."
- **Runner availability:** self-hosted runners offline, or *duplicate
  labels* causing wrong assignment; label mismatch leaves jobs queued.
- **Environment protection / required approvals:** runs may wait for
  deployment approval. Endpoints exist to list and act on them
  (`…/runs/{run_id}/pending_deployments`, `…/approvals`)
  [src:rest-workflow-runs]; approving is a **high-risk write** (see
  `08-agent/`) and must not be automatic.
- **Fork PR approval:** public-fork PR runs can require approval
  (`POST …/runs/{run_id}/approve`) [src:rest-workflow-runs].
- **Concurrency groups:** cancelled/queued by a newer run in the same
  group (**details UNVERIFIED — concurrency docs not fetched**).

## 4. Execution problems: getting the logs

### 4.1 Evidence retrieval order (read-only, cheap → expensive)

1. `GET /repos/{owner}/{repo}/actions/runs/{run_id}` — status,
   conclusion, head SHA, attempt. [src:rest-workflow-runs]
2. Jobs for the run → find the failed job and failed **step**
   (listing jobs/steps endpoints: named in the tool registry;
   per-endpoint detail **PLANNED**).
3. `GET /repos/{owner}/{repo}/actions/runs/{run_id}/logs` — returns a
   **`302` redirect to an archive that expires after 1 minute**
   [src:rest-workflow-runs]. Follow it immediately and stream/store
   the archive; do not store or forward the redirect URL.
   Per-attempt: `…/attempts/{attempt_number}/logs`.
4. Inside the archive, the failing job's `system.txt` shows how
   conditions were evaluated — look for *Evaluating*, *Expanded* and
   *Result* lines to see why a step/job ran or was skipped
   [src:actions-troubleshooting].

### 4.2 Getting more verbosity [src:actions-debug-logging]

- Set `ACTIONS_STEP_DEBUG=true` (verbose step logs) and/or
  `ACTIONS_RUNNER_DEBUG=true` (runner diagnostic logs; adds runner-process
  and worker-process log files under a `runner-diagnostic-logs` folder in
  the downloaded archive) as a secret or variable; **if both exist the
  secret wins.**
- Anyone who can run the workflow can enable both for a *re-run*.
- The REST re-run endpoint documents a debug-logging option
  [src:rest-workflow-runs]; the exact field name is **UNVERIFIED** — read
  it from the OpenAPI description before coding it.
- Tool-level verbosity, per GitHub: `npm install --verbose`,
  `GIT_TRACE=1 GIT_CURL_VERBOSE=1 git …` [src:actions-troubleshooting].
  ⚠ **These can print secrets and tokens.** Any debug log the agent
  ingests goes through credential scrubbing before reaching the model
  (see `08-agent/`).

### 4.3 Log intelligence pipeline (Design)

```text
Raw archive
  → ANSI removal
  → timestamp extraction
  → per-step segmentation (use step boundaries, not regex guesses)
  → error-line extraction  (exit codes, "Error:", stack frames, tool-specific markers)
  → stack-trace grouping
  → classification (dependency | network | auth | permission | timeout | OOM |
                    toolchain/version | test failure | lint | build | config)
  → context-window extraction (±N lines around the FIRST failing line)
  → credential scrub
  → store excerpt as evidence with ids ev_001…  (never store the whole log in the prompt)
```

Key discipline: **the first error is usually the cause; later errors are
often cascade.** Extract the *earliest* failing line in the *failed step*,
and retain later ones as secondary evidence.

## 5. Actions-adjacent API facts

- List runs returns **up to 1,000 results**; an empty page is not proof
  a run doesn't exist [src:rest-workflow-runs].
- Re-run **failed jobs** also re-runs their dependent jobs (`201`);
  single-job re-run: `POST …/actions/jobs/{job_id}/rerun`; cancel
  returns `202`; force-cancel bypasses `always()` conditions and is for
  when normal cancel fails [src:rest-workflow-runs].
- Re-running is a **write with side effects** (consumes minutes, may
  trigger deployments): medium risk; high if the workflow deploys to a
  protected environment.
- Rate limits: `GITHUB_TOKEN` gets 1,000 req/hr/repo, so an agent
  running *inside* Actions must be frugal [src:rest-rate-limits].
- Mutations: ≥ 1 s apart, serial [src:rest-best-practices].

## 6. Downstream / semantic problems (CI green, outcome wrong)

The rule from the brief applies fully: **completion ≠ success.** Examples:
the deploy job succeeded but the environment didn't change; the fix PR
was created but from a `GITHUB_TOKEN` actor so CI never ran (§2); a
"skipped" job counted as success in a required check. Verification must
assert the *desired state* (see `08-agent/`), not the exit code.

## 7. Diagnostic decision summary for the agent

1. Classify: trigger / gating / execution / downstream (§1).
2. Collect the minimum evidence for that class (tables above).
3. Generate ≥ 2 hypotheses; each names the *evidence that would falsify it*.
4. Test the cheapest falsifier first (read-only calls).
5. Only after a hypothesis survives, decide remediation and risk tier.

Full worked flow: `10-playbooks/failed-actions-run.md`.

## 8. What this chapter does not cover yet (honest backlog)

Matrix/concurrency race diagnostics; cache and artifact failure modes
and limits; runner disk/OOM signatures; self-hosted runner ops;
reusable-workflow and composite-action failures; OIDC/`id-token`
issues; workflow-syntax error catalogue; log retention period. All
**PLANNED**.
