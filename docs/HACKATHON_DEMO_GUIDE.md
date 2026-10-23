# Operon — hackathon demo guide

A repeatable script for showing Operon, the AI technical-support agent, on **NexaDesk**, a demo SaaS
app with real, reproducible faults. Every step below was run end to end by `npm run e2e:journey`
(see "Proof" at the end). Nothing in the demo is mocked: the faults are real application state, the
diagnosis comes from the Operon backend, fixes run in the browser and the **backend** verifies them.

## 1. Start everything (one command)

```bash
cd backend && python -m venv .venv && . .venv/bin/activate \
  && pip install --require-hashes -r requirements.txt && cd ..        # once
cd extension && npm ci && cd ..                                         # once
OPERON_PYTHON=backend/.venv/bin/python node scripts/dev-local.mjs        # offline engine (deterministic)
OPERON_PYTHON=backend/.venv/bin/python node scripts/dev-local.mjs --groq # real model (GROQ_API_KEY in your env)
```

It starts the backend and NexaDesk, builds the SDK and the extension, runs a self-check, and prints
the URLs and two local keys (a user token for the extension, an admin token for the support desk).
Ctrl+C stops everything. `--fresh` starts from an empty local database (it deletes `.local/`).

| What | URL |
|---|---|
| NexaDesk (the demo SaaS, with the Operon support widget) | http://127.0.0.1:4300/ |
| Demo console (presenter only) | http://127.0.0.1:4300/demo |
| Operon support desk (escalation tickets) | http://localhost:8000/dashboard |
| Operon backend health | http://localhost:8000/health |

Chrome extension (once): `chrome://extensions` → Developer mode → **Load unpacked** →
`extension/dist/local-demo`. Open the popup → **Backend access** → paste the user token.

## 2. The scenarios

Open the **demo console**. Each card shows the symptom, the real cause, what Operon should do, how
the fix is verified, the scenario's **real status in this browser** (read from the app's own state,
not a label) and the last result the widget recorded.

| # | Scenario | Symptom (page) | Operon's correct response |
|---|---|---|---|
| 1 | Saved settings corrupted | error banner instead of projects (Overview) | proposes `clear_storage_key` for that one key → approve → verified |
| 2 | Invalid time zone | dates missing, error banner (Account) | proposes `reset_user_preference(timezone)` → approve → verified |
| 3 | Invalid currency | prices missing, error banner (Account) | proposes `reset_user_preference(currency)` → approve → verified |
| 4 | Projects API 500 | project list never loads (Projects) | **escalates** with a ticket — a server fault can't be fixed in the browser |
| 5 | Session expired (401) | shown as signed out (Account) | **escalates**: signing in is the user's step |
| 6 | Reports API blocked by CORS | reports empty (Reports) | **escalates**: server configuration |
| 7 | Stale service worker | reports fail with a chunk error (Reports) | proposes `unregister_service_worker` → approve → verified |
| 8 | Saved search filters corrupted | project search disabled (Projects) | proposes `clear_storage_key` for the search key → approve → verified |

**Activate** plants the fault (and clears any earlier scenario first, so runs never contaminate each
other) and opens the affected page. **Re-activate** after a fix plants it again. **Open healthy app
(reset all)** returns to a clean NexaDesk.

## 3. Presentation script (≈5 minutes)

**Setup (before you go on):** run `dev-local.mjs`, open the demo console, load the extension, paste
the token. Optional: open the support desk and load it with the admin token.

1. **The product.** Open NexaDesk (healthy). "NexaDesk is a normal SaaS app — projects, reports,
   settings." Click through Overview, Projects (search works), Settings.
2. **The problem.** In the demo console, **Activate** scenario 2. NexaDesk opens on Account: dates
   are missing and there's an error banner. "A user sees this and files a ticket. Normally a support
   engineer spends an hour reproducing it."
3. **Operon, in the app (SDK widget).** In the Operon panel (bottom right) click the suggestion
   "Dates are missing…" → **Start investigation**. Point at the progress: it collects evidence from
   the page, investigates, prepares a fix.
4. **The diagnosis.** "What's wrong: the saved timezone preference is invalid." Show **Proposed
   fix** (reset only the timezone), **Why** (based on the evidence collected), **Before you decide**
   (what changes, that it runs only with approval, how it will be checked). "Nothing has been changed
   yet."
5. *(Optional, 15 s)* Reload the page: the widget picks the pending proposal back up — nothing was
   lost and nothing ran.
6. **Approve.** "Fixed and verified by the Operon backend." Reload NexaDesk: dates are back. Back in
   the demo console, scenario 2 now reads **Fixed in this browser** / **Resolved and verified**.
7. **Same agent, any site (extension).** Activate scenario 8 (search). Open the Operon extension
   popup: it shows the backend is connected and which site it is investigating. Describe "Project
   search is unavailable" → **Ask Operon** → it proposes clearing the corrupted search key. Click
   **Deny**: nothing changes — the search is still broken. (Then ask again and **Approve**: search
   works.)
8. **When Operon should NOT fix it.** Activate scenario 4 (or 5). Ask Operon. It explains the server
   is failing, proposes **no** action, and opens a **support ticket** — the reference is shown. Open
   the support desk with the admin token: the ticket is there with the evidence, the diagnosis and
   the full timeline.
9. **Close:** "Every proposal is checked against a safety policy on the server; it only runs with
   approval, only on the page it was diagnosed on, and Operon only says *resolved* after it verified
   the result itself."

## 4. If something goes wrong

| Situation | What to do |
|---|---|
| The live model is slow, rate-limited (429) or unavailable | Restart without `--groq`: the deterministic offline engine handles all 8 scenarios. Diagnoses are labelled with the engine that produced them; nothing pretends to be the model |
| The widget says "Operon can't reach its service" | The backend is down — check the `dev-local.mjs` terminal; restart it. Click **Try again** |
| A scenario shows no symptom | It was already fixed in this browser. Use **Re-activate (reset)** in the demo console |
| The extension says "No access token" | Popup → Backend access → paste the user token printed by `dev-local.mjs` |
| The extension says the tab was closed / shows another site | By design: Operon only acts on the tab it diagnosed. Reset and ask again on that tab |
| Desktop Chrome won't load the extension from the command line | Expected (recent Chrome); use **Load unpacked** as above |

## 5. What is real, and what is limited

Implemented and tested end to end: the 8 scenarios through the SDK widget and the extension;
evidence collection with client- and server-side redaction; knowledge retrieval; rule-based and
live-model diagnosis with grounding validation (cited evidence, closed action set, targets present in
the evidence, and guidance free of dangerous instructions or certainty claims); policy; approval and
rejection; execution on the investigated tab only; backend verification; retries; escalation tickets;
the support desk; SDK session recovery after a page reload.

Limited (be honest if asked):

- one issue per investigation — a complaint about two problems gets one diagnosis;
- diagnosis runs inside an ordinary request (progress is streamed; a backend restart mid-diagnosis
  loses that cycle cleanly, and resubmitting works) — no durable job queue;
- guidance text is checked for dangerous or overconfident instructions, but multi-step procedures are
  not checked step by step against the knowledge base;
- not deployed: everything runs locally.

## Proof

```bash
cd extension
npm run e2e:journey                        # this guide's journey, both interfaces, offline engine
OPERON_E2E_GROQ=1 npm run e2e:journey      # the same with the real model
npm run e2e:buggy && npm run e2e:sdk       # every scenario through the extension / the SDK
npm run e2e:screens && npm run e2e:dashboard
```

Results of the latest run are in [`FEATURE_AUDIT_REPORT.md`](FEATURE_AUDIT_REPORT.md).
