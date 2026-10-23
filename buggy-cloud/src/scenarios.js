// The real status of each demo scenario in THIS browser, read from the application's own state —
// never from a label or a claim. Used by the demo control panel and the in-app footer.
//
//   active      the fault is present right now (the symptom is real)
//   fixed       the scenario was planted here and the fault is gone (e.g. Operon's approved fix)
//   idle        not planted in this browser
//   server      a server-side fault: active whenever the app is opened with this scenario
import { PREFS_KEY, SEARCH_KEY, SETTINGS_KEY } from "./bugs.js";
import { SEEDED_MARKER } from "./activate.js";
import { formatDate, formatMoney, loadPrefs } from "./prefs.js";

const parses = (raw) => {
  if (raw === null) return true;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
};
const prefsBroken = (storage, check) => {
  try {
    check(loadPrefs(storage, PREFS_KEY));
    return false;
  } catch {
    return true;
  }
};

export const SERVER_SIDE = new Set([4, 5, 6]);

/** `workers`: number of service-worker registrations for this origin (the caller looks it up). */
export function scenarioStatus(bugId, storage, { workers = 0 } = {}) {
  if (SERVER_SIDE.has(bugId)) return "server";
  const faulty = {
    1: () => !parses(storage.getItem(SETTINGS_KEY)),
    2: () => prefsBroken(storage, (p) => formatDate("2026-01-01T00:00:00Z", p)),
    3: () => prefsBroken(storage, (p) => formatMoney(1, p)),
    7: () => workers > 0,
    8: () => !parses(storage.getItem(SEARCH_KEY)),
  }[bugId];
  if (!faulty) return "idle";
  if (faulty()) return "active";
  return storage.getItem(SEEDED_MARKER) === String(bugId) ? "fixed" : "idle";
}

// What the Operon support widget in the app recorded about its own investigations (ids and
// outcomes only — no evidence, no text the user typed).
export const OUTCOME_LOG_KEY = "nexadesk_operon_outcomes";

export function recordOutcome(storage, entry) {
  let log = [];
  try {
    log = JSON.parse(storage.getItem(OUTCOME_LOG_KEY) ?? "[]");
    if (!Array.isArray(log)) log = [];
  } catch {
    log = [];
  }
  log.push({ at: new Date().toISOString(), ...entry });
  storage.setItem(OUTCOME_LOG_KEY, JSON.stringify(log.slice(-30)));
}

export function readOutcomes(storage) {
  try {
    const log = JSON.parse(storage.getItem(OUTCOME_LOG_KEY) ?? "[]");
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}
