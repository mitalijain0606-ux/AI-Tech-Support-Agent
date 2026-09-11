# GitHub scenario playbook

Why this exists: a live demo of real production software can't rely on a
genuine bug happening to occur on cue — that's true of any real site, not
something specific to GitHub. The professional answer to that (how every
observability/reliability product demos itself) is controlled fault
injection on a real target, shown transparently, plus enough scenario
variety that it reads as capability rather than one trick. This doc
catalogues both kinds running against the `github` target, and is the
place to add more of either.

Every scenario here is either **seeded** (we deliberately create the
condition, clearly labeled as such) or **real** (a genuinely-occurring
browser condition we detect without fabricating anything — reproducible by
you, not manufactured by us). Nothing here pretends a seeded condition is
an undiscovered GitHub defect.

## Implemented

### 1. Corrupted cached config — seeded

- **How it's created:** the popup's "Seed demo bug" button writes an
  invalid JSON string into `localStorage['operon_demo_cache']` on the
  active tab.
- **Evidence:** a real `console.error` (genuine `SyntaxError`, thrown by
  our own content script's `JSON.parse` attempt — not a fabricated log
  line) plus a `StorageSignal` with `parse_status: "syntax_error"`.
- **Diagnosis:** `category: "storage_corruption"`, resolvable
  automatically.
- **Action:** `clear_storage_key` → reload → re-verify the key parses
  clean (or is gone).
- **Why it's honest, not fake:** everything downstream of the seed —
  attach, capture, diagnose, policy gate, execute, verify — is the exact
  same real machinery a genuine corrupted-cache bug would go through. The
  only fabricated part is the initial condition, clearly labeled as such
  in the UI and in this doc.

### 2. Ad-blocker / privacy-extension interference — real

- **How it occurs:** if you have an ad blocker or privacy extension
  installed (uBlock, Privacy Badger, etc.), it may cancel some of
  GitHub's own outgoing requests (telemetry/analytics endpoints are the
  usual target). This is not something we trigger — it only shows up if
  such an extension is genuinely active and genuinely blocks something
  during the observation window.
- **Evidence:** `chrome.debugger`'s `Network.loadingFailed` event fires
  with `errorText: "net::ERR_BLOCKED_BY_CLIENT"` (or a `blockedReason`) —
  this is the same signal Chrome DevTools' own Network tab uses to show
  `(blocked:other)`. Recorded as a `NetworkEvidence` entry with `status: 0`.
  Before this was added, these requests were invisible to us entirely —
  `Network.responseReceived` never fires for a request that never got a
  response.
- **Diagnosis:** `category: "blocked_by_client"`, `resolvable_automatically:
  false`. The prompt explicitly forbids proposing to disable another
  browser extension — Operon has no such capability and shouldn't imply
  one exists.
- **Response:** explain what's happening and ask the user to check their
  ad blocker / privacy extension settings for this site, then re-verify
  once they've done so — the "Class B, user-assisted" pattern from the
  original build plan.
- **Demo caveat:** genuinely environment-dependent. It only fires if the
  demo machine actually has a blocking extension active. Worth confirming
  before relying on it live — don't promise it in a demo you haven't
  rehearsed on that exact machine.

## Candidates — documented, not yet implemented

### 3. Expired session — real, not yet wired

A real 401 when your actual GitHub session cookie has lapsed. Fully
diagnosable with the machinery that already exists (cookie metadata +
network status capture) — nothing new to build on the evidence side. What's
missing: a controlled way to demo it, since you can't force your own real
session to expire on command without actually logging out, which is
disruptive to test repeatedly. Lowest priority of the three candidates
because of that friction, not because of technical difficulty.

### 4. A genuine escalation case (4xx/5xx from GitHub itself) — real, harder to stage

Pointing at something that genuinely 404s or errors server-side (e.g. a
broken/private repo link) would produce a real escalation — Operon
correctly refusing to act because nothing client-side can fix a
server-side problem. The friction: reliably producing this without
spamming GitHub's real API (rate-limiting it deliberately would be poor
practice, not just impractical) needs a specific, real, already-broken URL
picked in advance rather than an on-demand trigger. Worth having one ready
for a demo rather than building a mechanism to force it.

## Adding a new scenario here

For each one, document: how it's created (seeded vs. real, and if real,
what the user needs to have/do for it to occur), exactly what evidence
signal it produces and via which CDP event, what `category` and behavior
it should get from the diagnosis prompt (`llm.py`'s `SYSTEM_PROMPT`), and
any demo caveats (environment-dependent, needs setup, etc.). Keep the
seeded/real distinction explicit — that honesty is the point of this doc.
