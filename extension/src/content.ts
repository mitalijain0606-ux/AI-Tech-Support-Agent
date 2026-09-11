import type { ContentRequest, ContentResponse, StorageCheckResult } from "./lib/types";

// The one seeded marker this demo plants and inspects — see docs/README.md
// for why the bug is extension-seeded rather than an organic site defect.
const DEMO_STORAGE_KEY = "operon_demo_cache";

function checkStorage(): StorageCheckResult {
  const raw = window.localStorage.getItem(DEMO_STORAGE_KEY);

  if (raw === null) {
    return { key: DEMO_STORAGE_KEY, present: false, parse_status: "empty" };
  }

  try {
    JSON.parse(raw);
    return { key: DEMO_STORAGE_KEY, present: true, parse_status: "valid_json" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown parse error";
    // This is real, observable evidence — a genuine SyntaxError logged to
    // this tab's actual console, which the background service worker's
    // chrome.debugger session captures the same way it would for a defect
    // the site introduced itself.
    console.error(`SyntaxError: ${message} while parsing cached config ("${DEMO_STORAGE_KEY}")`);
    return {
      key: DEMO_STORAGE_KEY,
      present: true,
      parse_status: "syntax_error",
      error_message: message,
    };
  }
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
        sendResponse({ storage: checkStorage() });
        return;
      case "CLEAR_STORAGE_KEY":
        window.localStorage.removeItem(request.key);
        sendResponse({});
        return;
    }
  },
);
