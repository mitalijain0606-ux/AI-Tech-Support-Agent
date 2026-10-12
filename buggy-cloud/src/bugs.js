// The seeded defects. Each is deterministic: `?bug=N` always produces the same
// observable failure, and `expected` is the ground truth a correct diagnosis
// must reach (it is what the end-to-end test asserts and what the evaluation
// fixtures mirror). Definitions only — how a bug is switched on lives in
// activate.js, how it shows up in the UI in ui.js.

export const SETTINGS_KEY = "buggycloud_settings";
export const PREFS_KEY = "buggycloud_prefs";

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
]);

export function bugById(id) {
  return BUGS.find((b) => b.id === id) ?? null;
}
