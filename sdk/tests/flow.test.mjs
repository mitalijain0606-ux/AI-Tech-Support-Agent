import assert from "node:assert/strict";
import test from "node:test";

import { OperonError, init } from "../operon-sdk.js";
import { fakeBackend, fakeWindow, happyBackend, install, proposal, session } from "./fakes.mjs";

function setup({ backend = happyBackend(), actions, builtinActions, storage, storageKeys, reobserve, capture } = {}) {
  const win = fakeWindow({ storage });
  const restore = install(win);
  const calls = [];
  const client = init({
    backendUrl: "https://api.example.com", token: "opk_x", fetch: backend.fetch, evidenceWaitMs: 0, maxObserveMs: 50,
    actions: actions ?? { reset_user_preference: async (p) => (calls.push(p), { detail: `reset ${p.preference}` }) },
    builtinActions, storageKeys, reobserve, capture,
  });
  return { win, client, backend, calls, done: () => (client.dispose(), restore()) };
}
const order = (backend) => backend.calls.filter((c) => c.method === "POST").map((c) => c.path.replace("/api/sessions", "").replace(/^\/s1/, "") || "/create");

test("diagnose stops at a proposal and executes nothing", async () => {
  const t = setup();
  const r = await t.client.diagnose("dates are wrong");
  assert.equal(r.state, "proposal");
  assert.equal(r.proposal.action_id, "reset_user_preference");
  assert.deepEqual(t.calls, []);
  assert.deepEqual(order(t.backend), ["/create", "/investigate"]);
  t.done();
});

test("approve: policy → approval bound to the proposal → the action → result → verification", async () => {
  const t = setup({ reobserve: async () => {} });
  await t.client.diagnose("dates are wrong");
  const d = await t.client.decide(true);
  assert.deepEqual(order(t.backend), ["/create", "/investigate", "/policy", "/approve", "/action-result", "/verify"]);
  assert.deepEqual(t.backend.calls.find((c) => c.path.endsWith("/approve")).body, { approved: true, proposal_id: "prop1" });
  assert.deepEqual(t.calls, [{ preference: "timezone" }]);
  assert.equal(d.executed, true);
  assert.equal(d.state, "resolved");
  assert.equal(d.verification.outcome, "passed");
  const report = t.backend.calls.find((c) => c.path.endsWith("/action-result")).body;
  assert.deepEqual([report.action_id, report.succeeded], ["reset_user_preference", true]);
  const verify = t.backend.calls.find((c) => c.path.endsWith("/verify")).body;
  assert.equal(verify.action_id, "reset_user_preference");
  assert.ok(!("passed" in verify) && !("outcome" in verify), "the client never claims the verdict");
  assert.ok(Array.isArray(verify.observation.console));
  t.done();
});

test("reject: the backend records it and NOTHING runs", async () => {
  const t = setup();
  await t.client.diagnose("dates are wrong");
  const d = await t.client.decide(false);
  assert.deepEqual(order(t.backend), ["/create", "/investigate", "/policy", "/approve"]);
  assert.equal(t.backend.calls.at(-1).body.approved, false);
  assert.deepEqual(t.calls, []);
  assert.deepEqual([d.executed, d.reason, d.state], [false, "rejected", "declined"]);
  t.done();
});

test("a policy DENY ends the session and runs nothing", async () => {
  const t = setup({
    backend: happyBackend({ "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "DENY", reason: "no" }, session: session("ESCALATED", { pending_action: proposal() }) }] }),
  });
  await t.client.diagnose("x");
  const d = await t.client.decide(true);
  assert.deepEqual([d.executed, d.reason, d.state], [false, "denied_by_policy", "escalated"]);
  assert.deepEqual(t.calls, []);
  assert.equal(t.backend.count("POST", /approve|action-result|verify/), 0);
  t.done();
});

test("an action the backend proposes but this app did not enable is reported as failed, not run", async () => {
  const pending = proposal("clear_storage_key", { key: "k" });
  const backend = happyBackend({
    "POST /api/sessions/s1/investigate": () => [200, { session: session("ACTION_PROPOSED", { pending_action: pending }) }],
    "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: pending.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: pending }) }],
    "POST /api/sessions/s1/approve": () => [200, session("EXECUTING", { pending_action: pending })],
    "POST /api/sessions/s1/action-result": () => [200, session("ESCALATED", { pending_action: pending })],
  });
  const t = setup({ backend, storage: { k: "{bad" } });
  await t.client.diagnose("x");
  const d = await t.client.decide(true);
  assert.equal(d.executed, false);
  assert.equal(t.win._store.get("k"), "{bad", "the key was not touched");
  const reported = t.backend.calls.find((c) => c.path.endsWith("/action-result")).body;
  assert.equal(reported.succeeded, false);
  assert.match(reported.detail, /not enabled/);
  assert.equal(t.backend.count("POST", /verify/), 0, "nothing was done, so nothing is verified");
  t.done();
});

for (const bad of ["password", "", null, ["timezone"], "timezone; DROP"]) {
  test(`reset_user_preference with parameter ${JSON.stringify(bad)} is refused locally even if approved`, async () => {
    const pending = proposal("reset_user_preference", { preference: bad });
    const backend = happyBackend({
      "POST /api/sessions/s1/investigate": () => [200, { session: session("ACTION_PROPOSED", { pending_action: pending }) }],
      "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: pending.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: pending }) }],
      "POST /api/sessions/s1/approve": () => [200, session("EXECUTING", { pending_action: pending })],
      "POST /api/sessions/s1/action-result": () => [200, session("ESCALATED", { pending_action: pending })],
    });
    const t = setup({ backend });
    await t.client.diagnose("x");
    const d = await t.client.decide(true);
    assert.deepEqual(t.calls, [], "the app's handler was never called");
    assert.equal(d.executed, false);
    assert.equal(t.backend.calls.find((c) => c.path.endsWith("/action-result")).body.succeeded, false);
    t.done();
  });
}

test("a handler that throws or hangs is a reported failure, never a success", async () => {
  const t = setup({ actions: { reset_user_preference: () => { throw new Error(`boom with ${"ghp_" + "A1b2C3d4E5f6G7h8J9k0A1b2C3d4E5f6G7h8J9k0"}`); } } });
  await t.client.diagnose("x");
  const d = await t.client.decide(true);
  assert.equal(d.executed, false);
  const sent = t.backend.calls.find((c) => c.path.endsWith("/action-result")).body;
  assert.equal(sent.succeeded, false);
  assert.ok(!sent.detail.includes("A1b2C3d4E5f6G7h8J9k0A1b2"), "the error text is redacted before it is reported");
  t.done();
});

test("verification is honest: no way to re-observe means 'cannot observe', never a clean bill", async () => {
  const t = setup(); // no reobserve hook, and the proposal cites a console error
  await t.client.diagnose("x");
  await t.client.decide(true);
  const observation = t.backend.calls.find((c) => c.path.endsWith("/verify")).body.observation;
  assert.equal(observation.error, "reobserve_unavailable");
  t.done();
});

test("a failing reobserve hook is reported as an error observation", async () => {
  const t = setup({ reobserve: async () => { throw new Error("render failed"); } });
  await t.client.diagnose("x");
  await t.client.decide(true);
  assert.equal(t.backend.calls.find((c) => c.path.endsWith("/verify")).body.observation.error, "reobserve_failed");
  t.done();
});

test("errors that reappear during re-observation are reported to the backend, which decides", async () => {
  let t;
  t = setup({ capture: { console: true }, reobserve: async () => t.win.console.error("boom") });
  await t.client.diagnose("x");
  await t.client.decide(true);
  const observation = t.backend.calls.find((c) => c.path.endsWith("/verify")).body.observation;
  assert.deepEqual(observation.console.map((c) => c.text), ["boom"]);
  t.done();
});

test("built-in clear_storage_key only touches keys the app listed", async () => {
  const pending = (key) => proposal("clear_storage_key", { key }, { verification: { strategy: "storage_recheck", cited_evidence: { console: [], network: [], cookies: [], storage: [{ id: "ev1", key, present: true, parse_status: "syntax_error" }], page: [] }, storage_keys: [key], observe_ms: 0 } });
  for (const [key, cleared] of [["app_settings", true], ["other_app_data", false]]) {
    const p = pending(key);
    const backend = happyBackend({
      "POST /api/sessions/s1/investigate": () => [200, { session: session("ACTION_PROPOSED", { pending_action: p }) }],
      "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: p.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: p }) }],
      "POST /api/sessions/s1/approve": () => [200, session("EXECUTING", { pending_action: p })],
      "POST /api/sessions/s1/action-result": (b) => [200, session(b.succeeded ? "VERIFYING" : "ESCALATED", { pending_action: p })],
    });
    const t = setup({ backend, actions: {}, builtinActions: ["clear_storage_key"], storageKeys: ["app_settings"], storage: { app_settings: "{bad", other_app_data: "{bad" } });
    await t.client.diagnose("x");
    await t.client.decide(true);
    assert.equal(t.win._store.get(key) === undefined, cleared, key);
    if (cleared) assert.deepEqual(t.backend.calls.find((c) => c.path.endsWith("/verify")).body.observation.storage, [{ key: "app_settings", present: false, parse_status: "empty" }]);
    t.done();
  }
});

test("built-in unregister_service_worker removes only the registration with that scope", async () => {
  const p = proposal("unregister_service_worker", { scope: "/" }, { verification: { strategy: "service_worker_recheck", cited_evidence: { console: [], network: [], cookies: [], storage: [], page: [] }, service_worker_scope: "/", storage_keys: [], observe_ms: 0 } });
  const backend = happyBackend({
    "POST /api/sessions/s1/investigate": () => [200, { session: session("ACTION_PROPOSED", { pending_action: p }) }],
    "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: p.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: p }) }],
    "POST /api/sessions/s1/approve": () => [200, session("EXECUTING", { pending_action: p })],
  });
  const t = setup({ backend, actions: {}, builtinActions: ["unregister_service_worker"] });
  const removed = [];
  t.win._registrations = [
    { scope: "https://app.test/", unregister: async () => (removed.push("/"), (t.win._registrations = t.win._registrations.filter((r) => r.scope !== "https://app.test/")), true) },
    { scope: "https://app.test/docs/", unregister: async () => (removed.push("/docs/"), true) },
  ];
  await t.client.diagnose("x");
  await t.client.decide(true);
  assert.deepEqual(removed, ["/"]);
  assert.deepEqual(t.backend.calls.find((c) => c.path.endsWith("/verify")).body.observation.service_worker_scopes, ["/docs/"]);
  t.done();
});

test("progress and state events reach listeners; a throwing listener cannot break the SDK", async () => {
  const t = setup();
  const states = [];
  t.client.on("state", (r) => states.push(r.state));
  t.client.on("state", () => { throw new Error("listener bug"); });
  const off = t.client.on("progress", () => { throw new Error("never"); });
  off();
  await t.client.diagnose("x");
  assert.deepEqual(states, ["in_progress", "proposal"]);
  assert.throws(() => t.client.on("state", "nope"), (e) => e.code === "config_invalid");
  t.done();
});

test("the live progress stream is read when the backend provides one", async () => {
  const enc = new TextEncoder();
  const frames = ['data: {"id":1,"type":"stage","stage":"diagnose","status":"started"}\n\n', 'data: {"id":2,"type":"stage","stage":"plan","status":"finished","outcome":"action_proposed"}\n\n', 'data: {"id":3,"type":"end"}\n\n'];
  const backend = happyBackend({
    "GET /api/sessions/s1/events": () => [200, {}],
  });
  const baseFetch = backend.fetch;
  const fetch = async (url, init) => {
    if (String(url).endsWith("/events")) {
      let i = 0;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < frames.length ? { done: false, value: enc.encode(frames[i++]) } : { done: true }) }) } };
    }
    return baseFetch(url, init);
  };
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch, evidenceWaitMs: 0 });
  const seen = [];
  client.on("progress", (p) => seen.push(`${p.stage}:${p.status}`));
  await client.diagnose("x");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, ["diagnose:started", "plan:finished"]);
  client.dispose();
  restore();
});

test("a second diagnose starts a clean session; decide acts only on the current one", async () => {
  const t = setup();
  await t.client.diagnose("first");
  const first = t.client.session;
  await t.client.diagnose("second");
  assert.equal(t.backend.count("POST", /^\/api\/sessions$/), 2);
  assert.equal(t.client.session.session_id, first.session_id); // same fake id; the point is a new create call each time
  t.done();
});

test("deciding twice does not execute twice", async () => {
  const t = setup({ reobserve: async () => {} });
  await t.client.diagnose("x");
  await t.client.decide(true);
  await assert.rejects(t.client.decide(true), (e) => e instanceof OperonError && e.code === "invalid_state");
  assert.equal(t.calls.length, 1);
  assert.equal(t.backend.count("POST", /action-result/), 1);
  t.done();
});

test("a conflict from the backend (stale or replayed approval) surfaces as an error and runs nothing", async () => {
  const t = setup({ backend: happyBackend({ "POST /api/sessions/s1/approve": () => [409, { detail: "different proposal" }] }) });
  await t.client.diagnose("x");
  await assert.rejects(t.client.decide(true), (e) => e.code === "conflict");
  assert.deepEqual(t.calls, []);
  t.done();
});
