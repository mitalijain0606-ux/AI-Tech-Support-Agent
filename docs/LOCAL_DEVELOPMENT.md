# Running Operon locally

Everything below runs on your machine. Nothing needs a cloud account, a production credential or the internet
(the first backend start downloads the ~90 MB embedding model once; after that it works offline). Deployment is a
separate topic: [`DEPLOYMENT.md`](DEPLOYMENT.md).

## One-time setup

```bash
# 1. Backend dependencies (Python 3.11+). A virtualenv is recommended.
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes -r requirements.txt            # add: -r requirements-dev.txt  to run the tests
cd ..

# 2. Extension / SDK build tools and the browser tests' library
cd extension && npm ci && cd ..
```

For the browser test suites you also need a Chromium that `playwright-core` can find. The simplest way, on macOS or
Linux: `cd extension && npx playwright-core install chromium` (one download, into Playwright's own cache). Or point at
an existing one with `PLAYWRIGHT_BROWSERS_PATH=/path/to/browsers` or `OPERON_E2E_CHROMIUM=/path/to/chromium`. Use
Chromium, not branded Google Chrome: current Chrome builds ignore the `--load-extension` flag the suites rely on
(loading by hand via *Load unpacked* works in either).

## Start the whole project (one command)

```bash
# with the venv activated (or: OPERON_PYTHON=/path/to/python)
node scripts/dev-local.mjs
```

It, in this order: stops a stale Operon process left by a crashed earlier run (only if it is verifiably ours),
checks the ports, prepares a SQLite database in `./.local/` with `alembic upgrade head`, mints two API keys the first
time (a user key and an admin key, stored in `.local/tokens.json`, mode 600), builds the SDK script (`sdk/dist`) and the
extension (`extension/dist/local-demo`), starts the backend, starts Buggy Cloud (with the SDK panel), then verifies
`/health`, `/ready`, that a request without a key gets 401, and that Buggy Cloud and its Operon config answer.
It prints the URLs, your token and the Chrome steps, and runs until Ctrl+C.

| Option | Meaning |
|---|---|
| `--fresh` | delete the local database and keys first (a clean slate) |
| `--check` | start, verify, stop; exit code 0/1 (used for automated checks) |
| `--backend-port N` / `--app-port N` | defaults 8000 and 4300 (Buggy Cloud's reports API uses app-port + 1) |
| `--groq` | use the real model: needs `GROQ_API_KEY` in your environment (never written to disk or printed) |
| `--no-sdk-panel` | serve Buggy Cloud without the SDK panel, to try the extension alone |
| `--no-build` | skip building the SDK script and the extension |

Safe local defaults it sets for the backend: `ENVIRONMENT=development`, **`AUTH_REQUIRED=true`**,
`CORS_ALLOW_ORIGINS=http://127.0.0.1:<app port>` (exactly the demo site), `GROQ_API_KEY` empty (the labelled offline
engine), `DATABASE_URL=sqlite:///…/.local/operon.db`. Other settings are documented in `backend/.env.example`.

### Ports and health checks

| Service | Default | Check |
|---|---|---|
| Backend | `http://localhost:8000` | `curl localhost:8000/health` → `{"status":"ok"}`; `curl -H "Authorization: Bearer <admin token>" localhost:8000/ready` (detail in development: `ready`, KB chunks, embeddings) |
| Buggy Cloud | `http://127.0.0.1:4300` | open it; `curl 127.0.0.1:4300/operon-config.json` |
| Buggy Cloud reports API (the CORS bug) | `127.0.0.1:4301` | — |

Startup order matters only for the first backend start: it indexes the knowledge base (and may download the embedding
model) before `/health` answers, which can take a minute. The script waits for it.

### Manual alternative (the same thing, step by step)

```bash
cd backend
export DATABASE_URL=sqlite:///$PWD/../.local/operon.db AUTH_REQUIRED=true CORS_ALLOW_ORIGINS=http://127.0.0.1:4300
python -m alembic upgrade head
python scripts/manage_keys.py create --tenant local --subject me --role user     # prints the token once
python -m uvicorn operon_backend.main:app --port 8000
# another terminal:
cd buggy-cloud && node -e "import('./server.mjs').then(m=>m.startBuggyCloud({port:4300,operon:{backendUrl:'http://localhost:8000',token:process.env.OPERON_TOKEN}}).then(a=>console.log(a.url)))"
```

## Try it

**Through the SDK, no extension:** open `http://127.0.0.1:4300/?bug=2` → *Diagnose with Operon* → read the proposal →
*Reject* (nothing changes; reload to confirm) → *Diagnose* again → *Approve* → "Fixed and verified by the Operon
backend". Also `http://127.0.0.1:4300/sdk/examples/minimal.html` (the classic-script example).

**Through the extension** (desktop Chrome — a manual step, see below): open `http://127.0.0.1:4300/?bug=2`, open the
Operon popup, paste your token under *Backend access*, press *Ask Operon*, then Approve or Deny. Run it with
`--no-sdk-panel` to see that the extension needs nothing from the website.

| URL | What is wrong | Correct outcome |
|---|---|---|
| `/?bug=1` | settings JSON corrupted | `clear_storage_key` (approval), verified |
| `/?bug=2` | saved timezone invalid | `reset_user_preference` timezone (approval), verified |
| `/?bug=3` | saved currency invalid | `reset_user_preference` currency (approval), verified |
| `/?bug=4` | projects API answers 500 | diagnosis, **no action**, escalation |
| `/?bug=5` | account API answers 401 | diagnosis, **no action**, escalation |
| `/?bug=6` | reports API blocked by CORS | diagnosis, **no action**, escalation |
| `/?bug=7` | stale service worker | `unregister_service_worker` (approval), verified |
| `/` | nothing | nothing proposed |

Add `&reset=1` (or click *Reset this scenario* in the footer) to put a scenario back to its starting state.

## Check the project you are running

With `node scripts/dev-local.mjs` running in another terminal:

```bash
cd extension && npm run e2e:live
```

drives **your** backend (`:8000`) and **your** Buggy Cloud (`:4300`) in Chromium with your token from
`.local/tokens.json`: all seven scenarios and the healthy control through the SDK panel *and* through the built
`extension/dist/local-demo`, with reject-then-approve, backend verification and an independent check of the page,
plus the classic-script example page. It adds test sessions to your local demo database and changes nothing else.
Exit code 0 = everything passed.

## Stopping

Ctrl+C in the terminal running the script stops the backend and Buggy Cloud. If it was started in the background:
`kill $(node -e "console.log(require('./.local/pids.json').launcher)")` (run from the repository root), which also
stops the backend. Check with `curl localhost:8000/health` (should fail) — or just run the script again: it stops a
leftover process of its own before starting.

## Load the extension in desktop Chrome (manual)

1. Run `node scripts/dev-local.mjs` (it builds `extension/dist/local-demo` pointing at your backend).
2. Chrome → `chrome://extensions` → switch on **Developer mode** → **Load unpacked** → select
   `extension/dist/local-demo` (this repository's folder, not a file).
3. Open `http://127.0.0.1:4300/?bug=2`. Click the Operon icon → *Backend access* → paste the **user** token the script
   printed (also in `.local/tokens.json`) → **Ask Operon**.
4. After you rebuild: click the circular reload icon on the extension's card **and reload the tab**.

For GitHub instead: `OPERON_BACKEND_URL=http://localhost:8000 npm run build -- github` in `extension/`, load
`extension/dist/github`, open a public github.com page and use *Seed demo bug* in the popup.

> **Status:** the built extension is exercised in automated Chromium (below) with the popup opened as a tab. Loading
> it by hand into your desktop Chrome has **not** been done by the author of this document; the steps above are the
> standard unpacked-extension flow.

## Restarting cleanly

* `Ctrl+C` stops both processes. If the launcher is killed hard, the next run stops the orphaned backend itself (it
  records pids in `.local/pids.json` and only stops a process whose command line is still ours).
* A busy port stops the script with a message naming the port; choose others with `--backend-port` / `--app-port`
  (then the extension must be rebuilt: the script does that unless `--no-build`).
* `--fresh` removes `.local/operon.db` and the keys. The tests never use `.local`: every test run starts its own
  backend on a free port with a throwaway database and removes it.
* The extension unit tests build into temporary folders, so they do not overwrite the `dist/` you loaded in Chrome;
  the browser suites (`npm run e2e*`) do rebuild `dist/<target>` — run `dev-local.mjs` again afterwards.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `cannot import the backend's dependencies` | activate the venv or set `OPERON_PYTHON`; `pip install --require-hashes -r backend/requirements.txt` |
| `a build failed` | `cd extension && npm ci` |
| Popup: "enter an access token" | paste the user token under *Backend access* |
| Popup: "Can't reach the Operon backend" | backend not running, or the extension was built for another port |
| SDK panel: `network_error` | the backend's `CORS_ALLOW_ORIGINS` does not include the page's exact origin (`http://127.0.0.1:4300`, not `localhost`) |
| SDK panel: `unauthorized` | the token in `/operon-config.json` is not a valid key for this database: run with `--fresh` |
| `rate_limited` / "wait Ns" | 429: wait; limits are in `backend/.env.example` |
| Retrieval `empty_index` in `/ready` | the embedding model could not be downloaded; check the network and restart |
| Everything fails after pulling code | `python -m alembic upgrade head` (the script does this), then restart |

## Tests

```bash
cd backend && pytest --ignore=tests/live          # backend (needs requirements-dev.txt)
cd sdk && npm test                                  # SDK
cd extension && npm test && npx tsc --noEmit -p .   # extension unit tests + types
cd buggy-cloud && npm test                          # Buggy Cloud
cd extension && npm run e2e && npm run e2e:buggy && npm run e2e:sdk && npm run e2e:wire && npm run e2e:sdk-wire
cd extension && npm run e2e:live                     # against the stack you started with dev-local (see above)
node scripts/dev-local.mjs --check                  # the whole local project starts and answers
cd backend && python eval.py --engine offline       # measured evaluation (deterministic)
```

Real model (optional, needs `GROQ_API_KEY`; the free tier allows ~8,000 tokens/minute, so the suites pace themselves):
`OPERON_E2E_GROQ=1 OPERON_E2E_BUGS=2,4 npm run e2e:sdk` and `… npm run e2e:buggy` (in `extension/`).
Details per suite: [`TESTING.md`](TESTING.md) and [`../extension/e2e/README.md`](../extension/e2e/README.md).
