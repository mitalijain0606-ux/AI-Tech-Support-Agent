import assert from "node:assert/strict";
import test from "node:test";

import { OperonError, init, validateBackendUrl } from "../operon-sdk.js";
import { fakeWindow, happyBackend, install } from "./fakes.mjs";

const base = (extra = {}) => ({ backendUrl: "https://api.example.com", token: "opk_x", ...extra });
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof OperonError, `expected OperonError, got ${e}`);
    return e.code;
  }
  assert.fail("expected an error");
};

test("backend URLs: https required, loopback http allowed, nothing else", () => {
  assert.equal(validateBackendUrl("https://api.example.com/"), "https://api.example.com");
  assert.equal(validateBackendUrl("https://api.example.com/operon/"), "https://api.example.com/operon");
  assert.equal(validateBackendUrl("http://localhost:8000"), "http://localhost:8000");
  assert.equal(validateBackendUrl("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
  for (const bad of ["http://api.example.com", "ftp://x.test", "not a url", "", undefined, "https://u:p@api.example.com", "https://api.example.com?x=1", "https://api.example.com#frag", "javascript:alert(1)"]) {
    assert.throws(() => validateBackendUrl(bad), (e) => e instanceof OperonError && e.code === "config_invalid", String(bad));
  }
});

test("configuration is validated before anything else happens", () => {
  const restore = install(fakeWindow());
  try {
    const { fetch, calls } = happyBackend();
    assert.equal(code(() => init()), "config_invalid");
    assert.equal(code(() => init(null)), "config_invalid");
    assert.equal(code(() => init({ backendUrl: "https://a.test" })), "config_invalid"); // no token
    assert.equal(code(() => init(base({ getToken: () => "x" }))), "config_invalid"); // both
    assert.equal(code(() => init(base({ token: "   " }))), "config_invalid");
    assert.equal(code(() => init(base({ appId: "" }))), "config_invalid");
    assert.equal(code(() => init(base({ appId: "a".repeat(65) }))), "config_invalid");
    assert.equal(code(() => init(base({ actions: { run_javascript: () => {} } }))), "config_invalid");
    assert.equal(code(() => init(base({ actions: { reset_user_preference: "yes" } }))), "config_invalid");
    assert.equal(code(() => init(base({ builtinActions: ["delete_everything"] }))), "config_invalid");
    assert.equal(code(() => init(base({ builtinActions: ["clear_storage_key"] }))), "config_invalid"); // needs storageKeys
    assert.equal(code(() => init(base({ storageKeys: ["a".repeat(201)] }))), "config_invalid");
    assert.equal(code(() => init(base({ storageKeys: Array.from({ length: 26 }, (_, i) => `k${i}`) }))), "config_invalid");
    assert.equal(code(() => init(base({ reobserve: "nope" }))), "config_invalid");
    assert.equal(calls.length, 0);
    void fetch;
  } finally {
    restore();
  }
});

test("outside a browser the SDK refuses to start, with a clear error", () => {
  assert.equal(code(() => init(base())), "unsupported_environment");
});

test("without fetch there is no client", () => {
  const win = fakeWindow();
  win.fetch = undefined;
  const restore = install(win);
  try {
    assert.equal(code(() => init(base())), "unsupported_environment");
    assert.equal(typeof init(base({ fetch: async () => ({}) })).dispose, "function"); // an injected fetch is enough
  } finally {
    restore();
  }
});

test("numeric options are clamped, not trusted", () => {
  const restore = install(fakeWindow());
  try {
    const c = init(base({ timeoutMs: -5, maxCycles: 9999, maxEvidenceBytes: 1, fetch: happyBackend().fetch }));
    assert.equal(c.disposed, false);
    c.dispose();
  } finally {
    restore();
  }
});

test("init twice for the same app disposes the first client: no duplicate wrappers", () => {
  const win = fakeWindow();
  const original = win.console.error;
  const restore = install(win);
  try {
    const cfg = base({ capture: { console: true }, fetch: happyBackend().fetch });
    const first = init(cfg);
    const wrappedOnce = win.console.error;
    assert.notEqual(wrappedOnce, original);
    const second = init(cfg);
    assert.equal(first.disposed, true);
    assert.equal(second.disposed, false);
    win.console.error("x");
    assert.equal(win._log.error.length, 1); // the app's own console.error ran exactly once
    second.dispose();
    assert.equal(win.console.error, original); // fully restored
    assert.equal(win.listenerCount("error"), 0);
    assert.equal(win.listenerCount("unhandledrejection"), 0);
    second.dispose(); // idempotent
    first.dispose();
  } finally {
    restore();
  }
});

test("different apps keep independent clients", () => {
  const restore = install(fakeWindow());
  try {
    const f = happyBackend().fetch;
    const a = init(base({ appId: "a", fetch: f }));
    const b = init(base({ appId: "b", fetch: f }));
    assert.equal(a.disposed, false);
    assert.equal(b.disposed, false);
    a.dispose();
    b.dispose();
  } finally {
    restore();
  }
});
