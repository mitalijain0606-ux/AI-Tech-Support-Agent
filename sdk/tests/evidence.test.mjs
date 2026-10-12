import assert from "node:assert/strict";
import test from "node:test";

import { OperonError, init } from "../operon-sdk.js";
import { evidenceRequest, fakeBackend, fakeWindow, happyBackend, install, session } from "./fakes.mjs";

const j = (...p) => p.join("");
const GH = j("gh", "p_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0");
const JWT = j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r");

function run({ storage = {}, config = {}, request = evidenceRequest() } = {}) {
  const win = fakeWindow({ storage });
  const restore = install(win);
  let bundle;
  const backend = happyBackend({
    "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: request })],
    "POST /api/sessions/s1/investigate": (b) => ((bundle = b.bundle), [200, { session: session("ESCALATED") }]),
  });
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: backend.fetch, evidenceWaitMs: 0, ...config });
  return { win, client, backend, bundle: () => bundle, done: () => (client.dispose(), restore()) };
}

test("captured console output is bounded, labelled, and redacted", async () => {
  const t = run({ config: { capture: { console: true } } });
  t.win.console.error("Failed to load settings", new Error(`bad token ${GH}`));
  t.win.console.warn(`jwt ${JWT}`);
  t.win.console.error({ nested: { deep: "x".repeat(5000) } });
  for (let i = 0; i < 100; i++) t.win.console.error(`noise ${i}`);
  await t.client.diagnose("broken");
  const b = t.bundle();
  assert.ok(b.console.length <= 40);
  const wire = JSON.stringify(b);
  assert.ok(!wire.includes(GH) && !wire.includes(JWT), "no secret in the evidence");
  assert.ok(b.console.every((c) => c.text.length <= 500 && c.id && ["error", "warn"].includes(c.level)));
  assert.equal(t.backend.calls.find((c) => c.path.endsWith("/investigate")).body.bundle.collectors.includes("console"), true);
  t.done();
});

test("page errors and unhandled rejections are captured; the app's own console still works", async () => {
  const t = run({ config: { capture: { console: true } } });
  t.win._listeners.get("error").forEach((fn) => fn({ message: "TypeError: x is undefined", filename: "https://app.test/a.js?token=abc123456" }));
  t.win._listeners.get("unhandledrejection").forEach((fn) => fn({ reason: new Error("rejected") }));
  t.win.console.error("still reaches the app");
  assert.equal(t.win._log.error.length, 1);
  await t.client.diagnose("broken");
  const texts = t.bundle().console.map((c) => c.text);
  assert.ok(texts.some((x) => x.includes("TypeError")) && texts.some((x) => x.includes("Unhandled rejection")));
  t.done();
});

test("nothing is captured unless the app opts in", async () => {
  const t = run();
  t.win.console.error("an error");
  await t.client.diagnose("broken");
  assert.deepEqual(t.bundle().console, []);
  assert.deepEqual(t.bundle().network, []);
  t.done();
});

test("network capture records failures only, drops query strings, and ignores Operon's own traffic", async () => {
  const t = run({ config: { capture: { network: true } }, request: evidenceRequest({ collectors: ["network", "page"] }) });
  const real = t.win.fetch;
  t.win.fetch = async (url) => {
    if (String(url).includes("boom")) throw new TypeError("Failed to fetch");
    return { ok: false, status: String(url).includes("missing") ? 404 : 200, statusText: "Not Found" };
  };
  // re-wrap happens at init(); simulate by re-initialising with the replaced fetch
  t.client.dispose();
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: t.backend.fetch, evidenceWaitMs: 0, capture: { network: true } });
  await t.win.fetch(`https://app.test/api/missing?access_token=${GH}`);
  await t.win.fetch("https://app.test/api/fine");
  await t.win.fetch("https://app.test/api/boom").catch(() => {});
  await t.win.fetch("https://api.example.com/api/sessions/s1/events"); // Operon's own backend: never reported
  await client.diagnose("broken");
  const net = t.backend.calls.filter((c) => c.path.endsWith("/investigate")).at(-1).body.bundle.network;
  assert.deepEqual(net.map((n) => [n.status, n.url]), [[404, "https://app.test/api/missing"], [0, "https://app.test/api/boom"]]);
  assert.ok(!JSON.stringify(net).includes(GH));
  client.dispose();
  void real;
});

test("storage: only listed keys, shape only, never a value", async () => {
  const SECRET_VALUE = `{"token":"${GH}"`; // corrupt JSON containing a token
  const t = run({
    storage: { app_settings: SECRET_VALUE, app_prefs: '{"ok":true}', unlisted: "{bad", plain: "hello" },
    config: { storageKeys: ["app_settings", "app_prefs", "missing_key"] },
    request: evidenceRequest({ collectors: ["storage"], params: { storage_keys: ["unlisted", "missing_key"], observe_ms: 0 } }),
  });
  await t.client.diagnose("broken");
  const storage = t.bundle().storage;
  const byKey = Object.fromEntries(storage.map((s) => [s.key, s]));
  assert.equal(byKey.app_settings.parse_status, "syntax_error");
  assert.equal(byKey.app_prefs.parse_status, "valid_json");
  assert.equal(byKey.missing_key.present, false); // asked about, so reported absent
  assert.ok(!("unlisted" in byKey) && !("plain" in byKey), "unlisted keys are never read, even when the backend asks");
  const wire = JSON.stringify(t.bundle());
  assert.ok(!wire.includes(GH) && !wire.includes("hello"));
  t.done();
});

test("page signal: path without query, truncated title, selector count, bad selector survives", async () => {
  const t = run({ request: evidenceRequest({ collectors: ["page"], params: { selector: ".row", storage_keys: [], observe_ms: 0 } }) });
  t.win.location.pathname = "/dashboard";
  t.win.document.title = "T".repeat(500);
  t.win._registrations = [{ scope: "https://app.test/", unregister: async () => true }];
  await t.client.diagnose("broken");
  const page = t.bundle().page[0];
  assert.equal(page.url_path, "/dashboard");
  assert.ok(page.title.length <= 120);
  assert.equal(page.selector_matches, 2);
  assert.deepEqual(page.service_worker_scopes, ["/"]);
  assert.ok(!t.bundle().url.includes("?"));
  t.done();
  const bad = run({ request: evidenceRequest({ collectors: ["page"], params: { selector: "!!", storage_keys: [], observe_ms: 0 } }) });
  await bad.client.diagnose("broken");
  assert.equal(bad.bundle().page[0].selector_matches, null);
  bad.done();
});

test("collectors the SDK cannot perform are reported, not faked", async () => {
  const t = run({ request: evidenceRequest({ collectors: ["page", "cookies", "reload_observe"] }) });
  await t.client.diagnose("broken");
  assert.deepEqual(t.bundle().collection_errors, ["cookies_unsupported_in_sdk", "reload_observe_unsupported_in_sdk"]);
  assert.deepEqual(t.bundle().cookies, []);
  t.done();
});

test("oversized evidence is trimmed oldest-first, or refused if it still does not fit", async () => {
  const t = run({ config: { capture: { console: true }, maxEvidenceBytes: 10_000 } });
  for (let i = 0; i < 40; i++) t.win.console.error(`line ${i} ${"y".repeat(400)}`);
  await t.client.diagnose("broken");
  const b = t.bundle();
  assert.ok(JSON.stringify({ bundle: b }).length <= 10_000 + 200);
  assert.ok(b.console.at(-1).text.startsWith("line 39"), "the newest entries survive");
  t.done();

  const tiny = run({ config: { maxEvidenceBytes: 1_000 }, request: evidenceRequest({ collectors: ["page"] }) });
  tiny.win.document.title = "x".repeat(120);
  tiny.win.location.pathname = "/" + "p".repeat(900);
  await assert.rejects(tiny.client.diagnose("broken"), (e) => e instanceof OperonError && e.code === "payload_too_large");
  tiny.done();
});

test("the description and answers are redacted before they leave, including unknown-format keys", async () => {
  const KEY = "Zq9Xk2LmN8vB4cR7tY1wE5uI3oP6aS0d";
  const asks = happyBackend({
    "POST /api/sessions": () => [200, session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "What did you click?" }) })],
    "POST /api/sessions/s1/answer": () => [200, session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "What did you click?" }) })],
  });
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: asks.fetch });
  const result = await client.diagnose(`broken. token ${GH}, key ${KEY}, my password is hunter2x9. Please help`);
  assert.equal(result.state, "needs_answer");
  assert.equal(result.question, "What did you click?");
  await client.answer(`I pasted ${GH} and ${JWT}`);
  const wire = asks.calls.map((c) => c.raw ?? "").join("\n");
  for (const secret of [GH, JWT, KEY, "hunter2x9"]) assert.ok(!wire.includes(secret), `${secret.slice(0, 8)}… leaked`);
  assert.match(asks.calls[0].body.user_issue, /Please help/);
  assert.match(asks.calls.find((c) => c.path.endsWith("/answer")).body.answer, /\[REDACTED:/);
  client.dispose();
  restore();
});

test("with a question open the SDK stops and waits instead of looping", async () => {
  const asks = fakeBackend({
    "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: evidenceRequest() })],
    "POST /api/sessions/s1/investigate": () => [200, { session: session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "q?" }) }) }],
    "POST /api/sessions/s1/answer": () => [200, session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "q?" }) })],
  });
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: asks.fetch, evidenceWaitMs: 0 });
  assert.equal((await client.diagnose("x")).state, "needs_answer");
  assert.equal(asks.count("POST", /investigate/), 1);
  client.dispose();
  restore();
});

test("the evidence loop is bounded", async () => {
  const loop = fakeBackend({
    "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: evidenceRequest() })],
    "POST /api/sessions/s1/investigate": () => [200, { session: session("NEED_INFORMATION", { evidence_request: evidenceRequest() }) }],
  });
  const win = fakeWindow();
  const restore = install(win);
  const client = init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: loop.fetch, evidenceWaitMs: 0, maxCycles: 3 });
  const r = await client.diagnose("x");
  assert.equal(r.state, "needs_evidence");
  assert.equal(loop.count("POST", /investigate/), 3);
  client.dispose();
  restore();
});

test("console lines in formats no fixed rule knows are redacted too (unknown keys, vendor keys, stated passwords)", async () => {
  const KEY = "Zq9Xk2LmN8vB4cR7tY1wE5uI3oP6aS0d";
  const VENDOR = j("sk_li", "ve_", "4eC39HqLyjWDarjtT1zdp7dc");
  const t = run({ config: { capture: { console: true } } });
  t.win.console.error(`auth failed key=${KEY} vendor ${VENDOR}; my password is hunter2x9`);
  t.win.console.error("TypeError: Cannot read properties of undefined (reading 'map') at renderProjectListItems");
  await t.client.diagnose("broken");
  const wire = JSON.stringify(t.bundle());
  for (const secret of [KEY, VENDOR, "hunter2x9"]) assert.ok(!wire.includes(secret), `${secret.slice(0, 8)} leaked`);
  assert.equal(t.bundle().console[1].text, "TypeError: Cannot read properties of undefined (reading 'map') at renderProjectListItems");
  t.done();
});

test("a JSON parser's error message cannot carry the stored value out", async () => {
  const VALUE = `{"session_id":"${GH}","note":"private-note-text"`;
  const t = run({ storage: { app_settings: VALUE }, config: { storageKeys: ["app_settings"] }, request: evidenceRequest({ collectors: ["storage"], params: { storage_keys: [], observe_ms: 0 } }) });
  await t.client.diagnose("broken");
  const row = t.bundle().storage[0];
  assert.equal(row.parse_status, "syntax_error");
  assert.ok(!/private-note|session_id|ghp_/.test(JSON.stringify(row)), JSON.stringify(row));
  t.done();
});
