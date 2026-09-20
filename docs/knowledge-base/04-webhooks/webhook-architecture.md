---
doc_id: kb_gh_webhooks
title: Webhook ingestion architecture
severity: high
sources: [webhook-validation, webhook-best-practices]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: volatile
confidence: medium
---

# Webhook ingestion architecture

Webhooks are how the agent learns something happened without polling
(polling burns rate limit [src:rest-best-practices]). They are also an
**unauthenticated inbound network endpoint**, so validation comes first.

## 1. Verified facts

| Fact | Source |
|---|---|
| Signature header `X-Hub-Signature-256`, value starts `sha256=`, HMAC-SHA256 of the payload with the webhook secret | [src:webhook-validation] |
| Legacy `X-Hub-Signature` (HMAC-SHA1) exists only for backward compatibility — do not use | [src:webhook-validation] |
| Compare in constant time; never `==` | [src:webhook-validation] |
| Verify against the raw body; treat payload as UTF-8 | [src:webhook-validation] |
| Respond `2XX` within **10 seconds** | [src:webhook-best-practices] |
| Process asynchronously via a queue | [src:webhook-best-practices] |
| `X-GitHub-Event` names the event; `X-GitHub-Delivery` is unique per event and **the same on a redelivery**; `X-GitHub-Hook-ID` identifies the hook | [src:webhook-best-practices] |
| `GET /meta` returns GitHub's current IP ranges; refresh periodically | [src:webhook-best-practices] |
| No ordering guarantee is stated in the fetched docs | [src:webhook-best-practices] — treated as **not guaranteed** |
| Payload size cap | **UNVERIFIED** |
| Per-event payload schemas (`workflow_run`, `check_run`, `pull_request`, …) | **UNVERIFIED — not fetched this pass**; see Appendix R plan |

## 2. Signature verification (tested)

The code below reproduces GitHub's documented test vector — secret
`It's a Secret to Everybody`, payload `Hello, World!` →
`sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`
— and this was executed when the article was written.

```python
import hashlib, hmac

def verify_github_signature(secret: bytes, raw_body: bytes, header_value: str | None) -> bool:
    if not header_value or not header_value.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_value)   # constant time
```

Implementation traps:

- **Read the raw bytes before any JSON parsing.** Frameworks that parse
  then re-serialize change whitespace/key order and break the HMAC.
  (In FastAPI: `await request.body()`, verify, *then* `json.loads`.)
- Reject missing/malformed headers with `401`/`403` and **do no work**.
- Log a *hash* of the delivery id and the failure reason, never the
  header or body of an unauthenticated request.
- Never accept the SHA-1 header as a fallback.

## 3. Pipeline (Design)

```text
GitHub
  │  HTTPS POST  (X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256)
  ▼
Edge / API gateway ── optional IP allowlist from GET /meta (refresh on a schedule)
  ▼
Ingress handler  (must return 2xx < 10 s → do almost nothing)
  1. verify signature on raw body           ── fail → 401, stop
  2. INSERT delivery_id (unique) into dedup ── conflict → 200 "duplicate", stop
  3. persist raw event (encrypted) + enqueue job(event, delivery_id, installation_id)
  4. return 202/200
  ▼
Queue  ── retries with backoff, dead-letter queue after N attempts
  ▼
Event processor
  1. resolve tenant from installation_id  (never from payload repo name alone)
  2. RE-READ current GitHub state          (payload may be stale/out of order)
  3. correlate → existing Investigation, or open a new one
  ▼
Agent context builder → reasoning → policy engine → tool execution → verification
```

Why step 2 of the processor matters: with no ordering guarantee, a
`workflow_run: completed` can arrive before an earlier `in_progress`
or after a newer run superseded it. The processor trusts the API, not
the arrival order.

## 4. Deduplication and idempotency

- **Key:** `X-GitHub-Delivery` (same value on redelivery)
  [src:webhook-best-practices]. Store it with a unique constraint;
  insert-or-ignore is the whole dedup mechanism and is atomic.
- **Retention:** keep delivery ids at least as long as GitHub could
  plausibly redeliver. The redelivery window is **UNVERIFIED**; until
  confirmed, keep ≥ 30 days (*Design* default; it's cheap).
- **Two layers:** delivery-level dedup (identical redelivery) is
  *necessary but not sufficient*. GitHub can also emit distinct
  deliveries describing the same logical change (e.g. `check_run` +
  `workflow_job` + `workflow_run` for one CI failure). The
  correlation step must be idempotent on the *logical key*
  `(repo, workflow_run_id, run_attempt)`.
- Handlers must be safe to run twice: never "create PR" purely because
  an event fired — check whether one already exists (see
  `08-agent/` idempotency rules).

## 5. Failure handling

| Failure | Behavior |
|---|---|
| Signature invalid | 401; alert on a sustained rate (probe/forgery attempt) |
| Duplicate delivery | 200, no work |
| Queue unavailable | Return 5xx so GitHub's own retry/redelivery path can recover; do **not** ack what you didn't persist |
| Processor crashes mid-job | Job is retried; because steps re-read state and writes carry idempotency/verification, replay is safe |
| Poison message | After N failures → dead-letter queue, alert, investigation marked `needs_human` |
| Server down for a period | Redeliver missed deliveries once back up [src:webhook-best-practices]; mechanism/API details **UNVERIFIED** |

## 6. Replay protection

Signature validation proves *GitHub sent it*, not *it's fresh*: a
captured, validly signed delivery can be replayed. Mitigations
(*Design*): delivery-id dedup (above); reject deliveries older than a
tolerance where the payload carries a reliable timestamp; and — most
importantly — never let a webhook *itself* authorize an action: it only
opens an investigation, and any write still passes the policy engine
against **current** state.

## 7. Events the agent needs (per-event field reference **PLANNED**)

`push`, `pull_request`, `pull_request_review`, `issues`,
`issue_comment`, `workflow_run`, `workflow_job`, `check_run`,
`check_suite`, `deployment`, `deployment_status`, `release`,
`installation`, `installation_repositories`, `repository`,
`organization`, and security events. Priorities for the failed-CI
playbook: `workflow_run` (completed/failure), `workflow_job`,
`check_run`. `installation` / `installation_repositories` drive
tenant onboarding, permission changes, and **uninstall handling**
(revoke cached tokens, stop work, retain audit data per policy).

## 8. Tests

- Unit: signature vector above; missing/short/uppercase-prefix headers.
- Property: any body mutation ⇒ verification fails.
- Integration: same `X-GitHub-Delivery` twice ⇒ exactly one job.
- Chaos: kill processor mid-job ⇒ no duplicate side effects after replay.
- Security: forged delivery without valid signature does zero work and
  returns fast.
