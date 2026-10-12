// Popup lifecycle through the real bundled background worker: unsupported pages, duplicate
// clicks, closing and reopening the popup, session isolation, and the manifest's permissions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { awaitingApproval, createWorld, evidenceRequest, flush, plan, session } from "./helpers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const done = () => ({ diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) });

const UNSUPPORTED = [
  "chrome://extensions/",
  "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html",
  "about:blank",
  "file:///home/user/page.html",
  "edge://settings",
  "https://chromewebstore.google.com/detail/some-extension/abc",
  "https://chrome.google.com/webstore/detail/x",
];
for (const url of UNSUPPORTED) {
  test(`${url.split("/")[0]}// page: a clear 'unsupported' message, and nothing is sent anywhere`, async () => {
    const world = await createWorld({ tabs: [{ id: 5, url }], content: () => ({}), backend: () => ({ status: 500, body: {} }) }).load();
    const popup = world.connect();
    popup.send({ type: "ASK_OPERON", message: "help" });
    await world.until(() => popup.last()?.phase === "error", "error state");
    assert.match(popup.last().message, /can't investigate this kind of page/);
    assert.equal(world.requests.filter((r) => r.path.startsWith("/api")).length, 0, "no backend request");
    assert.ok(!world.log.some((e) => e === "attach"), "the debugger was never attached");
  });
}

test("ordinary http and https pages are supported", async () => {
  for (const url of ["https://github.com/o/r", "http://localhost:3000/app", "http://127.0.0.1:4300/?bug=1"]) {
    const world = await createWorld({
      tabs: [{ id: 5, url }],
      content: () => ({}),
      backend: (m, p) => (p === "/api/sessions" ? session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) }) : done()),
    }).load();
    const popup = world.connect();
    popup.send({ type: "ASK_OPERON", message: "help" });
    await world.until(() => popup.last()?.phase === "escalated", url);
  }
});

test("a double click on Approve reaches the backend once and runs the fix once", async () => {
  const pending = plan("clear_storage_key", { cited: { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] } });
  let release;
  const gate = new Promise((r) => (release = r));
  const world = await createWorld({
    initialStorage: awaitingApproval(pending),
    content: (msg) => (msg.type === "CHECK_STORAGE" ? { storage: [{ key: "operon_demo_cache", present: false, parse_status: "empty" }] } : {}),
    backend: async (method, path) => {
      if (path.endsWith("/approve")) return (await gate, session("EXECUTING", { pending_action: pending }));
      if (path.endsWith("/action-result")) return session("VERIFYING", { pending_action: pending });
      if (path.endsWith("/verify")) return session("RESOLVED", { pending_action: pending, verification_state: { outcome: "passed", passed: true, message: "ok", at: "t" } });
      return { status: 500, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  popup.send({ type: "APPROVE" });
  popup.send({ type: "DENY" }); // a deny racing the approval is also ignored while the approval is in flight
  await flush(30);
  release();
  await world.until(() => popup.last()?.phase === "resolved", "resolved");
  assert.equal(world.calls("/approve").length, 1);
  assert.equal(world.calls("/action-result").length, 1);
  assert.equal(world.calls("/verify").length, 1);
  assert.equal(world.log.filter((e) => String(e).includes("CLEAR_STORAGE_KEY")).length, 1, "the key was cleared exactly once");
});

test("RESET always works, even while another command is stuck", async () => {
  const world = await createWorld({
    content: () => ({}),
    backend: () => new Promise(() => {}), // never answers
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "help" });
  await flush(30);
  popup.send({ type: "RESET" });
  await world.until(() => popup.last()?.phase === "idle", "reset to idle");
});

test("closing and reopening the popup shows the real state, not a stale one", async () => {
  const pending = plan("clear_storage_key", { cited: { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] } });
  const world = await createWorld({ initialStorage: awaitingApproval(pending), backend: () => ({ status: 500, body: {} }) }).load();
  const first = world.connect();
  await world.until(() => first.last()?.phase === "awaiting_approval", "first popup");
  const second = world.connect(); // the popup was closed and opened again
  await world.until(() => second.last()?.phase === "awaiting_approval", "second popup");
  assert.equal(second.last().session.pending_action.proposal_id, pending.proposal_id);
  assert.equal(world.calls("/approve").length, 0, "reopening approves nothing");
});

test("after RESET a new question is a new session; nothing from the old one carries over", async () => {
  let n = 0;
  const world = await createWorld({
    content: () => ({}),
    backend: (m, p) => {
      if (p === "/api/sessions") return { ...session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) }), session_id: `s${++n}` };
      return { diagnosis: null, session: { ...done().session, session_id: p.split("/")[3] } };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "first" });
  await world.until(() => popup.last()?.phase === "escalated", "first done");
  const first = popup.last().session.session_id;
  popup.send({ type: "RESET" });
  await world.until(() => popup.last()?.phase === "idle", "idle");
  assert.equal(popup.last().session ?? null, null);
  popup.send({ type: "ASK_OPERON", message: "second" });
  await world.until(() => popup.last()?.phase === "escalated", "second done");
  assert.notEqual(popup.last().session.session_id, first);
  assert.equal(world.calls("/api/sessions").filter((c) => c.body?.user_issue).length, 2);
});

test("a rejected fix leaves the page untouched and never executes", async () => {
  const pending = plan("clear_storage_key", { cited: { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] } });
  const world = await createWorld({
    initialStorage: awaitingApproval(pending),
    content: () => ({}),
    backend: (m, p) => (p.endsWith("/approve") ? session("RESOLVED", { pending_action: pending, resolution_state: "declined_by_user" }) : { status: 500, body: {} }),
  }).load();
  const popup = world.connect();
  popup.send({ type: "DENY" });
  await world.until(() => popup.last()?.phase === "resolved", "resolved(declined)");
  assert.deepEqual(world.calls("/approve")[0].body, { approved: false, proposal_id: pending.proposal_id });
  assert.equal(world.calls("/action-result").length, 0);
  assert.ok(!world.log.some((e) => String(e).includes("CLEAR_STORAGE_KEY")));
});

test("the built manifest asks only for permissions the code uses", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "operon-lifecycle-build-"));
  execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "github"], { cwd: root, env: { ...process.env, OPERON_BACKEND_URL: "http://localhost:8000", OPERON_BUILD_OUT: out }, stdio: "ignore" });
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf-8"));
  const code = readFileSync(path.join(root, "src/background.ts"), "utf-8") + readFileSync(path.join(root, "src/content.ts"), "utf-8");
  const uses = { debugger: /chrome\.debugger\./, storage: /chrome\.storage\./, cookies: /chrome\.cookies\./, scripting: /chrome\.scripting\./, activeTab: /activeTab/, tabs: /chrome\.tabs\./ };
  assert.deepEqual([...manifest.permissions].sort(), ["cookies", "debugger", "storage"]);
  for (const permission of manifest.permissions) assert.match(code, uses[permission], `permission '${permission}' has no use in the code`);
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ["https://github.com/*", "http://localhost:8000/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://github.com/*"]);
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>") && !JSON.stringify(manifest).includes("*://*/*"));
});
