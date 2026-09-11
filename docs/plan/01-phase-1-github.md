# Phase 1 — GitHub demo (active)

## Goal

Prove the full loop, for real, against a live production site we don't
control:

```text
seed a bug → collect evidence → diagnose (Groq) → policy gate →
human approves → extension executes the fix → verify it actually worked
```

See the root [`README.md`](../../README.md) for the detailed walkthrough
of why GitHub, and the honest caveat about the bug being extension-seeded
rather than an organic GitHub defect (GitHub doesn't have one lying around
for us — same as any healthy production app).

## Scope for this phase

- **Target:** `github.com` only. The extension build for this phase has
  its permissions locked to this one domain (`extension/targets/github.json`).
- **Actions in scope:** `inspect_page`, `reload`, `clear_storage_key`,
  `unregister_service_worker` — the four actions that need no cooperation
  from the target site's backend. Anything requiring an app-specific
  capability (like `refresh_auth`) is out of scope, because GitHub can't
  grant Operon that.
- **Persistence:** none in this phase — the backend was stateless, the
  extension carried context between calls. This was a deliberate
  simplification to prove the loop worked at all, not a rejection of
  persistence — see [`production-architecture.md`](production-architecture.md)
  for the real Postgres/Redis design that supersedes this.
- **Pipeline:** one combined Groq call did classify + diagnose + plan.
  The real five (six, counting Retrieve) independently-scored stages are
  designed in [`production-architecture.md`](production-architecture.md).

## Milestones

- [x] **M1 — Repo scaffolded.** `backend/` and `extension/` boilerplate
  created and pushed to `main`. No logic yet.
- [x] **M2 — EvidenceBundle + tripwire.** `operon_backend/schemas.py`
  filled in for real; `operon_backend/tripwire.py` scans raw payloads for
  JWT-shaped strings, `Bearer` headers, long hex strings. `tests/test_tripwire.py`
  passes with a fake JWT rejected.
- [x] **M3 — Policy engine.** `operon_backend/policy.py` implements the
  closed action enum + `evaluate()` → ALLOW / REQUIRE_APPROVAL / DENY for
  the four in-scope actions. `tests/test_policy.py` covers all four plus
  an out-of-enum action_id (must DENY).
- [x] **M4 — Groq diagnosis.** `operon_backend/llm.py` calls Groq with the
  evidence summary + user message, returns a structured diagnosis. Backend
  rejects any `evidence_ids` not actually present in the submitted bundle.
- [x] **M5 — Content script.** Storage-shape reader; seeds, checks, and
  clears the demo marker key (`operon_demo_cache`). DOM skeleton collection
  was scoped out — the backend's `EvidenceBundle` schema has no `dom` field
  to receive it, so there was nothing to send it to.
- [x] **M6 — Background service worker.** `chrome.debugger` attach
  (Network + Runtime domains), `chrome.cookies` metadata (never values),
  evidence assembly into an `EvidenceBundle`, calls the backend, executes
  an approved action, reloads, re-verifies. Declares only the capabilities
  actually implemented (`inspect_page`, `reload`, `clear_storage_key`) —
  `unregister_service_worker` is not yet built, so the Policy Engine denies
  it automatically rather than needing a special case in the executor.
- [x] **M7 — Popup UI.** React + Tailwind, monochrome (no color, no
  gradients). Full state machine: seed/idle → collecting → diagnosing →
  awaiting approval (diagnosis + cited evidence pills + proposed action) →
  executing → verifying → resolved/escalated/error.
- [x] **M8 — Build pipeline.** `extension/scripts/build.mjs` reads
  `targets/github.json`, stamps `manifest.template.json`, bundles the
  TypeScript with esbuild (minified, production React), compiles Tailwind,
  writes `dist/github/`. Verified: correct manifest, correctly-scoped
  `host_permissions`, 150KB popup bundle. Refuses to build `fake-saas` until
  its target config has a real domain, as designed.
- [ ] **M9 — End-to-end run, live.** The whole loop, on real github.com,
  witnessed working start to finish. **Blocked on manual verification** —
  see the note below on why this couldn't be automated.
- [ ] **M10 — Backend deployed.** Vercel deployment with `GROQ_API_KEY`
  set as a runtime env var.
- [ ] **M11 — Demo rehearsed.** Run through at least twice, ideally with a
  recording, before showing anyone else.

## Known limitation — can't automate loading the extension (2026-09-11)

Chrome's `--load-extension` / `--disable-extensions-except` command-line
flags no longer load an unpacked extension on this machine's stable Chrome
(149.0.7827.102) — confirmed with a trivial one-file test extension and
direct `google-chrome --load-extension=... --remote-debugging-port` (no
Playwright involved), which shows only Chrome's own built-in component
extensions in the target list, never the one passed on the command line.
This matches Chrome's rollout of restrictions on command-line extension
loading (aimed at automated malware installs) — it does **not** affect the
normal developer path.

Practical effect: M9 has to be verified manually, the same way you'd
actually use this day to day —

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select `extension/dist/github/`.
2. Run the backend locally (`uvicorn operon_backend.main:app --reload`)
   with a real `GROQ_API_KEY` in `.env`.
3. Open github.com, open the extension popup, click **Seed demo bug**,
   describe the problem, **Ask Operon**, **Approve**, and watch it reload
   and verify.

If a CI step ever needs this automated, look into Puppeteer/Playwright's
newer extension-testing APIs or a Chrome policy override rather than
retrying the command-line flags — they were the first thing tried here and
they're the thing that's actually blocked.

## Resolved — model + structured output (2026-09-11)

- `llama-3.3-70b-versatile` is gone from Groq (confirmed via a live 404
  `model_not_found` against the real API). Queried `GET
  /openai/v1/models` with the real key and switched the default to
  **`openai/gpt-oss-120b`**, which is live on Groq right now. Updated in
  `.env.example` and `config.py`. Re-verify against `console.groq.com`
  periodically — this list changes.
- Groq's `chat/completions` does support `response_format: {"type":
  "json_object"}`, and a real end-to-end call against the actual
  `/api/diagnose` endpoint returned clean, schema-valid JSON with correct
  evidence citations (`ev_001`, `ev_002`) and the expected `clear_storage_key`
  action — no retry loop needed for now.
