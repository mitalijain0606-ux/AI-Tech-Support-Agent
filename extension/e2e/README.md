# Browser end-to-end tests

Two suites drive the **actual built extension** in Chromium against the **real
backend process**. Unit tests (`extension/tests`, `backend/tests`) cover the
pieces; these cover the pieces wired together: build-time backend URL,
manifest, service worker, content script, popup, the HTTP contract, and
browser timing.

| Suite | Command | Targets | Network |
|---|---|---|---|
| Deterministic | `npm run e2e` | local fixture pages (`e2e/fixtures`) via the `e2e-local` build | none (localhost only) |
| Live github.com | `npm run e2e:github` | one public github.com page via the real `github` build | outbound HTTPS to github.com |

Both suites start their own backend (`uvicorn`, a throwaway SQLite database,
`GROQ_API_KEY` forced empty so diagnoses come from the labelled offline
engine), build the extension pointed at it, and clean up afterwards. Neither
needs credentials, and neither uses a signed-in browser profile. Nothing is
seeded around the application: the backend's own startup indexes the
knowledge base into the fresh database, exactly as in a real deployment.

## Setup

```bash
cd backend && pip install -r requirements.txt      # the backend the suites start
cd ../extension && npm ci                         # includes playwright-core
```

The suites need a Chromium that `playwright-core` can find. With
`PLAYWRIGHT_BROWSERS_PATH` pointing at an installed Playwright Chromium this
works as is. Otherwise set `OPERON_E2E_CHROMIUM=/path/to/chrome`.

| Variable | Default | Meaning |
|---|---|---|
| `OPERON_E2E_PYTHON` | `python3` | interpreter with the backend's dependencies |
| `OPERON_E2E_CHROMIUM` | Playwright's Chromium | Chromium executable |
| `OPERON_E2E_HEADED` | unset | `1` shows the browser (needs a display, e.g. `xvfb-run`) |
| `OPERON_E2E_GITHUB_URL` | `https://github.com/octocat/Hello-World` | public page for the live suite |

`node e2e/run.mjs <regex>` runs only the scenarios whose names match.

## Deterministic suite (`run.mjs`)

Each scenario opens a fixture page, opens the popup as a tab, and drives the
popup like a user. The one test-only stub pins the extension's "active tab"
to the fixture tab, because the popup is opened as a tab rather than over the
page. Covered:

- backend startup on a fresh database. With the embedding model available,
  the backend indexes the knowledge base itself, and the corrupted-cache
  cycle retrieves its own KB entry. Without the model, startup must log why,
  and retrieval must report `empty_index`/`error`, never `no_match`.
- session creation, evidence request, request-driven collection, investigation,
  retrieval (status recorded honestly), NEED_INFORMATION, plan, policy,
  approval, execution, and server-side verification through to RESOLVED
- false-positive protection: a fix that doesn't stick (verification fails, the
  automatic retry refuses to repeat it, escalation), a reload that doesn't
  help, and a reload that does
- deny: nothing executed
- bounded escalation on repeated insufficient evidence
- stale request: a replayed request id gets 409, and the extension resyncs
  from the backend instead of submitting stale evidence
- credential redaction: a page logs token-shaped strings, which the extension
  redacts before upload. The raw value is absent from the API and the database
  file, a commit SHA survives as context, and the backend tripwire still
  rejects an unredacted payload
- unsupported action / forged verdict sent from the extension's origin: a
  policy for an action that wasn't proposed gets 409, a client `passed` gets
  422, an action result before approval gets 409
- the content script's closed message set, plus a real service worker
  inspected and unregistered
- Reset on an unreachable tab
- service-worker restart (stopped via CDP, as Chrome does to idle workers):
  while awaiting approval (state restored, approval still works), and during
  verification (reported as `interrupted`, never as a pass)
- no unexpected runtime errors from the extension's pages or worker

Fixture pages that log secret-shaped strings assemble them at runtime. No
literal token is stored in the repository, and none of them is a real
credential.

## Live github.com suite (`github-live.mjs`)

Read-only and anonymous: a fresh profile, a page load, the extension's own
collectors (cookie *metadata* only), and **no approvals**. Anything that needs
approval is denied. The policy lets only a page reload run unattended. The
suite checks that the content script loads on github.com, that collected
evidence reaches the backend with provenance, that every diagnosis cites only
collected evidence, that retrieval is recorded honestly, that nothing is
approved or falsely verified, and that the session stays coherent and bounded.
A healthy page should end in NEED_INFORMATION, not an invented fix.

Exit codes: `0` all checks passed, `1` a check failed, `2` **BLOCKED**
(github.com unreachable from this environment; nothing was verified).

## Not covered here

Live Groq: both suites run the offline engine. Live model answers are
covered by `backend/scripts/validate_services.py` and `backend/tests/live/`.
Real embeddings are used here whenever the model can be downloaded.
