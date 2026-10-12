// Checks the project you actually RUN: the backend and Buggy Cloud that `node scripts/dev-local.mjs` started
// (default http://localhost:8000 and http://127.0.0.1:4300), using the keys in ../.local/tokens.json and the
// extension that script built (dist/local-demo). Nothing is started or stopped here, and nothing outside the
// browser's own throwaway profile is changed; it does add test sessions to the local demo database.
//
//   npm run e2e:live
//
// Every scenario (seven bugs + the healthy control) runs through BOTH integration paths: the SDK panel in plain
// Chromium (no extension) and the built extension driving the same page. For each fixable bug it first REJECTS (the
// application must be unchanged and the backend must show nothing executed), then runs the scenario again from a clean
// state and APPROVES (the application's real state must change and the backend itself must report verification passed).
// Offline engine unless dev-local was started with --groq.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BUGS, PREFS_KEY, SETTINGS_KEY } from "../../buggy-cloud/src/bugs.js";
import { extensionState, launchWithExtension, pinActiveTab, popupDriver, recorder } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND = process.env.OPERON_LOCAL_BACKEND || "http://localhost:8000";
const APP = process.env.OPERON_LOCAL_APP || "http://127.0.0.1:4300";
const TOKEN = process.env.OPERON_LOCAL_TOKEN || JSON.parse(readFileSync(path.join(ROOT, ".local/tokens.json"), "utf-8")).user;
const EXT = path.join(ROOT, "extension/dist/local-demo");
const { check, summary } = recorder();

const api = async (p) => (await fetch(`${BACKEND}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
for (const [what, url] of [["backend", `${BACKEND}/health`], ["Buggy Cloud", `${APP}/`]]) {
  const ok = await fetch(url).then((r) => r.ok, () => false);
  if (!ok) {
    console.error(`${what} is not answering at ${url}. Start the project first:  node scripts/dev-local.mjs`);
    process.exit(2);
  }
}
const manifest = JSON.parse(readFileSync(path.join(EXT, "manifest.json"), "utf-8"));
check("the built extension (dist/local-demo) points at this backend", manifest.host_permissions.includes(`${BACKEND.replace("localhost", "localhost")}/*`), manifest.host_permissions.join(" "));

const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const errors = (page) => page.locator(".error").count();
async function openScenario(ctx, bug) {
  const page = await ctx.newPage();
  await page.goto(`${APP}/?${bug ? `bug=${bug.id}&` : ""}reset=1`); // the "Reset this scenario" path: clean slate every run
  await page.waitForFunction(() => window.__buggyCloud?.ready === true, null, { timeout: 20_000 });
  return page;
}
async function independentlyFixed(page, bug) {
  const a = bug.expected;
  await page.reload();
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  const clean = (await errors(page)) === 0;
  if (a.action_id === "clear_storage_key") return clean && (await stored(page, SETTINGS_KEY)) === null;
  if (a.action_id === "reset_user_preference") return clean && JSON.parse(await stored(page, PREFS_KEY))[a.params.preference] === { timezone: "UTC", currency: "USD", locale: "en-US" }[a.params.preference];
  if (a.action_id === "unregister_service_worker") return clean && (await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0;
  return clean;
}
const snapshot = async (page) => JSON.stringify([await stored(page, SETTINGS_KEY), await stored(page, PREFS_KEY), await errors(page)]);
function judge(label, bug, session) {
  const want = bug.expected;
  const last = session.diagnoses.at(-1);
  check(`${label}: diagnosed ${want.category}`, last?.category === want.category, `${last?.category}`);
  if (want.action_id) check(`${label}: proposes ${want.action_id} ${JSON.stringify(want.params)}`, session.pending_action?.action_id === want.action_id && JSON.stringify(session.pending_action.parameters) === JSON.stringify(want.params));
  else check(`${label}: proposes no action and escalates`, session.pending_action === null && session.phase === "ESCALATED" && session.attempted_actions.length === 0, session.phase);
}

// ===== SDK path: plain Chromium, no extension ==========================================================================
const plain = await chromium.launch({ channel: "chromium", executablePath: process.env.OPERON_E2E_CHROMIUM || undefined, headless: process.env.OPERON_E2E_HEADED !== "1" });
const settle = (page, ...s) => page.waitForFunction((x) => x.some((p) => document.querySelector("#operon-panel").dataset.state?.startsWith(p)), s, { timeout: 90_000 });
for (const bug of [...BUGS, null]) {
  const label = `SDK · ${bug ? `bug ${bug.id} ${bug.slug}` : "healthy control"}`;
  console.log(`\n== ${label}`);
  const ctx = await plain.newContext();
  let page = await openScenario(ctx, bug);
  check(`${label}: ${bug ? "the symptom is visible" : "the app is healthy"}`, bug ? (await errors(page)) > 0 : (await errors(page)) === 0 && (await page.locator("#projects li").count()) === 3);
  await page.click("#operon-diagnose");
  await settle(page, "proposal", "escalated", "needs_", "error");
  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  const session = await api(`/api/sessions/${sid}`);
  if (!bug) {
    check(`${label}: nothing proposed or executed`, session.pending_action === null && session.attempted_actions.length === 0, session.phase);
    await ctx.close();
    continue;
  }
  judge(label, bug, session);
  if (bug.expected.action_id) {
    const before = await snapshot(page);
    await page.click("#operon-reject");
    await settle(page, "declined");
    const rejected = await api(`/api/sessions/${sid}`);
    check(`${label}: REJECT — backend shows declined_by_user, nothing executed, application unchanged`, rejected.resolution_state === "declined_by_user" && rejected.attempted_actions.length === 0 && (await snapshot(page)) === before);
    await page.close();
    page = await openScenario(ctx, bug); // clean run
    await page.click("#operon-diagnose");
    await settle(page, "proposal");
    const sid2 = await page.locator("#operon-panel").getAttribute("data-session");
    await page.click("#operon-approve");
    await settle(page, "resolved", "unverified", "not_executed", "error");
    const done = await api(`/api/sessions/${sid2}`);
    check(`${label}: APPROVE — one attempt, executed, and the BACKEND says verification passed`, done.attempted_actions.length === 1 && done.attempted_actions[0].succeeded === true && done.verification_state?.outcome === "passed", done.verification_state?.message);
    check(`${label}: APPROVE — the application's real state changed (fresh load is clean)`, await independentlyFixed(page, bug));
  }
  await ctx.close();
}
// ----- the documented classic-script example (sdk/examples/minimal.html, built SDK script) -----------------------------
console.log("\n== SDK · minimal example page (classic script, built by sdk/scripts/build.mjs)");
{
  const ctx = await plain.newContext();
  const page = await ctx.newPage();
  await page.goto(`${APP}/sdk/examples/minimal.html`);
  await page.evaluate(() => localStorage.removeItem("example_prefs"));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#date").className === "broken", null, { timeout: 15_000 });
  check("example: starts with a real, visible problem", (await page.locator("#date").innerText()) === "(cannot show the date)");
  await page.click("#diagnose");
  await page.waitForFunction(() => /Operon proposes|Operon says|Operon error/.test(document.querySelector("#log").textContent), null, { timeout: 90_000 });
  check("example: proposes reset_user_preference for the timezone", /reset_user_preference \{"preference":"timezone"\}/.test(await page.locator("#log").innerText()));
  await page.click("#reject");
  await page.waitForFunction(() => /Rejected/.test(document.querySelector("#log").textContent));
  check("example: reject changes nothing", (await page.locator("#date").getAttribute("class")) === "broken" && JSON.parse(await stored(page, "example_prefs")).timezone === "Mars/Phobos");
  await page.click("#diagnose");
  await page.waitForFunction(() => !document.querySelector("#approve").hidden, null, { timeout: 90_000 });
  await page.click("#approve");
  await page.waitForFunction(() => /Executed/.test(document.querySelector("#log").textContent), null, { timeout: 60_000 });
  check("example: approve runs the fix and the backend's verdict is passed", /Executed: true\. Backend verification: passed/.test(await page.locator("#log").innerText()));
  check("example: the date renders and the saved timezone really changed", (await page.locator("#date").getAttribute("class")) === "" && JSON.parse(await stored(page, "example_prefs")).timezone === "UTC");
  await ctx.close();
}
await plain.close();

// ===== Extension path: the built dist/local-demo in Chromium =================================================================
console.log("\n== Extension path (built dist/local-demo)");
const browser = await launchWithExtension(EXT);
await browser.setToken(TOKEN);
const { ctx, extId } = browser;
async function ask(bug, text) {
  const page = await openScenario(ctx, bug);
  await pinActiveTab(browser.sw, page.url());
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  const popup = popupDriver(popupPage);
  await page.bringToFront();
  await popup.ask(text);
  // A healthy page gives Operon nothing to fix, so "needs more evidence" is a legitimate place to stop for the control.
  const stop = bug ? /Awaiting approval|Escalated|Resolved/ : /Needs more evidence|Escalated|Awaiting approval|Resolved/;
  for (let i = 0; i < 6; i++) {
    const header = await popupPage.locator("header").innerText();
    if (stop.test(header)) break;
    if (/Needs more evidence/.test(header)) await popup.click("Collect evidence");
    await popupPage.waitForTimeout(1500);
  }
  await popupPage.locator("header", { hasText: stop }).waitFor({ timeout: 60_000 });
  return { page, popupPage, popup, sid: (await extensionState(popupPage)).session.session_id };
}
for (const bug of [...BUGS, null]) {
  const label = `Extension · ${bug ? `bug ${bug.id} ${bug.slug}` : "healthy control"}`;
  console.log(`\n== ${label}`);
  let run = await ask(bug, bug ? `Something is wrong: ${bug.symptom}` : "Is anything wrong on this page?");
  if (!bug) {
    const s = await api(`/api/sessions/${run.sid}`);
    check(`${label}: nothing proposed or executed`, s.pending_action === null && s.attempted_actions.length === 0, s.phase);
    await run.popupPage.close();
    await run.page.close();
    continue;
  }
  const session = await api(`/api/sessions/${run.sid}`);
  judge(label, bug, session);
  check(`${label}: live progress was shown by the backend (activity recorded)`, session.activity.some((a) => a.kind === "diagnosis"));
  if (bug.expected.action_id) {
    const before = await snapshot(run.page);
    await run.popup.click("Deny");
    await run.popup.waitPhase("Resolved");
    const rejected = await api(`/api/sessions/${run.sid}`);
    check(`${label}: DENY — backend shows declined_by_user, nothing executed, application unchanged`, rejected.resolution_state === "declined_by_user" && rejected.attempted_actions.length === 0 && (await snapshot(run.page)) === before);
    await run.popupPage.close();
    await run.page.close();
    run = await ask(bug, `Something is wrong: ${bug.symptom}`);
    await run.popup.click("Approve");
    await run.popup.waitPhase("Resolved", 60_000);
    const done = await api(`/api/sessions/${run.sid}`);
    check(`${label}: APPROVE — one attempt, executed, and the BACKEND says verification passed`, done.attempted_actions.length === 1 && done.attempted_actions[0].succeeded === true && done.verification_state?.outcome === "passed", done.verification_state?.message);
    check(`${label}: APPROVE — the application's real state changed (fresh load is clean)`, await independentlyFixed(run.page, bug));
  }
  await run.popupPage.close().catch(() => {});
  await run.page.close().catch(() => {});
}
const own = browser.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
check("no extension runtime errors", own.length === 0, own.slice(0, 3).map((e) => e.text).join(" | "));
await browser.close();
process.exit(summary() ? 0 : 1);
