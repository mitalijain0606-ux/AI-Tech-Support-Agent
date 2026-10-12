import { discoverAppActions, invokeAppAction } from "./lib/appbridge";
import { scrubParseError } from "./lib/sanitize";
import type {
  ContentRequest,
  ContentResponse,
  PageInspection,
  StorageCheckResult,
} from "./lib/types";

// The one seeded marker this demo plants and inspects — see docs/README.md
// for why the bug is extension-seeded rather than an organic site defect.
const DEMO_STORAGE_KEY = "operon_demo_cache";

// Bounds: how many localStorage keys are scanned, and how many reported.
const MAX_KEYS_SCANNED = 200;
const MAX_KEYS_REPORTED = 25;

function inspectKey(key: string): StorageCheckResult {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return { key, present: false, parse_status: "empty" };
  try {
    JSON.parse(raw);
    return { key, present: true, parse_status: "valid_json" };
  } catch (err) {
    // The parser's message can quote the stored text; keep only its shape.
    const message = scrubParseError(err instanceof Error ? err.message : "Unknown parse error");
    const looksLikeJson = /^\s*[[{]/.test(raw);
    if (key === DEMO_STORAGE_KEY) {
      // This is real, observable evidence — a genuine SyntaxError logged to
      // this tab's actual console, which the background service worker's
      // chrome.debugger session captures the same way it would for a defect
      // the site introduced itself.
      console.error(`SyntaxError: ${message} while parsing cached config ("${DEMO_STORAGE_KEY}")`);
    }
    return {
      key,
      present: true,
      parse_status: looksLikeJson || key === DEMO_STORAGE_KEY ? "syntax_error" : "not_json",
      error_message: message.slice(0, 200),
    };
  }
}

// Shape only, never values: the requested keys, plus any key whose value
// looks like JSON but doesn't parse (a corrupted cache), bounded.
function checkStorage(requestedKeys: string[] = []): StorageCheckResult[] {
  const results = new Map<string, StorageCheckResult>();
  for (const key of requestedKeys.slice(0, 10)) results.set(key, inspectKey(key));

  const total = Math.min(window.localStorage.length, MAX_KEYS_SCANNED);
  for (let i = 0; i < total && results.size < MAX_KEYS_REPORTED; i++) {
    const key = window.localStorage.key(i);
    if (key === null || results.has(key)) continue;
    const result = inspectKey(key);
    if (result.parse_status === "syntax_error") results.set(key, result);
  }
  return [...results.values()];
}

async function serviceWorkerScopes(): Promise<string[]> {
  if (!("serviceWorker" in navigator)) return [];
  const registrations = await navigator.serviceWorker.getRegistrations();
  return registrations.slice(0, 5).map((r) => new URL(r.scope).pathname);
}

async function inspectPage(selector?: string | null): Promise<PageInspection> {
  let matches: number | null = null;
  if (selector) {
    try {
      matches = document.querySelectorAll(selector).length;
    } catch {
      matches = null; // invalid selector
    }
  }
  return {
    url_path: location.pathname,
    title: document.title ? document.title.slice(0, 120) : null,
    ready_state: document.readyState,
    service_worker_controlled: Boolean(navigator.serviceWorker?.controller),
    service_worker_scopes: await serviceWorkerScopes(),
    selector: selector ?? null,
    selector_matches: matches,
  };
}

async function unregisterServiceWorker(scope?: string | null): Promise<ContentResponse> {
  if (!("serviceWorker" in navigator)) return { unregistered: 0, remaining_scopes: [] };
  const registrations = await navigator.serviceWorker.getRegistrations();
  let unregistered = 0;
  for (const registration of registrations) {
    if (!scope || new URL(registration.scope).pathname === scope) {
      if (await registration.unregister()) unregistered++;
    }
  }
  return { unregistered, remaining_scopes: await serviceWorkerScopes() };
}

chrome.runtime.onMessage.addListener(
  (request: ContentRequest, _sender, sendResponse: (response: ContentResponse) => void) => {
    switch (request.type) {
      case "SEED":
        window.localStorage.setItem(DEMO_STORAGE_KEY, "{invalid-json");
        sendResponse({});
        return;
      case "RESET_STORAGE":
        window.localStorage.removeItem(DEMO_STORAGE_KEY);
        sendResponse({});
        return;
      case "CHECK_STORAGE":
        sendResponse({ storage: checkStorage(request.keys) });
        return;
      case "CLEAR_STORAGE_KEY":
        window.localStorage.removeItem(request.key);
        sendResponse({});
        return;
      case "INSPECT_PAGE":
        inspectPage(request.selector)
          .then((page) => sendResponse({ page }))
          .catch((err) => sendResponse({ error: String(err) }));
        return true; // async response
      case "DISCOVER_APP_ACTIONS":
        discoverAppActions(window)
          .then((app_actions) => sendResponse({ app_actions }))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      case "INVOKE_APP_ACTION":
        invokeAppAction(window, request.action, request.params)
          .then((app_result) => sendResponse({ app_result }))
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
      case "UNREGISTER_SERVICE_WORKER":
        unregisterServiceWorker(request.scope)
          .then(sendResponse)
          .catch((err) => sendResponse({ error: String(err) }));
        return true;
    }
  },
);
