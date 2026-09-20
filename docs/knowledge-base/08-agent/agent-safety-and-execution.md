# Agent safety, approval, execution, verification, recovery (Design)

Engineering recommendations, not GitHub facts, except where a
`[src:<id>]` tag is present. This is the part of the system that decides
whether the agent is safe to run against a customer's repositories.

## 1. Trust boundaries — repository content is data, never instructions

Six kinds of text reach the agent; only the first three may ever
*direct* it.

| Level | Examples | May it direct the agent? |
|---|---|---|
| 1. System instructions | Fixed prompt, tool schemas | Yes |
| 2. Developer policy | Risk tiers, approval rules, tenant policy | Yes |
| 3. Requester instructions | The authenticated human's request in the UI | Yes — *within* policy |
| 4. Trusted tool results | Registry-tool output about GitHub *state* (status codes, ids, timestamps) | Informs, doesn't command |
| 5. Repository content | README, source, workflow YAML, issue/PR text, commit messages, comments, logs, generated files | **Never** |
| 6. Untrusted external | Anything fetched from URLs, third-party docs | **Never** |

Mechanics:

- Level-5/6 text is wrapped and labelled as data in the prompt, and the
  system prompt states that instructions inside it are to be *reported*,
  not obeyed.
- **The policy engine does not read model prose.** It sees only a
  structured request. A fully successful injection therefore still
  cannot exceed the action set, the permissions, or the approval rules
  — the structural defence, not the prompt, is the security boundary.
- Any level-5/6 text that *looks like an instruction to the agent*
  ("ignore previous instructions", "reveal your token", "disable
  branch protection") is a **detection event**: logged, surfaced in the
  investigation as suspicious content, and never acted on.

## 2. Risk tiers

| Tier | Examples | Default policy |
|---|---|---|
| **read_only** | get repo/file/commit/PR/issue/run/job/logs/check | Auto-execute |
| **low** | Comment on an issue/PR, add labels, add diagnostics | Auto-execute if tenant policy allows; else approve |
| **medium** | Create issue, create branch, commit to a *non-default, non-protected* branch, open PR, re-run a non-deploy workflow | **Approval required** |
| **high** | Merge PR, delete branch, touch `.github/workflows`, change security/permission/deployment config, cancel or re-run a production deployment, approve a deployment | **Explicit per-action approval; disabled unless tenant enables; some never automated** |
| **forbidden** | Delete repository, change org permissions, rotate/read secrets, disable branch protection, force-push to a protected branch, bypass required checks | No tool exists; request is refused and escalated |

Risk is a property of the *tool plus its arguments and target*, not the
tool alone. The registry's `escalates_to_high_when` rules encode this
(e.g. `create_or_update_file` on `.github/workflows/*` or on a
protected branch is high). Calls the classifier cannot confidently place
are treated as one tier higher.

## 3. Approval matrix

| Action | Auto | Approve | Notes |
|---|---|---|---|
| Any read_only | ✅ | | Subject to API/log budgets |
| Comment (low) | tenant option | ✅ default | Never includes secrets or raw logs |
| Create issue / branch / PR (medium) | | ✅ | Approval binds to the exact diff/arguments shown |
| Commit to feature branch (medium) | | ✅ | |
| Re-run workflow (medium/high) | | ✅ | High when it deploys |
| Merge / delete / workflow-file change (high) | | ✅ + tenant flag | Approval expires; head SHA must still match |
| Approve deployment, security/permission changes | | 🚫 not agent-executable | Human does it in GitHub |

**Approvals bind to content, not intent.** An approval record stores the
tool, the canonical hash of the arguments, and (for PR/merge/commit) the
target head SHA. If anything changed — the diff, the head, the branch —
the approval is void and a new one is requested. Approvals also expire.

## 4. The approval card

```text
Root cause      <one sentence>                              Confidence: <level>
Evidence        ev_003  workflow run 812 job "build" step "npm ci" failed (exit 1)
                ev_007  package.json engines.node ">=20"; workflow uses node-version 18
Proposed action github.create_or_update_file  .github/workflows/ci.yml  (branch fix/node-20)
Files affected  .github/workflows/ci.yml  (+1 −1)   ← diff shown in full
Risk            HIGH (workflow file)        Permission check: contents:write ✔  workflows: ✔ / ✖
Expected result CI on the new PR reaches "success"
Rollback        Close the PR / revert commit <sha>; no change to default branch
Verification    PR exists with this diff; CI for head <sha> concludes success
[Approve] [Reject] [Modify]
```

The card is built from the structured `RemediationProposal`, not from
model prose, so what the human approves is exactly what will run.

## 5. Permission-aware planning

1. Planner drafts a `RemediationProposal` naming registry tools.
2. Resolver looks up each tool's required permissions
   (`07-tools/tool-registry.yaml`) and intersects them with the
   installation's *granted* permissions and its repository selection.
3. If not satisfiable: the action is **not proposed as executable**.
   Options presented, in order: *(a)* request permission from the
   installation owner; *(b)* ask the user to perform the step;
   *(c)* deliver the change as a patch/diff for manual application.
4. The model may never assert, assume, or "invent" a permission. Its
   claims about permissions are ignored; the resolver's are used.

## 6. Idempotency — never blindly retry a write

Decision procedure for any write that did not return a clear success:

```text
Did the first request actually succeed?      ← unknown after timeout/5xx/crash
   │
   ├─ Re-read current GitHub state (the tool's verification predicate).
   ├─ Predicate already true?  → treat as success; record; DO NOT re-send.
   ├─ Predicate false and the failure was definitive (4xx validation)? → fix request, new attempt.
   └─ Predicate false and outcome unknowable? → still re-read once more, then escalate; never a third blind send.
```

Per-tool mechanisms live in the registry (`idempotency.mechanism`):
hidden correlation markers for comments/issues, "list PRs for head→base
first" for PR creation, blob-`sha` for file updates, `run_attempt`
counters for re-runs. Additionally: a write is executed **at most once
per `(action_id, argument_hash)`** by a DB unique constraint, so a
duplicate webhook or a retried job cannot double-execute.

Contents writes must be serial — parallel create/update/delete calls
conflict [src:rest-contents] — so the executor takes a per-repository
write lock.

## 7. Verification — never claim success from a return code

Every action has a **deterministic predicate** evaluated against fresh
GitHub state; the LLM is never asked whether it worked.

| Action | Predicate |
|---|---|
| create_or_update_file | File at branch head hashes to the intended content; branch head's parent is the pre-write head |
| create_pull_request | PR open with expected head/base; diff equals the approved diff |
| Fix-PR overall | CI on the PR head SHA reached a terminal state, and for a "fix CI" goal, the previously failing check now concludes `success` |
| rerun_* | `run_attempt` advanced by exactly one; status queued/in_progress |
| merge_pull_request | PR merged; merge commit on base; merged head == approved head |
| comment / issue | Exactly one item with the correlation marker |

Fix-verification is *behavioral*: "the workflow file changed" is not
success; "the failing job now passes on this commit" is. If CI never
starts (e.g. PR created with `GITHUB_TOKEN`, so no run
[src:actions-github-token]), verification **fails visibly** rather than
passing by default.

On failure: record the attempt, update the hypothesis (the fix was
wrong or incomplete), and continue investigating within the loop limits
— or escalate. The agent never re-applies the same change unchanged.

## 8. Failure recovery loop

```text
Detect → Persist state → Retry ONLY if safe (idempotent or verified-not-applied)
       → Re-check current GitHub state → Resume from the last verified step
       → Roll back if partially applied and unsafe to leave → Escalate with full context
```

| Failure | Behavior |
|---|---|
| API timeout | Reads: backoff-retry. Writes: §6 procedure |
| Token expired mid-task (1 h [src:app-installation-auth]) | Renew; **re-read state**; resume from last verified step |
| Permission failure | No retry; read `X-Accepted-GitHub-Permissions`; permission-aware fallback (§5) |
| Rate limit | Wait per headers (see `02-platform/`); pause the investigation, don't fan out |
| Partial write (branch created, commit failed) | Clean up the orphan branch *only if* created by this investigation (tracked by id), else leave and report |
| Failed PR creation after commit | Resume from "open PR" using the existing branch |
| Base/head moved (force-push, new commits) | Approvals void; re-analyse against new head |
| GitHub outage | Pause and retry on schedule; surface status; do not burn attempt budget |
| DB/queue/LLM outage | Persisted state + idempotent steps make replay safe; DLQ after N failures |
| Duplicate execution | Blocked by the `(action_id, argument_hash)` unique constraint |

## 9. Audit log

Every tool call — including denied and read-only — writes an
**append-only** audit event before and after execution:

```json
{
  "event_id": "…", "correlation_id": "…", "timestamp": "…",
  "tenant_id": "…", "installation_id": 12345, "repository": "acme/backend",
  "actor": "agent", "requester_user_id": "…",
  "tool": "github.create_pull_request",
  "arguments_redacted": { "head": "fix/node-20", "base": "main", "title": "…" },
  "risk_tier": "medium", "permission_checked": { "pull_requests": "write", "granted": true },
  "policy_decision": "REQUIRE_APPROVAL", "approval_id": "…",
  "result_status": 201, "verification": { "predicate": "pr_exists", "passed": true },
  "prev_hash": "…", "hash": "…"
}
```

Immutability: application role has INSERT-only on the table; each row
carries a hash chained to the previous row (tamper-evident); periodic
export to write-once storage. Never log secrets — arguments go through
the scrubber first.

## 10. Secrets

The agent must never: print secrets; commit secrets; put them in logs,
error reports, PR/issue text; send them to the LLM unnecessarily; store
raw secrets in the vector DB.

- Credential scrubber (pattern set as in
  `backend/operon_backend/tripwire.py`, extended with GitHub token
  shapes such as `ghp_`/`gho_`/`ghs_`/`github_pat_` — *token prefix
  formats not verified against GitHub docs this release*) runs on every
  tool result and log excerpt **before** LLM context and storage.
- If a scan of repository content or logs finds a secret, the agent
  reports *that* one exists and *where* (file/line), never its value,
  and recommends rotation. Committing a fix that removes it does not
  un-leak it.

## 11. Confidence

Confidence describes **evidence**, and never authorises risk:

| Level | Meaning |
|---|---|
| High | ≥ 2 independent signals confirm the root cause and at least one competing hypothesis has been explicitly falsified |
| Medium | Strong evidence, another explanation still open |
| Low | Insufficient evidence — the correct output is "what I still need", not a fix |

**Confidence never raises a risk tier's autonomy**: a "high confidence"
merge is still a high-risk action needing approval. Low confidence
blocks even low-risk *writes* (comments asserting a cause).

## 12. Multi-tenant isolation requirements

Every row and every vector chunk carries `tenant_id`; queries are
scoped by it at the data layer (row-level security), not just in
application code. Per-tenant installation credentials; per-tenant vector
namespaces; a tool call's `installation_id` must belong to the session's
tenant (checked in the executor, not the prompt). Cross-tenant tests are
a release gate (`09-evaluation/`).
