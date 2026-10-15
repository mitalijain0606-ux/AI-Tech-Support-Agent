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

### 3. Expired / missing session (401) — real response, our trigger

- **How it's created:** while Operon observes the page, the visitor makes a
  request that needs a signed-in GitHub session —
  `fetch("https://api.github.com/user")` from a github.com tab in an
  anonymous profile. The trigger is ours (one request, labelled as such in
  the test); the **401 is GitHub's own answer**, exactly what an expired
  session gets. Forcing your real session to expire on command is not
  possible, which is why the trigger is staged and the response is not.
- **Evidence:** `Network.responseReceived` with status 401 for
  `api.github.com/user`, recorded as a `NetworkEvidence` entry.
- **Diagnosis:** `category: "auth_failure"`, no action — signing in again is
  the user's own step and Operon never handles credentials (prompt rule 5a,
  classifier in `stages.py`).
- **Outcome:** ESCALATED (`escalated_no_action_available`) with that
  guidance, and an escalation ticket for the support team.
- **Proof:** `cd extension && npm run e2e:github-escalation` (real
  github.com; one API request, anonymous).

### 4. A genuine escalation case (404 from GitHub itself) — real

- **How it occurs:** a link to a repository that does not exist
  (`github.com/octocat/operon-e2e-this-repository-does-not-exist`). The
  visitor reproduces it by reloading while Operon observes; GitHub answers
  404. One page load, no rate-limit pressure, nothing staged.
- **Evidence:** `Network.responseReceived` with status 404 for the document.
- **Diagnosis:** `category: "network_error"`, no action — nothing in the
  browser can make a missing repository exist.
- **Outcome:** ESCALATED with a ticket carrying the full report (user
  message, the 404 evidence, the diagnosis, the timeline).
- **Proof:** the same `npm run e2e:github-escalation` run (12/12 on
  2026-10-14).

## Adding a new scenario here

For each one, document: how it's created (seeded vs. real, and if real,
what the user needs to have/do for it to occur), exactly what evidence
signal it produces and via which CDP event, what `category` and behavior
it should get from the diagnosis prompt (`llm.py`'s `SYSTEM_PROMPT`), and
any demo caveats (environment-dependent, needs setup, etc.). Keep the
seeded/real distinction explicit — that honesty is the point of this doc.
