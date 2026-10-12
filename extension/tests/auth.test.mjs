// Access token handling in the extension: stored locally, sent only as an
// Authorization header to the backend, never part of evidence or UI state,
// and the backend's 401 / 429 answers become clear messages.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { awaitingApproval, createWorld, evidenceRequest, flush, plan, session } from "./helpers.mjs";

const TOKEN = "opk_" + "Zq9".repeat(14);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const done = () => ({ diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) });
const happy = (method, path) => {
  if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
  if (path.endsWith("/investigate")) return done();
  return { status: 404, body: {} };
};

async function ask(world) {
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "page broken" });
  return popup;
}

test("without a saved token no Authorization header is sent", async () => {
  const world = await createWorld({ content: () => ({}), backend: happy }).load();
  const popup = await ask(world);
  await world.until(() => popup.last()?.phase === "escalated", "done");
  assert.ok(world.requests.length > 0);
  assert.ok(world.requests.every((r) => !("Authorization" in r.headers)));
  assert.equal(popup.last().tokenSet, false);
});

test("SET_TOKEN stores the token locally and every backend call then carries it", async () => {
  const world = await createWorld({ content: () => ({}), backend: happy }).load();
  const popup = world.connect();
  popup.send({ type: "SET_TOKEN", token: `  ${TOKEN}  ` });
  await world.until(() => popup.last()?.tokenSet === true, "token saved");
  assert.equal(world.local.operon_token, TOKEN);

  popup.send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => popup.last()?.phase === "escalated", "done");
  const calls = world.requests.filter((r) => r.path.startsWith("/api/sessions"));
  assert.ok(calls.length >= 2 && calls.every((r) => r.headers.Authorization === `Bearer ${TOKEN}`), JSON.stringify(calls.map((r) => r.headers)));
});

test("the token never appears in evidence, UI state or the persisted session state", async () => {
  const world = await createWorld({ content: () => ({}), backend: happy, initialLocal: { operon_token: TOKEN } }).load();
  const popup = await ask(world);
  await world.until(() => popup.last()?.phase === "escalated", "done");
  assert.ok(!JSON.stringify(world.requests.map((r) => r.body)).includes(TOKEN), "not in any request body");
  assert.ok(!JSON.stringify(popup.received).includes(TOKEN), "not in anything sent to the popup");
  assert.ok(!JSON.stringify(world.storage).includes(TOKEN), "not in chrome.storage.session");
});

test("an empty token removes the saved one", async () => {
  const world = await createWorld({ content: () => ({}), backend: happy, initialLocal: { operon_token: TOKEN } }).load();
  const popup = world.connect();
  popup.send({ type: "SET_TOKEN", token: "" });
  await world.until(() => popup.last()?.tokenSet === false, "token removed");
  assert.equal("operon_token" in world.local, false);
});

test("a 401 tells the user to enter an access token", async () => {
  const world = await createWorld({ content: () => ({}), backend: () => ({ status: 401, body: { detail: "Authentication required" } }) }).load();
  const popup = await ask(world);
  await world.until(() => popup.last()?.phase === "error", "error");
  assert.match(popup.last().message, /access token/);
});

test("a 429 says how long to wait", async () => {
  const world = await createWorld({ content: () => ({}), backend: () => ({ status: 429, body: { detail: "Rate limit exceeded" }, headers: { "retry-after": "7" } }) }).load();
  const popup = await ask(world);
  await world.until(() => popup.last()?.phase === "error", "error");
  assert.match(popup.last().message, /wait 7s/);
});

test("an approval names the plan it is about", async () => {
  const pending = plan("clear_storage_key", { cited: { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] } });
  const world = await createWorld({
    initialStorage: awaitingApproval(pending),
    content: () => ({ storage: [{ key: "operon_demo_cache", present: false, parse_status: "empty" }] }),
    backend: (method, path) => {
      if (path.endsWith("/approve")) return session("RESOLVED", { pending_action: pending, resolution_state: "declined_by_user" });
      return { status: 404, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "DENY" });
  await world.until(() => world.calls("/approve").length === 1, "approval call");
  assert.deepEqual(world.calls("/approve")[0].body, { approved: false, proposal_id: pending.proposal_id });
});

test("the built manifest lets the extension reach exactly its own backend", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "operon-auth-build-")); // never overwrite the dist/ you may have loaded in Chrome
  execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "github"], {
    cwd: root,
    env: { ...process.env, OPERON_BACKEND_URL: "https://operon-api.example.test", OPERON_BUILD_OUT: out },
    stdio: "ignore",
  });
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf-8"));
  assert.deepEqual(manifest.host_permissions, ["https://github.com/*", "https://operon-api.example.test/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://github.com/*"]);
  assert.ok(!JSON.stringify(manifest).includes("__"), "no unreplaced placeholder");
});

test("a free-text answer goes to the backend for the open question, and only then", async () => {
  const req = evidenceRequest({ collectors: ["console"], question: "What did you click last?" });
  const asking = session("NEED_INFORMATION", { evidence_request: req });
  const world = await createWorld({
    initialStorage: { operon_state: { state: { phase: "needs_more_evidence", session: asking, diagnosis: null }, nextEvidenceId: 10 } },
    backend: (method, path) => (path.endsWith("/answer") ? session("NEED_INFORMATION", { evidence_request: req, diagnostic_steps: [{ request_id: req.request_id, answer: "x" }] }) : { status: 404, body: {} }),
  }).load();
  const popup = world.connect();
  popup.send({ type: "ANSWER", text: "   " }); // blank: ignored
  await flush(30);
  popup.send({ type: "ANSWER", text: "I changed my timezone" });
  await world.until(() => world.calls("/answer").length === 1, "answer call");
  assert.deepEqual(world.calls("/answer")[0].body, { request_id: req.request_id, answer: "I changed my timezone" });
  assert.equal(world.calls("/answer").length, 1);
});

test("an answer is ignored when no question is open", async () => {
  const asking = session("NEED_INFORMATION", { evidence_request: evidenceRequest({ collectors: ["console"] }) });
  const world = await createWorld({
    initialStorage: { operon_state: { state: { phase: "needs_more_evidence", session: asking, diagnosis: null }, nextEvidenceId: 10 } },
    backend: () => ({ status: 404, body: {} }),
  }).load();
  const popup = world.connect();
  popup.send({ type: "ANSWER", text: "hello" });
  popup.send({ type: "GET_STATE" });
  await world.until(() => popup.last(), "state");
  assert.equal(world.calls("/answer").length, 0);
});
