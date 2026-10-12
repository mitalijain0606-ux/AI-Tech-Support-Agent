// Operon SDK — for a web app you control.
//
// Two ways to use it, both going through the SAME Operon backend pipeline
// (evidence -> classify -> investigate -> diagnose -> plan -> policy -> approval ->
// execution -> verification). Neither one has its own reasoning or its own rules.
//
//  1. `init(config)` — the app talks to the Operon backend itself: it collects a small,
//     redacted set of evidence, starts an investigation, shows the proposed fix, and (after
//     the user approves) runs an action from a closed list and reports the outcome. The
//     backend decides everything that matters (policy, approval, verification).
//  2. `registerOperon(...)` — the app only declares which closed-list fixes it can perform
//     and the Operon browser extension carries the conversation. See docs/SDK_VS_EXTENSION.md.
//
// What it will NOT do: hold an AI key or any server secret; read cookies, passwords,
// headers or storage *values*; run model-written code; execute any action that is not in
// SUPPORTED_ACTIONS, was not proposed by the backend for this session, or was not approved.
// Everything it sends is redacted first (redact.js), but pattern-based redaction is a best
// effort, not a guarantee. Full reference: sdk/README.md.

import { redactDeep, redactFreeText, redactText, scrubParseError, scrubUrl } from "./redact.js";

export const VERSION = "0.2.0";
export { redactDeep, redactFreeText, redactText, scrubParseError, scrubUrl };

// ---- errors -----------------------------------------------------------------------------------

/**
 * Every failure the SDK reports is an OperonError with a stable `code`:
 * config_invalid · unsupported_environment · network_error · timeout · aborted · unauthorized ·
 * forbidden · not_found · conflict · rate_limited · request_rejected · server_error ·
 * malformed_response · invalid_state · unsupported_action · payload_too_large · busy · disposed.
 * `message` never contains a token, a request body or a response body; `status` and
 * `retryAfterSeconds` are set when they apply.
 */
export class OperonError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "OperonError";
    this.code = code;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterSeconds !== undefined) this.retryAfterSeconds = extra.retryAfterSeconds;
  }
}

// ---- constants ------------------------------------------------------------------------------

export const SUPPORTED_ACTIONS = Object.freeze(["reset_user_preference"]);
/** Actions the SDK can perform itself when the app opts in (config.builtinActions). */
export const BUILTIN_ACTIONS = Object.freeze(["clear_storage_key", "unregister_service_worker"]);
export const RESETTABLE_PREFERENCES = Object.freeze(["timezone", "locale", "currency", "date_format"]);
const PROTOCOL = 1;
/** A handler may do real work; the extension waits longer than this (see appbridge.ts). */
export const HANDLER_TIMEOUT_MS = 10_000;

const DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  investigateTimeoutMs: 90_000,
  maxEvidenceBytes: 200_000,
  maxCycles: 6,
  maxObserveMs: 1_500,
  evidenceWaitMs: 400,
  maxConsoleEntries: 40,
  maxNetworkEntries: 40,
  maxTextChars: 500,
});

const clampInt = (value, min, max, fallback) => (Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback);
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
const newId = (() => {
  let n = 0;
  return () => `ev_${Date.now().toString(36)}${(n++).toString(36)}`;
})();

/** Validates and normalises a backend URL. https is required except for loopback development. */
export function validateBackendUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new OperonError("config_invalid", "backendUrl must be an absolute URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new OperonError("config_invalid", "backendUrl must use https (plain http is accepted only for localhost)");
  }
  if (url.username || url.password) throw new OperonError("config_invalid", "backendUrl must not contain credentials");
  if (url.search || url.hash) throw new OperonError("config_invalid", "backendUrl must not contain a query string or fragment");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function normaliseConfig(config) {
  if (!config || typeof config !== "object") throw new OperonError("config_invalid", "init() needs a configuration object");
  const backendUrl = validateBackendUrl(config.backendUrl);
  const hasToken = typeof config.token === "string" && config.token.trim() !== "";
  const hasGetter = typeof config.getToken === "function";
  if (hasToken === hasGetter) throw new OperonError("config_invalid", "provide exactly one of `token` or `getToken`");
  const appId = config.appId ?? "app";
  if (typeof appId !== "string" || !appId || appId.length > 64) throw new OperonError("config_invalid", "appId must be a non-empty string of at most 64 characters");

  const storageKeys = [...new Set(config.storageKeys ?? [])];
  if (!storageKeys.every((k) => typeof k === "string" && k.length > 0 && k.length <= 200) || storageKeys.length > 25) {
    throw new OperonError("config_invalid", "storageKeys must be at most 25 non-empty strings of at most 200 characters");
  }
  const actions = {};
  for (const name of SUPPORTED_ACTIONS) {
    if (config.actions?.[name] === undefined) continue;
    if (typeof config.actions[name] !== "function") throw new OperonError("config_invalid", `actions.${name} must be a function`);
    actions[name] = config.actions[name];
  }
  for (const name of Object.keys(config.actions ?? {})) {
    if (!SUPPORTED_ACTIONS.includes(name)) throw new OperonError("config_invalid", `'${name.slice(0, 40)}' is not a supported action (supported: ${SUPPORTED_ACTIONS.join(", ")})`);
  }
  const builtin = [...new Set(config.builtinActions ?? [])];
  for (const name of builtin) {
    if (!BUILTIN_ACTIONS.includes(name)) throw new OperonError("config_invalid", `'${String(name).slice(0, 40)}' is not a built-in action (${BUILTIN_ACTIONS.join(", ")})`);
  }
  if (builtin.includes("clear_storage_key") && storageKeys.length === 0) {
    throw new OperonError("config_invalid", "clear_storage_key needs `storageKeys`: the SDK only ever clears keys the app lists");
  }
  const capture = { console: false, network: false, ...(config.capture ?? {}) };
  if (config.reobserve !== undefined && typeof config.reobserve !== "function") throw new OperonError("config_invalid", "reobserve must be a function");
  return {
    ...DEFAULTS,
    backendUrl,
    token: hasToken ? config.token.trim() : null,
    getToken: hasGetter ? config.getToken : null,
    appId,
    storageKeys,
    actions,
    builtin,
    capture: { console: capture.console === true, network: capture.network === true },
    reobserve: config.reobserve ?? null,
    fetch: config.fetch ?? null,
    timeoutMs: clampInt(config.timeoutMs, 1_000, 300_000, DEFAULTS.timeoutMs),
    investigateTimeoutMs: clampInt(config.investigateTimeoutMs, 1_000, 600_000, DEFAULTS.investigateTimeoutMs),
    maxEvidenceBytes: clampInt(config.maxEvidenceBytes, 1_000, 1_000_000, DEFAULTS.maxEvidenceBytes),
    maxCycles: clampInt(config.maxCycles, 1, 10, DEFAULTS.maxCycles),
    maxObserveMs: clampInt(config.maxObserveMs, 0, 8_000, DEFAULTS.maxObserveMs),
    evidenceWaitMs: clampInt(config.evidenceWaitMs, 0, 8_000, DEFAULTS.evidenceWaitMs),
  };
}

// ---- evidence capture (opt-in, bounded, redacted) -------------------------------------------

// Text the page itself wrote (console output, titles, URLs, error messages) can contain a credential
// in any shape, so it gets the free-text heuristics too, and is redacted BEFORE it is shortened.
function safeString(value, max) {
  return redactFreeText(String(value ?? "")).text.slice(0, max);
}

/** Stringifies console arguments without ever throwing or walking a huge object. */
function argsToText(args) {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a)?.slice(0, 300) ?? String(a);
      } catch {
        return "[unserialisable]";
      }
    })
    .join(" ");
}

function startCapture(cfg, win) {
  const state = { console: [], network: [], restore: [] };
  const push = (list, entry, cap) => {
    list.push(entry);
    if (list.length > cap) list.shift();
  };
  if (cfg.capture.console) {
    const con = win.console;
    for (const level of ["error", "warn"]) {
      const original = con[level];
      const wrapped = function (...args) {
        try {
          push(state.console, { level: level === "warn" ? "warn" : "error", text: safeString(argsToText(args), cfg.maxTextChars) }, cfg.maxConsoleEntries);
        } catch {
          /* capturing must never break the app's own logging */
        }
        return original.apply(this, args);
      };
      con[level] = wrapped;
      state.restore.push(() => {
        if (con[level] === wrapped) con[level] = original;
      });
    }
    const onError = (e) => push(state.console, { level: "error", text: safeString(`${e.message ?? "error"}`, cfg.maxTextChars), url: e.filename ? safeString(e.filename, 500) : undefined }, cfg.maxConsoleEntries);
    const onRejection = (e) => push(state.console, { level: "error", text: safeString(`Unhandled rejection: ${e.reason?.message ?? e.reason}`, cfg.maxTextChars) }, cfg.maxConsoleEntries);
    win.addEventListener?.("error", onError);
    win.addEventListener?.("unhandledrejection", onRejection);
    state.restore.push(() => {
      win.removeEventListener?.("error", onError);
      win.removeEventListener?.("unhandledrejection", onRejection);
    });
  }
  if (cfg.capture.network && typeof win.fetch === "function") {
    const original = win.fetch;
    const backendPrefix = cfg.backendUrl;
    const wrapped = async function (input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
      const started = Date.now();
      const record = (extra) => {
        if (String(url).startsWith(backendPrefix)) return; // never report Operon's own traffic
        // Query strings and fragments are dropped: they are where tokens live.
        const clean = scrubUrl(String(url).split(/[?#]/)[0]);
        push(state.network, { method: method.slice(0, 16), url: safeString(clean, 500), duration_ms: Date.now() - started, ...extra }, cfg.maxNetworkEntries);
      };
      try {
        const res = await original.call(this, input, init);
        if (res.status >= 400) record({ status: res.status, status_text: safeString(res.statusText || "error", 100) });
        return res;
      } catch (err) {
        record({ status: 0, status_text: "failed", failure_reason: safeString(err?.message ?? "request failed", 200) });
        throw err;
      }
    };
    win.fetch = wrapped;
    state.restore.push(() => {
      if (win.fetch === wrapped) win.fetch = original;
    });
  }
  state.clear = () => {
    state.console.length = 0;
    state.network.length = 0;
  };
  state.stop = () => state.restore.splice(0).reverse().forEach((fn) => fn());
  return state;
}

function storageShape(storage, key) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return { key, present: false, parse_status: "empty", error_message: "storage_unavailable" };
  }
  if (raw === null) return { key, present: false, parse_status: "empty" };
  try {
    JSON.parse(raw);
    return { key, present: true, parse_status: "valid_json" };
  } catch (err) {
    // Shape only: the parser's message can quote the value, so it is redacted and cut short.
    return { key, present: true, parse_status: /^\s*[[{]/.test(raw) ? "syntax_error" : "not_json", error_message: scrubParseError(err?.message) };
  }
}

async function serviceWorkerScopes(win) {
  try {
    const regs = await win.navigator?.serviceWorker?.getRegistrations?.();
    return (regs ?? []).slice(0, 5).map((r) => new URL(r.scope).pathname);
  } catch {
    return [];
  }
}

// ---- the client -------------------------------------------------------------------------------

/**
 * Starts the SDK for this page. Returns a client; call `client.dispose()` when finished.
 * Calling init() again with the same `appId` first disposes the previous client (no duplicate
 * listeners, no double-wrapped console).
 *
 * @param {object} config see sdk/README.md ("Configuration")
 */
export function init(config) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new OperonError("unsupported_environment", "the Operon SDK needs a browser window");
  }
  const cfg = normaliseConfig(config);
  const fetchImpl = cfg.fetch ?? (typeof window.fetch === "function" ? window.fetch.bind(window) : null);
  if (!fetchImpl) throw new OperonError("unsupported_environment", "fetch is not available in this browser");
  const registry = (globalThis.__operonSdkClients ??= new Map());
  registry.get(cfg.appId)?.dispose();

  const win = window;
  const listeners = new Map();
  const lifetime = new AbortController();
  let disposed = false;
  let busy = false;
  let session = null;
  let capture = startCapture(cfg, win);

  const emit = (event, payload) => {
    for (const handler of [...(listeners.get(event) ?? [])]) {
      try {
        handler(payload);
      } catch {
        /* a listener's bug must not break the SDK */
      }
    }
  };

  function enabledActions() {
    return [...Object.keys(cfg.actions), ...cfg.builtin];
  }
  function capabilities() {
    return ["inspect_page", ...(cfg.capture.console ? ["console_errors"] : []), ...(cfg.capture.network ? ["network_requests"] : []), ...enabledActions()];
  }
  function collectors() {
    return ["storage", "page", ...(cfg.capture.console ? ["console"] : []), ...(cfg.capture.network ? ["network"] : [])];
  }

  async function authHeaders() {
    let token = cfg.token;
    if (cfg.getToken) {
      try {
        token = await cfg.getToken();
      } catch {
        throw new OperonError("unauthorized", "getToken() failed; no request was sent");
      }
    }
    if (typeof token !== "string" || !token.trim()) throw new OperonError("unauthorized", "no access token available; no request was sent");
    return { Authorization: `Bearer ${token.trim()}`, "Content-Type": "application/json" };
  }

  /** One HTTP exchange. Never retried (a repeated POST could repeat a remediation). */
  async function request(method, path, body, { timeoutMs = cfg.timeoutMs, signal } = {}) {
    if (disposed) throw new OperonError("disposed", "this Operon client was disposed");
    const headers = await authHeaders();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), controller.abort()), timeoutMs);
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    let res;
    try {
      res = await fetchImpl(cfg.backendUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, credentials: "omit" });
    } catch (err) {
      if (timedOut) throw new OperonError("timeout", `the Operon backend did not answer within ${Math.round(timeoutMs / 1000)}s`);
      if (controller.signal.aborted) throw new OperonError(disposed ? "disposed" : "aborted", "the request was aborted");
      throw new OperonError("network_error", "could not reach the Operon backend (network error, blocked by CORS, or the backend is down)");
    } finally {
      clearTimeout(timer);
      lifetime.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
    if (!res.ok) {
      const retry = Number(res.headers?.get?.("retry-after"));
      const retryAfterSeconds = Number.isFinite(retry) ? retry : undefined;
      const status = res.status;
      const map = { 401: ["unauthorized", "the backend rejected the access token (401)"], 403: ["forbidden", "this token may not perform that operation (403)"], 404: ["not_found", "the session was not found for this caller (404)"], 409: ["conflict", "the backend refused the request in the session's current state (409)"], 429: ["rate_limited", "rate limit reached; retry later (429)"] };
      if (map[status]) throw new OperonError(map[status][0], map[status][1], { status, retryAfterSeconds });
      if (status >= 500) throw new OperonError("server_error", `the Operon backend failed (HTTP ${status})`, { status });
      throw new OperonError("request_rejected", `the backend rejected the request (HTTP ${status})`, { status });
    }
    try {
      return await res.json();
    } catch {
      throw new OperonError("malformed_response", "the backend answered with something that is not JSON");
    }
  }

  function asSession(value, expectedId) {
    if (!value || typeof value !== "object" || typeof value.session_id !== "string" || typeof value.phase !== "string") {
      throw new OperonError("malformed_response", "the backend's session response had an unexpected shape");
    }
    if (expectedId && value.session_id !== expectedId) throw new OperonError("malformed_response", "the backend answered for a different session");
    return value;
  }

  /** Runs `fn` as the only operation in flight. */
  async function exclusive(fn) {
    if (disposed) throw new OperonError("disposed", "this Operon client was disposed");
    if (busy) throw new OperonError("busy", "another Operon operation is already in progress");
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  }

  // -- progress (Server-Sent Events over fetch: EventSource cannot send an Authorization header)
  function watchProgress(sessionId) {
    const controller = new AbortController();
    lifetime.signal.addEventListener("abort", () => controller.abort(), { once: true });
    (async () => {
      try {
        const headers = { ...(await authHeaders()), Accept: "text/event-stream" };
        const res = await fetchImpl(`${cfg.backendUrl}/api/sessions/${encodeURIComponent(sessionId)}/events`, { headers, signal: controller.signal, credentials: "omit" });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (event.type === "stage") emit("progress", { stage: event.stage, status: event.status, detail: event.category ?? event.outcome ?? event.engine ?? event.retrieval });
            else if (event.type === "activity" && event.entry?.summary) emit("activity", { kind: event.entry.kind, summary: safeString(event.entry.summary, 200) });
            if (event.type === "end") return;
          }
        }
      } catch {
        /* progress is best effort: it never affects the investigation */
      }
    })();
    return () => controller.abort();
  }

  // -- evidence ---------------------------------------------------------------------------------
  async function collectEvidence(evidenceRequest, signal) {
    const wants = new Set(evidenceRequest.collectors ?? []);
    const params = evidenceRequest.params ?? {};
    const errors = [];
    // Capture started at init(), so errors from page load are already buffered; waiting a moment
    // only lets late asynchronous errors arrive.
    if (wants.has("console") || wants.has("network")) await sleep(Math.min(cfg.evidenceWaitMs, clampInt(params.observe_ms, 0, 8_000, cfg.evidenceWaitMs)), signal);
    const storage = [];
    if (wants.has("storage")) {
      // Only keys the app listed are ever read; a backend-supplied key outside the list is ignored.
      const asked = (params.storage_keys ?? []).filter((k) => cfg.storageKeys.includes(k));
      for (const key of new Set([...cfg.storageKeys, ...asked]).values()) {
        const shape = storageShape(win.localStorage, key);
        if (shape.present || asked.includes(key)) storage.push({ id: newId(), storage_type: "localStorage", ...shape });
      }
    }
    const page = [];
    if (wants.has("page")) {
      let matches = null;
      if (typeof params.selector === "string" && params.selector) {
        try {
          matches = win.document.querySelectorAll(params.selector).length;
        } catch {
          matches = null;
        }
      }
      const scopes = await serviceWorkerScopes(win);
      page.push({
        id: newId(),
        url_path: safeString(win.location.pathname, 1000),
        title: win.document.title ? safeString(win.document.title, 120) : null,
        ready_state: win.document.readyState,
        service_worker_controlled: Boolean(win.navigator?.serviceWorker?.controller),
        service_worker_scopes: scopes,
        selector: typeof params.selector === "string" && params.selector ? safeString(params.selector, 200) : null,
        selector_matches: matches,
      });
    }
    for (const unsupported of ["cookies", "reload_observe"]) if (wants.has(unsupported)) errors.push(`${unsupported}_unsupported_in_sdk`);
    const bundle = {
      url: safeString(win.location.origin + win.location.pathname, 1000),
      timestamp: Date.now() / 1000,
      bundle_id: `bun_${Math.random().toString(36).slice(2, 14)}`,
      request_id: evidenceRequest.request_id,
      collectors: [...wants].filter((c) => collectors().includes(c)),
      collection_errors: errors,
      console: wants.has("console") ? capture.console.map((c) => ({ id: newId(), ...c })) : [],
      network: wants.has("network") ? capture.network.map((n) => ({ id: newId(), ...n })) : [],
      cookies: [],
      storage,
      page,
      redaction_applied: [],
    };
    const { value, rules } = redactDeep(bundle);
    value.redaction_applied = rules;
    return fitToBudget(value, cfg.maxEvidenceBytes);
  }

  function fitToBudget(bundle, budget) {
    const size = () => new TextEncoder().encode(JSON.stringify({ bundle })).length;
    while (size() > budget && (bundle.console.length > 1 || bundle.network.length > 1)) {
      if (bundle.console.length >= bundle.network.length) bundle.console.shift();
      else bundle.network.shift();
    }
    if (size() > budget) throw new OperonError("payload_too_large", "the evidence is larger than maxEvidenceBytes even after trimming");
    return bundle;
  }

  // -- investigation ------------------------------------------------------------------------------
  function outcomeOf(s) {
    if (s.phase === "ACTION_PROPOSED" || s.phase === "WAITING_FOR_APPROVAL") return "proposal";
    if (s.phase === "NEED_INFORMATION") return s.evidence_request?.question ? "needs_answer" : "needs_evidence";
    if (s.phase === "RESOLVED") return s.resolution_state === "resolved" ? "resolved" : "declined";
    if (s.phase === "ESCALATED") return "escalated";
    return "in_progress";
  }
  const publicResult = (s) => ({ state: outcomeOf(s), session: s, proposal: proposalOf(s), question: s.phase === "NEED_INFORMATION" ? s.evidence_request?.question ?? null : null });
  const proposalOf = (s) => (s.pending_action && (s.phase === "ACTION_PROPOSED" || s.phase === "WAITING_FOR_APPROVAL") ? s.pending_action : null);

  async function cycleUntilSettled(first, signal) {
    let s = first;
    for (let cycle = 0; cycle < cfg.maxCycles; cycle++) {
      if (s.phase !== "UNDERSTANDING" && s.phase !== "NEED_INFORMATION") return s;
      if (s.phase === "NEED_INFORMATION" && s.evidence_request?.question) return s; // a person must answer first
      if (!s.evidence_request) throw new OperonError("malformed_response", "the backend asked for more evidence without saying which");
      const bundle = await collectEvidence(s.evidence_request, signal);
      const stop = watchProgress(s.session_id);
      let res;
      try {
        res = await request("POST", `/api/sessions/${encodeURIComponent(s.session_id)}/investigate`, { bundle }, { timeoutMs: cfg.investigateTimeoutMs, signal });
      } finally {
        stop();
      }
      s = asSession(res?.session, s.session_id);
      session = s;
      emit("state", publicResult(s));
    }
    return s;
  }

  const api = {
    version: VERSION,
    appId: cfg.appId,
    get session() {
      return session;
    },
    get disposed() {
      return disposed;
    },
    on(event, handler) {
      if (typeof handler !== "function") throw new OperonError("config_invalid", "on(event, handler) needs a function");
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => listeners.get(event)?.delete(handler);
    },

    /**
     * Describe the problem and let Operon investigate. Resolves with
     * { state, session, proposal, question }, where state is one of:
     * proposal · needs_answer · needs_evidence · escalated · resolved · declined · in_progress.
     */
    diagnose(issue, { signal } = {}) {
      return exclusive(async () => {
        const text = redactFreeText(String(issue ?? "").trim()).text;
        if (!text) throw new OperonError("config_invalid", "diagnose() needs a description of the problem");
        if (text.length > 4000) throw new OperonError("payload_too_large", "the description is longer than 4000 characters");
        const created = asSession(await request("POST", "/api/sessions", { user_issue: text, source: "sdk", provider_capabilities: capabilities(), collectors: collectors() }, { signal }));
        session = created;
        emit("state", publicResult(created));
        const settled = await cycleUntilSettled(created, signal);
        session = settled;
        return publicResult(settled);
      });
    },

    /** Continue after the backend asked for more evidence, or after answering its question. */
    continue({ signal } = {}) {
      return exclusive(async () => {
        if (!session) throw new OperonError("invalid_state", "no investigation in progress; call diagnose() first");
        const current = asSession(await request("GET", `/api/sessions/${encodeURIComponent(session.session_id)}`, undefined, { signal }), session.session_id);
        const settled = await cycleUntilSettled(current, signal);
        session = settled;
        return publicResult(settled);
      });
    },

    /** Answer the backend's free-text question (redacted before it is sent). */
    answer(text, { signal } = {}) {
      return exclusive(async () => {
        const asked = session?.evidence_request;
        if (!session || session.phase !== "NEED_INFORMATION" || !asked?.question) throw new OperonError("invalid_state", "there is no open question to answer");
        const clean = redactFreeText(String(text ?? "").trim()).text.slice(0, 1000);
        if (!clean) throw new OperonError("config_invalid", "answer() needs some text");
        session = asSession(await request("POST", `/api/sessions/${encodeURIComponent(session.session_id)}/answer`, { request_id: asked.request_id, answer: clean }, { signal }), session.session_id);
        return publicResult(session);
      });
    },

    /**
     * Approve (true) or reject (false) the proposed fix. The decision is recorded by the backend,
     * which checks it against the proposal and the caller. Rejecting guarantees nothing runs.
     * Approving runs the one approved action, reports the outcome, and lets the backend verify it.
     */
    decide(approve, { signal } = {}) {
      return exclusive(async () => {
        if (typeof approve !== "boolean") throw new OperonError("config_invalid", "decide() needs true (approve) or false (reject)");
        const proposal = session && proposalOf(session);
        if (!proposal) throw new OperonError("invalid_state", "there is no proposed fix to decide on");
        const sid = session.session_id;
        const base = `/api/sessions/${encodeURIComponent(sid)}`;
        // Policy first: the backend evaluates ITS stored proposal, not anything we send.
        const policy = await request("POST", `${base}/policy`, {}, { signal });
        let current = asSession(policy?.session, sid);
        session = current;
        const decision = policy?.policy?.decision;
        if (decision === "DENY") {
          emit("state", publicResult(current));
          return { ...publicResult(current), executed: false, reason: "denied_by_policy" };
        }
        if (decision === "REQUIRE_APPROVAL") {
          current = asSession(await request("POST", `${base}/approve`, { approved: approve, proposal_id: proposal.proposal_id }, { signal }), sid);
          session = current;
          if (!approve) {
            emit("state", publicResult(current));
            return { ...publicResult(current), executed: false, reason: "rejected" };
          }
        } else if (!approve) {
          return { ...publicResult(current), executed: false, reason: "cancelled_locally" };
        }
        if (current.phase !== "EXECUTING") throw new OperonError("invalid_state", `the backend is in phase ${current.phase}, not ready to execute`);

        // Execute exactly the stored, approved action.
        const approved = current.pending_action;
        const outcome = await execute(approved, policy?.policy?.validated_params ?? approved.parameters);
        current = asSession(await request("POST", `${base}/action-result`, { action_id: approved.action_id, succeeded: outcome.ok, detail: redactFreeText(outcome.detail).text.slice(0, 1000) }, { signal }), sid);
        session = current;
        if (current.phase === "VERIFYING") {
          const observation = await observe(approved, outcome);
          current = asSession(await request("POST", `${base}/verify`, { action_id: approved.action_id, observation }, { signal }), sid);
          session = current;
        }
        if (current.phase === "RESOLVED" && current.resolution_state === "resolved") capture.clear(); // old errors are not evidence for the next question
        emit("state", publicResult(current));
        return { ...publicResult(current), executed: outcome.ok, reason: outcome.ok ? "executed" : "execution_failed", verification: current.verification_state ?? null };
      });
    },

    /** Aborts anything in flight, restores the console/fetch the SDK wrapped, drops listeners. */
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      capture.stop();
      listeners.clear();
      if (registry.get(cfg.appId) === api) registry.delete(cfg.appId);
    },
  };

  // -- action execution (closed allowlist; parameters validated here as well as by the backend)
  async function execute(proposal, params) {
    const name = proposal.action_id;
    if (!enabledActions().includes(name)) return { ok: false, detail: `'${String(name).slice(0, 40)}' is not enabled in this app` };
    try {
      if (name === "reset_user_preference") {
        const preference = params?.preference;
        if (typeof preference !== "string" || !RESETTABLE_PREFERENCES.includes(preference)) return { ok: false, detail: "reset_user_preference needs a known preference name" };
        const out = await runHandler(cfg.actions[name], { preference });
        return { ok: true, detail: out };
      }
      if (name === "clear_storage_key") {
        const key = params?.key;
        if (typeof key !== "string" || !cfg.storageKeys.includes(key)) return { ok: false, detail: "that storage key is not one this app lists" };
        win.localStorage.removeItem(key);
        return { ok: true, detail: `cleared storage key '${key.slice(0, 60)}'` };
      }
      if (name === "unregister_service_worker") {
        const scope = params?.scope;
        if (typeof scope !== "string") return { ok: false, detail: "unregister_service_worker needs a scope" };
        const regs = (await win.navigator?.serviceWorker?.getRegistrations?.()) ?? [];
        let removed = 0;
        for (const r of regs) if (new URL(r.scope).pathname === scope && (await r.unregister())) removed++;
        return removed ? { ok: true, detail: `unregistered ${removed} service worker(s)` } : { ok: false, detail: "no matching service worker registration was found" };
      }
    } catch (err) {
      return { ok: false, detail: String(err?.message ?? err).slice(0, 200) };
    }
    return { ok: false, detail: "unsupported action" };
  }

  async function runHandler(handler, params) {
    let timer;
    const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the handler did not finish in time")), HANDLER_TIMEOUT_MS)));
    try {
      const out = await Promise.race([Promise.resolve().then(() => handler(params)), timeout]);
      return String(out?.detail ?? "done").slice(0, 200);
    } finally {
      clearTimeout(timer);
    }
  }

  /** What the page looks like after the action. The backend — not this code — decides what it means. */
  async function observe(proposal, outcome) {
    const plan = proposal.verification ?? {};
    const cited = plan.cited_evidence ?? {};
    const citesSignals = (cited.console?.length ?? 0) + (cited.network?.length ?? 0) > 0;
    if (!outcome.ok) return { console: [], network: [], error: "action_failed" };
    if (citesSignals && !cfg.reobserve) return { console: [], network: [], error: "reobserve_unavailable" };
    capture.clear();
    let error;
    if (cfg.reobserve) {
      try {
        await cfg.reobserve();
      } catch {
        error = "reobserve_failed";
      }
    }
    const settle = Math.min(cfg.maxObserveMs, clampInt(plan.observe_ms, 0, 8_000, cfg.maxObserveMs));
    await sleep(settle, lifetime.signal);
    const keys = [...new Set([...(plan.storage_keys ?? []), ...(cited.storage ?? []).map((s) => s.key)])].filter((k) => cfg.storageKeys.includes(k));
    const observation = {
      console: capture.console.map((c) => ({ id: newId(), ...c })),
      network: capture.network.map((n) => ({ id: newId(), ...n })),
      observed_ms: settle,
    };
    if (keys.length) observation.storage = keys.map((k) => storageShape(win.localStorage, k));
    if (plan.strategy === "service_worker_recheck") observation.service_worker_scopes = await serviceWorkerScopes(win);
    if (error) observation.error = error;
    return redactDeep(observation).value;
  }

  registry.set(cfg.appId, api);
  return api;
}

// ---- extension carrier: declare closed-list actions for the Operon browser extension -------------

let unregisterCurrent = null;

/**
 * Registers this app's Operon actions. Calling it again replaces the previous
 * registration (one app, one listener: no duplicate replies). Returns a function
 * that removes the listener; calling that more than once is harmless.
 *
 * @param {{ appId?: string, actions: Record<string, (params: object) => unknown> }} options
 * @returns {() => void}
 */
export function registerOperon({ appId = "app", actions } = {}) {
  if (typeof appId !== "string" || !appId || appId.length > 64) throw new TypeError("registerOperon: appId must be a non-empty string of at most 64 characters");
  unregisterCurrent?.();

  const handlers = {};
  for (const name of SUPPORTED_ACTIONS) {
    if (typeof actions?.[name] === "function") handlers[name] = actions[name];
  }
  // postMessage to our own window; an opaque origin (file://) reports "null", which is not a valid target.
  const targetOrigin = window.location.origin && window.location.origin !== "null" ? window.location.origin : "*";

  async function onMessage(event) {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.operon !== PROTOCOL || msg.from !== "extension" || typeof msg.id !== "string") return;
    const reply = (body) => window.postMessage({ operon: PROTOCOL, from: "app", id: msg.id, appId, ...body }, targetOrigin);
    if (msg.type === "discover") {
      reply({ type: "capabilities", actions: Object.keys(handlers) });
    } else if (msg.type === "invoke") {
      const handler = typeof msg.action === "string" && Object.hasOwn(handlers, msg.action) ? handlers[msg.action] : null;
      const shown = typeof msg.action === "string" ? msg.action.slice(0, 40) : "(invalid)"; // never call String() on page-controlled objects
      if (!handler) return reply({ type: "result", ok: false, detail: `this app does not offer '${shown}'` });
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("the handler did not finish in time")), HANDLER_TIMEOUT_MS);
        });
        const out = await Promise.race([Promise.resolve().then(() => handler(msg.params ?? {})), timeout]);
        reply({ type: "result", ok: true, detail: String(out?.detail ?? "done").slice(0, 200) });
      } catch (err) {
        reply({ type: "result", ok: false, detail: String(err?.message ?? err).slice(0, 200) });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  window.addEventListener("message", onMessage);

  const unregister = () => {
    window.removeEventListener("message", onMessage);
    if (unregisterCurrent === unregister) unregisterCurrent = null;
  };
  unregisterCurrent = unregister;
  return unregister;
}
