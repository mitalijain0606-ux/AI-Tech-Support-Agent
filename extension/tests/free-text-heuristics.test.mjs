// redactFreeText: protections for credentials in shapes no fixed rule knows,
// applied to what a person types. The random-key tests use a seeded generator so
// the measured rates are reproducible. Nothing here is a real credential.
import assert from "node:assert/strict";
import test from "node:test";

import { bundle } from "./helpers.mjs";

const { redactFreeText, shannonEntropy } = await import(
  `data:text/javascript;base64,${Buffer.from(await bundle("src/lib/sanitize.ts")).toString("base64")}`
);

function rng(seed) {
  let a = seed;
  return () => ((a = (a * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const randomKey = (r, n, set = BASE62) => Array.from({ length: n }, () => set[Math.floor(r() * set.length)]).join("");

test("unknown-format random keys are redacted (measured on 2,000 seeded keys per length)", () => {
  const r = rng(42);
  for (const [length, minimum] of [[24, 0.9], [32, 0.97], [40, 0.99], [64, 0.99]]) {
    let hit = 0;
    for (let i = 0; i < 2000; i++) {
      const key = randomKey(r, length);
      const out = redactFreeText(`my key is ${key} please help`).text;
      if (!out.includes(key.slice(0, 12)) && out.includes("please help")) hit++;
    }
    assert.ok(hit / 2000 >= minimum, `${length} chars: ${(hit / 20).toFixed(1)}% redacted, need >= ${minimum * 100}%`);
  }
});

test("vendor-prefixed keys the fixed rules do not know are caught", () => {
  const cases = [
    ["stripe", "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"],
    ["sendgrid", "SG." + "abcdEFGH1234abcd" + "." + "ijklMNOP5678ijkl"],
    ["npm", "npm_" + "abcdEFGHijklMNOP0123456789abcdEF"],
    ["pypi", "pypi-" + "AgEIcHlwaS5vcmcCJGFiY2RlZmdoaWprbG1ub3BxcnN0dQ"],
  ];
  for (const [name, secret] of cases) {
    const out = redactFreeText(`x ${secret} y`).text;
    assert.ok(!out.includes(secret.slice(4)), `${name} leaked: ${out}`);
  }
});

test("a stated secret ('password is hunter2x') is redacted, a stated non-secret is not", () => {
  assert.match(redactFreeText("my password is hunter2x, please reset it").text, /\[REDACTED:stated_secret\]/);
  assert.match(redactFreeText("the api key: Zq9Xk2LmN8vB4c").text, /\[REDACTED:/);
  for (const ok of ["my token is expired", "the password is wrong", "the key is missing", "pin is required for this"]) {
    assert.equal(redactFreeText(ok).text, ok);
  }
});

test("ordinary text is left alone: sentences, errors, identifiers, UUIDs, Git SHAs, URLs, versions", () => {
  const normal = [
    "The dashboard shows a 500 error at /api/projects after I clicked Save",
    "TypeError: Cannot read properties of undefined (reading 'map') at renderProjectListItems",
    "Error: getUserPreferencesFromLocalStorageHandlerFactory is not a function",
    "ChunkLoadError: Loading chunk 12 failed",
    "commit 4f3a9c1d2b7e9f0a1b2c3d4e5f60718293a4b5c6 broke it",
    "session 123e4567-e89b-12d3-a456-426614174000 expired",
    "see https://github.com/octocat/Hello-World/issues/1234 and https://example.com/AbCdEf123456GhIjKl789012MnOpQr",
    "internationalization-and-localization-settings-page",
    "I use Chrome 129.0.6668.89 on macOS 14.6.1",
    "file main.4f3a9c.js not found",
    "version 2026.10.10-rc1 of buggy-cloud",
    "Mars/Phobos is not a valid timezone and EUR is fine",
  ];
  for (const text of normal) assert.equal(redactFreeText(text).text, text, text);
});

test("known limitation: a long mixed-case identifier containing a digit can be over-redacted", () => {
  // Documented trade-off of the entropy rule: a few words of context lost, never a leak.
  const out = redactFreeText("ReactDOMServerRenderToPipeableStream2ndAttempt fails").text;
  assert.match(out, /\[REDACTED:high_entropy_token\] fails/);
});

test("known limitation: low-entropy or short secrets are not caught by the heuristics", () => {
  // These are why the backend tripwire, rate limits and tenant isolation remain the real controls.
  for (const text of ["pass the word hunter2", "my pin 4829", "secret=abc"]) {
    assert.equal(redactFreeText(text).text, text);
  }
});

test("entropy helper", () => {
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("abcdefgh") > 2.9);
});
