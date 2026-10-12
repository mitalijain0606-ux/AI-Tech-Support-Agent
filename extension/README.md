# Operon Chrome extension

Manifest V3 extension (TypeScript + React popup, one esbuild per target). It investigates a page the way a
support engineer would — asks the backend what evidence it needs, collects exactly that, shows the diagnosis
and proposed fix, asks you to approve or reject it, runs the one approved action, and lets the **backend**
verify the result. It works on sites you do not control; the site needs no code changes. (For a site you do
control, see [`../sdk/`](../sdk/) and [`../docs/SDK_VS_EXTENSION.md`](../docs/SDK_VS_EXTENSION.md).)

## Build and install (unpacked)

```bash
cd extension
npm ci
OPERON_BACKEND_URL=https://operon.example.com npm run build -- github     # → dist/github/
#   without the variable the build points at http://localhost:8000 (development)
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist/github/`. Open the popup,
paste your access token under **Backend access** (`python backend/scripts/manage_keys.py create …` prints one),
open a github.com page and press **Ask Operon**. Reload the *tab* after reloading the extension (the old content
script is disconnected).

Targets (`targets/*.json`): `github` (https://github.com/*), `e2e-local` (http://127.0.0.1/*, local tests only —
never ship it), `fake-saas` (unset; refuses to build). The build puts exactly one target domain plus the backend
origin into the manifest.

## Permissions and why

| Permission | Used for |
|---|---|
| `debugger` | attach to the tab while collecting console/network evidence and while observing a reload for verification |
| `storage` | `chrome.storage.session` for the in-progress session (survives worker restarts), `chrome.storage.local` for your access token |
| `cookies` | cookie **metadata** (name, domain, flags) when the backend asks; values are never read |
| `host_permissions`: the target site + the backend origin | content script on the target; calls to the backend (so no CORS is needed) |

No `<all_urls>`, no `scripting`, no `activeTab` (removed: unused). A test fails if a permission is added that the
code does not use. Pages that are not http(s) (`chrome://`, the Web Store, other extensions, `file:`) are refused
up front with a clear message.

## How an investigation runs

1. **Ask** → `POST /api/sessions` (the issue text is redacted first; capabilities = the browser baseline, plus any
   closed-list action the page's own SDK offers).
2. The backend answers with an **evidence request**. The extension collects exactly those collectors (console,
   network, storage shape, cookies metadata, page, reload-observe), bounded, then redacts and submits them
   (`/investigate`). Live progress comes from the backend's event stream (`/events`), not from a local timer.
3. The backend classifies, diagnoses (offline rule engine or the configured model, always grounded in cited
   evidence) and either asks for more evidence, asks a short question, escalates, or **proposes a fix**.
4. **Approve / Reject** → `POST …/policy` then `…/approve` (bound to the proposal id and your token). Reject
   guarantees nothing runs. Duplicate clicks are ignored while a step is in flight.
5. The approved action runs (`clear_storage_key`, `reload`, `unregister_service_worker`, `inspect_page`, or the
   page's `reset_user_preference`); the result is reported (`…/action-result`).
6. The extension reports what it **observed** after the action (`…/verify`); the backend decides
   passed / failed / inconclusive. "Resolved" is shown only when the backend says so.

Closing the popup does not lose anything: the state is in `chrome.storage.session` and is re-synchronised with
the backend when the worker restarts (an interrupted step is reported as interrupted, never as a pass).

## Errors and recovery

| What you see | Meaning / what to do |
|---|---|
| "enter an access token" | 401: paste a valid token under *Backend access* |
| "wait Ns" | 429 rate limit |
| "Can't reach the Operon backend" | backend down or `OPERON_BACKEND_URL` wrong for this build |
| "This session no longer exists" | 404: **Reset** and ask again |
| "can't investigate this kind of page" | open a normal http(s) site tab |
| "stale content script" | reload the tab |
| Escalated | no safe action exists; the reason is shown. Nothing was changed |

## Testing

```bash
npm test                 # 112 unit tests (incl. the built dist/ directories) against the real bundled source in a fake browser
npx tsc --noEmit -p .    # type check
npm run e2e              # built extension + real backend + Chromium + local fixtures (63 checks)
npm run e2e:buggy        # second app, seven seeded bugs + control + failure paths (67 checks)
npm run e2e:sdk          # the SDK in Buggy Cloud, no extension (121 checks)
npm run e2e:sdk-wire     # SDK request bytes through a recording proxy (15 checks)
npm run e2e:wire         # recording proxy: fake secrets never leave the browser (11 checks)
npm run e2e:demo         # approve / deny on a real github.com page (needs outbound HTTPS)
npm run e2e:github       # read-only compatibility check on a public github.com page
```

Details: [`e2e/README.md`](e2e/README.md) and [`../docs/TESTING.md`](../docs/TESTING.md).

## Known limitations

* Verification uses what the extension reports; a compromised client could report a clean page.
* Chromium only; the popup is exercised as a tab (Playwright cannot open the toolbar popup).
* `chrome.debugger` shows Chrome's "debugging this browser" bar while collecting — inherent to the API.
* Redaction is pattern-based (see `sdk/README.md`, "Evidence and privacy").
* Only a development build is produced; no signed/packed CRX and no Web Store listing.
