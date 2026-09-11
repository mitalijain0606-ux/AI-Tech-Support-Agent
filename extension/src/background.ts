import type {
  ConsoleEvidence,
  ContentRequest,
  ContentResponse,
  CookieSignal,
  Diagnosis,
  EvidenceBundle,
  NetworkEvidence,
  PolicyDecision,
  PopupCommand,
  ProposedAction,
  SessionState,
} from "./lib/types";

// Change for a deployed backend (see docs/plan/01-phase-1-github.md).
const BACKEND_URL = "http://localhost:8000";

// What this provider build can actually do. `unregister_service_worker` is
// intentionally absent — not implemented yet, so the Policy Engine will
// correctly DENY it if the model ever proposes it, rather than us needing a
// special case here.
const PROVIDER_CAPABILITIES = ["inspect_page", "reload", "clear_storage_key"];

let state: SessionState = { phase: "idle" };
const ports = new Set<chrome.runtime.Port>();

function setState(next: SessionState) {
  state = next;
  for (const port of ports) {
    try {
      port.postMessage(state);
    } catch {
      ports.delete(port);
    }
  }
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
const requestInfo = new Map<string, { method: string; url: string }>();

function newId(): string {
  return `ev_${String(nextEvidenceId++).padStart(3, "0")}`;
}

chrome.debugger.onEvent.addListener((_source, method, params) => {
  const p = params as Record<string, any>;

  if (method === "Runtime.consoleAPICalled") {
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

async function collectEvidence(tab: chrome.tabs.Tab): Promise<EvidenceBundle> {
  consoleEvents = [];
  networkEvents = [];
  nextEvidenceId = 1;
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

// ---- Backend calls — SupportSession API (AGENT_ARCHITECTURE.md Phase 1) --
//
// The backend now owns a persisted, stateful session for every report —
// see backend/operon_backend/session_service.py. This extension no longer
// carries the diagnosis/policy result as the only record of what
// happened; it drives the same session forward one step at a time and the
// backend logs every transition.

let currentSessionId: string | null = null;

async function createBackendSession(userIssue: string): Promise<string> {
  const res = await fetch(`${BACKEND_URL}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_issue: userIssue, source: "github" }),
  });
  if (!res.ok) throw new Error(`Could not start a session (${res.status})`);
  const body = await res.json();
  return body.session_id as string;
}

async function callDiagnose(sessionId: string, bundle: EvidenceBundle): Promise<Diagnosis> {
  const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundle }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Diagnosis request failed (${res.status})`);
  }
  const body = await res.json();
  return body.diagnosis as Diagnosis;
}

async function callPolicy(sessionId: string, action: ProposedAction): Promise<PolicyDecision> {
  const res = await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action_id: action.action_id,
      params: action.params,
      provider_capabilities: PROVIDER_CAPABILITIES,
    }),
  });
  if (!res.ok) throw new Error(`Policy request failed (${res.status})`);
  const body = await res.json();
  return body.policy as PolicyDecision;
}

async function recordApproval(sessionId: string, approved: boolean): Promise<void> {
  await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
}

async function recordActionResult(sessionId: string, succeeded: boolean, detail: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/action-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ succeeded, detail }),
  });
}

async function recordVerification(sessionId: string, passed: boolean, message: string): Promise<void> {
  await fetch(`${BACKEND_URL}/api/sessions/${sessionId}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passed, message }),
  });
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

async function executeAndVerify(sessionId: string, tab: chrome.tabs.Tab, diagnosis: Diagnosis, policy: PolicyDecision) {
  setState({ phase: "executing", diagnosis, policy });

  if (policy.action_id === "clear_storage_key") {
    const key = policy.validated_params.key as string;
    await sendToContent(tab.id!, { type: "CLEAR_STORAGE_KEY", key });
    await recordActionResult(sessionId, true, `cleared storage key '${key}'`);
  } else if (policy.action_id !== "reload" && policy.action_id !== "inspect_page") {
    // Unreachable today — PROVIDER_CAPABILITIES only declares actions
    // handled above, so the Policy Engine denies anything else before
    // execution is ever reached. Left in place as a defensive backstop.
    setState({
      phase: "escalated",
      diagnosis,
      policy,
      message: `Action '${policy.action_id}' isn't implemented by this provider yet.`,
    });
    return;
  } else {
    await recordActionResult(sessionId, true, `no-op action '${policy.action_id}'`);
  }

  await reloadTab(tab.id!);
  setState({ phase: "verifying", diagnosis, policy });

  const check = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
  const stillBroken = check.storage?.parse_status === "syntax_error";
  const message = stillBroken
    ? "Verification failed — the issue is still present."
    : "Verified — the page initializes cleanly now.";
  await recordVerification(sessionId, !stillBroken, message);

  if (stillBroken) {
    setState({ phase: "error", diagnosis, policy, message });
  } else {
    setState({ phase: "resolved", diagnosis, policy, message });
  }
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
      const tab = await getActiveTab();
      await sendToContent(tab.id!, { type: "RESET_STORAGE" });
      currentSessionId = null;
      setState({ phase: "idle" });
      return;
    }

    case "ASK_OPERON": {
      const tab = await getActiveTab();
      currentSessionId = await createBackendSession(command.message);

      setState({ phase: "collecting" });
      const bundle = await collectEvidence(tab);

      setState({ phase: "diagnosing" });
      const diagnosis = await callDiagnose(currentSessionId, bundle);

      if (!diagnosis.proposed_action) {
        setState({
          phase: "escalated",
          diagnosis,
          message: "No safe automatic action available for this — it needs a human.",
        });
        return;
      }

      const policy = await callPolicy(currentSessionId, diagnosis.proposed_action);

      if (policy.decision === "DENY") {
        setState({ phase: "escalated", diagnosis, policy, message: policy.reason });
      } else if (policy.decision === "REQUIRE_APPROVAL") {
        setState({ phase: "awaiting_approval", diagnosis, policy });
      } else {
        await executeAndVerify(currentSessionId, tab, diagnosis, policy);
      }
      return;
    }

    case "APPROVE": {
      if (state.phase !== "awaiting_approval" || !state.diagnosis || !state.policy || !currentSessionId) return;
      const tab = await getActiveTab();
      await recordApproval(currentSessionId, true);
      await executeAndVerify(currentSessionId, tab, state.diagnosis, state.policy);
      return;
    }

    case "DENY":
      if (currentSessionId) await recordApproval(currentSessionId, false);
      currentSessionId = null;
      setState({ phase: "idle" });
      return;
  }
}

chrome.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.postMessage(state);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((command: PopupCommand) => {
    handleCommand(command).catch((err) => {
      setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    });
  });
});
