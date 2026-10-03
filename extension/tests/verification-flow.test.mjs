// Runs the real bundled background.ts through approve -> execute -> reload ->
// observe -> verify for `reload` and `inspect_page`, and asserts on what it
// reports to the backend's /verify endpoint.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { bundle, connectPopup, createFakeChrome } from "./helpers.mjs";

const TAB = { id: 5, url: "https://github.com/" };

const BASELINE = {
  url: "https://github.com/",
  timestamp: 1,
  console: [{ id: "ev_001", level: "error", text: "TypeError: init failed at app.js:10:2" }],
  network: [],
  cookies: [],
  storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }],
  redaction_applied: [],
};

const CORRUPT = { key: "operon_demo_cache", present: true, parse_status: "syntax_error" };
const FIXED = { key: "operon_demo_cache", present: false, parse_status: "empty" };

function sessionIn(phase, actionId, citedIds) {
  return {
    session_id: "s1",
    phase,
    user_issue: "page broken",
    issue_category: null,
    hypotheses: [],
    current_hypothesis_id: null,
    knowledge_references: [],
    pending_action: {
      diagnosis: "d",
      evidence_ids: citedIds,
      action_id: actionId,
      parameters: {},
      expected_effect: "",
      risk: "unknown",
      verification_predicate: "",
      requires_approval: true,
    },
    verification_state: null,
    resolution_state: null,
    confidence: 0.5,
    phase_history: [{ from: "VERIFYING", to: phase, reason: "r", at: "t" }],
    diagnostic_steps: [],
    attempted_actions: [],
    step_count: 0,
    tool_call_count: 0,
    llm_call_count: 0,
    action_attempt_count: 0,
  };
}

/**
 * @param {object} o
 * @param {"reload"|"inspect_page"} o.actionId
 * @param {string[]} o.citedIds
 * @param {object|null} o.baseline           lastBundle the proposal was made from (null = missing)
 * @param {string[]} o.errorsAfterReload     console errors the *new* page logs
 * @param {object|null} o.storageAfter       what CHECK_STORAGE returns after the reload (null = tab unreachable)
 */
async function runApprovedAction({ actionId, citedIds, baseline, errorsAfterReload, storageAfter }) {
  const fake = createFakeChrome({
    tabs: [TAB],
    initialStorage: {
      operon_state: {
        state: {
          phase: "awaiting_approval",
          session: sessionIn("WAITING_FOR_APPROVAL", actionId, citedIds),
          diagnosis: null,
          policy: { action_id: actionId, decision: "REQUIRE_APPROVAL", reason: "", validated_params: {} },
        },
        nextEvidenceId: 10,
        lastBundle: baseline,
      },
    },
  });
  const { chrome, listeners } = fake;
  const emit = (method, params = {}) => listeners.debuggerEvent.forEach((fn) => fn({ tabId: TAB.id }, method, params));
  const consoleError = (text) => emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: text }] });

  chrome.tabs.reload = (tabId) => {
    setTimeout(() => {
      consoleError("TypeError: init failed at app.js:10:2"); // the OLD page, still running until navigation commits
      emit("Runtime.executionContextsCleared");
      errorsAfterReload.forEach(consoleError);
      listeners.tabUpdated.forEach((fn) => fn(tabId, { status: "complete" }));
    }, 0);
  };
  chrome.tabs.sendMessage = (_tabId, message, callback) => {
    if (message.type === "CHECK_STORAGE" && storageAfter) {
      callback({ storage: storageAfter });
    } else if (message.type === "CHECK_STORAGE") {
      chrome.runtime.lastError = { message: "Receiving end does not exist." };
      callback(undefined);
      chrome.runtime.lastError = undefined;
    } else {
      callback({});
    }
  };

  let verifyBody = null;
  const respond = (body) => ({ ok: true, json: async () => body });
  const fetchStub = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith("/approve")) return respond(sessionIn("EXECUTING", actionId, citedIds));
    if (url.endsWith("/action-result")) return respond(sessionIn("VERIFYING", actionId, citedIds));
    if (url.endsWith("/verify")) {
      verifyBody = body;
      return respond(sessionIn(body.passed ? "RESOLVED" : "INVESTIGATING", actionId, citedIds));
    }
    throw new Error(`unexpected request ${url}`);
  };

  const code = await bundle("src/background.ts", { format: "iife" });
  const context = vm.createContext({
    chrome,
    fetch: fetchStub,
    // Collapse the 4 s observation window; short timers keep their timing.
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms >= 1000 ? 0 : ms, ...args),
    clearTimeout,
    console,
    URL,
    structuredClone,
  });
  vm.runInContext(code, context);
  await new Promise((r) => setTimeout(r, 20));

  const popup = connectPopup(listeners);
  popup.send({ type: "APPROVE" });
  for (let i = 0; i < 100 && !verifyBody; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(verifyBody, `no /verify call (last popup state: ${JSON.stringify(popup.received.at(-1))})`);
  return verifyBody;
}

for (const actionId of ["reload", "inspect_page"]) {
  test(`${actionId}: storage-only cited evidence, storage still corrupt, quiet page -> NOT passed`, async () => {
    const result = await runApprovedAction({
      actionId,
      citedIds: ["ev_002"],
      baseline: BASELINE,
      errorsAfterReload: [],
      storageAfter: CORRUPT,
    });
    assert.equal(result.passed, false);
    assert.match(result.message, /ev_002.*syntax_error/);
  });

  test(`${actionId}: cited evidence but baseline bundle missing, quiet page -> NOT passed`, async () => {
    const result = await runApprovedAction({
      actionId,
      citedIds: ["ev_001"],
      baseline: null,
      errorsAfterReload: [],
      storageAfter: FIXED,
    });
    assert.equal(result.passed, false);
    assert.match(result.message, /inconclusive/);
  });

  test(`${actionId}: storage cited but tab unreachable for the re-check -> NOT passed`, async () => {
    const result = await runApprovedAction({
      actionId,
      citedIds: ["ev_002"],
      baseline: BASELINE,
      errorsAfterReload: [],
      storageAfter: null,
    });
    assert.equal(result.passed, false);
    assert.match(result.message, /inconclusive/);
  });
}

test("reload: cited page error genuinely gone after reload (old page's last error ignored) -> passed", async () => {
  const result = await runApprovedAction({
    actionId: "reload",
    citedIds: ["ev_001"],
    baseline: BASELINE,
    errorsAfterReload: [],
    storageAfter: FIXED,
  });
  assert.equal(result.passed, true, result.message);
});

test("reload: cited page error still logged by the reloaded page -> failed", async () => {
  const result = await runApprovedAction({
    actionId: "reload",
    citedIds: ["ev_001"],
    baseline: BASELINE,
    errorsAfterReload: ["TypeError: init failed at app.js:12:7"],
    storageAfter: FIXED,
  });
  assert.equal(result.passed, false);
  assert.match(result.message, /ev_001 reappeared/);
});

test("reload: cited storage signal actually fixed and error gone -> passed", async () => {
  const result = await runApprovedAction({
    actionId: "reload",
    citedIds: ["ev_001", "ev_002"],
    baseline: BASELINE,
    errorsAfterReload: [],
    storageAfter: FIXED,
  });
  assert.equal(result.passed, true, result.message);
});
