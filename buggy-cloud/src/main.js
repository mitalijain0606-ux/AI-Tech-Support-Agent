import { registerOperon } from "/sdk/operon-sdk.js";
import { activeBug, ensureStaleWorker, resetScenario, seedBug, wantsReset } from "./activate.js";
import { createApi } from "./api.js";
import { PREFS_KEY, SETTINGS_KEY } from "./bugs.js";
import { mountOperon } from "./operon-panel.js";
import { DEFAULT_PREFS, loadPrefs, resetPreference } from "./prefs.js";
import { render } from "./ui.js";

const root = document.getElementById("app");
const bug = activeBug(location.search);
if (wantsReset(location.search)) {
  // "Reset this scenario": clean slate, then continue as a fresh first visit (the URL loses ?reset=1).
  await resetScenario(localStorage);
  const clean = new URLSearchParams(location.search);
  clean.delete("reset");
  history.replaceState(null, "", `${location.pathname}${clean.toString() ? `?${clean}` : ""}`);
}
seedBug(bug, localStorage);

const api = createApi({ reportsBase: document.querySelector('meta[name="reports-api"]')?.content ?? "", bug });

async function load() {
  const errors = [];
  const state = { projects: null, account: null, reports: null, prefs: { ...DEFAULT_PREFS }, errors, bug };
  const fail = (what, err) => {
    console.error(`${what}: ${err.name === "Error" ? "" : `${err.name}: `}${err.message}`);
    errors.push(`${what}.`);
  };
  state.onFormatError = (err) => {
    const message = `Could not format values for display: ${err.name}: ${err.message}`;
    if (!errors.includes(message)) {
      console.error(message);
      errors.push(message);
    }
  };

  try {
    JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch (err) {
    fail(`Failed to load saved settings (${SETTINGS_KEY})`, err);
  }
  try {
    state.prefs = loadPrefs(localStorage, PREFS_KEY);
  } catch (err) {
    fail(`Failed to load preferences (${PREFS_KEY})`, err);
  }

  const [projects, me, reports] = await Promise.allSettled([api.projects(), api.me(), loadReports()]);
  if (projects.status === "fulfilled") state.projects = projects.value.projects;
  else fail("Could not load projects", projects.reason);
  if (me.status === "fulfilled") state.account = me.value;
  else fail("Could not load your account", me.reason);
  if (reports.status === "fulfilled") state.reports = reports.value.reports;
  else fail("Could not load reports", reports.reason);
  return state;
}

// The reports panel is a lazily loaded chunk. While a stale service worker is
// registered (bug 7) the chunk manifest it serves points at a file that no
// longer exists.
async function loadReports() {
  if (await ensureStaleWorker(bug, localStorage)) {
    throw Object.assign(new Error("Loading chunk reports failed. (missing: /chunks/reports.4f3a9c.js)"), { name: "ChunkLoadError" });
  }
  return api.reports();
}

async function paint() {
  render(root, await load());
}

// Start the Operon SDK before the first paint, so errors from page load are already captured.
const operonClient = await mountOperon({ root, reobserve: paint });

registerOperon({
  appId: "buggy-cloud",
  actions: {
    reset_user_preference: async ({ preference }) => {
      const out = resetPreference(localStorage, PREFS_KEY, preference);
      await paint();
      return out;
    },
  },
});

await paint();
// `repaint` lets a test make the app re-run its real load path (and so re-raise its real errors).
window.__buggyCloud = { bug: bug?.id ?? null, ready: true, operon: operonClient ? "sdk" : "off", repaint: paint };
