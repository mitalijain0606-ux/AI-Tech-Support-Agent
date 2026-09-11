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
- **Persistence:** none. The backend is stateless; the extension carries
  context (the evidence bundle, the diagnosis) between calls.
- **Pipeline:** one combined Groq call does classify + diagnose + plan.
  Splitting into five independently-scored stages is roadmap, not this
  phase.

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
- [ ] **M5 — Content script.** DOM skeleton + storage-shape reader; seeds
  and reads the demo marker key (`operon_demo_cache`) on github.com.
- [ ] **M6 — Background service worker.** `chrome.debugger` attach
  (Network + Runtime domains), `chrome.cookies` metadata (never values),
  evidence assembly into an `EvidenceBundle`, calls the backend, executes
  an approved action.
- [ ] **M7 — Popup UI.** Seed bug / Ask Operon / show diagnosis with cited
  evidence / Approve / re-verify and report the result.
- [ ] **M8 — Build pipeline.** `extension/scripts/build.mjs` reads
  `targets/github.json`, stamps `manifest.template.json`, bundles the
  TypeScript, writes `dist/github/` as a loadable unpacked extension.
- [ ] **M9 — End-to-end run, live.** The whole loop, on real github.com,
  witnessed working start to finish.
- [ ] **M10 — Backend deployed.** Vercel deployment with `GROQ_API_KEY`
  set as a runtime env var.
- [ ] **M11 — Demo rehearsed.** Run through at least twice, ideally with a
  recording, before showing anyone else.

## Open questions / things to confirm before M4

- Confirm `GROQ_MODEL` in `.env.example` (`llama-3.3-70b-versatile`) is
  still the right pick when we actually wire the call — Groq's available
  models change; check `console.groq.com` at build time rather than
  trusting this doc.
- Confirm Groq's API supports constrained/structured JSON output the way
  the diagnosis schema needs (equivalent to what Gemini's `responseSchema`
  gave us) — if not, the prompt needs an explicit "respond with only JSON
  matching this shape" instruction plus a parse-and-retry loop in `llm.py`.
