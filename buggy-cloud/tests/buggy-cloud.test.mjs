// Buggy Cloud's own logic: bug definitions, activation, preferences, API
// helpers, server behaviour. Run with `node --test tests/`.
import assert from "node:assert/strict";
import test from "node:test";

import { activeBug, ensureStaleWorker, resetScenario, seedBug, wantsReset } from "../src/activate.js";
import { createApi } from "../src/api.js";
import { BUGS, PREFS_KEY, SETTINGS_KEY, bugById } from "../src/bugs.js";
import { DEFAULT_PREFS, RESETTABLE, formatDate, formatMoney, loadPrefs, resetPreference } from "../src/prefs.js";
import { startBuggyCloud } from "../server.mjs";

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
};

test("there are at least five bugs, uniquely numbered, each with a ground-truth diagnosis", () => {
  assert.ok(BUGS.length >= 5);
  assert.equal(new Set(BUGS.map((b) => b.id)).size, BUGS.length);
  for (const b of BUGS) {
    assert.ok(b.slug && b.title && b.symptom);
    assert.ok(b.expected.category);
    assert.equal(b.expected.action_id === null, b.expected.params === null);
  }
});

test("?bug=N selects exactly the defined bugs", () => {
  assert.equal(activeBug("?bug=2").slug, "invalid-timezone");
  for (const bad of ["", "?bug=", "?bug=0", "?bug=99", "?bug=abc", "?bug=1;2", "?bug=-1", "?other=1"]) assert.equal(activeBug(bad), null, bad);
  assert.equal(bugById(7).slug, "stale-service-worker");
});

test("seeding plants the bad value once, so a fix stays fixed", () => {
  const s = memory();
  const bug = bugById(1);
  assert.equal(seedBug(bug, s), true);
  assert.equal(s.getItem(SETTINGS_KEY), "{broken");
  assert.throws(() => JSON.parse(s.getItem(SETTINGS_KEY)));
  s.removeItem(SETTINGS_KEY); // the fix
  assert.equal(seedBug(bug, s), false); // reload with ?bug=1: not re-planted
  assert.equal(s.getItem(SETTINGS_KEY), null);
});

test("server-side bugs seed nothing", () => {
  for (const id of [4, 5, 6]) assert.equal(seedBug(bugById(id), memory()), false);
});

test("the invalid preferences really make Intl throw (nothing is faked)", () => {
  const tz = memory();
  seedBug(bugById(2), tz);
  assert.throws(() => formatDate("2026-10-01T00:00:00Z", loadPrefs(tz, PREFS_KEY)), /Invalid time zone/);
  const cur = memory();
  seedBug(bugById(3), cur);
  assert.throws(() => formatMoney(5, loadPrefs(cur, PREFS_KEY)), /Invalid currency/);
  assert.match(formatMoney(5, DEFAULT_PREFS), /\$5\.00/);
});

test("resetPreference fixes one preference and touches nothing else", () => {
  const s = memory();
  s.setItem(PREFS_KEY, JSON.stringify({ timezone: "Mars/Phobos", locale: "de-DE", currency: "EUR" }));
  s.setItem("unrelated", "keep");
  const out = resetPreference(s, PREFS_KEY, "timezone");
  assert.match(out.detail, /timezone/);
  assert.deepEqual(JSON.parse(s.getItem(PREFS_KEY)), { timezone: "UTC", locale: "de-DE", currency: "EUR" });
  assert.equal(s.getItem("unrelated"), "keep");
  assert.doesNotThrow(() => formatDate("2026-10-01T00:00:00Z", loadPrefs(s, PREFS_KEY)));
});

test("resetPreference refuses anything outside the allowlist", () => {
  const s = memory();
  for (const bad of ["password", "theme", "", null, undefined, ["timezone"], "__proto__"]) {
    assert.throws(() => resetPreference(s, PREFS_KEY, bad));
  }
  assert.equal(s.m.size, 0);
  assert.deepEqual([...RESETTABLE], ["timezone", "locale", "currency"]);
});

test("the stale worker is registered once and counts as present until removed", async () => {
  const regs = [];
  const nav = { serviceWorker: { register: async (u, o) => void regs.push({ u, o }), getRegistrations: async () => [...regs] } };
  const s = memory();
  assert.equal(await ensureStaleWorker(bugById(7), s, nav), true);
  assert.equal(regs.length, 1);
  assert.equal(await ensureStaleWorker(bugById(7), s, nav), true);
  assert.equal(regs.length, 1); // not re-registered
  regs.length = 0; // the fix: unregistered
  assert.equal(await ensureStaleWorker(bugById(7), s, nav), false);
  assert.equal(await ensureStaleWorker(bugById(1), memory(), nav), false);
});

test("API helpers call the right URLs and surface HTTP errors", async () => {
  const seen = [];
  const api = createApi({ reportsBase: "http://r.test", bug: bugById(4), fetchImpl: async (u) => (seen.push(u), { ok: false, status: 500, statusText: "Server Error" }) });
  await assert.rejects(api.projects(), /500/);
  await assert.rejects(api.reports(), /500/);
  assert.deepEqual(seen, ["/api/projects?bug=4", "http://r.test/api/reports?bug=4"]);
});

test("the server returns the documented failure for each server-side bug, and only for it", async () => {
  const app = await startBuggyCloud();
  try {
    const get = async (p, base = app.url) => fetch(base + p);
    assert.equal((await get("/api/projects")).status, 200);
    assert.equal((await get("/api/projects?bug=4")).status, 500);
    assert.equal((await get("/api/projects?bug=5")).status, 200);
    assert.equal((await get("/api/me?bug=5")).status, 401);
    assert.equal((await get("/api/me")).status, 200);
    const ok = await get("/api/reports", app.reportsUrl);
    assert.equal(ok.headers.get("access-control-allow-origin"), app.url);
    const blocked = await get("/api/reports?bug=6", app.reportsUrl);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    assert.equal((await get("/../backend/pyproject.toml")).status, 404); // no path escape
    assert.match(await (await get("/")).text(), new RegExp(app.reportsUrl.replace(/\./g, "\\.")));
  } finally {
    await app.close();
  }
});

test("API helpers look fetch up at call time, so a wrapper installed later (the SDK's network capture) sees the requests", async () => {
  const seen = [];
  const original = globalThis.fetch;
  const api = createApi({ reportsBase: "http://r.test", bug: null });
  globalThis.fetch = async (u) => (seen.push(u), { ok: true, json: async () => ({ projects: [] }) });
  try {
    await api.projects();
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(seen, ["/api/projects"]);
});

test("the Operon config endpoint exists only when the server was started with one (local testing)", async () => {
  const without = await startBuggyCloud();
  const withCfg = await startBuggyCloud({ operon: { backendUrl: "http://localhost:8000", token: "opk_local" } });
  try {
    assert.equal((await fetch(`${without.url}/operon-config.json`)).status, 404);
    const res = await fetch(`${withCfg.url}/operon-config.json`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { backendUrl: "http://localhost:8000", token: "opk_local" });
    assert.match(await (await fetch(`${withCfg.url}/sdk/redact.js`)).text(), /redactFreeText/); // the SDK's dependency is served
    assert.equal((await fetch(`${withCfg.url}/sdk/..%2fpackage.json`)).status, 404);
  } finally {
    await without.close();
    await withCfg.close();
  }
});

test("a scenario can be reset and run again: only Buggy Cloud's own state is removed", async () => {
  const s = memory();
  seedBug(bugById(2), s);
  s.setItem("other_app_key", "keep");
  const regs = [{ unregister: async () => true }, { unregister: async () => true }];
  const out = await resetScenario(s, { serviceWorker: { getRegistrations: async () => regs } });
  assert.equal(out.unregistered, 2);
  assert.equal(s.getItem(PREFS_KEY), null);
  assert.equal(s.getItem("buggycloud_seeded"), null);
  assert.equal(s.getItem("other_app_key"), "keep");
  assert.equal(seedBug(bugById(2), s), true); // seeds again, as on a first visit
  assert.deepEqual([wantsReset("?bug=2&reset=1"), wantsReset("?bug=2"), wantsReset("?reset=0")], [true, false, false]);
  assert.deepEqual(await resetScenario(memory(), {}), { unregistered: 0 }); // no service worker support is fine
});

test("five screens, each reachable by its own hash route; unknown routes show the overview", async () => {
  const { ROUTES, routeOf } = await import("../src/ui.js");
  assert.deepEqual(ROUTES.map((r) => r.title), ["Overview", "Projects", "Reports", "Account", "Settings"]);
  for (const r of ROUTES) assert.equal(routeOf(r.hash), r);
  for (const bad of ["", "#", "#/nope", "#/projects/../settings", "javascript:alert(1)"]) assert.equal(routeOf(bad).title, "Overview", bad);
});
