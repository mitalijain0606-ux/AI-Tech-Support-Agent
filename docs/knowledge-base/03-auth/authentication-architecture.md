---
doc_id: kb_gh_authentication
title: GitHub authentication architecture for an agent
severity: critical
sources: [app-installation-auth, app-jwt, app-user-token-refresh, apps-vs-oauth, rest-rate-limits, actions-github-token, rest-troubleshooting]
last_verified: 2026-09-20
api_version: "2022-11-28"
stability: versioned
confidence: medium
---

# GitHub authentication architecture for an agent

The single most common way a GitHub agent goes wrong is acting under
the wrong identity, or assuming a token is still valid. This chapter
pins down the identities, how each token is obtained and expires, and
the rules the agent must never violate. Facts tagged `[src:<id>]`.

## 1. Five things that must never be confused

| Concept | What it is | Example question it answers |
|---|---|---|
| **App identity** | The GitHub App itself, authenticated with a short-lived **JWT** signed by the App's private key | "Which installations does this app have?" |
| **Installation identity** | The App acting *within one installation* (one org/user account), using an **installation access token** | "Read this repo's workflow runs" |
| **User identity** | The App/OAuth app acting *as a specific person*, using a **user access token** | "Comment as Alice" |
| **Repository access** | The set of repos an installation (or token) can reach — chosen at install time and further narrowable per token | "Can I see `acme/private-repo`?" |
| **Organization access** | Org-level scope (org resources, org policies) — separate from repository access | "Can I list org members?" |

**Rule 1:** every tool call declares which identity it runs under and
the audit record stores it. **Rule 2:** the agent never "upgrades" its
identity implicitly — an installation-token `403` is never retried with a
user token unless a policy explicitly allows that identity for that
action. **Rule 3:** the identity of the *requester* (the human asking
for help) is not the identity of the *actor* (the App). Authorization
decisions must check both: the requester may be allowed to ask, but the
App may lack permission to act, and vice-versa.

## 2. Why a GitHub App (and not an OAuth app or a PAT)

GitHub's own comparison [src:apps-vs-oauth]:

- **Permissions:** Apps use fine-grained permissions; OAuth apps use
  broad scopes. An App can request read-only repository contents and
  cannot do more privileged things.
- **Token lifetime:** App tokens are short-lived; OAuth tokens persist
  until revoked.
- **Repository selection:** whoever installs the App chooses which
  repositories it can access; OAuth apps reach everything the
  authorizing user can.
- **Rate limits:** App limits scale with installation size; OAuth apps'
  do not [src:rest-rate-limits].
- **Webhooks:** built in and centralised for Apps.
- GitHub's stated recommendation: **Apps are preferred over OAuth apps.**

*Design decision:* the agent is a GitHub App. PATs are for local
development and one-off scripts only, never for the production agent.

## 3. Token lifecycle

### 3.1 App JWT [src:app-jwt]

- Signed with **RS256** using the App's private key.
- Claims: `iat` (recommended 60 s in the past to absorb clock drift),
  `exp` (no more than 10 minutes ahead), `iss` (the App's **client ID**
  recommended; app ID also accepted).
- Sent as `Authorization: Bearer <JWT>` (a JWT must use `Bearer`).
- Used only to (a) list installations and (b) mint installation tokens.

Tested reference (checked against the claim rules above with
`PyJWT` + `cryptography`; header `alg: RS256`, `exp − iat ≤ 10 min`):

```python
import time, jwt   # PyJWT

def app_jwt(client_id: str, private_key_pem: bytes, now: int | None = None) -> str:
    now = int(time.time()) if now is None else now
    claims = {"iat": now - 60, "exp": now + 9 * 60, "iss": client_id}
    return jwt.encode(claims, private_key_pem, algorithm="RS256")
```

Nine minutes (not ten) leaves headroom under the 10-minute maximum
[src:app-jwt] once the 60 s backdating is counted — a *Design* margin.

### 3.2 Installation access token [src:app-installation-auth]

```http
POST /app/installations/{installation_id}/access_tokens
Authorization: Bearer <JWT>
X-GitHub-Api-Version: 2022-11-28

{ "repositories": ["backend"], "permissions": { "contents": "read", "actions": "read" } }
```

- **Expires after 1 hour.** Cache it and renew *before* expiry; a
  long-running investigation must plan for mid-task expiry
  (see §6).
- Scope narrowing: `repositories` / `repository_ids` (max 500) and
  `permissions` restrict the token. **If `permissions` is omitted the
  token inherits all of the App's permissions** — so the agent should
  always request the minimum for the current task (*Design* rule;
  the inheritance behavior is documented).
- Use as `Authorization: Bearer <token>` for REST and GraphQL.
- Finding the installation id: `GET /repos/{owner}/{repo}/installation`,
  `GET /orgs/{org}/installation`, `GET /users/{username}/installation`,
  `GET /app/installations` (JWT-authenticated).

### 3.3 User access token (act-as-user) [src:app-user-token-refresh]

- With expiration enabled (opt-in/out under the App's optional
  features): access token expires after **8 hours**, refresh token after
  **6 months**.
- Refresh: `POST https://github.com/login/oauth/access_token` with
  `client_id`, `client_secret` (unless device flow), `grant_type=refresh_token`,
  `refresh_token`.
- **Refresh tokens are single-use.** After a refresh, the old refresh
  token *and* the old access token stop working. ⇒ Refresh must be
  serialized per user (a lock), and the new pair must be persisted
  *atomically before* being used; two concurrent refreshes will lose
  the loser's credentials.
- Expired refresh token: recover by sending the user back through the
  web or device flow (no dedicated error string was confirmed —
  **UNVERIFIED**).
- Any endpoint of the OAuth-token family is subject to a secondary limit
  of 2,000 token requests/hr [src:rest-rate-limits].

### 3.4 `GITHUB_TOKEN` in Actions [src:actions-github-token]

- Maximum lifetime: up to 6 hours on GitHub-hosted runners (max job
  time); on self-hosted runners the job limit is 5 days but the token
  can be refreshed only up to 24 hours.
- Rate limit: 1,000 requests/hr per repository (15,000 on GHEC)
  [src:rest-rate-limits].
- **Events caused by `GITHUB_TOKEN` do not create new workflow runs**,
  except `workflow_dispatch` and `repository_dispatch`, which always do;
  `pull_request` `opened`/`synchronize`/`reopened` create runs in an
  approval-required state. This is the well-known reason "the PR the
  workflow created never ran CI" — see `05-actions/`.
- Default permission mode (permissive vs restricted) and the full
  `permissions:` scope list: **UNVERIFIED this release** — read the
  effective permissions from the workflow/repo settings rather than
  assuming.

## 4. Comparison table

| Method | Identity | Lifetime | Repo scoping | Status in this KB |
|---|---|---|---|---|
| GitHub App JWT | App | ≤ 10 min [src:app-jwt] | n/a | verified |
| Installation access token | Installation | 1 h [src:app-installation-auth] | per-install + per-token narrowing | verified |
| User access token (App) | User | 8 h (expiring) [src:app-user-token-refresh] | user ∩ install | verified |
| Refresh token | User | 6 months, single-use [src:app-user-token-refresh] | — | verified |
| `GITHUB_TOKEN` | Actions installation | ≤ 6 h hosted [src:actions-github-token] | the workflow's repo | lifetime verified; scopes UNVERIFIED |
| OAuth app token | User | until revoked [src:apps-vs-oauth] | everything the user can reach | verified (comparison only) |
| Classic PAT | User | — | scopes (`repo`, `workflow`, …) | **UNVERIFIED** (only the `repo`/`workflow` scope need for Contents API was confirmed [src:rest-contents]) |
| Fine-grained PAT | User | — | per-repo, per-permission | **UNVERIFIED** |
| Deploy key | Repository | — | one repo (SSH) | **UNVERIFIED** |
| SSH key / HTTPS credential | User | — | git transport | **UNVERIFIED** |

## 5. Storage and handling rules (Design)

1. **Private key**: KMS/secret manager only; the signing operation
   happens in a small dedicated component; the key never enters an LLM
   prompt, log line, error report, or vector store.
2. **Installation tokens**: memory/short-TTL cache keyed by
   `(tenant, installation_id, permission_set)`; never persisted in
   plaintext to the primary DB; never sent to the model.
3. **Client secret / webhook secret**: secret manager; rotate on
   suspected exposure.
4. **Token leakage scenarios to design against**: token in a URL
   (proxy/server logs), token in a cloned-remote URL
   (`https://x-access-token:TOKEN@…`) persisted in `.git/config`,
   token echoed in CI logs, token in an error message returned to the
   model, token in a "diagnostic" comment posted to an issue.
5. **Scrub outputs before model context.** Any tool result that could
   contain an `Authorization` header or a token-shaped string is
   passed through the same credential tripwire pattern already used in
   this repository (`backend/operon_backend/tripwire.py`) *before* it
   reaches the LLM or storage.

## 6. Diagnosing authentication problems (discriminating evidence)

| Observation | Most likely cause | How to confirm | Notes |
|---|---|---|---|
| `404` on a repo you know exists | Token can't see it (repo not in installation, or token narrowed) | `GET /installation/repositories` with the installation token; compare | GitHub returns 404 rather than 403 to avoid confirming existence [src:rest-troubleshooting] |
| `403` "Resource not accessible by integration" | App/installation lacks a required permission | Read `X-Accepted-GitHub-Permissions` on the response | Header uses `,` for "all of" and `;` for "any of" alternatives [src:rest-troubleshooting] |
| `403` "Resource not accessible by personal access token" | PAT lacks a permission | Same header | Same |
| Requests fail ~1 h after start | Installation token expired | Compare token-mint time to now | Renew and **re-check state before resuming the write** |
| Refresh call fails after a crash/restart | Single-use refresh token already consumed | Check whether a new pair was persisted | Recover via web/device flow |
| Long JWT rejected | `exp` > 10 min ahead or clock skew | Decode claims; compare to server time | Backdate `iat` 60 s [src:app-jwt] |
| Works locally, fails in Actions | `GITHUB_TOKEN` scopes narrower than PAT | Print effective `permissions:` | Don't print the token |

## 7. Permission-aware planning hook

Before proposing any action the planner resolves: *required permission
(from the tool registry) ⊆ installation's granted permissions?* If not,
the action is downgraded to "ask user to grant X" or "propose a patch"
(see `08-agent/agent-safety-and-execution.md`). The model is never the
source of truth for permissions.
