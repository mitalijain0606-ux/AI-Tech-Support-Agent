import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Bundles a TypeScript entry point from src/ the same way the real build
// does, so tests exercise the actual source rather than a copy.
export async function bundle(entry, { format = "esm", define = {} } = {}) {
  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    format,
    target: "es2022",
    define: { __OPERON_BACKEND_URL__: JSON.stringify("http://backend.test"), ...define },
  });
  return result.outputFiles[0].text;
}

export const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

export const TAB = { id: 5, url: "https://github.com/octo/repo" };

/**
 * A fake browser + backend around the real background.ts bundle.
 *
 * content(message) -> response object, or throw to simulate an unreachable tab.
 * backend(method, path, body) -> { status, body } (or a plain body for 200).
 * debuggerAvailable: false makes chrome.debugger.attach reject.
 * onReload(world): runs when the tab reloads (emit debugger events here).
 */
export function createWorld({
  content = () => ({}),
  backend = () => ({ status: 500, body: { detail: "no route" } }),
  debuggerAvailable = true,
  tabs = [TAB],
  initialStorage = {},
  cookies = [],
  onReload = () => {},
} = {}) {
  const log = []; // ordered record of side effects: attach/detach/reload/content/fetch
  const storage = { ...initialStorage };
  const listeners = { connect: [], debuggerEvent: [], tabUpdated: new Set() };
  const requests = [];

  const chrome = {
    runtime: { lastError: undefined, onConnect: { addListener: (fn) => listeners.connect.push(fn) } },
    storage: {
      session: {
        get: async (key) => (key in storage ? { [key]: clone(storage[key]) } : {}),
        set: async (items) => Object.assign(storage, clone(items)),
      },
    },
    debugger: {
      onEvent: { addListener: (fn) => listeners.debuggerEvent.push(fn) },
      attach: async () => {
        log.push("attach");
        if (!debuggerAvailable) throw new Error("Another debugger is already attached");
      },
      detach: async () => log.push("detach"),
      sendCommand: async () => ({}),
    },
    tabs: {
      query: async () => tabs,
      reload: (tabId) => {
        log.push("reload");
        setTimeout(() => {
          onReload(world);
          listeners.tabUpdated.forEach((fn) => fn(tabId, { status: "complete" }));
        }, 0);
      },
      onUpdated: {
        addListener: (fn) => listeners.tabUpdated.add(fn),
        removeListener: (fn) => listeners.tabUpdated.delete(fn),
      },
      sendMessage: (_tabId, message, callback) => {
        const msg = clone(message);
        log.push(`content:${msg.type}`);
        let response;
        try {
          response = content(msg, world);
        } catch (err) {
          chrome.runtime.lastError = { message: String(err.message ?? err) };
          callback(undefined);
          chrome.runtime.lastError = undefined;
          return;
        }
        callback(clone(response) ?? {});
      },
    },
    cookies: { getAll: async () => clone(cookies) },
  };

  const fetchStub = async (url, init = {}) => {
    const reqPath = url.replace("http://backend.test", "");
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method ?? "GET";
    requests.push({ method, path: reqPath, body });
    log.push(`fetch:${method} ${reqPath}`);
    const out = await backend(method, reqPath, body, world);
    if (out instanceof Error) throw out;
    const { status = 200, body: resBody, raw } = out && "status" in out ? out : { body: out };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (raw !== undefined ? JSON.parse(raw) : clone(resBody)),
    };
  };

  const world = {
    chrome,
    storage,
    listeners,
    requests,
    log,
    emit(method, params = {}) {
      listeners.debuggerEvent.forEach((fn) => fn({ tabId: TAB.id }, method, params));
    },
    consoleError(text) {
      world.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: text }] });
    },
    failedRequest(url, status) {
      const requestId = `r${Math.random()}`;
      world.emit("Network.requestWillBeSent", { requestId, request: { method: "GET", url } });
      world.emit("Network.responseReceived", { requestId, response: { url, status, statusText: "err" } });
    },
    async load() {
      const code = await bundle("src/background.ts", { format: "iife" });
      const context = vm.createContext({
        chrome,
        fetch: fetchStub,
        crypto: globalThis.crypto,
        // Collapse observation windows (1–10 s); short timers and long
        // safety timeouts (e.g. the 30 s reload timeout) keep their timing.
        setTimeout: (fn, ms, ...args) => setTimeout(fn, ms >= 1000 && ms <= 10_000 ? 0 : ms, ...args),
        clearTimeout,
        console,
        URL,
        structuredClone,
      });
      vm.runInContext(code, context);
      await flush();
      return world;
    },
    connect() {
      const received = [];
      let onMessage;
      const port = {
        postMessage: (message) => received.push(clone(message)),
        onDisconnect: { addListener: () => {} },
        onMessage: { addListener: (fn) => (onMessage = fn) },
      };
      for (const fn of listeners.connect) fn(port);
      world.popup = { received, send: (command) => onMessage(command), last: () => received.at(-1) };
      return world.popup;
    },
    async until(predicate, label = "condition") {
      for (let i = 0; i < 200; i++) {
        if (predicate()) return;
        await flush(5);
      }
      throw new Error(`timed out waiting for ${label}; last popup state: ${JSON.stringify(world.popup?.last())}`);
    },
    calls(pathSuffix) {
      return requests.filter((r) => r.path.endsWith(pathSuffix));
    },
  };
  return world;
}

// ---- Backend session fixtures -----------------------------------------------------

export function evidenceRequest(overrides = {}) {
  return {
    request_id: "req_1",
    purpose: "initial",
    collectors: ["console", "network", "storage", "cookies", "page"],
    params: { storage_keys: [], selector: null, observe_ms: 4000 },
    reason: "Initial evidence.",
    requires_user_action: false,
    cycle: 1,
    ...overrides,
  };
}

export function plan(actionId, { cited = {}, strategy, storage_keys = [], scope = null } = {}) {
  return {
    proposal_id: "prop_1",
    diagnosis: "d",
    evidence_ids: [...(cited.console ?? []), ...(cited.network ?? []), ...(cited.storage ?? [])].map((i) => i.id),
    knowledge_refs: [],
    action_id: actionId,
    parameters: actionId === "clear_storage_key" ? { key: "operon_demo_cache" } : actionId === "unregister_service_worker" ? { scope } : {},
    target: {},
    rationale: "r",
    expected_effect: "e",
    risk: "low",
    verification_predicate: "p",
    verification: {
      strategy: strategy ?? (actionId === "clear_storage_key" ? "storage_recheck" : actionId === "unregister_service_worker" ? "service_worker_recheck" : "reobserve_cited"),
      cited_evidence: { console: [], network: [], cookies: [], storage: [], page: [], ...cited },
      storage_keys,
      service_worker_scope: scope,
      observe_ms: 4000,
    },
    requires_approval: true,
    attempt: 1,
    retry_of: null,
    retry_reason: null,
  };
}

export function session(phase, extra = {}) {
  return {
    session_id: "s1",
    phase,
    user_issue: "page broken",
    issue_category: null,
    hypotheses: [],
    current_hypothesis_id: null,
    knowledge_references: [],
    evidence_request: null,
    investigation_cycle: 0,
    pending_action: null,
    policy_decision: null,
    verification_state: null,
    escalation_state: null,
    resolution_state: null,
    confidence: 0.5,
    phase_history: [{ from: "VERIFYING", to: phase, reason: `now ${phase}`, at: "t" }],
    attempted_actions: [],
    activity: [],
    action_attempt_count: 0,
    ...extra,
  };
}

export const awaitingApproval = (pendingAction) => ({
  operon_state: {
    state: { phase: "awaiting_approval", session: session("WAITING_FOR_APPROVAL", { pending_action: pendingAction }), diagnosis: null },
    nextEvidenceId: 10,
  },
});
