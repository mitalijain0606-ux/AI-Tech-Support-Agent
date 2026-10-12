import assert from "node:assert/strict";
import test from "node:test";

import { OperonError, init } from "../operon-sdk.js";
import { evidenceRequest, fakeBackend, fakeWindow, happyBackend, install, session } from "./fakes.mjs";

const TOKEN = "opk_secret-token-value-123456";
function setup(backend, extra = {}) {
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", token: TOKEN, fetch: backend.fetch, ...extra });
  return { win, client, done: () => (client.dispose(), restore()) };
}
async function failure(promise) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof OperonError, `expected OperonError, got ${e}`);
    assert.ok(!String(e.message).includes(TOKEN), "the token must never appear in an error");
    return e;
  }
  assert.fail("expected the call to fail");
}

test("requests carry the bearer token in a header only, never in a URL or body, and no cookies", async () => {
  const backend = happyBackend();
  const { client, done } = setup(backend);
  await client.diagnose("my dashboard is broken");
  const created = backend.calls.find((c) => c.path === "/api/sessions");
  assert.equal(created.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(created.credentials, "omit");
  for (const c of backend.calls) {
    assert.ok(!c.path.includes(TOKEN) && !(c.raw ?? "").includes(TOKEN));
    assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  }
  assert.equal(created.body.source, "sdk");
  assert.deepEqual(created.body.provider_capabilities, ["inspect_page"]);
  done();
});

test("getToken is asked for on every request and its failure sends nothing", async () => {
  const backend = happyBackend();
  let n = 0;
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", getToken: async () => `tok${++n}`, fetch: backend.fetch });
  await client.diagnose("x");
  assert.ok(backend.calls.length >= 2 && new Set(backend.calls.map((c) => c.headers.Authorization)).size === backend.calls.length);
  client.dispose();

  const quiet = happyBackend();
  const c2 = init({ backendUrl: "https://api.example.com", getToken: async () => { throw new Error("vault down: secret-detail"); }, fetch: quiet.fetch });
  const e = await failure(c2.diagnose("x"));
  assert.equal(e.code, "unauthorized");
  assert.ok(!e.message.includes("secret-detail"));
  assert.equal(quiet.calls.length, 0);
  const c3 = init({ appId: "other", backendUrl: "https://api.example.com", getToken: () => "", fetch: quiet.fetch });
  assert.equal((await failure(c3.diagnose("x"))).code, "unauthorized");
  c3.dispose();
  c2.dispose();
  restore();
});

const STATUS_CASES = [
  [401, "unauthorized"], [403, "forbidden"], [404, "not_found"], [409, "conflict"], [429, "rate_limited"],
  [400, "request_rejected"], [422, "request_rejected"], [500, "server_error"], [503, "server_error"],
];
for (const [status, errorCode] of STATUS_CASES) {
  test(`HTTP ${status} becomes ${errorCode}, without leaking the response body`, async () => {
    const backend = fakeBackend({ "POST /api/sessions": () => [status, { detail: `SECRET-BODY-${TOKEN}` }, { "retry-after": "7" }] });
    const { client, done } = setup(backend);
    const e = await failure(client.diagnose("x"));
    assert.equal(e.code, errorCode);
    assert.equal(e.status, status);
    assert.ok(!e.message.includes("SECRET-BODY"));
    if (status === 429) assert.equal(e.retryAfterSeconds, 7);
    assert.equal(backend.calls.length, 1, "never retried automatically");
    done();
  });
}

test("malformed JSON, wrong shapes and another session's answer are rejected", async () => {
  for (const body of [Symbol.for("malformed"), null, "text", { nope: 1 }, { session_id: 5, phase: "X" }]) {
    const backend = fakeBackend({ "POST /api/sessions": () => [200, body] });
    const { client, done } = setup(backend);
    assert.equal((await failure(client.diagnose("x"))).code, "malformed_response");
    done();
  }
  const crossed = fakeBackend({
    "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: evidenceRequest() })],
    "POST /api/sessions/s1/investigate": () => [200, { session: { ...session("ACTION_PROPOSED"), session_id: "OTHER" } }],
  });
  const { client, done } = setup(crossed);
  assert.equal((await failure(client.diagnose("x"))).code, "malformed_response");
  done();
});

test("a network failure, a timeout and an abort are different errors", async () => {
  const down = fakeBackend({ "POST /api/sessions": () => new TypeError("Failed to fetch https://api.example.com?token=abc") });
  let s = setup(down);
  const e = await failure(s.client.diagnose("x"));
  assert.equal(e.code, "network_error");
  assert.ok(!e.message.includes("token=abc"));
  s.done();

  const hang = { calls: [], fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) };
  s = setup(hang, { timeoutMs: 1000 });
  assert.equal((await failure(s.client.diagnose("x"))).code, "timeout");
  s.done();

  s = setup(hang);
  const ac = new AbortController();
  const p = s.client.diagnose("x", { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  assert.equal((await failure(p)).code, "aborted");
  assert.equal(s.client.disposed, false);
  s.done();
});

test("dispose aborts what is in flight and blocks further use", async () => {
  const hang = { fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) };
  const { client, done } = setup(hang);
  const p = client.diagnose("x");
  setTimeout(() => client.dispose(), 20);
  assert.equal((await failure(p)).code, "disposed");
  assert.equal((await failure(client.diagnose("y"))).code, "disposed");
  assert.equal((await failure(client.decide(true))).code, "disposed");
  done();
});

test("overlapping operations are refused instead of duplicated", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const backend = happyBackend({ "POST /api/sessions": async () => (await gate, [200, session("ESCALATED")]) });
  const { client, done } = setup(backend);
  const first = client.diagnose("x");
  assert.equal((await failure(client.diagnose("again"))).code, "busy");
  release();
  await first;
  assert.equal(backend.count("POST", /^\/api\/sessions$/), 1);
  await client.diagnose("after"); // the lock was released
  done();
});

test("diagnose validates its input", async () => {
  const backend = happyBackend();
  const { client, done } = setup(backend);
  assert.equal((await failure(client.diagnose("   "))).code, "config_invalid");
  assert.equal((await failure(client.diagnose(undefined))).code, "config_invalid");
  assert.equal((await failure(client.diagnose("x".repeat(4001)))).code, "payload_too_large");
  assert.equal((await failure(client.decide("yes"))).code, "config_invalid");
  assert.equal((await failure(client.decide(true))).code, "invalid_state");
  assert.equal((await failure(client.answer("hi"))).code, "invalid_state");
  assert.equal((await failure(client.continue())).code, "invalid_state");
  assert.equal(backend.calls.length, 0);
  done();
});
