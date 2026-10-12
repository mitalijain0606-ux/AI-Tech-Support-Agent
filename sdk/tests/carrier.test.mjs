import assert from "node:assert/strict";
import test from "node:test";

import { HANDLER_TIMEOUT_MS, SUPPORTED_ACTIONS, registerOperon } from "../operon-sdk.js";
import { fakeWindow, install } from "./fakes.mjs";

function ask(win, body) {
  return new Promise((resolve) => {
    const id = `t${Math.random()}`;
    win.addEventListener("message", (e) => e.data?.from === "app" && e.data.id === id && resolve(e.data));
    win.postMessage({ operon: 1, from: "extension", id, ...body });
  });
}

test("the extension carrier answers discover and invoke, and nothing else", async () => {
  const win = fakeWindow();
  const restore = install(win);
  const seen = [];
  const off = registerOperon({ appId: "t", actions: { reset_user_preference: (p) => (seen.push(p), { detail: "ok" }), run_javascript: () => {} } });
  assert.deepEqual((await ask(win, { type: "discover" })).actions, ["reset_user_preference"]);
  assert.deepEqual(await ask(win, { type: "invoke", action: "reset_user_preference", params: { preference: "locale" } }).then((r) => [r.ok, r.detail]), [true, "ok"]);
  assert.equal((await ask(win, { type: "invoke", action: "run_javascript", params: {} })).ok, false);
  assert.equal((await ask(win, { type: "invoke", action: "constructor", params: {} })).ok, false);
  assert.equal((await ask(win, { type: "invoke", action: { toString: 1 }, params: {} })).ok, false);
  assert.deepEqual(seen, [{ preference: "locale" }]);
  off();
  restore();
});

test("registering again replaces the previous registration (one reply, not two)", async () => {
  const win = fakeWindow();
  const restore = install(win);
  registerOperon({ appId: "t", actions: { reset_user_preference: () => ({}) } });
  const off2 = registerOperon({ appId: "t", actions: { reset_user_preference: () => ({}) } });
  let replies = 0;
  win.addEventListener("message", (e) => e.data?.from === "app" && e.data.id === "dup" && replies++);
  win.postMessage({ operon: 1, from: "extension", id: "dup", type: "discover" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(replies, 1);
  assert.equal(win.listenerCount("message") >= 1, true);
  off2();
  off2(); // idempotent
  restore();
});

test("cleanup removes the listener; a stuck handler gets a clear timed-out answer", async () => {
  const win = fakeWindow();
  const restore = install(win);
  const off = registerOperon({ appId: "t", actions: { reset_user_preference: () => new Promise(() => {}) } });
  const timers = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => timers(fn, ms === HANDLER_TIMEOUT_MS ? 30 : ms, ...a); // shorten the handler timeout for the test
  const r = await ask(win, { type: "invoke", action: "reset_user_preference", params: {} });
  globalThis.setTimeout = timers;
  assert.equal(r.ok, false);
  assert.match(r.detail, /did not finish in time/);
  off();
  let answered = false;
  win.addEventListener("message", (e) => e.data?.from === "app" && (answered = true));
  win.postMessage({ operon: 1, from: "extension", id: "after-cleanup", type: "discover" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(answered, false, "no reply after cleanup");
  restore();
});

test("bad appId is refused; SUPPORTED_ACTIONS is the closed list", () => {
  const restore = install(fakeWindow());
  assert.throws(() => registerOperon({ appId: "", actions: {} }), TypeError);
  assert.throws(() => registerOperon({ appId: "x".repeat(65), actions: {} }), TypeError);
  assert.deepEqual([...SUPPORTED_ACTIONS], ["reset_user_preference"]);
  assert.throws(() => SUPPORTED_ACTIONS.push("x"));
  restore();
});

test("an opaque origin (file://) does not break replies", async () => {
  const win = fakeWindow();
  win.location.origin = "null";
  const restore = install(win);
  const off = registerOperon({ appId: "t", actions: { reset_user_preference: () => ({}) } });
  assert.equal((await ask(win, { type: "discover" })).type, "capabilities");
  off();
  restore();
});
