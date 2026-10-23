# NexaDesk (buggy-cloud/)

**NexaDesk** is a small, realistic SaaS app — a workspace and customer-operations product with an
overview dashboard, projects (search and status filter), reports, notifications, account, settings
and help — that deliberately contains **reproducible faults** for Operon to diagnose. It is the demo
target for both Operon interfaces: the SDK support widget built into the app, and the Chrome
extension. Plain JavaScript modules, no build step. (The directory, the `buggycloud_*` storage keys
and `?bug=N` keep their original names because tests and integrations depend on them.)

```bash
npm start            # http://127.0.0.1:4300  (reports API on :4301), no Operon widget
npm test             # unit tests for the app's own logic
# with the Operon widget and backend: node ../scripts/dev-local.mjs (see docs/HACKATHON_DEMO_GUIDE.md)
```

| URL | |
|---|---|
| `/` | NexaDesk (`#/`, `#/projects`, `#/reports`, `#/notifications`, `#/account`, `#/settings`, `#/help`) |
| `/?bug=N` | open NexaDesk with scenario N; `&reset=1` plants it from a clean slate |
| `/demo` | **demo console** for presenters: every scenario, its real status, activate / reset links |
| `/operon-config.json` | local testing only: the widget's backend URL and token (204 when not configured) |

## Scenarios

Each is deterministic and defined with its ground truth in `src/bugs.js` (presenter notes in
`SCENARIO_NOTES`):

| `?bug=` | Fault (what the app really does) | Correct Operon outcome | Verified by |
|---|---|---|---|
| 1 | corrupted `buggycloud_settings` JSON in localStorage | `storage_corruption` → `clear_storage_key` | key gone / parses; error not logged again |
| 2 | saved timezone `Mars/Phobos` → `Intl` throws `RangeError` | `invalid_preference` → `reset_user_preference` (timezone) | dates format; error gone |
| 3 | saved currency `US` → `Intl` throws `RangeError` | `invalid_preference` → `reset_user_preference` (currency) | prices format; error gone |
| 4 | `/api/projects` answers 500 | `network_error`, no action → escalation ticket | — |
| 5 | `/api/me` answers 401 | `auth_failure`, no action → escalation ticket | — |
| 6 | reports API on another origin sends no CORS header | `network_error`, no action → escalation ticket | — |
| 7 | a service worker stays registered and the lazy chunk fails | `service_worker_stale` → `unregister_service_worker` | no worker; chunk error gone |
| 8 | corrupted `buggycloud_saved_search` JSON disables project search | `storage_corruption` → `clear_storage_key` | key gone; search works |

**Lifecycle.** A client-side fault is planted once per browser profile, so a fix stays fixed after a
reload. Opening a *different* scenario first clears the previous one's planted state (no
cross-scenario contamination). `&reset=1` (the console's **Activate / Re-activate**) plants it again.
The footer and the demo console report the **real** status — active, fixed, not active — read from
the app's own state (`src/scenarios.js`), never from a label.

**The Operon widget** (`src/operon-panel.js`) is a support panel built on `sdk/operon-sdk.js`: issue
input with suggestions, progress from the backend's real stage events, a plain-language proposal
(what changes, why, what will be checked), approve / reject, escalation with the real ticket
reference, answers to Operon's questions, retry on errors, and recovery of a pending investigation
after a page reload (only the session id is kept, in `sessionStorage`).

Layout: `src/bugs.js` (scenarios + ground truth), `src/activate.js` (planting, switching, reset),
`src/scenarios.js` (real status, widget outcome log), `src/prefs.js` (Intl formatting + the app's own
reset handler), `src/api.js`, `src/mock-data.js`, `src/ui.js` (the seven screens),
`src/main.js` (wiring + SDK registration), `src/operon-panel.js` (the widget), `src/demo.js` (the
console), `src/nexadesk.css` (design tokens + components), `server.mjs` (static files, mock API,
second origin).

## Proof

`cd extension`, then: `npm run e2e:journey` (the demo journey through the widget and the extension),
`npm run e2e:buggy` (every scenario through the built extension), `npm run e2e:sdk` (every scenario
through the SDK), `npm run e2e:screens` (every screen under every scenario, interactions, lifecycle).
