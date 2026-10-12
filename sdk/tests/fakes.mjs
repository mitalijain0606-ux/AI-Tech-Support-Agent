// Test doubles for the SDK: a fake browser window and a scripted fake Operon backend.
export function fakeWindow({ storage = {}, path = "/dashboard", title = "Dashboard" } = {}) {
  const listeners = new Map();
  const store = new Map(Object.entries(storage));
  const log = { error: [], warn: [] };
  const win = {
    console: { error: (...a) => log.error.push(a), warn: (...a) => log.warn.push(a), log: () => {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    location: { origin: "https://app.test", pathname: path },
    document: { title, readyState: "complete", querySelectorAll: (sel) => { if (sel === "!!") throw new Error("bad selector"); return [1, 2]; } },
    navigator: { serviceWorker: { controller: null, getRegistrations: async () => win._registrations } },
    _registrations: [],
    _store: store,
    _log: log,
    _listeners: listeners,
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
    postMessage(data) { queueMicrotask(() => [...(listeners.get("message") ?? [])].forEach((fn) => fn({ source: win, data }))); },
    fetch: async () => ({ ok: true, status: 200 }),
  };
  return win;
}

export function install(win) {
  globalThis.window = win;
  globalThis.document = win.document;
  delete globalThis.__operonSdkClients;
  return () => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.__operonSdkClients;
  };
}

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => {
    if (body === Symbol.for("malformed")) throw new SyntaxError("bad json");
    return body;
  },
  body: null,
});

/** A scripted backend: `routes` maps "METHOD /path-regex" to (body, call) => [status, json, headers]. */
export function fakeBackend(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const call = { method: init.method ?? "GET", path: u.pathname, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined, raw: init.body, credentials: init.credentials, signal: init.signal };
    calls.push(call);
    for (const [key, handler] of Object.entries(routes)) {
      const [method, pattern] = key.split(" ");
      if (method === call.method && new RegExp(`^${pattern}$`).test(call.path)) {
        const out = await handler(call.body, call);
        if (out instanceof Error) throw out;
        const [status, body, headers] = out;
        return json(status, body, headers);
      }
    }
    return json(404, { detail: "no route" });
  };
  return { fetch, calls, count: (method, re) => calls.filter((c) => c.method === method && re.test(c.path)).length };
}

export const session = (phase, extra = {}) => ({ session_id: "s1", phase, user_issue: "x", resolution_state: null, evidence_request: null, pending_action: null, verification_state: null, ...extra });
export const evidenceRequest = (extra = {}) => ({ request_id: "req1", purpose: "initial", collectors: ["console", "storage", "page"], params: { storage_keys: [], selector: null, observe_ms: 1000 }, reason: "r", requires_user_action: false, cycle: 1, question: null, ...extra });
export const proposal = (action_id = "reset_user_preference", parameters = { preference: "timezone" }, extra = {}) => ({
  proposal_id: "prop1", action_id, parameters, diagnosis: "d", rationale: "r", expected_effect: "e", evidence_ids: ["ev1"], risk: "destructive_or_sensitive",
  verification: { strategy: "reobserve_cited", cited_evidence: { console: [{ id: "ev1", level: "error", text: "boom" }], network: [], cookies: [], storage: [], page: [] }, storage_keys: [], observe_ms: 400 },
  ...extra,
});

/** The standard happy-path backend. `over` replaces individual routes. */
export function happyBackend(over = {}) {
  let phase = "UNDERSTANDING";
  const pending = proposal();
  return fakeBackend({
    "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: evidenceRequest() })],
    "POST /api/sessions/s1/investigate": () => [200, { diagnosis: null, session: session("ACTION_PROPOSED", { pending_action: pending }) }],
    "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: pending.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: pending }) }],
    "POST /api/sessions/s1/approve": (b) => [200, b.approved ? session("EXECUTING", { pending_action: pending }) : session("RESOLVED", { resolution_state: "declined_by_user", pending_action: pending })],
    "POST /api/sessions/s1/action-result": () => [200, session("VERIFYING", { pending_action: pending })],
    "POST /api/sessions/s1/verify": () => [200, session("RESOLVED", { resolution_state: "resolved", pending_action: pending, verification_state: { outcome: "passed", passed: true, message: "ok" } })],
    "GET /api/sessions/s1/events": () => [404, {}],
    ...over,
  });
}
