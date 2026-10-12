# SDK vs. browser extension

Operon reaches an app in two ways. They are two **entry points** into one backend pipeline, not two AI
systems: reasoning, policy, approval and verification exist once, in the backend.

| | Browser extension | In-app SDK (`sdk/`) |
|---|---|---|
| Who installs it | the person who has the problem | the app's developers, in a site they control |
| Works on sites you do not control (GitHub) | yes | no |
| Evidence | console, network (via `chrome.debugger`), storage shape, cookie metadata, page, reload-and-observe | what the app opts into: console/network capture, listed storage keys, page; no cookies, no reload |
| Fixes | `clear_storage_key`, `reload`, `unregister_service_worker`, `inspect_page`, plus app actions the page offers | `reset_user_preference` (app code), opt-in `clear_storage_key` and `unregister_service_worker` |
| Talks to the backend | background service worker, token typed into the popup | the page, with a token your own backend hands it |
| User interface | extension popup | whatever the app builds (Buggy Cloud has a panel) |
| Declared as | `source: "extension"` | `source: "sdk"` |

## The shared pipeline

```
evidence collection ─▶ redaction (browser) ─▶ authentication / tenant ─▶ tripwire + scrub (backend)
  ─▶ classify ─▶ investigate ─▶ diagnose ─▶ plan ─▶ policy ─▶ approval (bound to the proposal and the caller)
  ─▶ controlled execution (closed action list) ─▶ report ─▶ verification (decided by the backend)
```

Both clients call the same endpoints: `POST /api/sessions`, `…/investigate`, `…/answer`, `…/policy`,
`…/approve`, `…/action-result`, `…/verify`, and `GET …/events` for progress. A test proves it:
`backend/tests/test_sdk_extension_parity.py` drives an SDK-declared and an extension-declared session through
identical evidence and gets the identical category, plan, policy decision and verification result; the only
differences are the recorded `source` and the declared capabilities. `backend/tests/test_sdk_contract.py` runs
the real SDK and validates every body it sends against the backend's own models.

## Boundaries

* **Browser → backend.** Authentication is a bearer token (an API key bound to a tenant, a subject and a role).
  Another tenant's or another user's session is a 404. Approval names the proposal id; the backend refuses a
  stale, forged, replayed or cross-session approval (409/404). Rate limits apply per key.
* **No secrets in the page.** Neither client holds an AI key. The SDK takes a token from `getToken()`; the
  extension stores the token in `chrome.storage.local`. The model runs on the backend only.
* **Approval is the backend's.** A button state is not a boundary: `/action-result` is accepted only after a
  policy decision and, where required, an approval for that exact proposal. Rejecting records
  `declined_by_user` and the execution endpoints then answer 409.
* **Execution is a closed list.** Backend (`ACTION_POLICIES`, grounding against the session's declared
  capabilities, a parameter allowlist), extension (`APP_ACTIONS`, parameter validation) and SDK
  (`SUPPORTED_ACTIONS`, `BUILTIN_ACTIONS`, per-action validation and the listed storage keys) each enforce it
  independently. A page announcing an extra action changes nothing; an action the session did not declare is
  never proposed.
* **Verification is a verdict only the backend gives.** The client reports an observation; `/verify` rejects any
  field that looks like a verdict. If the client cannot re-observe, the answer is *inconclusive*, never *passed*.
  This is still the client's *report* of the page: a compromised page or client could report a clean state. It is
  not independent server-side verification.
* **Untrusted text.** Page text, console lines, titles, error messages and the typed issue are data. Text that
  addresses an AI is classified `suspicious_content` and never adds an action; the model can only choose from the
  closed list.

## Two ways to use the SDK

1. **Direct (`init`)** — the app is the client (see `sdk/README.md`). Verified end to end in Chromium without the
   extension (`npm run e2e:sdk`).
2. **Extension carrier (`registerOperon`)** — the app only declares which closed-list fixes it can perform, and
   the extension does the talking. The extension discovers them over `window.postMessage` (messages from other
   windows are ignored, the answer is intersected with the closed list, parameters are validated before
   anything is sent). Verified with `npm run e2e:buggy`.

If both are active on one page they are independent sessions; neither can approve for the other.

## Minimal permissions

Extension: `debugger`, `storage`, `cookies`, and host permissions for one target domain plus the backend origin.
SDK: none (it is page JavaScript); its network access is the backend URL you configure, restricted by the
backend's `CORS_ALLOW_ORIGINS`.

## What is and is not verified

Locally verified, end to end, against a real backend process in Chromium: both entry points, approval,
rejection, execution, verification, the failure paths, and request bytes on the wire. **Not** verified:
anything against a deployed backend, a managed database/Redis, other browsers, or real-world third-party sites
beyond the read-only github.com compatibility run. The GitHub API agent (a service that acts on repositories
through GitHub's API) is a separate, unstarted product with a different threat model.
