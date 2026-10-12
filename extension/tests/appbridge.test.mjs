// The extension<->page SDK protocol, with the SDK and the bridge wired to a
// shared fake window. The page is untrusted: the bridge intersects what it
// announces with a closed list, validates parameters, and survives silence.
import assert from "node:assert/strict";
import test from "node:test";

import { bundle } from "./helpers.mjs";

const load = async (file) => import(`data:text/javascript;base64,${Buffer.from(await bundle(file)).toString("base64")}`);
const { discoverAppActions, invokeAppAction } = await load("src/lib/appbridge.ts");

// A window where posted messages are delivered back to its own listeners
// (event.source === window), exactly like a real window.postMessage.
function fakeWindow() {
  const listeners = new Set();
  const win = {
    location: { origin: "https://app.test" },
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    postMessage: (data) => queueMicrotask(() => [...listeners].forEach((fn) => fn({ source: win, data }))),
  };
  return win;
}

async function withSdk(win, actions) {
  globalThis.window = win;
  const sdk = await import("../../sdk/operon-sdk.js?" + Math.random());
  return sdk.registerOperon({ appId: "test", actions });
}

test("discovery returns only closed-list actions the page registered", async () => {
  const win = fakeWindow();
  await withSdk(win, { reset_user_preference: () => ({}), run_javascript: () => ({}), clear_storage_key: () => ({}) });
  assert.deepEqual(await discoverAppActions(win), ["reset_user_preference"]);
});

test("a page announcing extra actions cannot widen the set", async () => {
  const win = fakeWindow();
  win.addEventListener("message", (e) => {
    if (e.data?.from === "extension") win.postMessage({ operon: 1, from: "app", id: e.data.id, type: "capabilities", actions: ["run_javascript", "clear_storage_key", "reset_user_preference"] });
  });
  assert.deepEqual(await discoverAppActions(win), ["reset_user_preference"]);
});

test("without an SDK discovery is empty, after a bounded wait", async () => {
  const started = Date.now();
  assert.deepEqual(await discoverAppActions(fakeWindow()), []);
  assert.ok(Date.now() - started < 3000);
});

test("invoke runs the page's handler and reports its result", async () => {
  const win = fakeWindow();
  const calls = [];
  await withSdk(win, { reset_user_preference: (p) => (calls.push(p), { detail: "reset timezone" }) });
  const out = await invokeAppAction(win, "reset_user_preference", { preference: "timezone", extra: "ignored" });
  assert.deepEqual(out, { ok: true, detail: "reset timezone" });
  assert.deepEqual(calls, [{ preference: "timezone" }]); // only the validated field is sent
});

test("a handler that throws is a failure, not a crash", async () => {
  const win = fakeWindow();
  await withSdk(win, { reset_user_preference: () => { throw new Error("nope"); } });
  assert.deepEqual(await invokeAppAction(win, "reset_user_preference", { preference: "locale" }), { ok: false, detail: "nope" });
});

test("invalid actions and parameters never reach the page", async () => {
  const win = fakeWindow();
  const calls = [];
  await withSdk(win, { reset_user_preference: (p) => (calls.push(p), {}) });
  for (const params of [{}, { preference: "password" }, { preference: ["timezone"] }, { preference: "timezone; x" }]) {
    assert.equal((await invokeAppAction(win, "reset_user_preference", params)).ok, false);
  }
  assert.equal((await invokeAppAction(win, "run_javascript", { code: "alert(1)" })).ok, false);
  assert.equal(calls.length, 0);
});

test("messages with the wrong protocol version or direction are ignored", async () => {
  const win = fakeWindow();
  const calls = [];
  await withSdk(win, { reset_user_preference: (p) => (calls.push(p), {}) });
  const invoke = { type: "invoke", action: "reset_user_preference", params: { preference: "timezone" } };
  win.postMessage({ operon: 2, from: "extension", id: "y", ...invoke });
  win.postMessage({ operon: 1, from: "app", id: "z", ...invoke });
  win.postMessage({ operon: 1, from: "extension", ...invoke }); // no id
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 0);
});

test("an unknown action asked of the SDK is refused by the SDK itself", async () => {
  const win = fakeWindow();
  await withSdk(win, { reset_user_preference: () => ({}) });
  const reply = await new Promise((resolve) => {
    win.addEventListener("message", (e) => e.data?.from === "app" && e.data.id === "id1" && resolve(e.data));
    win.postMessage({ operon: 1, from: "extension", id: "id1", type: "invoke", action: "constructor", params: {} });
  });
  assert.equal(reply.ok, false);
});
