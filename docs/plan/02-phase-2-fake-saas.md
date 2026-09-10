# Phase 2 — Fake SaaS demo (blocked on Phase 1)

## Goal

Answer the question a mentor will ask right after seeing the GitHub demo:
*"okay, but how does this work for an actual SaaS startup's product?"* —
by pointing the exact same backend and extension source at a second,
self-built target, with nothing shared at runtime between the two builds.

**Do not start this phase until every milestone in
[`01-phase-1-github.md`](01-phase-1-github.md) is checked off.** That
sequencing was a deliberate choice, not a default — see that doc's
history for why.

## Scope

- **Size:** a full small app — 4 to 5 screens, 5+ seeded bugs. Bigger than
  a single-screen demo, deliberately smaller than the original 12-bug,
  9-page "Acme Cloud" concept archived in
  [`../archive/02-original-demo-cloud-spec.md`](../archive/02-original-demo-cloud-spec.md).
  That doc is still the right place to borrow bug ideas and UI/visual
  guidance from — just don't build all twelve.
- **No Operon code inside the fake app.** Same rule as GitHub — the app
  must not know it's being diagnosed, otherwise "same tool, unmodified,
  on a product we don't control" stops being true.
- **Reuses the same backend and the same `extension/` source** as Phase 1.
  The only new things are: the fake app itself, and
  `extension/targets/fake-saas.json` pointing at its real deployed domain.

## Suggested bug selection (pick 5+, not necessarily all)

Pulled from the archived catalogue, favoring ones that exercise the same
four in-scope actions from Phase 1 (so the extension code genuinely
doesn't change between targets) plus at least one that must escalate:

| Bug | Class | Action | Why it's a good pick |
|---|---|---|---|
| Corrupted local feature config | Auto-fix | `clear_storage_key` | Same mechanism as the GitHub demo bug — good consistency check |
| Stale service worker | Auto-fix | `unregister_service_worker` | Exercises the one action GitHub's demo doesn't reliably hit |
| Invalid preference (e.g. bad timezone) | Auto-fix | app-specific — **needs a real endpoint this time**, since we own this backend | First real test of an app-specific capability, impossible on GitHub |
| Backend 504 / CORS failure | Escalate | `DENY` | Proves it still knows when *not* to act, on a second target |
| Prompt injection in page content | Security | `DENY` | Cheap to add, strong demo moment, reuses the same guardrail already built for Phase 1 |

Final selection is a decision to make when this phase actually starts —
this table is a starting point, not a commitment.

## Milestones

- [ ] **M1 — Decide app concept, name, and stack.** Small Next.js app is
  the likely default (matches the rest of the project's tooling), but
  confirm before building.
- [ ] **M2 — Build the 4-5 screens** with realistic, production-looking
  UI — see the archived spec's design guidance (no neon, no fake logos,
  no obvious "bug button" in the normal UI).
- [ ] **M3 — Deploy it** somewhere with a real, stable domain (Vercel).
- [ ] **M4 — Wire 5+ seeded bugs** behind a hidden diagnostics control,
  each producing real, observable browser evidence, each independently
  resettable.
- [ ] **M5 — Create `extension/targets/fake-saas.json`** with the real
  domain, run the build for that target → `dist/fake-saas/`.
- [ ] **M6 — End-to-end run, live**, against the deployed fake app.
- [ ] **M7 — Rehearse both demos back to back** — GitHub, then a target
  switch, then the fake app, same extension family, same backend.

## Open questions

- App name — reuse "Acme Cloud" from the archived spec, or something new?
- Confirm the app-specific capability from bug 3 in the table above
  (e.g. `reset_user_preference`) gets its own real backend route in *this*
  app, and how that's represented in the shared, target-agnostic Operon
  backend — this is the first time Phase 2 needs something Phase 1 didn't.
