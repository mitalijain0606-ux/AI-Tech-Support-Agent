# Demo rehearsal checklist

Run this before showing Operon to anyone. Each step says what you should see.
Anything that does not happen is a stop-and-fix, not something to talk around.

## Before

- [ ] Backend reachable: `curl https://<backend>/health` → `{"status":"ok"}`;
      `curl https://<backend>/ready` → `{"status":"ok"}` (all an anonymous caller is told in
      production). For the detail, send an admin key: `curl -H "Authorization: Bearer $ADMIN_TOKEN"
      https://<backend>/ready` → `"status":"ready"` (database ok, embeddings available, knowledge
      index non-empty; `degraded` means no precedent retrieval). Local development shows the detail
      without a key: `uvicorn operon_backend.main:app`.
- [ ] A key exists for you (`python scripts/manage_keys.py list`) and is saved in
      the popup under *Backend access* ("token saved").
- [ ] `GROQ_API_KEY` is set if you want to show the real model. Without it the
      popup/diagnosis says `rule_based`: say so out loud, it is the offline engine.
- [ ] Extension built with the right backend: `OPERON_BACKEND_URL=… npm run build -- github`
      and loaded from `extension/dist/github/`.
- [ ] You are in a normal (not signed-in-as-someone-important) Chrome profile.

## The GitHub run (about 3 minutes)

1. Open any public page, e.g. `https://github.com/octocat/Hello-World`.
2. Popup → **Seed demo bug**. It writes one namespaced `localStorage` key,
   `operon_demo_cache`, with invalid JSON. GitHub never reads it.
3. **Ask Operon**: "This page looks broken — something seems wrong with my saved settings."
   Expect the live progress lines: *Gathering and searching the evidence →
   Classifying the problem → Asking the model for a diagnosis → Planning the next step*.
4. Expect **Awaiting approval** with the plan: `clear_storage_key` on
   `operon_demo_cache`, the evidence ids it cites, and what it will verify.
   Nothing has run yet (the key is still there).
5. **Deny** first (a separate run): expect *Resolved · declined*; the key is
   still there; no action was recorded.
6. Run again and **Approve**: expect *Resolved*; the key is gone; the session
   shows verification `passed` decided **by the backend**.
7. Reset when done (the popup's **Reset**).

## Things to point out

- The model can only pick from a closed list of actions; the backend checks
  every action and parameter again, and policy decides whether approval is needed.
- The extension never sends cookies, tokens or storage values; the backend
  rejects anything credential-shaped anyway.
- "Resolved" only appears when the backend's verification passed.

## Second app (Buggy Cloud), about 3 minutes

1. `cd buggy-cloud && npm start` (serves `http://127.0.0.1:4300`; reports API on 4301).
2. Build the extension for the local target:
   `cd extension && npm run build -- e2e-local` (never ship this build) and reload it.
3. Open `http://127.0.0.1:4300/?bug=2` (invalid saved timezone). Ask Operon.
   Expect `reset_user_preference {"preference":"timezone"}`, approval, then
   *Resolved* after a backend-verified reload. `?bug=4` (API 500) must end with a
   diagnosis and **no action**.

## The SDK path (about 3 minutes, no extension)

1. Start a backend that allows the demo page's origin, e.g. from `backend/`:
   `CORS_ALLOW_ORIGINS=http://127.0.0.1:4300 AUTH_REQUIRED=true uvicorn operon_backend.main:app` and mint a key
   (`python scripts/manage_keys.py create --tenant demo --subject you`).
2. Serve Buggy Cloud *with an Operon config* (local testing only; the token is handed to the page):
   `cd buggy-cloud && node -e "import('./server.mjs').then(m=>m.startBuggyCloud({port:4300,operon:{backendUrl:'http://localhost:8000',token:process.env.OPERON_TOKEN}}).then(a=>console.log(a.url)))"`
3. Open `http://127.0.0.1:4300/?bug=2`, press **Diagnose with Operon**. Expect progress, then a proposal
   (`reset_user_preference {"preference":"timezone"}`), **Reject** → "Nothing was changed" (reload to confirm the
   error is still there), then again **Approve** → "Fixed and verified by the Operon backend" and a clean reload.
   `?bug=4` ends in an escalation with no action.

## Automated rehearsal

`cd extension && npm run e2e:demo` (real github.com), `npm run e2e` (local fixtures),
`npm run e2e:buggy` (Buggy Cloud through the extension), `npm run e2e:sdk` (Buggy Cloud through the SDK, no extension), `npm run e2e:wire` / `e2e:sdk-wire` (request bytes). They start their own backend and
browser; see `extension/e2e/README.md`.

## If something goes wrong

| Symptom | Likely cause |
|---|---|
| "enter an access token" | no key saved in the popup |
| "wait Ns" | rate limit (429) — wait, then retry |
| Diagnosis says `rule_based` | no `GROQ_API_KEY` on the server |
| Groq 429 in the activity log | free-tier 8,000 tokens/minute: wait a minute |
| Retrieval `empty_index` | the embedding model could not load at startup; restart |
