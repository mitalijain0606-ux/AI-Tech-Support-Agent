// The seeded defects. Each is deterministic: `?bug=N` always produces the same
// observable failure, and `expected` is the ground truth a correct diagnosis
// must reach (it is what the end-to-end test asserts and what the evaluation
// fixtures mirror). Definitions only — how a bug is switched on lives in
// activate.js, how it shows up in the UI in ui.js.

export const SETTINGS_KEY = "buggycloud_settings";
export const PREFS_KEY = "buggycloud_prefs";
export const SEARCH_KEY = "buggycloud_saved_search";

export const BUGS = Object.freeze([
  {
    id: 1,
    slug: "corrupt-settings",
    title: "Saved settings are corrupted",
    symptom: "The dashboard shows an error instead of your projects.",
    expected: { category: "storage_corruption", action_id: "clear_storage_key", params: { key: SETTINGS_KEY }, resolves: true },
  },
  {
    id: 2,
    slug: "invalid-timezone",
    title: "Saved timezone is invalid",
    symptom: "Dates are missing and an error banner appears.",
    expected: { category: "invalid_preference", action_id: "reset_user_preference", params: { preference: "timezone" }, resolves: true },
  },
  {
    id: 3,
    slug: "invalid-currency",
    title: "Saved currency is invalid",
    symptom: "Prices are missing and an error banner appears.",
    expected: { category: "invalid_preference", action_id: "reset_user_preference", params: { preference: "currency" }, resolves: true },
  },
  {
    id: 4,
    slug: "projects-api-500",
    title: "The projects API fails",
    symptom: "The project list never loads.",
    expected: { category: "network_error", action_id: null, params: null, resolves: false },
  },
  {
    id: 5,
    slug: "session-401",
    title: "The account API rejects the session",
    symptom: "You are shown as signed out.",
    expected: { category: "auth_failure", action_id: null, params: null, resolves: false },
  },
  {
    id: 6,
    slug: "reports-cors",
    title: "The reports API is blocked by CORS",
    symptom: "The reports panel stays empty.",
    expected: { category: "network_error", action_id: null, params: null, resolves: false },
  },
  {
    id: 7,
    slug: "stale-service-worker",
    title: "A stale service worker serves an old bundle",
    symptom: "The reports panel fails with a chunk-loading error.",
    expected: { category: "service_worker_stale", action_id: "unregister_service_worker", params: { scope: "/" }, resolves: true },
  },
  {
    id: 8,
    slug: "corrupt-saved-search",
    title: "Saved search filters are corrupted",
    symptom: "Project search is unavailable and an error banner appears.",
    expected: { category: "storage_corruption", action_id: "clear_storage_key", params: { key: SEARCH_KEY }, resolves: true },
  },
]);

// What a presenter needs to know about each scenario (shown on the demo control panel).
// `page` is where the symptom is most visible; `cause` is the real underlying fault.
export const SCENARIO_NOTES = Object.freeze({
  1: { page: "#/", cause: "The saved settings value in localStorage is not valid JSON.", fix: "Operon clears that one storage key (with your approval).", verify: "The key is gone or parses, and the error is not logged again." },
  2: { page: "#/account", cause: "The saved time zone is \"Mars/Phobos\", so Intl throws a RangeError.", fix: "Operon asks the app to reset the time zone preference (with your approval).", verify: "Dates format again; the RangeError is gone." },
  3: { page: "#/account", cause: "The saved currency is \"US\", not an ISO code, so Intl throws.", fix: "Operon asks the app to reset the currency preference (with your approval).", verify: "Prices format again; the RangeError is gone." },
  4: { page: "#/projects", cause: "The projects API answers 500 (server-side).", fix: "None from the browser: Operon explains and escalates with a ticket.", verify: "—" },
  5: { page: "#/account", cause: "The account API answers 401: the session expired (server-side).", fix: "None: signing in is the user's step; Operon escalates.", verify: "—" },
  6: { page: "#/reports", cause: "The reports API on another origin sends no CORS header.", fix: "None from the browser: a server configuration problem; Operon escalates.", verify: "—" },
  7: { page: "#/reports", cause: "An old service worker stays registered and serves a stale chunk manifest.", fix: "Operon unregisters that service worker (with your approval).", verify: "No worker controls the page and the chunk error is gone." },
  8: { page: "#/projects", cause: "The saved project-search filters are not valid JSON.", fix: "Operon clears that one storage key (with your approval).", verify: "The key is gone and search works again." },
});

export function bugById(id) {
  return BUGS.find((b) => b.id === id) ?? null;
}
