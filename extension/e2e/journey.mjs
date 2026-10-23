// The hackathon demo journey, end to end, through BOTH interfaces against the real backend:
// NexaDesk (buggy-cloud/) + the Operon SDK widget, and NexaDesk + the built Chrome extension.
// Every outcome is checked independently — from the backend's session record, the app's real
// state after a fresh load, and the presenter's demo console — never from the UI's own message.
//
//   npm run e2e:journey                       (offline engine)
//   OPERON_E2E_GROQ=1 npm run e2e:journey     (real model; paced for the free tier)
import { chromium } from "playwright-core";
import { SEARCH_KEY } from "../../buggy-cloud/src/bugs.js";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import { buildExtension, extensionState, launchWithExtension, pinActiveTab, popupDriver, recorder, startBackend } from "./lib/harness.mjs";

const useGroq = process.env.OPERON_E2E_GROQ === "1";
const pace = () => (useGroq ? new Promise((r) => setTimeout(r, 20_000)) : Promise.resolve());
const { check, summary } = recorder();
const cfg = {};
const app = await startBuggyCloud({ operon: cfg });
const backend = await startBackend({ groq: useGroq, env: { CORS_ALLOW_ORIGINS: app.url, RATE_LIMIT_PER_MINUTE: "600" } });
Object.assign(cfg, { backendUrl: backend.url, token: backend.tokens.user });
console.log(`backend ${backend.url} · NexaDesk ${app.url} · engine ${useGroq ? "groq" : "rule_based"}`);

const ready = (p) => p.waitForFunction(() => window.__buggyCloud?.ready === true, null, { timeout: 20_000 });
const errorsOn = (p) => p.locator(".error").count();
const widgetState = (p) => p.locator("#operon-panel").getAttribute("data-state");
const settle = (p, re = /^(proposal|escalated|needs_|error|resolved|declined|unverified|not_executed)/) =>
  p.waitForFunction((src) => new RegExp(src).test(document.querySelector("#operon-panel")?.dataset.state ?? ""), re.source, { timeout: 120_000 });
const pageErrors = [];

async function consoleStatus(page, bug) {
  await page.goto(`${app.url}/demo`);
  await page.locator(`#scenarios [data-bug="${bug}"]`).waitFor();
  return page.locator(`#scenarios [data-bug="${bug}"]`).getAttribute("data-status");
}
async function activateFromConsole(page, bug) {
  await page.goto(`${app.url}/demo`);
  await page.locator(`#scenarios [data-bug="${bug}"] a.btn.primary`).click();
  await ready(page);
}
async function ask(page, text) {
  await page.fill("#operon-issue", text);
  await page.click("#operon-diagnose");
  await settle(page);
  return backend.session(await page.locator("#operon-panel").getAttribute("data-session"));
}

async function sdkJourney(label) {
  console.log(`\n== SDK widget journey (${label})`);
  const browser = await chromium.launch({ executablePath: process.env.OPERON_E2E_CHROMIUM || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(`${label}: ${e.message}`));

  // 1. healthy start
  await page.goto(`${app.url}/?reset=1`);
  await ready(page);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  check(`${label}: NexaDesk starts healthy (no error banner) with the support widget ready`, (await errorsOn(page)) === 0);
  check(`${label}: the demo console reports scenario 2 as not active`, (await consoleStatus(page, 2)) === "idle");

  // 2. activate the timezone bug from the console
  await activateFromConsole(page, 2);
  check(`${label}: activating scenario 2 opens the affected page with the real symptom`, (await errorsOn(page)) > 0 && /account/.test(page.url()) && /Mars\/Phobos/.test(await page.locator("#account-prefs").innerText()));
  check(`${label}: the console now reports it active`, (await consoleStatus(page, 2)) === "active");
  await page.goBack();
  await ready(page);

  // 3. diagnose through the widget
  let s = await ask(page, "Dates are missing and an error banner appears");
  const d = s.diagnoses.at(-1);
  check(`${label}: the backend diagnosed invalid_preference from collected evidence`, d?.category === "invalid_preference" && d.evidence_ids.length > 0 && s.source === "sdk", `${d?.category} cites ${d?.evidence_ids}`);
  check(`${label}: it proposes resetting the timezone and waits for approval`, (await widgetState(page)) === "proposal" && s.pending_action?.action_id === "reset_user_preference" && s.pending_action?.parameters?.preference === "timezone" && s.attempted_actions.length === 0);
  check(`${label}: the widget explains the fix in plain language`, /Reset your timezone preference/.test(await page.locator("#operon-detail").innerText()));

  // 4. reload with the proposal pending → the widget picks it up (SDK session recovery)
  const sid = s.session_id;
  await page.reload();
  await ready(page);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  check(`${label}: after a page reload the pending proposal is recovered (same session, nothing executed)`, (await page.locator("#operon-panel").getAttribute("data-session")) === sid && (await widgetState(page)) === "proposal" && (await backend.session(sid)).attempted_actions.length === 0);

  // 5. approve → real fix → backend verification
  await page.click("#operon-approve");
  await settle(page, /^(resolved|unverified|error|not_executed)/);
  s = await backend.session(sid);
  check(`${label}: approving runs exactly the approved action and the BACKEND verifies it`, (await widgetState(page)) === "resolved" && s.phase === "RESOLVED" && s.verification_state?.outcome === "passed" && s.attempted_actions.length === 1, s.verification_state?.message);
  await page.goto(`${app.url}/?bug=2#/account`);
  await ready(page);
  check(`${label}: INDEPENDENT CHECK — a fresh load of the app shows valid dates and no error`, (await errorsOn(page)) === 0 && !/—/.test(await page.locator("#prefs-example").innerText()));
  check(`${label}: the console reports scenario 2 fixed, with the resolved run recorded`, (await consoleStatus(page, 2)) === "fixed" && /Resolved and verified/.test(await page.locator('#scenarios [data-bug="2"]').innerText()));
  await pace();

  // 6. reset (re-activate) then switch to the search bug: no contamination
  await activateFromConsole(page, 2);
  check(`${label}: resetting the scenario plants the fault again`, (await errorsOn(page)) > 0);
  await activateFromConsole(page, 8);
  const banners = await page.locator(".error").allInnerTexts();
  check(`${label}: switching to scenario 8 starts clean — only the search fault, no timezone fault left over`, banners.length === 1 && /saved search filters/.test(banners[0]) && (await consoleStatus(page, 2)) === "idle", banners.join(" | "));
  await page.goto(`${app.url}/?bug=8#/projects`);
  await ready(page);
  check(`${label}: project search is disabled by the real fault`, await page.locator("#project-search").isDisabled());

  // 7. reject → nothing changes
  s = await ask(page, "Project search is unavailable");
  check(`${label}: scenario 8 diagnosed as storage corruption of the search key`, s.pending_action?.action_id === "clear_storage_key" && s.pending_action?.parameters?.key === SEARCH_KEY, JSON.stringify(s.pending_action?.parameters));
  await page.click("#operon-reject");
  await settle(page, /^(declined|error)/);
  const stillBroken = await page.evaluate((k) => localStorage.getItem(k), SEARCH_KEY);
  check(`${label}: rejecting records the decision and changes NOTHING`, (await widgetState(page)) === "declined" && (await backend.session(s.session_id)).attempted_actions.length === 0 && stillBroken !== null && (() => { try { JSON.parse(stillBroken); return false; } catch { return true; } })());
  await pace();

  // 8. ask again → approve → search works
  await page.click("#operon-new");
  s = await ask(page, "Project search is unavailable");
  await page.click("#operon-approve");
  await settle(page, /^(resolved|unverified|error|not_executed)/);
  s = await backend.session(s.session_id);
  await page.goto(`${app.url}/?bug=8#/projects`);
  await ready(page);
  check(`${label}: approving clears only the corrupted key; verified; search works again`, s.verification_state?.outcome === "passed" && !(await page.locator("#project-search").isDisabled()) && (await errorsOn(page)) === 0);
  await page.fill("#project-search", "billing");
  check(`${label}: …and actually filters`, (await page.locator("#projects-table tbody tr").count()) === 1);
  await pace();

  // 9. a server-side fault escalates with a ticket, visible on the dashboard
  await activateFromConsole(page, 5);
  s = await ask(page, "I'm shown as signed out");
  const ticket = s.escalation_state?.ticket_id;
  check(`${label}: a server-side fault escalates instead of inventing a fix`, (await widgetState(page)) === "escalated" && s.phase === "ESCALATED" && !s.pending_action && s.attempted_actions.length === 0, s.resolution_state);
  check(`${label}: the widget shows the real ticket reference`, Boolean(ticket) && (await page.locator("#operon-ticket").innerText()) === ticket);
  const t = await backend.api("GET", `/api/tickets/${ticket}`, undefined, backend.tokens.admin);
  check(`${label}: the ticket is on the support dashboard API with the evidence`, t.status === 200 && t.body.status === "open" && t.body.report.evidence.length > 0 && t.body.report.diagnoses.length > 0);
  await browser.close();
}

async function extensionJourney() {
  console.log("\n== Chrome extension journey");
  const ext = await launchWithExtension(buildExtension("e2e-local", backend.url));
  await ext.setToken(backend.tokens.user);
  const { ctx, extId, sw } = ext;
  const target = await ctx.newPage();
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  const popup = popupDriver(popupPage);
  const run = async (bug, text) => {
    await target.goto(`${app.url}/?bug=${bug}&reset=1`);
    await ready(target);
    await pinActiveTab(sw, target.url());
    await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
    await popupPage.locator("textarea").waitFor();
    await popup.ask(text);
    for (let i = 0; i < 4; i++) {
      await popupPage.locator("header", { hasText: /Awaiting approval|Escalated|Resolved|Needs more evidence|Error/ }).waitFor({ timeout: 120_000 });
      if (!/Needs more evidence/.test(await popupPage.locator("header").innerText())) break;
      await popup.click("Collect evidence");
      await popupPage.waitForTimeout(1500);
    }
    return extensionState(popupPage);
  };

  let st = await run(2, "Dates are missing and an error banner appears");
  check("extension: scenario 2 → proposes the same fix as the widget", st.phase === "awaiting_approval" && st.session.pending_action?.action_id === "reset_user_preference" && st.session.pending_action?.parameters?.preference === "timezone");
  check("extension: the popup names the investigated site", /Investigating/.test(await popupPage.locator("body").innerText()));
  await popup.click("Approve");
  await popup.waitPhase("Resolved", 60_000);
  let s = await backend.session(st.session.session_id);
  await target.goto(`${app.url}/?bug=2`);
  await ready(target);
  check("extension: approve → BACKEND-verified fix → a fresh load is clean", s.verification_state?.outcome === "passed" && (await errorsOn(target)) === 0);
  await pace();

  st = await run(8, "Project search is unavailable");
  check("extension: scenario 8 (after a reset/switch) → proposes clearing the search key", st.session?.pending_action?.action_id === "clear_storage_key" && st.session.pending_action.parameters.key === SEARCH_KEY);
  await popup.click("Deny");
  await popup.waitPhase("Resolved");
  s = await backend.session(st.session.session_id);
  check("extension: deny → nothing executed, the fault is still there", s.resolution_state === "declined_by_user" && s.attempted_actions.length === 0 && (await target.evaluate((k) => localStorage.getItem(k), SEARCH_KEY)) !== null);
  await pace();

  st = await run(4, "The project list never loads");
  check("extension: a server-side fault escalates with a ticket and no action", st.phase === "escalated" && Boolean(st.session?.escalation_state?.ticket_id) && st.session.attempted_actions.length === 0);
  check("extension: the popup tells the user the ticket reference", (await popupPage.locator("body").innerText()).includes(st.session.escalation_state.ticket_id));
  const own = ext.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
  check("extension: no extension runtime errors", own.length === 0, own.map((e) => e.text).join(" | "));
  await ext.close();
}

try {
  await sdkJourney("run 1");
  await pace();
  await sdkJourney("run 2 (fresh browser context)");
  await pace();
  await extensionJourney();
  check("no uncaught page errors in NexaDesk", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  check("journey completed without exception", false, err.message.split("\n")[0]);
}

backend.stop();
await app.close();
process.exit(summary() ? 0 : 1);
