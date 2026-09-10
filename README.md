# Operon — GitHub Demo (MVP slice)

This is the first working, end-to-end slice of Operon: a Chrome extension
that attaches to a real, live web tool (GitHub.com), collects sanitized
browser evidence, sends it to a small stateless backend for diagnosis, and —
once a human approves — executes a real fix in the browser and verifies it
worked.

It is deliberately the smallest cut that proves the whole loop for real,
against a real production site, rather than a synthetic demo app. The fuller
system (Postgres, Redis, the full 5-stage pipeline, the SDK, a second demo
app) is designed and scoped, but out of this slice — see
[What's deferred](#whats-deferred) below.

## Why GitHub, and why this isn't "a real GitHub bug"

GitHub was chosen because it's a real product almost everyone already has an
account on, with predictable network/DOM structure, and nothing about this
demo requires GitHub's cooperation or backend access.

GitHub is a mature, well-engineered product — it doesn't have a convenient,
reproducible bug sitting around for a demo to find. So the extension seeds
one itself: it plants a synthetic, clearly-labeled marker value in
`localStorage` on the active GitHub tab, in a shape that mimics a real
cached-config bug (a corrupted JSON blob a real app might leave behind after
a bad deploy). Everything downstream of that is genuine:

- a real `chrome.debugger` attach to a live, real GitHub tab
- real console and network capture from an external site Operon does not
  control
- real cookie metadata (name, domain, expiry — never the value) pulled via
  `chrome.cookies`
- a real call to Groq for diagnosis
- a real policy-engine gate before anything executes
- a real `localStorage.removeItem` + reload against the live tab
- a real re-check of the page afterward to confirm the fix actually worked

The only fabricated part is the bug itself — the same way Operon's own
seeded-bug testbeds (Buggy Cloud / Acme Cloud) fabricate bugs on purpose.
Nothing here silently touches your real GitHub data: the marker key is
namespaced (`operon_demo_cache`) and is not read or used by GitHub itself.

## How the loop works

```text
1. SEED    — popup button writes a corrupted JSON string into
             localStorage['operon_demo_cache'] on the active github.com tab

2. REPORT  — user clicks "Ask Operon for help" in the popup

3. COLLECT — background.js attaches chrome.debugger (Network + Runtime),
             content.js reads the DOM skeleton and storage-key shape,
             chrome.cookies.getAll() reads cookie metadata (never values)
             → assembled into an EvidenceBundle, each item tagged ev_NNN

4. DIAGNOSE — POST /api/diagnose { message, bundle }
              → server-side tripwire scans the raw payload for anything
                credential-shaped (should never fire — see below)
              → Groq returns { category, root_cause, reasoning,
                evidence_ids, confidence, resolvable_automatically,
                proposed_action }
              → backend rejects any evidence_ids not actually present in
                the submitted bundle

5. POLICY  — POST /api/policy { action_id, params, provider_capabilities }
             → deterministic evaluate(): ALLOW / REQUIRE_APPROVAL / DENY
             → clear_storage_key and unregister_service_worker are
               "destructive" class → always REQUIRE_APPROVAL

6. APPROVE — popup shows the diagnosis + cited evidence + proposed action,
             user clicks Approve

7. EXECUTE — background.js runs the approved action directly in the tab
             (e.g. localStorage.removeItem('operon_demo_cache')), reloads

8. VERIFY  — content.js re-checks the page deterministically (no more
             JSON.parse errors, marker key gone) — the LLM does not decide
             whether the fix worked, the extension does
```

## The contracts, as implemented in this slice

This MVP is a thin, faithful implementation of the three contracts from the
full build plan — trimmed to what a single extension-only, third-party-site
demo actually needs.

**Contract 1 — EvidenceBundle.** `backend/app/schemas.py` defines the
Pydantic shape. Every item (console line, network request, cookie, storage
key) carries a stable `ev_NNN` id, and the diagnosis is rejected if it cites
an id that isn't actually in the bundle.

**Contract 1a — the credential rule.** Three layers, same as the full plan:
1. *Collector allowlist* — `content.js` only ever reports a storage key's
   *presence* and *parse success*, never its value; `chrome.cookies` metadata
   never includes the cookie value.
2. *Local sanitization* — evidence is redacted client-side before it's sent
   (see `background.js`).
3. *Server-side tripwire* — `backend/app/tripwire.py` scans the raw request
   body for JWT-shaped strings, `Bearer` headers, and long hex strings, and
   rejects the request outright (422) if anything matches. This should never
   fire; if it does, it's a collector bug, not a user problem.

**Contract 2 — CapabilityProvider (partial).** Only `ExtensionProvider`
exists in this slice, and only for the four actions that don't require the
target site's cooperation: `inspect_page`, `reload`, `clear_storage_key`,
`unregister_service_worker`. Anything requiring an app-specific capability
(like `refresh_auth` on a site we don't own) is intentionally out of scope —
GitHub can't grant Operon that.

**Contract 3 — Policy Engine.** `backend/app/policy.py` is the same
ALLOW / REQUIRE_APPROVAL / DENY decision matrix from the full plan, scoped to
the four actions above. The model only ever emits an `action_id` string from
this closed enum — never code, never a selector.

## Folder structure

```text
operon/
├── README.md                           # this file
│
├── backend/                            # FastAPI, stateless — deployed on Vercel
│   ├── requirements.txt                # fastapi, httpx, pydantic, uvicorn
│   ├── vercel.json                     # routes all paths to api/index.py
│   ├── api/
│   │   └── index.py                    # exports `app` for Vercel's Python runtime
│   └── app/
│       ├── main.py                     # FastAPI app: /health, /api/diagnose, /api/policy
│       ├── schemas.py                  # EvidenceBundle + sub-schemas, Diagnosis, Policy types
│       ├── tripwire.py                 # Contract 1a layer 3 — server-side credential scanner
│       ├── policy.py                   # Contract 3 — action enum + evaluate()
│       └── llm.py                      # Groq call: classify+diagnose+plan combined (MVP)
│
└── extension/                          # MV3, plain JS (no bundler), scoped to github.com
    ├── manifest.json                   # host_permissions: github.com only; debugger, cookies,
    │                                   #   storage, activeTab, scripting
    ├── background.js                   # service worker: chrome.debugger attach, evidence
    │                                   #   assembly, calls backend, executes approved actions
    ├── content.js                      # DOM skeleton + storage-shape reader, seeds/reads the
    │                                   #   demo marker key, runs at document_start
    └── popup/
        ├── popup.html                  # "Seed a bug" / "Ask Operon" / approval UI
        └── popup.js
```

Everything under `backend/` except `requirements.txt`, `vercel.json`, and
`api/index.py` already exists. `extension/` doesn't exist yet.

## Backend — setup

```bash
cd backend
pip install -r requirements.txt        # fastapi, httpx, pydantic, uvicorn

export GROQ_API_KEY="your-groq-key"                       # required
export GROQ_MODEL="llama-3.3-70b-versatile"               # optional, this is the default

uvicorn operon_backend.main:app --reload --port 8000
curl localhost:8000/health              # {"status": "ok"}
```

Deploying is the same `vercel deploy --temporary --yes` flow already used
elsewhere in this project — no account login required for a claimable
temporary deployment. `GROQ_API_KEY` needs to be passed as a runtime env
var on deploy (`-e GROQ_API_KEY=...`) or set in the Vercel project once
it's claimed.

**Get a Groq key:** [console.groq.com/keys](https://console.groq.com/keys)
— free tier, no card required. This is the one piece I can't provision for
you since it has to be tied to your own account.

## Extension — setup

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select the `extension/` folder.
2. Open `github.com` and sign in (your own account).
3. Click the Operon icon:
   - **Seed a bug** — corrupts the demo marker key in `localStorage`.
   - Reload the tab manually once, so the corrupted value actually gets
     read and throws a real console error — this is what Operon will find.
   - **Ask Operon for help** — type something like *"my GitHub feels
     broken"* and submit.
   - Review the diagnosis and cited evidence, then **Approve**.
   - Watch the tab reload and the popup report the verified result.
4. **Reset** clears the marker key directly, if you want to re-run the demo
   without going through the fix flow.

The extension needs `background.js` to know where the backend is — set the
deployed URL as `BACKEND_URL` at the top of `background.js` before loading
the extension (or point it at `http://localhost:8000` for local testing).

## What's deferred

Nothing from the earlier planning is dropped — it's sequenced, not cut:

- **`acme-cloud/`** — the fake SaaS ("Acme Cloud") with twelve seeded bugs,
  already built as a full Next.js app with no Operon code inside it. This
  becomes the second demo once this GitHub slice is proven.
- **`cors-service/`** — the tiny cross-origin service that makes Acme
  Cloud's CORS bug (#8) a genuine browser-level error. Only relevant once
  work resumes on Acme Cloud.
- **Persistence** — Postgres (Neon) for `evidence_bundles`/`support_tickets`,
  Redis (Upstash) for session state. This MVP is intentionally stateless:
  the extension carries context between calls instead of the backend storing
  it, which is simpler and avoids a database dependency for the first
  working loop.
- **The full 5-stage pipeline** — this MVP combines classify + diagnose +
  plan into one Groq call for speed. Splitting them into five separate,
  independently-scored stages (per the full build plan) is the next step
  once this path is proven.
- **`SdkProvider` / `packages/operon-core`** — there's no SDK yet, so there's
  no second consumer to justify extracting a shared package. `extension/`
  is written as its own clean, self-contained module so it can be lifted
  into `packages/operon-core` later without a rewrite.
- **Escalation, dashboard, eval.py** — all still apply once there's more
  than one bug and more than one provider to compare.
