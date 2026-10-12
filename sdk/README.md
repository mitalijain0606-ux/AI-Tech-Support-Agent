# Operon SDK

For a web app **you control**. It lets the app use the same Operon backend pipeline as the browser
extension — evidence → classify → investigate → diagnose → plan → policy → approval → execution →
verification — without a second set of rules. Version `0.2.0`. **Not published to npm**; you copy the
files or use the built script (see "Installation").

## What it does and does not do

| Does | Does not |
|---|---|
| Collects a small, **redacted** set of evidence you opt into (console errors, failed requests, the *shape* of storage keys you list, page path/title, service-worker scopes) | Read cookies, passwords, headers, storage *values*, arbitrary page text, or anything you did not list |
| Talks to **your** Operon backend with a bearer token | Hold an AI key or any server secret. The model runs on the backend only |
| Shows the backend's proposed fix and records the person's **approve / reject** on the backend | Run anything the backend did not propose for this session, or that was not approved |
| Runs one action from a **closed list**, validates its parameters, and reports the outcome | Run model-written code, shell commands or arbitrary JavaScript |
| Sends an *observation* after the fix; the **backend** decides passed / failed / inconclusive | Decide "it worked" itself |

## Installation

Two forms of the same code:

```html
<!-- ES module (primary; no build step). redact.js must sit next to it. -->
<script type="module">
  import { init } from "/sdk/operon-sdk.js";
</script>

<!-- Classic script (after `cd sdk && node scripts/build.mjs`): defines window.Operon -->
<script src="/sdk/dist/operon-sdk.iife.min.js"></script>
<script>const operon = Operon.init({ /* … */ });</script>
```

`node scripts/build.mjs` writes `dist/operon-sdk.iife.js` and `dist/operon-sdk.iife.min.js` (esbuild is taken
from `sdk/` if installed, otherwise from `extension/node_modules`, so run `npm ci` in `extension/` first).
`dist/` is a build product and is git-ignored. TypeScript users get `operon-sdk.d.ts`.

## Quick start

```js
import { init } from "/sdk/operon-sdk.js";

const operon = init({
  backendUrl: "https://operon.example.com",       // https required (http only for localhost)
  getToken: () => fetch("/my-backend/operon-token").then((r) => r.text()),   // see "Authentication"
  appId: "my-app",
  storageKeys: ["my_settings"],                    // keys the SDK may inspect (shape only) and clear
  capture: { console: true, network: true },       // opt-in evidence capture
  actions: {
    reset_user_preference: ({ preference }) => myApp.resetPreference(preference),   // YOUR code
  },
  builtinActions: ["clear_storage_key", "unregister_service_worker"],   // optional, SDK-implemented
  reobserve: () => myApp.render(),                 // re-run the failing path so a fix can be verified
});

operon.on("progress", ({ stage, status }) => showProgress(stage, status));

const result = await operon.diagnose("Prices are missing");
if (result.state === "proposal") {
  // show result.proposal.diagnosis, .action_id, .parameters, .expected_effect to the person …
  const outcome = await operon.decide(true);       // or decide(false) to reject
  // outcome.state === "resolved" only when the BACKEND's verification passed
}
operon.dispose();                                   // restores console/fetch, aborts requests
```

Start the SDK **before** your app's first render so errors from page load are already captured. A complete
integration is [`buggy-cloud/src/operon-panel.js`](../buggy-cloud/src/operon-panel.js).

## Configuration

| Option | Meaning |
|---|---|
| `backendUrl` (required) | `https://…` (plain `http` only for `localhost`/`127.0.0.1`). No credentials, query or fragment |
| `token` **or** `getToken` (exactly one) | Bearer token. `getToken()` is called for every request, so short-lived tokens work |
| `appId` | Names this client. `init` again with the same `appId` disposes the previous client first |
| `storageKeys` | ≤ 25 `localStorage` keys. Only these are ever inspected or cleared. Values are never sent |
| `capture.console`, `capture.network` | Opt-in, bounded, redacted. Network capture records **failed** requests only, without query strings, and never Operon's own traffic |
| `actions` | App-implemented fixes from the closed list `SUPPORTED_ACTIONS` (`reset_user_preference`) |
| `builtinActions` | `clear_storage_key` (only listed keys), `unregister_service_worker` (own origin) |
| `reobserve` | Re-runs the failing code path after a fix. **Required** to verify a fix that cites console/network evidence; without it the SDK reports `reobserve_unavailable` and the backend answers *inconclusive* — never "passed" |
| `timeoutMs`, `investigateTimeoutMs`, `maxEvidenceBytes`, `maxCycles`, `maxObserveMs`, `evidenceWaitMs`, `fetch` | Limits (clamped) and an injectable `fetch` |

## API

`init(config)` → client, or throws `OperonError`.

| Member | Behaviour |
|---|---|
| `diagnose(issue, {signal})` | Creates a session, collects the evidence the backend asks for, investigates (≤ `maxCycles`). Resolves `{state, session, proposal, question}`; `state` ∈ `proposal` · `needs_answer` · `needs_evidence` · `escalated` · `resolved` · `declined` · `in_progress` |
| `answer(text)` / `continue()` | Answer the backend's free-text question (redacted first), then continue |
| `decide(true \| false)` | Policy check → approval (bound to the proposal id) → the one approved action → result → verification. `false` records the rejection and **runs nothing**. Resolves `{executed, reason, verification, …}` |
| `on("state" \| "progress" \| "activity", fn)` | Listeners; returns an unsubscribe function. A throwing listener cannot break the SDK |
| `dispose()` | Idempotent. Aborts in-flight requests, restores `console`/`fetch`, drops listeners |
| `registerOperon({appId, actions})` | The *extension carrier*: declares your closed-list actions for the Operon browser extension instead of talking to the backend yourself |

One operation at a time per client: an overlapping call fails with `busy` rather than duplicating work.
Requests are **never retried automatically** (a repeated POST could repeat a fix).

### Errors

Every failure is an `OperonError` with a stable `code` (and `status` / `retryAfterSeconds` when relevant);
messages never contain tokens, request bodies or response bodies.

`config_invalid` · `unsupported_environment` · `network_error` (down, or blocked by CORS) · `timeout` ·
`aborted` · `unauthorized` (401, or no token available) · `forbidden` (403) · `not_found` (404) ·
`conflict` (409: stale or replayed approval) · `rate_limited` (429) · `request_rejected` (other 4xx) ·
`server_error` (5xx) · `malformed_response` · `invalid_state` · `unsupported_action` · `payload_too_large` ·
`busy` · `disposed`.

## Authentication architecture

The page must not hold a long-lived key. The intended shape:

1. Your **own backend** authenticates the person, and asks the Operon backend (server to server) for a
   short-lived API key for that person/tenant (`scripts/manage_keys.py` is the key tool today; there is no
   key-issuing HTTP API yet).
2. Your page receives that token through `getToken()`.
3. The Operon backend enforces tenant isolation and binds sessions, approvals and execution reports to the
   caller. A session created with one token is a 404 for any other tenant or user.

The local test apps hand the page a ready-made token from `/operon-config.json` — **for local testing only**.
CORS: the Operon backend allows no cross-origin page by default; list your site in `CORS_ALLOW_ORIGINS`.

## Evidence and privacy

* Everything is redacted in the browser before it is sent (`redact.js`, shared with the extension): fixed
  patterns (JWTs, GitHub/cloud/vendor keys, bearer/basic auth, URL credentials, password assignments, private
  keys …), and — for text the page or a person wrote — heuristics for unknown formats ("password is …" values,
  vendor prefixes, long random-looking mixed-case strings). Query strings of failed requests are dropped; JSON
  parse errors are stripped of any quoted text; key-like URL path segments are replaced.
* The backend redacts again and its tripwire rejects payloads that still match a fixed credential pattern.
* **Limits.** This is pattern-based. It cannot find every secret: short or low-entropy secrets
  ("my pin 4829"), secrets split across lines, and unusual encodings can pass; a long mixed-case identifier
  containing a digit may be over-redacted. Do not log secrets and expect the SDK to save you. Treat every string
  the page provides as untrusted: the backend and policy never let page text authorise an action.

## Supported actions

| Action | Who implements | Approval | Parameters |
|---|---|---|---|
| `reset_user_preference` | your app (`actions`) | always | `preference` ∈ `timezone`, `locale`, `currency`, `date_format` |
| `clear_storage_key` | the SDK (`builtinActions`) | always | `key` must be in `storageKeys` |
| `unregister_service_worker` | the SDK (`builtinActions`) | always | `scope` of a registration on your origin |

Not supported in the SDK (declared as unsupported, never faked): `reload` (it would destroy the page state the
SDK is running in) and the `cookies` / `reload_observe` collectors. The extension supports those.

## Local testing

```bash
cd sdk && npm test                     # 65 tests: config, transport, evidence, flow, carrier, built script
cd backend && pytest tests/test_sdk_contract.py     # every SDK request body validated by the backend's models
cd extension && npm run e2e:sdk        # Buggy Cloud + SDK + real backend in Chromium (no extension)
cd extension && npm run e2e:sdk-wire   # recording proxy: fake secrets must not appear in any request body
```

## Known limitations

* Not published to npm and not versioned beyond `VERSION`; no key-issuing API.
* Chromium is the only browser exercised.
* The SDK cannot reload the page, so fixes whose evidence only appears during page load need your `reobserve`.
* Verification is based on what the page reports; a compromised page could report a clean observation.
* Nothing here has been tested against a deployed backend.
