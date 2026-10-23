// resume(): re-attach to an investigation after a page reload, from its id alone.
import assert from "node:assert/strict";
import test from "node:test";

import { OperonError, init } from "../operon-sdk.js";
import { fakeWindow, happyBackend, install, proposal, session } from "./fakes.mjs";

function setup(over = {}) {
  const win = fakeWindow();
  const restore = install(win);
  const backend = happyBackend(over);
  const calls = [];
  const client = init({
    backendUrl: "https://api.example.com", token: "opk_x", fetch: backend.fetch, evidenceWaitMs: 0, maxObserveMs: 50,
    actions: { reset_user_preference: async (p) => (calls.push(p), { detail: "reset" }) },
  });
  return { client, backend, calls, done: () => (client.dispose(), restore()) };
}
const pending = proposal();

test("a pending proposal is picked up and can then be approved; nothing runs on resume", async () => {
  const t = setup({ "GET /api/sessions/s1": () => [200, session("ACTION_PROPOSED", { pending_action: pending })] });
  const r = await t.client.resume("s1");
  assert.equal(r.state, "proposal");
  assert.equal(r.proposal.action_id, "reset_user_preference");
  assert.deepEqual(t.calls, [], "resume ran nothing");
  assert.equal(t.backend.calls.filter((c) => c.method === "POST").length, 0, "resume changed nothing on the backend");
  const d = await t.client.decide(true);
  assert.equal(d.state, "resolved");
  assert.deepEqual(t.calls, [{ preference: "timezone" }]);
  t.done();
});

test("finished investigations come back as they ended", async () => {
  for (const [phase, extra, state] of [["RESOLVED", { resolution_state: "resolved" }, "resolved"], ["ESCALATED", { escalation_state: { reason: "r", ticket_id: "tkt_1" } }, "escalated"], ["RESOLVED", { resolution_state: "declined_by_user" }, "declined"]]) {
    const t = setup({ "GET /api/sessions/s1": () => [200, session(phase, extra)] });
    assert.equal((await t.client.resume("s1")).state, state);
    t.done();
  }
});

test("a reload while the approved fix was running is reported as interrupted, never as success", async () => {
  const t = setup({
    "GET /api/sessions/s1": () => [200, session("EXECUTING", { pending_action: pending })],
    "POST /api/sessions/s1/action-result": () => [200, session("ESCALATED", { pending_action: pending, escalation_state: { reason: "interrupted" } })],
  });
  const r = await t.client.resume("s1");
  const report = t.backend.calls.find((c) => c.path.endsWith("/action-result")).body;
  assert.equal(report.succeeded, false);
  assert.match(report.detail, /interrupted/);
  assert.equal(r.state, "escalated");
  assert.deepEqual(t.calls, [], "the fix is not run again on resume");
  t.done();
});

test("a reload during verification reports the observation as interrupted", async () => {
  const t = setup({
    "GET /api/sessions/s1": () => [200, session("VERIFYING", { pending_action: pending })],
    "POST /api/sessions/s1/verify": (b) => [200, session("ESCALATED", { pending_action: pending, observed: b })],
  });
  await t.client.resume("s1");
  const verify = t.backend.calls.find((c) => c.path.endsWith("/verify")).body;
  assert.match(verify.observation.error, /interrupted/);
  assert.ok(!("passed" in verify));
  t.done();
});

test("bad ids are refused before any request; another session's answer is refused", async () => {
  const t = setup({ "GET /api/sessions/s1": () => [200, session("ACTION_PROPOSED", { session_id: "other" })] });
  for (const bad of ["", "../x", "a/b", "x".repeat(65), null]) await assert.rejects(t.client.resume(bad), (e) => e instanceof OperonError && e.code === "config_invalid");
  await assert.rejects(t.client.resume("s1"), (e) => e.code === "malformed_response");
  t.done();
});
