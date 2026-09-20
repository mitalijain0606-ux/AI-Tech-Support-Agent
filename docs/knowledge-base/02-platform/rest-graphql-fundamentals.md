---
doc_id: kb_gh_api_fundamentals
title: REST & GraphQL API fundamentals for an agent client
severity: high
sources: [rest-api-versions, rest-rate-limits, rest-troubleshooting, rest-pagination, rest-best-practices, graphql-limits]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: volatile
confidence: medium
---

# REST & GraphQL API fundamentals for an agent client

Facts are tagged `[src:<id>]` (see `00-methodology/source-registry.yaml`).
Numbers in this chapter are **volatile** — model them as configuration,
never as constants in code.

## 1. Versioning

- Send `X-GitHub-Api-Version: <version>` on every REST request.
  [src:rest-api-versions]
- Supported at access time: `2026-03-10` and `2022-11-28`; requests with
  no header default to `2022-11-28`. [src:rest-api-versions]
- A superseded version stays supported ≥ 24 months after the new one
  ships; deprecated versions return `Deprecation` and `Sunset` response
  headers, and after end-of-support requests get `410 Gone`.
  [src:rest-api-versions]
- **Agent rule:** pin the version explicitly in the client; log any
  `Deprecation`/`Sunset` header seen as a KB-freshness event; treat
  `410 Gone` as a *client-configuration* fault (version retired), not a
  repository fault.
- Breaking changes (removed operations, renamed fields, new required
  parameters, changed auth requirements) only ship in a new version;
  additive changes (new operations, optional parameters, new response
  fields) can appear in the current one — so parsers must **ignore
  unknown fields**. [src:rest-api-versions]

## 2. Required request hygiene

- A valid `User-Agent` header is mandatory; requests without one are
  rejected. [src:rest-troubleshooting]
- Requests taking longer than 10 seconds are terminated with a
  "Server Error"; GraphQL requests over 10 s are terminated with `502`
  or `504`. [src:rest-troubleshooting][src:graphql-limits]
  *Implication:* a timeout is not proof the operation failed — for
  writes, re-read state before retrying (see `08-agent/`).
- Path parameters must be URL-encoded (a `/` in a branch name becomes
  `%2F`). [src:rest-troubleshooting]
- Follow `301` by updating the stored URL (e.g. a renamed/transferred
  repository); follow `302`/`307` without changing stored URLs.
  [src:rest-best-practices]

## 3. Rate limits

### 3.1 Primary limits (per hour) [src:rest-rate-limits]

| Identity | Limit |
|---|---|
| Unauthenticated | 60 |
| Personal access token (user) | 5,000 |
| GitHub App installation token | 5,000 minimum; +50/hr per repository beyond 20 repos (non-GHEC), capped at 12,500 |
| GitHub App installation on GHEC org | 15,000 |
| `GITHUB_TOKEN` in Actions | 1,000 per repository (15,000 on GHEC) |
| OAuth app, client credentials | 5,000 (15,000 if owned by a GHEC org) |

GraphQL uses a *points* budget instead: 5,000/hr for users and App
installations (10,000 on GHEC), 1,000 per repository for Actions.
[src:graphql-limits] Point cost: sum the requests needed for each
unique connection assuming maximum page sizes, divide by 100, round;
minimum 1. A call may request at most 500,000 nodes, and every
connection needs `first`/`last` in 1–100. [src:graphql-limits]

Response headers on every REST call: `x-ratelimit-limit`,
`x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` (UTC
epoch seconds), `x-ratelimit-resource`. [src:rest-rate-limits] Prefer
reading these off normal responses; `GET /rate_limit` does not count
against the primary limit but can count against the secondary one.
[src:rest-rate-limits]

### 3.2 Secondary limits [src:rest-rate-limits]

- ≤ 100 concurrent requests (shared REST + GraphQL)
- ≤ 900 points/min REST, ≤ 2,000 points/min GraphQL; `GET`/`HEAD`/
  `OPTIONS` ≈ 1 point, `POST`/`PATCH`/`PUT`/`DELETE` ≈ 5 points ("most"
  endpoints — some differ)
- ≤ 90 s CPU per 60 s real time (≤ 60 s of it GraphQL)
- ≤ 80 content-generating requests/min and ≤ 500/hr
- ≤ 2,000 OAuth access-token requests/hr for Apps/OAuth apps

### 3.3 What "limited" looks like, and the discriminating evidence

Both primary and secondary limits return **`403` or `429`**.
[src:rest-rate-limits] That means a `403` is *ambiguous* between a rate
limit and a permission failure, and an agent that waits on every `403`
would sit idle on what is actually a permission error. The discriminator:

| Signal on the response | Meaning |
|---|---|
| `retry-after` header present | Rate limited (secondary); wait that many seconds |
| `x-ratelimit-remaining: 0` | Primary limit exhausted; wait until `x-ratelimit-reset` |
| Body message says a secondary rate limit was exceeded | Secondary limit; no `retry-after` ⇒ wait ≥ 1 min, then exponentially longer |
| `429` | Rate limited |
| Body: "Resource not accessible by integration" / "…by personal access token", `X-Accepted-GitHub-Permissions` present | **Permission** failure — do not wait, diagnose (see `06-errors/`) |
| Plain `403`, none of the above | Treat as permission/policy; diagnose, do not blind-retry |

Continuing to hammer while limited can get the integration banned.
[src:rest-rate-limits]

### 3.4 Reference implementation (tested)

```python
import time

def next_wait_seconds(status, headers, body_message, attempt, now=None):
    """Seconds to wait before retrying, or None if this is NOT a rate-limit response.
    A bare 403 is ambiguous, so a 403 only counts as rate limiting if a
    rate-limit signal is present."""
    h = {k.lower(): v for k, v in headers.items()}
    now = time.time() if now is None else now
    msg = (body_message or "").lower()

    if status not in (403, 429):
        return None
    if "retry-after" in h:
        return float(h["retry-after"])
    if h.get("x-ratelimit-remaining") == "0" and "x-ratelimit-reset" in h:
        return max(0.0, float(h["x-ratelimit-reset"]) - now)
    if status == 429 or "rate limit" in msg:
        return 60.0 * (2 ** attempt)          # >= 1 minute, exponentially increasing
    return None                                # plain 403: diagnose, don't wait
```

This encodes the retry order in [src:rest-rate-limits] and was run
against these cases when this article was written: no-signal `200` →
`None`; `Retry-After: 30` → 30; remaining `0` + reset in 60 s → 60;
bare `429` → 60, then 240 on attempt 2; secondary-limit message on `403`
→ exponential; **"Resource not accessible by integration" `403` →
`None`**. Add jitter in production (a *Design* addition — the docs
specify exponential waits, not jitter).

## 4. Client discipline (all from GitHub's best practices [src:rest-best-practices])

1. Prefer webhooks over polling; if polling, fixed schedule and
   conditional requests.
2. **Serialize requests**; queue instead of fanning out (concurrency is a
   secondary-limit input).
3. **Wait ≥ 1 second between mutating requests.**
4. Send `If-None-Match` with the stored `ETag`; a `304` does **not**
   count against the primary limit when authenticated.
5. Don't re-request a resource that keeps returning `404` before
   checking authn/authz.

## 5. Pagination [src:rest-pagination]

- `per_page` max is 100 for most endpoints. *Default value not
  confirmed in fetched material: **UNVERIFIED** — always pass
  `per_page` explicitly.*
- Follow the `link` response header (`rel="next"|"prev"|"first"|"last"`);
  only a subset appears depending on position. **Never construct page
  URLs by arithmetic** — parameters differ by endpoint (`page`,
  `before`/`after`, `since`).
- Missing-results checklist: pagination implemented? token can see all
  the resources (fine-grained/App tokens limited to selected
  repositories silently *narrow* results)? [src:rest-troubleshooting]
- Some list endpoints cap total results (workflow runs list returns up
  to 1,000). [src:rest-workflow-runs] The agent must not conclude
  "no such run" from an empty page without considering caps and filters.

## 6. Error handling basics

| Status | Meaning here | Agent behavior |
|---|---|---|
| `301` | Resource moved | Update URL, retry once |
| `304` | ETag hit | Use cached body |
| `401` | *UNVERIFIED semantics* (not confirmed this pass) | Refresh token once; if it persists, stop and report |
| `403` | Permission, policy, or rate limit — disambiguate (§3.3) | Discriminate before acting |
| `404` | May mean "exists but you may not see it" [src:rest-troubleshooting] | Check token access before concluding absence |
| `409` | Conflict (e.g. stale `sha`, concurrent contents writes) | Re-read, rebuild request |
| `410` | API version retired | Fix client version |
| `422` | Validation failed; body has `errors[].code` in `missing`, `missing_field`, `invalid`, `already_exists`, `unprocessable`, `custom` [src:rest-troubleshooting] | Fix the request; also raised when the endpoint is "spammed" [src:rest-pulls] |
| `5xx` | Transient/infra, or 10 s termination | Check githubstatus.com [src:rest-troubleshooting]; retry idempotent calls only |

Full per-error articles: `06-errors/`.

## 7. Tests an implementation should have

- Unit: header parsing for `link`, `x-ratelimit-*`, `X-Accepted-GitHub-Permissions`; wait-decision function (§3.4).
- Contract: run the tool registry against a sandbox org with each supported `X-GitHub-Api-Version`.
- Chaos: inject `429`, `403`+`retry-after`, `5xx`, timeouts; assert no duplicate writes.
