---
doc_id: kb_gh_playbook_api_403
title: "Playbook: GitHub API returns 403 (permission vs. rate limit vs. policy)"
severity: high
symptoms:
  - "A tool call returns 403"
  - "Error message 'Resource not accessible by integration' or '…by personal access token'"
  - "An operation that worked before now fails"
causes:
  - "Installation/App lacks a required permission"
  - "Token was narrowed (permissions/repositories) and excludes this operation"
  - "Rate limit (primary or secondary) — also returned as 403"
  - "Organization policy or branch protection blocks the operation"
diagnostic_checks:
  - "Look for rate-limit signals first (retry-after, x-ratelimit-remaining == 0, secondary-limit message)"
  - "Read X-Accepted-GitHub-Permissions"
  - "Compare required permissions with installation's granted permissions and the token's requested permissions"
evidence_patterns:
  - "403 + retry-after"
  - "403 + x-ratelimit-remaining: 0"
  - "403 + 'Resource not accessible by integration' + X-Accepted-GitHub-Permissions"
recommended_actions:
  - github.get_repository
  - github.get_installation
prerequisites:
  - "Ability to read the installation's granted permissions (GET /app/installations/{id} with the JWT)"
contraindications:
  - "Never retry a permission 403 in a loop"
  - "Never grant the App broader permissions automatically — that is an owner decision"
verification_predicates:
  - "The same call succeeds under the corrected identity/permissions"
escalation_conditions:
  - "Installation owner must grant a permission"
  - "Organization policy (SSO/IP allow list) blocks access (details UNVERIFIED)"
sources: [rest-troubleshooting, rest-rate-limits, rest-best-practices, app-installation-auth, rest-permissions-apps]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: versioned
confidence: medium
---

# Playbook: API returns 403

## Problem

A 403 is the most misdiagnosed GitHub response, because three unrelated
causes share it: permission, rate limit, and policy. Waiting on a
permission error or "fixing permissions" on a rate limit both waste the
investigation. The first job is to discriminate.

## Diagnostic procedure

1. **Capture the full response**: status, body message, and the headers
   `retry-after`, `x-ratelimit-remaining`, `x-ratelimit-reset`,
   `x-ratelimit-resource`, `X-Accepted-GitHub-Permissions`.
   [src:rest-rate-limits][src:rest-troubleshooting]
2. **Rate limit?** Yes if `retry-after` is present, or
   `x-ratelimit-remaining` is `0`, or the body says a secondary rate
   limit was exceeded. → wait per headers, reduce concurrency/burst,
   resume. (Reference function: `02-platform/rest-graphql-fundamentals.md` §3.4.)
3. **Permission?** Yes if the message is "Resource not accessible by
   integration" (App token) or "…by personal access token".
   - Read `X-Accepted-GitHub-Permissions`. Comma-separated entries are
     *all required*; groups separated by `;` are alternatives (any one
     group suffices), e.g. `pull_requests=read,contents=read;
     issues=read,contents=read`. [src:rest-troubleshooting]
   - Fetch the installation's granted permissions and the token's
     requested permissions; find the gap.
4. **Token narrowing?** If the App has the permission but the call still
   fails, check whether the installation token was minted with a
   `permissions` body or `repositories` list that excluded it
   [src:app-installation-auth].
5. **Repository selection?** Endpoints for a repo outside the
   installation's selected repositories return `404`, not `403`
   [src:rest-troubleshooting] — if you see 404 instead, use the 404
   branch in `06-errors/errors.yaml` (`rest.404.private_or_missing`).
6. **Policy?** If permissions are sufficient: check branch protection /
   required checks / org policy for the specific operation. *SSO/SAML
   enforcement error strings and IP allow-list behavior are
   **UNVERIFIED** here.*

## Decision tree

```text
403 received
├─ retry-after present OR remaining==0 OR "secondary rate limit" in body ──► RATE LIMIT ─► wait, throttle, resume
├─ "Resource not accessible by …" ──► PERMISSION
│     ├─ header shows missing permission P
│     │     ├─ App has P but token was narrowed ──► re-mint with P (agent may do this: within granted set)
│     │     └─ App lacks P ──► owner must grant P  (ESCALATE: ask owner; or deliver patch / user does step)
│     └─ header absent ──► compare tool registry's required permission with granted; still missing? same as above
└─ none of the above ──► POLICY/OTHER ─► read operation-specific state (protection, checks); if unclear, escalate with evidence
```

## Resolution

| Cause | Resolution | Who acts | Approval |
|---|---|---|---|
| Rate limit | Wait & throttle | Agent | none |
| Token narrowed | Mint a new token with the required permission *already granted to the App* | Agent | none (within existing grants) |
| App lacks permission | Ask the installation owner to update the App's permissions | Human | n/a — agent only *requests* |
| Policy block | Explain; never bypass | Human | n/a |

## Verification

The same call now succeeds under the intended identity, with
`x-ratelimit-remaining` healthy. For "permission granted" outcomes,
re-read the installation's permissions rather than trusting the user's
statement that they changed it.

## Rollback

Nothing is changed by the diagnosis. If a temporary token with broader
permissions was minted, let it expire (1 hour [src:app-installation-auth])
and don't cache it beyond the task.

## Prevention

Request only the permissions each tool needs at token-mint time; keep
the permission matrix generated from OpenAPI; alert on new
`Resource not accessible…` clusters (they mean the registry's
permission data is wrong or the customer changed grants); record every
observed `X-Accepted-GitHub-Permissions` value to correct the matrix.

## Common mistakes

- Treating every 403 as a rate limit (or every 403 as a permission).
- Escalating a token-narrowing bug to the customer as "please grant a
  permission" when the App already has it.
- Retrying a permission failure with a *more privileged* identity
  without policy approval.

## Related

`rest.403.resource_not_accessible.integration`,
`rest.403.resource_not_accessible.pat`, `rest.rate_limit.primary`,
`rest.rate_limit.secondary`, `rest.404.private_or_missing`.
