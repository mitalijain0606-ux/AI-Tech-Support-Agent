import assert from "node:assert/strict";
import test from "node:test";

import { importBundle } from "./helpers.mjs";

const { verifyAgainstEvidence, signatureOf } = await importBundle("src/lib/verification.ts");

const baseline = {
  url: "https://github.com/",
  timestamp: 1,
  console: [{ id: "ev_001", level: "error", text: "TypeError: cannot read properties of undefined (reading 'x') at app.js:12:5" }],
  network: [{ id: "ev_002", method: "GET", url: "https://github.com/api/items?page=2", status: 500 }],
  cookies: [],
  storage: [],
  redaction_applied: [],
};

test("reload false positive: the cited error reappears after the action -> verification fails", () => {
  // Before the fix, any reload was reported "Verified" without looking.
  const after = {
    console: [{ id: "ev_009", level: "error", text: "TypeError: cannot read properties of undefined (reading 'x') at app.js:14:9" }],
    network: [],
  };
  const result = verifyAgainstEvidence(baseline, ["ev_001"], after);
  assert.equal(result.passed, false);
  assert.match(result.message, /ev_001/);
});

test("cited signals gone after the action -> verification passes", () => {
  const result = verifyAgainstEvidence(baseline, ["ev_001", "ev_002"], { console: [], network: [] });
  assert.equal(result.passed, true);
});

test("a failed request recurring with a different query string still counts as the same signal", () => {
  const after = { console: [], network: [{ id: "ev_010", method: "get", url: "https://github.com/api/items?page=3", status: 500 }] };
  assert.equal(verifyAgainstEvidence(baseline, ["ev_002"], after).passed, false);
});

test("an unrelated new error doesn't fail verification of the cited signal", () => {
  const after = { console: [{ id: "ev_011", level: "error", text: "ReferenceError: foo is not defined" }], network: [] };
  assert.equal(verifyAgainstEvidence(baseline, ["ev_001"], after).passed, true);
});

test("nothing cited: passes only on a clean observation window", () => {
  assert.equal(verifyAgainstEvidence(baseline, [], { console: [], network: [] }).passed, true);
  const noisy = { console: [{ id: "ev_012", level: "error", text: "boom" }], network: [] };
  assert.equal(verifyAgainstEvidence(baseline, [], noisy).passed, false);
  assert.equal(verifyAgainstEvidence(null, ["ev_001"], noisy).passed, false);
});

test("signatures ignore volatile numbers and query strings", () => {
  assert.equal(
    signatureOf({ id: "a", level: "error", text: "Error at line 10" }),
    signatureOf({ id: "b", level: "error", text: "Error  at line 99" }),
  );
  assert.equal(
    signatureOf({ id: "a", method: "GET", url: "https://x.test/p?q=1", status: 404 }),
    signatureOf({ id: "b", method: "GET", url: "https://x.test/p#frag", status: 404 }),
  );
});

// ---- P0 review round 2: cited evidence must be positively re-verified ----

const withStorage = {
  ...baseline,
  storage: [{ id: "ev_003", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }],
  cookies: [{ id: "ev_004", name: "user_session", domain: "github.com" }],
};
const quiet = (storage = null) => ({ console: [], network: [], storage });

test("storage-only citation with the key still corrupt never falls back to a clean-window pass", () => {
  const result = verifyAgainstEvidence(withStorage, ["ev_003"], quiet([{ key: "operon_demo_cache", present: true, parse_status: "syntax_error" }]));
  assert.equal(result.passed, false);
});

test("storage-only citation that was never re-checked is inconclusive, not passed", () => {
  const result = verifyAgainstEvidence(withStorage, ["ev_003"], quiet(null));
  assert.equal(result.passed, false);
  assert.match(result.message, /inconclusive/);
});

test("storage-only citation whose key is now gone or valid passes", () => {
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_003"], quiet([{ key: "operon_demo_cache", present: false, parse_status: "empty" }])).passed, true);
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_003"], quiet([{ key: "operon_demo_cache", present: true, parse_status: "valid_json" }])).passed, true);
});

test("cited ids with a missing baseline bundle are inconclusive, even on a quiet page", () => {
  const result = verifyAgainstEvidence(null, ["ev_001"], quiet([]));
  assert.equal(result.passed, false);
  assert.match(result.message, /inconclusive/);
});

test("cookie citations can't be re-checked by a reload -> inconclusive", () => {
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_004"], quiet([])).passed, false);
});

test("a cited id that is not in the baseline bundle is inconclusive", () => {
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_999"], quiet([])).passed, false);
});

test("mixed citation passes only when every cited signal is gone", () => {
  const fixedStorage = [{ key: "operon_demo_cache", present: false, parse_status: "empty" }];
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_001", "ev_003"], quiet(fixedStorage)).passed, true);
  const errorBack = { console: [{ id: "x", level: "error", text: baseline.console[0].text }], network: [], storage: fixedStorage };
  assert.equal(verifyAgainstEvidence(withStorage, ["ev_001", "ev_003"], errorBack).passed, false);
});
