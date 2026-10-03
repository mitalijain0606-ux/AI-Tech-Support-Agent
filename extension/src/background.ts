import type {
  BackendPhase,
  ConsoleEvidence,
  ContentRequest,
  ContentResponse,
  CookieSignal,
  Diagnosis,
  EvidenceBundle,
  ExtensionState,
  InvestigateResponse,
  NetworkEvidence,
  PolicyDecision,
  PolicyResponse,
  PopupCommand,
  RemediationProposal,
  StorageCheckResult,
  SupportSession,
  ViewPhase,
} from "./lib/types";
import {
  citedStorageKeys,
  type Observation,
  type VerificationResult,
  verifyAgainstEvidence,
} from "./lib/verification";

// Injected at build time by scripts/build.mjs: OPERON_BACKEND_URL, else the
// target's "backend_url", else http://localhost:8000 for local development.
declare const __OPERON_BACKEND_URL__: string;
const BACKEND_URL = __OPERON_BACKEND_URL__;

// What this provider build can actually do. `unregister_service_worker` is
// intentionally absent — not implemented yet, so the Policy Engine will
// correctly DENY it if the model ever proposes it, rather than us needing a
// special case here.
const PROVIDER_CAPABILITIES = ["inspect_page", "reload", "clear_storage_key"];

let state: ExtensionState = { phase: "idle" };
const ports = new Set<chrome.runtime.Port>();

const BUSY_PHASES: ReadonlySet<ViewPhase> = new Set(["collecting", "investigating", "checking_policy", "executing", "verifying"]);

// MV3 stops an idle service worker after ~30s — e.g. while the user reads
// the approval screen — so the state (including the backend session id) is
// mirrored into chrome.storage.session and restored on the next wake-up.
const STATE_KEY = "operon_state";

const restored: Promise<void> = chrome.storage.session
  .get(STATE_KEY)
  .then((items) => {
    const saved = items[STATE_KEY] as
      | { state: ExtensionState; nextEvidenceId: number; lastBundle?: EvidenceBundle | null }
      | undefined;
    if (!saved) return;
    nextEvidenceId = saved.nextEvidenceId;
    lastBundle = saved.lastBundle ?? null;
    state = BUSY_PHASES.has(saved.state.phase)
      ? {
          ...saved.state,
          phase: "error",
          message: "Operon was interrupted mid-step (the extension restarted). Reset and try again.",
        }
      : saved.state;
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
  chrome.storage.session.set({ [STATE_KEY]: { state, nextEvidenceId, lastBundle } }).catch(() => {});
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
      resolve(response ?? {});
    });
  });
}

// ---- Evidence capture via chrome.debugger --------------------------------

let consoleEvents: ConsoleEvidence[] = [];
let networkEvents: NetworkEvidence[] = [];
let nextEvidenceId = 1;
// The most recent bundle sent to the backend — the baseline a remediation's
// verification compares against (its proposal cites ids from this bundle).
let lastBundle: EvidenceBundle | null = null;
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
    consoleEvents.push({ id: newId(), level: p.type === "warning" ? "warn" : "error", text: text || "(no message)" });
  } else if (method === "Runtime.exceptionThrown") {
    const text: string =
      p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? "Uncaught exception";
    consoleEvents.push({ id: newId(), level: "error", text });
  } else if (method === "Network.requestWillBeSent") {
    requestInfo.set(p.requestId, { method: p.request?.method ?? "GET", url: p.request?.url ?? "" });
  } else if (method === "Network.responseReceived") {
    const status: number = p.response?.status ?? 0;
    if (status < 400) return; // evidence budgeting: non-2xx only
    networkEvents.push({
      id: newId(),
      method: requestInfo.get(p.requestId)?.method ?? "GET",
      url: p.response?.url ?? "",
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
      url: info?.url ?? "",
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

// Evidence ids are unique per backend session, not per cycle: hypotheses
// accumulate evidence ids across cycles, so a second bundle must not reuse
// ev_001 for something different. ASK_OPERON resets the counter.
async function collectEvidence(tab: chrome.tabs.Tab): Promise<EvidenceBundle> {
  consoleEvents = [];
  networkEvents = [];
  requestInfo.clear();

  await attachDebugger(tab.id!);
  const storageCheck = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
  // A real investigation window, not a snapshot — this is what gives a
  // genuine complaint (not just the seeded demo bug) a chance to actually
  // produce console/network evidence while we're attached and watching.
  await sleep(4000);
  await detachDebugger(tab.id!);

  const hostname = new URL(tab.url!).hostname;
  const cookies = await chrome.cookies.getAll({ domain: hostname });
  const cookieSignals: CookieSignal[] = cookies.map((c) => ({
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

  // Only report the demo marker key when it's actually present — an
  // absent/reset key is not evidence of anything and shouldn't be handed
  // to the model as if it were a signal for an unrelated complaint.
  const storageSignals =
    storageCheck.storage && storageCheck.storage.present ? [{ id: newId(), ...storageCheck.storage }] : [];

  return {
    url: tab.url!,
    timestamp: Date.now() / 1000,
    console: consoleEvents,
    network: networkEvents,
    cookies: cookieSignals,
    storage: storageSignals,
    redaction_applied: [],
  };
}

// ---- Backend calls — SupportSession API ----------------------------------
//
// The backend owns a persisted, stateful session for every report — see
// backend/operon_backend/session_service.py. Every call below returns the
// updated SupportSession, and session.phase decides what happens next.

async function postJson<T>(path: string, body: unknown, what: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.detail === "string" ? err.detail : `${what} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function createBackendSession(userIssue: string): Promise<SupportSession> {
  return postJson("/api/sessions", { user_issue: userIssue, source: "github" }, "Starting a session");
}

function callInvestigate(sessionId: string, bundle: EvidenceBundle): Promise<InvestigateResponse> {
  return postJson(`/api/sessions/${sessionId}/investigate`, { bundle }, "Investigation request");
}

function callPolicy(sessionId: string, proposal: RemediationProposal): Promise<PolicyResponse> {
  return postJson(
    `/api/sessions/${sessionId}/policy`,
    { action_id: proposal.action_id, params: proposal.parameters, provider_capabilities: PROVIDER_CAPABILITIES },
    "Policy request",
  );
}

function recordApproval(sessionId: string, approved: boolean): Promise<SupportSession> {
  return postJson(`/api/sessions/${sessionId}/approve`, { approved }, "Recording approval");
}

function recordActionResult(sessionId: string, succeeded: boolean, detail: string): Promise<SupportSession> {
  return postJson(`/api/sessions/${sessionId}/action-result`, { succeeded, detail }, "Recording action result");
}

function recordVerification(sessionId: string, passed: boolean, message: string): Promise<SupportSession> {
  return postJson(`/api/sessions/${sessionId}/verify`, { passed, message }, "Recording verification");
}

// ---- Session-driven flow ---------------------------------------------------

// The one place a backend phase becomes a popup view. Phases the extension
// must act on itself (ACTION_PROPOSED, EXECUTING) are handled in advance().
function viewPhaseFor(phase: BackendPhase): ViewPhase {
  switch (phase) {
    case "INVESTIGATING":
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

// Explanation for the current phase, taken from the backend's own record:
// the reason it logged for the latest transition. While the investigation
// loop is waiting for more evidence, the diagnosis' reasoning says what's
// missing. Never touches diagnosis fields when diagnosis is null.
function outcomeMessage(session: SupportSession, diagnosis: Diagnosis | null): string {
  const last = session.phase_history[session.phase_history.length - 1];
  if (session.phase === "INVESTIGATING" && last?.from === "KNOWLEDGE_LOOKUP" && diagnosis) {
    return diagnosis.reasoning;
  }
  return last?.reason ?? "";
}

function render(session: SupportSession, diagnosis: Diagnosis | null, policy?: PolicyDecision) {
  const phase = viewPhaseFor(session.phase);
  const message =
    phase === "error"
      ? `The backend session is in phase ${session.phase}, which this extension doesn't handle yet.`
      : outcomeMessage(session, diagnosis);
  setState({ phase, session, diagnosis, policy, message });
}

// Continues from whatever phase the backend just returned: performs the
// next step the extension owes (policy check, execution), or renders it.
async function advance(
  tab: chrome.tabs.Tab,
  session: SupportSession,
  diagnosis: Diagnosis | null,
  policy?: PolicyDecision,
): Promise<void> {
  if (session.phase === "ACTION_PROPOSED") {
    const proposal = session.pending_action;
    if (!proposal) throw new Error("The session reached ACTION_PROPOSED without a pending action.");
    setState({ phase: "checking_policy", session, diagnosis });
    const result = await callPolicy(session.session_id, proposal);
    // The Policy Engine moved the session: WAITING_FOR_APPROVAL, EXECUTING
    // (ALLOW only) or ESCALATED (DENY). Nothing executes unless it's EXECUTING.
    return advance(tab, result.session, diagnosis, result.policy);
  }
  if (session.phase === "EXECUTING") {
    if (!policy) throw new Error("The session is EXECUTING but no policy decision is available.");
    return executeAndVerify(tab, session, diagnosis, policy);
  }
  render(session, diagnosis, policy);
}

async function investigateCycle(tab: chrome.tabs.Tab, session: SupportSession) {
  setState({ phase: "collecting", session });
  const bundle = await collectEvidence(tab);
  lastBundle = bundle;

  setState({ phase: "investigating", session });
  const result = await callInvestigate(session.session_id, bundle);
  await advance(tab, result.session, result.diagnosis);
}

// ---- Action execution + verification --------------------------------------

function reloadTab(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.reload(tabId);
  });
}

// Reloads the tab with the debugger already attached, so errors thrown during
// page load are captured, then watches for the same window evidence
// collection uses.
async function observeReload(tab: chrome.tabs.Tab): Promise<Observation> {
  await attachDebugger(tab.id!);
  try {
    consoleEvents = [];
    networkEvents = [];
    requestInfo.clear();
    discardConsoleUntilNavigation = true;
    await reloadTab(tab.id!);
    await sleep(4000);
  } finally {
    discardConsoleUntilNavigation = false;
    await detachDebugger(tab.id!);
  }
  return { console: consoleEvents, network: networkEvents, storage: null };
}

// Re-reads the storage signals the content script can report. Null when the
// tab can't be reached — verification then treats cited storage as unchecked.
async function recheckStorage(tab: chrome.tabs.Tab): Promise<StorageCheckResult[] | null> {
  try {
    const check = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
    return check.storage ? [check.storage] : [];
  } catch {
    return null;
  }
}

async function executeAndVerify(
  tab: chrome.tabs.Tab,
  session: SupportSession,
  diagnosis: Diagnosis | null,
  policy: PolicyDecision,
) {
  const sessionId = session.session_id;
  setState({ phase: "executing", session, diagnosis, policy });

  let detail: string;
  let observation: Observation | null = null;
  if (policy.action_id === "clear_storage_key") {
    const key = policy.validated_params.key as string;
    await sendToContent(tab.id!, { type: "CLEAR_STORAGE_KEY", key });
    detail = `cleared storage key '${key}'`;
  } else if (policy.action_id === "reload") {
    // The reload is the action; observing across it is also the verification.
    observation = await observeReload(tab);
    detail = "reloaded the page";
  } else if (policy.action_id === "inspect_page") {
    detail = `no-op action '${policy.action_id}'`;
  } else {
    // Unreachable today — PROVIDER_CAPABILITIES only declares actions
    // handled above, so the Policy Engine denies anything else before
    // execution is ever reached. Left in place as a defensive backstop,
    // reported to the backend as a failure rather than decided locally.
    const failure = `Action '${policy.action_id}' isn't implemented by this provider yet.`;
    let next = await recordActionResult(sessionId, false, failure);
    if (next.phase === "VERIFYING") next = await recordVerification(sessionId, false, failure);
    return advance(tab, next, diagnosis, policy);
  }

  const afterAction = await recordActionResult(sessionId, true, detail);
  if (afterAction.phase !== "VERIFYING") return advance(tab, afterAction, diagnosis, policy);

  setState({ phase: "verifying", session: afterAction, diagnosis, policy });

  let verdict: VerificationResult;
  if (policy.action_id === "clear_storage_key") {
    await reloadTab(tab.id!);
    const check = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
    const stillBroken = check.storage?.parse_status === "syntax_error";
    verdict = {
      passed: !stillBroken,
      message: stillBroken
        ? "Verification failed — the issue is still present."
        : "Verified — the page initializes cleanly now.",
    };
  } else {
    // Never assume success: re-observe the page and check that every piece of
    // evidence the proposal cited is actually gone.
    const citedIds = afterAction.pending_action?.evidence_ids ?? [];
    observation ??= await observeReload(tab);
    if (citedStorageKeys(lastBundle, citedIds).length > 0) {
      // After the debugger detaches, so the content script's own parse-error
      // log can't leak into the observation.
      observation = { ...observation, storage: await recheckStorage(tab) };
    }
    verdict = verifyAgainstEvidence(lastBundle, citedIds, observation);
  }

  // RESOLVED, back to INVESTIGATING (retry budget left), or ESCALATED.
  const afterVerify = await recordVerification(sessionId, verdict.passed, verdict.message);
  await advance(tab, afterVerify, diagnosis, policy);
}

// ---- Command handling -------------------------------------------------------

async function handleCommand(command: PopupCommand) {
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
      lastBundle = null;
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
      lastBundle = null;
      const session = await createBackendSession(command.message);
      await investigateCycle(tab, session);
      return;
    }

    case "INVESTIGATE_AGAIN": {
      // Another cycle on the same backend session, with fresh evidence.
      const { session } = state;
      if (state.phase !== "needs_more_evidence" || session?.phase !== "INVESTIGATING") return;
      const tab = await getActiveTab();
      await investigateCycle(tab, session);
      return;
    }

    case "APPROVE": {
      const { session, diagnosis, policy } = state;
      if (state.phase !== "awaiting_approval" || !session || !policy) return;
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
  restored.then(() => port.postMessage(state));
  port.onMessage.addListener((command: PopupCommand) => {
    restored
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
