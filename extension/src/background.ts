import {
  BACKEND_PHASES,
  type BackendPhase,
  type Collector,
  type ConsoleEvidence,
  type ContentRequest,
  type ContentResponse,
  type CookieSignal,
  type Diagnosis,
  type EvidenceBundle,
  type EvidenceRequest,
  type ExtensionState,
  type InvestigateResponse,
  type NetworkEvidence,
  type PageSignal,
  type PolicyDecision,
  type PolicyResponse,
  type PopupCommand,
  type StorageSignal,
  type StorageState,
  type SupportSession,
  type VerificationObservation,
  type VerificationPlan,
  type ViewPhase,
} from "./lib/types";
import { redactDeep } from "./lib/sanitize";

// Injected at build time by scripts/build.mjs: OPERON_BACKEND_URL, else the
// target's "backend_url", else http://localhost:8000 for local development.
declare const __OPERON_BACKEND_URL__: string;
const BACKEND_URL = __OPERON_BACKEND_URL__;

// What this provider can do — sent once at session creation; the backend
// evaluates policy against these, not against per-request claims.
const PROVIDER_CAPABILITIES = [
  "inspect_page",
  "reload",
  "clear_storage_key",
  "unregister_service_worker",
  "console_errors",
  "network_requests",
];
const COLLECTORS: Collector[] = ["console", "network", "storage", "cookies", "page", "reload_observe"];

// Per-bundle caps, matching the backend's (evidence.KIND_CAPS).
const CAPS = { console: 40, network: 40, cookies: 40, storage: 25, page: 3 };
const MAX_TEXT = 500;
// The backend rejects longer values (schemas.py: 2000-char text, 200-char
// short fields). Context strings are truncated to fit; identifiers an action
// or a verification re-check depends on are dropped instead, because a
// truncated storage key or scope would name something else.
const MAX_URL = 1000;
const MAX_KEY = 200;
// Local guard on evidence requests continued without a user click per
// command; the backend's own limits are the real bound.
const MAX_AUTO_CYCLES = 6;
const RELOAD_TIMEOUT_MS = 30_000;

let state: ExtensionState = { phase: "idle" };
const ports = new Set<chrome.runtime.Port>();
let autoCycles = 0;

const BUSY_PHASES: ReadonlySet<ViewPhase> = new Set(["collecting", "investigating", "checking_policy", "executing", "verifying"]);

// MV3 stops an idle service worker after ~30s — e.g. while the user reads
// the approval screen — so the state (including the backend session id) is
// mirrored into chrome.storage.session and restored on the next wake-up.
const STATE_KEY = "operon_state";
let interruptedMidStep = false;

const restored: Promise<void> = chrome.storage.session
  .get(STATE_KEY)
  .then((items) => {
    const saved = items[STATE_KEY] as { state: ExtensionState; nextEvidenceId: number } | undefined;
    if (!saved) return;
    nextEvidenceId = saved.nextEvidenceId;
    state = saved.state;
    interruptedMidStep = BUSY_PHASES.has(saved.state.phase);
  })
  .catch(() => {
    // No restorable state — start idle.
  });

function setState(next: ExtensionState) {
  state = next;
  for (const port of ports) {
    try {
      port.postMessage(state);
    } catch {
      ports.delete(port);
    }
  }
  chrome.storage.session.set({ [STATE_KEY]: { state, nextEvidenceId } }).catch(() => {});
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab found. Open the target site in this window first.");
  }
  return tab;
}

function sendToContent(tabId: number, message: ContentRequest): Promise<ContentResponse> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response: ContentResponse) => {
      if (chrome.runtime.lastError) {
        // The most common cause by far: the extension was reloaded after
        // this tab was already open, so the tab is still running the old,
        // now-disconnected content script instance. Reloading the target
        // tab (not the extension) re-injects it and fixes this.
        reject(
          new Error(
            `Couldn't reach this tab (${chrome.runtime.lastError.message}). ` +
              `If you just reloaded the extension, reload this tab too — it's likely running a stale content script.`,
          ),
        );
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response ?? {});
    });
  });
}

// ---- Evidence capture via chrome.debugger --------------------------------

let consoleEvents: ConsoleEvidence[] = [];
let networkEvents: NetworkEvidence[] = [];
let nextEvidenceId = 1;
const requestInfo = new Map<string, { method: string; url: string }>();
// Set while observing across a reload: console output from the old document
// (still running until the navigation commits) must not count as evidence
// about the reloaded page.
let discardConsoleUntilNavigation = false;

function newId(): string {
  return `ev_${String(nextEvidenceId++).padStart(3, "0")}`;
}

chrome.debugger.onEvent.addListener((_source, method, params) => {
  const p = params as Record<string, any>;

  if (method === "Runtime.executionContextsCleared") {
    // Delivered in order with console events, exactly when the old
    // document's scripts are torn down.
    if (discardConsoleUntilNavigation) {
      consoleEvents = [];
      discardConsoleUntilNavigation = false;
    }
  } else if (method === "Runtime.consoleAPICalled") {
    if (p.type !== "error" && p.type !== "warning") return; // evidence budgeting: errors/warnings only
    const text = (p.args ?? [])
      .map((a: any) => a.value ?? a.description ?? "")
      .join(" ")
      .trim();
    consoleEvents.push({ id: newId(), level: p.type === "warning" ? "warn" : "error", text: (text || "(no message)").slice(0, MAX_TEXT) });
  } else if (method === "Runtime.exceptionThrown") {
    const text: string =
      p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "Uncaught exception";
    consoleEvents.push({ id: newId(), level: "error", text: text.slice(0, MAX_TEXT) });
  } else if (method === "Network.requestWillBeSent") {
    requestInfo.set(p.requestId, { method: p.request?.method ?? "GET", url: p.request?.url ?? "" });
  } else if (method === "Network.responseReceived") {
    const status: number = p.response?.status ?? 0;
    if (status < 400) return; // evidence budgeting: non-2xx only
    networkEvents.push({
      id: newId(),
      method: requestInfo.get(p.requestId)?.method ?? "GET",
      url: (p.response?.url ?? "").slice(0, MAX_TEXT),
      status,
      status_text: p.response?.statusText,
    });
  } else if (method === "Network.loadingFailed") {
    // A request a real browser-side blocker (ad blocker, privacy extension)
    // cancelled never gets a response at all, so Network.responseReceived
    // never fires for it — this is the only place that failure is visible.
    const errorText: string = p.errorText ?? "";
    const isClientBlocked = Boolean(p.blockedReason) || /BLOCKED/i.test(errorText);
    if (!isClientBlocked) return; // evidence budgeting: real client-blocks only, not every cancelled request
    const info = requestInfo.get(p.requestId);
    networkEvents.push({
      id: newId(),
      method: info?.method ?? "GET",
      url: (info?.url ?? "").slice(0, MAX_TEXT),
      status: 0,
      status_text: errorText || "blocked by client",
    });
  }
});

async function attachDebugger(tabId: number) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    throw new Error(
      `Couldn't attach to this tab (${err instanceof Error ? err.message : err}). ` +
        `Close DevTools on this tab if it's open, then try again.`,
    );
  }
  await chrome.debugger.sendCommand({ tabId }, "Network.enable");
  await chrome.debugger.sendCommand({ tabId }, "Runtime.enable");
}

async function detachDebugger(tabId: number) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached — fine
  }
}

function resetCapture() {
  consoleEvents = [];
  networkEvents = [];
  requestInfo.clear();
}

function reloadTab(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("The page did not finish reloading within 30 seconds."));
    }, RELOAD_TIMEOUT_MS);
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// Reloads the tab with the debugger already attached, so errors thrown during
// page load are captured, then watches for `observeMs`. Throws if the
// debugger can't attach.
async function observeReload(tab: chrome.tabs.Tab, observeMs: number): Promise<VerificationObservation> {
  await attachDebugger(tab.id!);
  try {
    resetCapture();
    discardConsoleUntilNavigation = true;
    await reloadTab(tab.id!);
    await sleep(observeMs);
  } finally {
    discardConsoleUntilNavigation = false;
    await detachDebugger(tab.id!);
  }
  return { console: [...consoleEvents], network: [...networkEvents], observed_ms: observeMs };
}

// ---- Requested evidence collection -----------------------------------------------

function withIds<T>(items: T[]): (T & { id: string })[] {
  return items.map((item) => ({ id: newId(), ...item }));
}

// Collects exactly what the backend asked for — nothing else — bounded.
async function collectForRequest(tab: chrome.tabs.Tab, request: EvidenceRequest): Promise<EvidenceBundle> {
  const wants = new Set(request.collectors);
  const errors: string[] = [];
  const observeConsole = wants.has("console") || wants.has("reload_observe");
  const observeNetwork = wants.has("network") || wants.has("reload_observe");
  let storage: StorageSignal[] = [];
  let page: PageSignal[] = [];
  let cookies: CookieSignal[] = [];

  resetCapture();
  let attached = false;
  if (observeConsole || observeNetwork) {
    try {
      await attachDebugger(tab.id!);
      attached = true;
    } catch {
      errors.push("debugger_unavailable");
    }
  }
  try {
    // Storage is read while attached: a corrupted value the page itself fails
    // to parse shows up as a real console error in the same window.
    if (wants.has("storage")) {
      try {
        const res = await sendToContent(tab.id!, { type: "CHECK_STORAGE", keys: request.params.storage_keys });
        // Absent keys are only evidence when they were explicitly asked about.
        storage = withIds(
          (res.storage ?? []).filter((s) => s.key.length <= MAX_KEY && (s.present || request.params.storage_keys.includes(s.key))),
        );
      } catch {
        errors.push("storage_unreachable");
      }
    }
    if (wants.has("page")) {
      try {
        const res = await sendToContent(tab.id!, { type: "INSPECT_PAGE", selector: request.params.selector });
        if (res.page) page = withIds([res.page]);
      } catch {
        errors.push("page_unreachable");
      }
    }
    if (attached) {
      if (wants.has("reload_observe")) {
        discardConsoleUntilNavigation = true;
        try {
          await reloadTab(tab.id!);
        } catch {
          errors.push("reload_timeout");
        }
      }
      await sleep(request.params.observe_ms);
    }
  } finally {
    discardConsoleUntilNavigation = false;
    if (attached) await detachDebugger(tab.id!);
  }

  if (wants.has("cookies")) {
    const hostname = new URL(tab.url!).hostname;
    const all = await chrome.cookies.getAll({ domain: hostname });
    cookies = all.slice(0, CAPS.cookies).map((c) => ({
      id: newId(),
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      http_only: c.httpOnly,
      same_site: c.sameSite,
      expires_at: c.expirationDate,
      // c.value is deliberately never read here — Contract 1a.
    }));
  }

  const bundle: EvidenceBundle = {
    url: tab.url!,
    timestamp: Date.now() / 1000,
    bundle_id: `bun_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
    request_id: request.request_id,
    collectors: request.collectors,
    collection_errors: errors,
    console: observeConsole ? consoleEvents.slice(-CAPS.console) : [],
    network: observeNetwork ? networkEvents.slice(-CAPS.network) : [],
    cookies,
    storage: storage.slice(0, CAPS.storage),
    page: page.slice(0, CAPS.page),
    redaction_applied: [],
  };
  // Pages log tokens and signed URLs; redact them here rather than have the
  // backend's tripwire reject the whole submission.
  const { value, rules } = redactDeep(bundle);
  // Truncate only after redaction, so a secret is never cut short of being recognised.
  return {
    ...value,
    url: value.url.slice(0, MAX_URL),
    page: value.page.map((p) => ({
      ...p,
      url_path: p.url_path.slice(0, MAX_URL),
      service_worker_scopes: p.service_worker_scopes.filter((scope) => scope.length <= MAX_URL),
    })),
    redaction_applied: rules,
  };
}

// ---- Backend calls — SupportSession API ----------------------------------

class BackendError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body: unknown, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new BackendError(`Can't reach the Operon backend (${BACKEND_URL}). Check that it's running, then try again.`, 0);
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new BackendError("This session no longer exists on the backend. Reset to start a new one.", 404);
    }
    const err = await res.json().catch(() => ({}));
    throw new BackendError(typeof err.detail === "string" ? err.detail : `${what} failed (${res.status})`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new BackendError(`${what}: the backend sent a response that isn't JSON.`, res.status);
  }
}

// The extension acts on session.phase, so a response without a recognisable
// session must stop the flow instead of being guessed at.
function asSession(value: unknown): SupportSession {
  const s = value as Partial<SupportSession> | null;
  if (!s || typeof s !== "object" || typeof s.session_id !== "string" || !BACKEND_PHASES.includes(s.phase as BackendPhase)) {
    throw new BackendError("The backend sent a malformed session. Reset and try again.", 0);
  }
  return value as SupportSession;
}

async function createBackendSession(userIssue: string): Promise<SupportSession> {
  return asSession(
    await request("POST", "/api/sessions", {
      user_issue: userIssue,
      source: "extension",
      provider_capabilities: PROVIDER_CAPABILITIES,
      collectors: COLLECTORS,
    }, "Starting a session"),
  );
}

async function fetchSession(sessionId: string): Promise<SupportSession> {
  return asSession(await request("GET", `/api/sessions/${sessionId}`, null, "Loading the session"));
}

async function callInvestigate(sessionId: string, bundle: EvidenceBundle): Promise<InvestigateResponse> {
  const res = await request<InvestigateResponse>("POST", `/api/sessions/${sessionId}/investigate`, { bundle }, "Investigation");
  return { diagnosis: res?.diagnosis ?? null, session: asSession(res?.session) };
}

async function callPolicy(session: SupportSession): Promise<PolicyResponse> {
  const pending = session.pending_action!;
  const res = await request<PolicyResponse>(
    "POST",
    `/api/sessions/${session.session_id}/policy`,
    { action_id: pending.action_id, params: pending.parameters, provider_capabilities: PROVIDER_CAPABILITIES },
    "Policy check",
  );
  if (!res?.policy || typeof res.policy.decision !== "string") throw new BackendError("The backend sent a malformed policy decision.", 0);
  return { policy: res.policy, session: asSession(res.session) };
}

async function recordApproval(sessionId: string, approved: boolean): Promise<SupportSession> {
  return asSession(await request("POST", `/api/sessions/${sessionId}/approve`, { approved }, "Recording approval"));
}

async function recordActionResult(sessionId: string, actionId: string, succeeded: boolean, detail: string): Promise<SupportSession> {
  return asSession(
    await request("POST", `/api/sessions/${sessionId}/action-result`, { action_id: actionId, succeeded, detail: detail.slice(0, 1000) }, "Recording the action result"),
  );
}

async function recordVerification(sessionId: string, actionId: string, observation: VerificationObservation): Promise<SupportSession> {
  return asSession(
    await request(
      "POST",
      `/api/sessions/${sessionId}/verify`,
      { action_id: actionId, observation: redactDeep(observation).value },
      "Recording verification",
    ),
  );
}

// ---- Session-driven flow ---------------------------------------------------

// The one place a backend phase becomes a popup view. Phases the extension
// must act on itself (NEED_INFORMATION without user action, ACTION_PROPOSED,
// EXECUTING, VERIFYING) are handled in advance().
function viewPhaseFor(phase: BackendPhase): ViewPhase {
  switch (phase) {
    case "NEED_INFORMATION":
      return "needs_more_evidence";
    case "ACTION_PROPOSED":
      return "checking_policy";
    case "WAITING_FOR_APPROVAL":
      return "awaiting_approval";
    case "EXECUTING":
      return "executing";
    case "VERIFYING":
      return "verifying";
    case "RESOLVED":
      return "resolved";
    case "ESCALATED":
      return "escalated";
    default:
      return "error";
  }
}

function outcomeMessage(session: SupportSession): string {
  if (session.phase === "NEED_INFORMATION") return session.evidence_request?.reason ?? "";
  if (session.phase === "ESCALATED" && session.escalation_state) {
    const { reason, guidance } = session.escalation_state;
    return guidance && guidance !== reason ? `${reason}\n\n${guidance}` : reason;
  }
  if (session.phase === "RESOLVED" && session.verification_state) return session.verification_state.message;
  return session.phase_history[session.phase_history.length - 1]?.reason ?? "";
}

function render(session: SupportSession, diagnosis: Diagnosis | null, policy?: PolicyDecision) {
  const phase = viewPhaseFor(session.phase);
  const message =
    phase === "error"
      ? `The backend session is in phase ${session.phase}, which this extension can't act on. Reset to start over.`
      : outcomeMessage(session);
  setState({ phase, session, diagnosis, policy, message });
}

// Continues from whatever phase the backend just returned: performs the next
// step the extension owes, or renders it. Never decides a phase itself.
async function advance(
  tab: chrome.tabs.Tab,
  session: SupportSession,
  diagnosis: Diagnosis | null,
  policy?: PolicyDecision,
): Promise<void> {
  switch (session.phase) {
    case "NEED_INFORMATION": {
      const req = session.evidence_request;
      if (req && !req.requires_user_action && autoCycles < MAX_AUTO_CYCLES) {
        autoCycles++;
        return investigateCycle(tab, session);
      }
      return render(session, diagnosis);
    }
    case "ACTION_PROPOSED": {
      if (!session.pending_action) throw new Error("The session reached ACTION_PROPOSED without a pending action.");
      setState({ phase: "checking_policy", session, diagnosis });
      const result = await callPolicy(session);
      // WAITING_FOR_APPROVAL, EXECUTING (ALLOW only) or ESCALATED (DENY).
      return advance(tab, result.session, diagnosis, result.policy);
    }
    case "EXECUTING":
      return executeAndVerify(tab, session, diagnosis, policy);
    case "VERIFYING":
      return verifyPending(tab, session, diagnosis, policy, null);
    default:
      return render(session, diagnosis, policy);
  }
}

async function investigateCycle(tab: chrome.tabs.Tab, session: SupportSession) {
  const req = session.evidence_request;
  if (!req) throw new Error("The backend didn't say what evidence it needs.");
  setState({ phase: "collecting", session });
  const bundle = await collectForRequest(tab, req);

  setState({ phase: "investigating", session });
  const result = await callInvestigate(session.session_id, bundle);
  await advance(tab, result.session, result.diagnosis);
}

// ---- Action execution + verification --------------------------------------

interface ExecutionOutcome {
  succeeded: boolean;
  detail: string;
  observation?: VerificationObservation;
}

async function executeAction(tab: chrome.tabs.Tab, session: SupportSession, policy?: PolicyDecision): Promise<ExecutionOutcome> {
  const pending = session.pending_action!;
  const params = (policy?.validated_params ?? pending.parameters) as Record<string, unknown>;
  const observeMs = pending.verification?.observe_ms ?? 4000;
  try {
    switch (pending.action_id) {
      case "clear_storage_key": {
        const key = String(params.key ?? "");
        if (!key) return { succeeded: false, detail: "no storage key to clear" };
        await sendToContent(tab.id!, { type: "CLEAR_STORAGE_KEY", key });
        return { succeeded: true, detail: `cleared storage key '${key}'` };
      }
      case "reload": {
        // The reload is the action; observing across it is also the
        // verification, so the page is reloaded once, not twice.
        try {
          return { succeeded: true, detail: "reloaded the page", observation: await observeReload(tab, observeMs) };
        } catch (err) {
          await reloadTab(tab.id!);
          return { succeeded: true, detail: `reloaded the page without observation (${err instanceof Error ? err.message : err})` };
        }
      }
      case "inspect_page": {
        const res = await sendToContent(tab.id!, { type: "INSPECT_PAGE", selector: (params.selector as string) ?? null });
        return { succeeded: true, detail: `inspected the page (selector matched ${res.page?.selector_matches ?? "n/a"} element(s))` };
      }
      case "unregister_service_worker": {
        const res = await sendToContent(tab.id!, { type: "UNREGISTER_SERVICE_WORKER", scope: (params.scope as string) ?? null });
        return res.unregistered
          ? { succeeded: true, detail: `unregistered ${res.unregistered} service worker(s)` }
          : { succeeded: false, detail: "no matching service worker registration was found" };
      }
      default:
        // Unreachable while PROVIDER_CAPABILITIES only declares the actions
        // above — reported to the backend as a failure, never faked.
        return { succeeded: false, detail: `action '${pending.action_id}' isn't implemented by this provider` };
    }
  } catch (err) {
    return { succeeded: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function recheckStorage(tab: chrome.tabs.Tab, keys: string[]): Promise<StorageState[] | null> {
  try {
    const res = await sendToContent(tab.id!, { type: "CHECK_STORAGE", keys });
    return (res.storage ?? []).filter((s) => keys.includes(s.key));
  } catch {
    return null;
  }
}

async function recheckServiceWorkers(tab: chrome.tabs.Tab): Promise<string[] | null> {
  try {
    const res = await sendToContent(tab.id!, { type: "INSPECT_PAGE" });
    return res.page?.service_worker_scopes ?? null;
  } catch {
    return null;
  }
}

// Observes what the verification plan needs. Reports what it saw, or an
// error saying why it couldn't — the backend decides what that means.
async function observeForVerification(
  tab: chrome.tabs.Tab,
  plan: VerificationPlan | null,
  prior: VerificationObservation | null,
): Promise<VerificationObservation> {
  const observeMs = plan?.observe_ms ?? 4000;
  const citesSignals = Boolean(plan && (plan.cited_evidence.console.length || plan.cited_evidence.network.length));
  let observation = prior;
  if (!observation) {
    try {
      observation = await observeReload(tab, observeMs);
    } catch (err) {
      if (citesSignals) return { console: [], network: [], error: "debugger_unavailable" };
      // Nothing cited needs the debugger: reload plainly and re-check state.
      try {
        await reloadTab(tab.id!);
      } catch {
        return { console: [], network: [], error: "reload_failed" };
      }
      observation = { console: [], network: [], observed_ms: 0 };
    }
  }
  const keys = [...new Set([...(plan?.storage_keys ?? []), ...(plan?.cited_evidence.storage ?? []).map((s) => s.key)])];
  // After the debugger detached, so the content script's own parse-error log
  // can't leak into the observation.
  if (keys.length) observation = { ...observation, storage: await recheckStorage(tab, keys) };
  if (plan?.strategy === "service_worker_recheck") {
    observation = { ...observation, service_worker_scopes: await recheckServiceWorkers(tab) };
  }
  return observation;
}

async function verifyPending(
  tab: chrome.tabs.Tab,
  session: SupportSession,
  diagnosis: Diagnosis | null,
  policy: PolicyDecision | undefined,
  prior: VerificationObservation | null,
) {
  const pending = session.pending_action!;
  setState({ phase: "verifying", session, diagnosis, policy });
  const observation = await observeForVerification(tab, pending.verification, prior);
  // RESOLVED, a retry evidence request (NEED_INFORMATION), or ESCALATED.
  const after = await recordVerification(session.session_id, pending.action_id, observation);
  await advance(tab, after, diagnosis, policy);
}

async function executeAndVerify(tab: chrome.tabs.Tab, session: SupportSession, diagnosis: Diagnosis | null, policy?: PolicyDecision) {
  if (!session.pending_action) throw new Error("The session is EXECUTING but has no pending action.");
  setState({ phase: "executing", session, diagnosis, policy });
  const outcome = await executeAction(tab, session, policy);
  const after = await recordActionResult(session.session_id, session.pending_action.action_id, outcome.succeeded, outcome.detail);
  if (after.phase === "VERIFYING") return verifyPending(tab, after, diagnosis, policy, outcome.observation ?? null);
  return advance(tab, after, diagnosis, policy);
}

// After a service-worker restart in the middle of a step, the extension
// can't know how far that step got — so it asks the backend, which is
// authoritative, and closes the step honestly.
async function resyncFromBackend() {
  const session = state.session;
  if (!session) {
    setState({ phase: "idle" });
    return;
  }
  try {
    const current = await fetchSession(session.session_id);
    if (current.phase === "EXECUTING" && current.pending_action) {
      const after = await recordActionResult(current.session_id, current.pending_action.action_id, false,
        "interrupted: the extension restarted before the action's result was known");
      return render(after, state.diagnosis ?? null, state.policy);
    }
    if (current.phase === "VERIFYING" && current.pending_action) {
      const after = await recordVerification(current.session_id, current.pending_action.action_id, { console: [], network: [], error: "interrupted" });
      return render(after, state.diagnosis ?? null, state.policy);
    }
    if (current.phase === "NEED_INFORMATION" || current.phase === "UNDERSTANDING") {
      // Re-show the request; the user (or the next command) continues it.
      return setState({ phase: "needs_more_evidence", session: current, diagnosis: state.diagnosis, message: current.evidence_request?.reason ?? "" });
    }
    render(current, state.diagnosis ?? null, state.policy);
  } catch (err) {
    setState({ phase: "error", session, message: err instanceof Error ? err.message : String(err) });
  }
}

const synced: Promise<void> = restored.then(() => (interruptedMidStep ? resyncFromBackend() : undefined));

// ---- Command handling -------------------------------------------------------

async function handleCommand(command: PopupCommand) {
  autoCycles = 0;
  switch (command.type) {
    case "GET_STATE":
      setState(state);
      return;

    case "SEED_BUG": {
      const tab = await getActiveTab();
      await sendToContent(tab.id!, { type: "SEED" });
      setState({ phase: "seeded" });
      return;
    }

    case "RESET": {
      // Local state first: the active tab may be one the content script can't
      // reach (outside the target, or stale), and that must never leave the
      // popup stuck on an error screen.
      setState({ phase: "idle" });
      try {
        const tab = await getActiveTab();
        await sendToContent(tab.id!, { type: "RESET_STORAGE" });
      } catch {
        // Best-effort cleanup of the demo key only.
      }
      return;
    }

    case "ASK_OPERON": {
      const tab = await getActiveTab();
      nextEvidenceId = 1;
      const session = await createBackendSession(command.message);
      if (session.phase !== "UNDERSTANDING") return render(session, null);
      await investigateCycle(tab, session);
      return;
    }

    case "INVESTIGATE_AGAIN": {
      // Another cycle on the same backend session, answering its request.
      const { session } = state;
      if (state.phase !== "needs_more_evidence" || !session) return;
      const current = await fetchSession(session.session_id);
      if (current.phase !== "NEED_INFORMATION" && current.phase !== "UNDERSTANDING") return render(current, state.diagnosis ?? null);
      const tab = await getActiveTab();
      await investigateCycle(tab, current);
      return;
    }

    case "APPROVE": {
      const { session, diagnosis, policy } = state;
      if (state.phase !== "awaiting_approval" || !session) return;
      const tab = await getActiveTab();
      const next = await recordApproval(session.session_id, true);
      await advance(tab, next, diagnosis ?? null, policy);
      return;
    }

    case "DENY": {
      const { session, diagnosis, policy } = state;
      if (state.phase !== "awaiting_approval" || !session) return;
      const next = await recordApproval(session.session_id, false);
      render(next, diagnosis ?? null, policy);
      return;
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  synced.then(() => port.postMessage(state));
  port.onMessage.addListener((command: PopupCommand) => {
    synced
      .then(() => handleCommand(command))
      .catch((err) => {
        setState({
          phase: "error",
          session: state.session,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  });
});
