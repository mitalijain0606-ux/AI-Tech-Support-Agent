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
        reject(
          new Error(
            `Couldn't reach this tab (${chrome.runtime.lastError.message}). Make sure you're on the target site.`,
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
const requestMethods = new Map<string, string>();

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
    requestMethods.set(p.requestId, p.request?.method ?? "GET");
  } else if (method === "Network.responseReceived") {
    const status: number = p.response?.status ?? 0;
    if (status < 400) return; // evidence budgeting: non-2xx only
    networkEvents.push({
      id: newId(),
      method: requestMethods.get(p.requestId) ?? "GET",
      url: p.response?.url ?? "",
      status,
      status_text: p.response?.statusText,
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
  requestMethods.clear();

  await attachDebugger(tab.id!);
  const storageCheck = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
  await sleep(600); // let async console/network debugger events land before we detach
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

  const storageSignals = storageCheck.storage ? [{ id: newId(), ...storageCheck.storage }] : [];

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

// ---- Backend calls ---------------------------------------------------------

async function callDiagnose(message: string, bundle: EvidenceBundle): Promise<Diagnosis> {
  const res = await fetch(`${BACKEND_URL}/api/diagnose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, bundle }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `Diagnosis request failed (${res.status})`);
  }
  return res.json();
}

async function callPolicy(action: ProposedAction): Promise<PolicyDecision> {
  const res = await fetch(`${BACKEND_URL}/api/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action_id: action.action_id,
      params: action.params,
      provider_capabilities: PROVIDER_CAPABILITIES,
    }),
  });
  if (!res.ok) throw new Error(`Policy request failed (${res.status})`);
  return res.json();
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

async function executeAndVerify(tab: chrome.tabs.Tab, diagnosis: Diagnosis, policy: PolicyDecision) {
  setState({ phase: "executing", diagnosis, policy });

  if (policy.action_id === "clear_storage_key") {
    const key = policy.validated_params.key as string;
    await sendToContent(tab.id!, { type: "CLEAR_STORAGE_KEY", key });
  } else if (policy.action_id !== "reload" && policy.action_id !== "inspect_page") {
    setState({
      phase: "escalated",
      diagnosis,
      policy,
      message: `Action '${policy.action_id}' isn't implemented by this provider yet.`,
    });
    return;
  }

  await reloadTab(tab.id!);
  setState({ phase: "verifying", diagnosis, policy });

  const check = await sendToContent(tab.id!, { type: "CHECK_STORAGE" });
  const stillBroken = check.storage?.parse_status === "syntax_error";

  if (stillBroken) {
    setState({ phase: "error", diagnosis, policy, message: "Verification failed — the issue is still present." });
  } else {
    setState({ phase: "resolved", diagnosis, policy, message: "Verified — the page initializes cleanly now." });
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
      setState({ phase: "idle" });
      return;
    }

    case "ASK_OPERON": {
      const tab = await getActiveTab();
      setState({ phase: "collecting" });
      const bundle = await collectEvidence(tab);

      setState({ phase: "diagnosing" });
      const diagnosis = await callDiagnose(command.message, bundle);

      if (!diagnosis.proposed_action) {
        setState({
          phase: "escalated",
          diagnosis,
          message: "No safe automatic action available for this — it needs a human.",
        });
        return;
      }

      const policy = await callPolicy(diagnosis.proposed_action);

      if (policy.decision === "DENY") {
        setState({ phase: "escalated", diagnosis, policy, message: policy.reason });
      } else if (policy.decision === "REQUIRE_APPROVAL") {
        setState({ phase: "awaiting_approval", diagnosis, policy });
      } else {
        await executeAndVerify(tab, diagnosis, policy);
      }
      return;
    }

    case "APPROVE": {
      if (state.phase !== "awaiting_approval" || !state.diagnosis || !state.policy) return;
      const tab = await getActiveTab();
      await executeAndVerify(tab, state.diagnosis, state.policy);
      return;
    }

    case "DENY":
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
