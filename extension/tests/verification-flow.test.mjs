// Approve -> execute -> observe -> report, through the real bundled
// background.ts. The backend decides verification; these tests check that the
// extension executes the right thing and reports a faithful observation.
import assert from "node:assert/strict";
import test from "node:test";

import { awaitingApproval, createWorld, plan, session } from "./helpers.mjs";

const OLD_ERROR = "TypeError: init failed at app.js:10:2";
const CITED_CONSOLE = { console: [{ id: "ev_001", level: "error", text: OLD_ERROR }] };
const CITED_STORAGE = { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] };

/**
 * Starts from WAITING_FOR_APPROVAL with `pending`, approves, and returns the
 * world after the extension reported the action result (and verification,
 * if the backend asked for it).
 */
async function approveAndRun(pending, { content, debuggerAvailable = true, onReload, actionSucceeds } = {}) {
  const world = createWorld({
    initialStorage: awaitingApproval(pending),
    debuggerAvailable,
    onReload: onReload ?? ((w) => {
      w.consoleError(OLD_ERROR); // the OLD page, still running until navigation commits
      w.emit("Runtime.executionContextsCleared");
    }),
    content: content ?? ((msg) => (msg.type === "CHECK_STORAGE" ? { storage: [{ key: "operon_demo_cache", present: false, parse_status: "empty" }] } : {})),
    backend: (method, path, body) => {
      if (path.endsWith("/approve")) return session("EXECUTING", { pending_action: pending });
      if (path.endsWith("/action-result")) {
        return body.succeeded ? session("VERIFYING", { pending_action: pending }) : session("NEED_INFORMATION", { pending_action: pending });
      }
      if (path.endsWith("/verify")) return session("RESOLVED", { pending_action: pending, verification_state: { outcome: "passed", passed: true, message: "ok", at: "t" } });
      return { status: 500, body: {} };
    },
  });
  await world.load();
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  await world.until(() => ["resolved", "needs_more_evidence", "error"].includes(popup.last()?.phase), "terminal popup state");
  return world;
}

const observationOf = (world) => world.calls("/verify")[0]?.body.observation;

test("reload: one reload, observed with the debugger attached first; old page's errors excluded", async () => {
  const world = await approveAndRun(plan("reload", { cited: CITED_CONSOLE }), {
    onReload: (w) => {
      w.consoleError(OLD_ERROR);
      w.emit("Runtime.executionContextsCleared");
      w.consoleError("ReferenceError: still broken on the new page");
    },
  });
  assert.deepEqual(world.log.filter((e) => ["attach", "reload", "detach"].includes(e)), ["attach", "reload", "detach"]);
  const result = world.calls("/action-result")[0].body;
  assert.deepEqual([result.action_id, result.succeeded, result.detail], ["reload", true, "reloaded the page"]);
  const obs = observationOf(world);
  assert.deepEqual(obs.console.map((c) => c.text), ["ReferenceError: still broken on the new page"]);
  assert.equal(obs.error, undefined);
});

test("clear_storage_key: clears the key, then re-checks storage only after the debugger detached", async () => {
  const world = await approveAndRun(plan("clear_storage_key", { cited: { ...CITED_CONSOLE, ...CITED_STORAGE }, storage_keys: ["operon_demo_cache"] }));
  const order = world.log.filter((e) => ["content:CLEAR_STORAGE_KEY", "attach", "reload", "detach", "content:CHECK_STORAGE"].includes(e));
  assert.deepEqual(order, ["content:CLEAR_STORAGE_KEY", "attach", "reload", "detach", "content:CHECK_STORAGE"]);
  const obs = observationOf(world);
  assert.deepEqual(obs.storage, [{ key: "operon_demo_cache", present: false, parse_status: "empty" }]);
  assert.deepEqual(obs.console, []); // the old page's error was discarded
});

test("debugger unavailable with cited console evidence: reported as an observation error, never as clean", async () => {
  const world = await approveAndRun(plan("clear_storage_key", { cited: { ...CITED_CONSOLE, ...CITED_STORAGE }, storage_keys: ["operon_demo_cache"] }), {
    debuggerAvailable: false,
  });
  const obs = observationOf(world);
  assert.equal(obs.error, "debugger_unavailable");
  assert.deepEqual(obs.console, []);
});

test("debugger unavailable but only storage cited: plain reload, storage still re-checked", async () => {
  const world = await approveAndRun(plan("clear_storage_key", { cited: CITED_STORAGE, storage_keys: ["operon_demo_cache"] }), {
    debuggerAvailable: false,
  });
  const obs = observationOf(world);
  assert.equal(obs.error, undefined);
  assert.deepEqual(obs.storage.map((s) => s.key), ["operon_demo_cache"]);
  assert.ok(world.log.includes("reload"));
});

test("storage re-check on an unreachable tab is reported as not re-checked (null), not as fixed", async () => {
  const world = await approveAndRun(plan("reload", { cited: CITED_STORAGE }), {
    content: (msg) => {
      if (msg.type === "CHECK_STORAGE") throw new Error("Receiving end does not exist.");
      return {};
    },
  });
  assert.equal(observationOf(world).storage, null);
});

test("unregister_service_worker: unregisters the cited scope and re-checks registrations", async () => {
  const scopes = ["/app/"];
  const world = await approveAndRun(plan("unregister_service_worker", { scope: "/app/", cited: { page: [{ id: "ev_003", url_path: "/", service_worker_controlled: true, service_worker_scopes: ["/app/"] }] } }), {
    content: (msg) => {
      if (msg.type === "UNREGISTER_SERVICE_WORKER") {
        assert.equal(msg.scope, "/app/");
        scopes.length = 0;
        return { unregistered: 1, remaining_scopes: [] };
      }
      if (msg.type === "INSPECT_PAGE") return { page: { url_path: "/", title: null, ready_state: "complete", service_worker_controlled: false, service_worker_scopes: [...scopes], selector: null, selector_matches: null } };
      return {};
    },
  });
  assert.equal(world.calls("/action-result")[0].body.succeeded, true);
  assert.deepEqual(observationOf(world).service_worker_scopes, []);
});

test("unregister_service_worker with nothing to unregister is reported as a failed action", async () => {
  const world = await approveAndRun(plan("unregister_service_worker", { scope: "/app/" }), {
    content: (msg) => (msg.type === "UNREGISTER_SERVICE_WORKER" ? { unregistered: 0, remaining_scopes: [] } : {}),
  });
  const result = world.calls("/action-result")[0].body;
  assert.equal(result.succeeded, false);
  assert.equal(world.calls("/verify").length, 0);
});

test("inspect_page: executes the read-only inspection, then verification re-observes the page", async () => {
  const world = await approveAndRun({ ...plan("inspect_page", { cited: CITED_CONSOLE }), parameters: { selector: "#app" } }, {
    content: (msg) => (msg.type === "INSPECT_PAGE" ? { page: { url_path: "/", title: null, ready_state: "complete", service_worker_controlled: false, service_worker_scopes: [], selector: "#app", selector_matches: 3 } } : {}),
  });
  assert.match(world.calls("/action-result")[0].body.detail, /matched 3 element/);
  assert.ok(world.log.includes("reload"));
  assert.ok(observationOf(world));
});

test("an action the extension can't perform is reported as failed, never faked", async () => {
  const world = await approveAndRun({ ...plan("reload"), action_id: "switch_workspace" });
  const result = world.calls("/action-result")[0].body;
  assert.equal(result.succeeded, false);
  assert.match(result.detail, /isn't implemented/);
});

test("clear_storage_key on an unreachable tab is a failed action, not a stuck session", async () => {
  const world = await approveAndRun(plan("clear_storage_key", { cited: CITED_STORAGE, storage_keys: ["operon_demo_cache"] }), {
    content: () => {
      throw new Error("Receiving end does not exist.");
    },
  });
  assert.equal(world.calls("/action-result")[0].body.succeeded, false);
  assert.equal(world.popup.last().phase, "needs_more_evidence");
});

test("the verification observation is credential-redacted before it is reported", async () => {
  const token = ["gs", "k_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0"].join("");
  const world = await approveAndRun(plan("reload", { cited: CITED_CONSOLE }), {
    onReload: (w) => {
      w.emit("Runtime.executionContextsCleared");
      w.consoleError(`request failed with key ${token}`);
    },
  });
  const obs = observationOf(world);
  assert.ok(!JSON.stringify(obs).includes(token.slice(4)));
  assert.deepEqual(obs.console.map((c) => c.text), ["request failed with key [REDACTED:api_key]"]);
});
