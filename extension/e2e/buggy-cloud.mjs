// Operon on a SECOND application: Buggy Cloud (../buggy-cloud), a small web app
// with seven deterministic, seeded defects selected by `?bug=N`.
//
//   npm run e2e:buggy
//
// For every bug the real built extension drives the real backend (offline
// rule-based engine, authentication ON) against the app running locally, and
// the result is compared with the ground truth defined next to the bug
// (buggy-cloud/src/bugs.js): the right category, the right action and
// parameters or no action, approval before anything runs, and — for fixes —
// server-side verification that the problem is really gone.
//
// Bugs 4-6 (API 500, 401, CORS) have no safe fix Operon may perform: the
// correct outcome is a diagnosis, no action, and an honest escalation.
import { BUGS } from "../../buggy-cloud/src/bugs.js";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import {
  buildExtension,
  extensionState,
  launchWithExtension,
  pinActiveTab,
  popupDriver,
  recorder,
  startBackend,
} from "./lib/harness.mjs";

const { check, summary } = recorder();
// OPERON_E2E_GROQ=1 uses the REAL model on the bugs in OPERON_E2E_BUGS (default "2,4"); see buggy-cloud-sdk.mjs.
const useGroq = process.env.OPERON_E2E_GROQ === "1";
const only = (process.env.OPERON_E2E_BUGS ?? (useGroq ? "2,4" : "")).split(",").filter(Boolean).map(Number);
const engine = useGroq ? "groq" : "rule_based";
const backend = await startBackend({ groq: useGroq });
const app = await startBuggyCloud();
const extPath = buildExtension("e2e-local", backend.url);
const browser = await launchWithExtension(extPath);
const { ctx, extId } = browser;
await browser.setToken(backend.tokens.user);
console.log(`backend ${backend.url} · app ${app.url} (reports API ${app.reportsUrl}) · extension ${extId}\n`);

async function open(bugId) {
  const target = await ctx.newPage();
  const logs = [];
  target.on("console", (m) => m.type() === "error" && logs.push(m.text()));
  await target.goto(`${app.url}/${bugId ? `?bug=${bugId}` : ""}`);
  await target.waitForFunction(() => window.__buggyCloud?.ready === true, null, { timeout: 15_000 });
  await pinActiveTab(browser.sw, target.url());
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  await target.bringToFront();
  return { target, popupPage, popup: popupDriver(popupPage), logs };
}

async function cleanProfileState() {
  const page = await ctx.newPage();
  await page.goto(`${app.url}/`);
  await page.evaluate(async () => {
    localStorage.clear();
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  await page.close();
}

async function ask(bug, popup, popupPage) {
  await popup.ask(`Something is wrong on this page: ${bug.symptom}`);
  // Initial evidence may be enough, or Operon may ask to watch a reload.
  for (let i = 0; i < 4; i++) {
    const text = await popupPage.locator("header").innerText();
    if (/Awaiting approval|Escalated|Resolved/.test(text)) return;
    if (/Needs more evidence/.test(text)) await popup.click("Collect evidence");
    await popupPage.waitForTimeout(1500);
  }
}

async function runBug(bug) {
  console.log(`\n== bug ${bug.id}: ${bug.slug} — ${bug.title}`);
  await cleanProfileState();
  const { target, popupPage, popup, logs } = await open(bug.id);
  const label = `bug ${bug.id}`;
  check(`${label}: the defect is observable in the app itself`, (await target.locator(".error").count()) > 0, logs.slice(0, 2).join(" | ").slice(0, 160));
  await ask(bug, popup, popupPage);
  await popupPage.locator("header", { hasText: /Awaiting approval|Escalated|Resolved/ }).waitFor({ timeout: 60_000 });
  const sid = (await extensionState(popupPage)).session.session_id;
  let b = await backend.session(sid);
  const last = b.diagnoses.at(-1);
  const want = bug.expected;
  check(`${label}: diagnosed as ${want.category}`, last?.category === want.category, `${last?.category} — ${last?.root_cause}`);
  check(`${label}: diagnosis cites real evidence`, last?.evidence_ids?.length > 0);
  check(`${label}: the diagnosis is labelled with the engine that produced it (${engine})`, last?.engine === engine);
  check(`${label}: recorded as an extension session; reset_user_preference is declared only because this page's SDK offered it`, b.source === "extension" && b.provider_capabilities.includes("reset_user_preference"), b.provider_capabilities.join(","));

  if (want.action_id) {
    const plan = b.pending_action;
    check(`${label}: proposes ${want.action_id} ${JSON.stringify(want.params)}`, plan?.action_id === want.action_id && JSON.stringify(plan.parameters) === JSON.stringify(want.params), `${plan?.action_id} ${JSON.stringify(plan?.parameters)}`);
    check(`${label}: approval required and nothing executed yet`, b.phase === "WAITING_FOR_APPROVAL" && b.policy_decision?.decision === "REQUIRE_APPROVAL" && b.attempted_actions.length === 0);
    await popup.click("Approve");
    await popup.waitPhase("Resolved", 60_000);
    b = await backend.session(sid);
    check(`${label}: the BACKEND verified the fix`, b.verification_state?.outcome === "passed" && b.phase === "RESOLVED", b.verification_state?.message);
    check(`${label}: exactly one attempt, succeeded`, b.attempted_actions.length === 1 && b.attempted_actions[0].succeeded === true);
    await target.reload();
    await target.waitForFunction(() => window.__buggyCloud?.ready === true);
    check(`${label}: after a fresh reload the app shows no errors`, (await target.locator(".error").count()) === 0, (await target.locator(".error").allInnerTexts()).join(" | "));
  } else {
    check(`${label}: proposes NO action`, b.pending_action === null && b.attempted_actions.length === 0);
    check(`${label}: escalates honestly instead of claiming a fix`, b.phase === "ESCALATED" && b.resolution_state !== "resolved", `${b.phase} ${b.resolution_state}`);
  }
  await popupPage.close();
  await target.close();
}

try {
  for (const bug of BUGS.filter((b) => !only.length || only.includes(b.id))) {
    if (useGroq) await new Promise((r) => setTimeout(r, 25_000));
    await runBug(bug);
  }

  if (!useGroq) {
  console.log("\n== control: no bug");
  await cleanProfileState();
  const { target, popupPage, popup } = await open(null);
  check("control: the app is healthy", (await target.locator(".error").count()) === 0 && (await target.locator("#projects li").count()) === 3);
  await popup.ask("everything looks fine, is anything wrong?");
  await popupPage.waitForTimeout(6000);
  const st = await extensionState(popupPage);
  const b = await backend.session(st.session.session_id);
  check("control: Operon proposes no action on a healthy app", b.pending_action === null && b.attempted_actions.length === 0, `${b.phase}`);
  await popupPage.close();
  await target.close();

  console.log("\n== failure paths through the extension");
  {
    await cleanProfileState();
    const { target, popupPage, popup } = await open(null);
    await browser.setToken("opk_forged-token-value-0000000000");
    await popupPage.reload();
    await popupPage.locator("textarea").waitFor();
    await popup.ask("anything wrong?");
    await popupPage.locator("header", { hasText: "Error" }).waitFor({ timeout: 30_000 });
    const shown = await popup.text();
    check("failure: a forged token is rejected by the backend and the popup says it needs a valid access token", /access token/i.test(shown), shown.replace(/\s+/g, " ").slice(0, 160));
    check("failure: …and no session was created for it", (await extensionState(popupPage))?.session == null);
    await browser.setToken(backend.tokens.user);
    await popupPage.reload();
    await popupPage.locator("textarea").waitFor();
    backend.stop();
    await popup.ask("anything wrong?");
    await popupPage.locator("header", { hasText: "Error" }).waitFor({ timeout: 30_000 });
    check("failure: with the backend down the popup says it cannot reach it (never a success)", /Can't reach the Operon backend/.test(await popup.text()));
    await popupPage.close();
    await target.close();
  }

  } // end of the deterministic-only scenarios

  const own = browser.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
  check("no extension runtime errors", own.length === 0, own.slice(0, 3).map((e) => e.text).join(" | "));
} catch (err) {
  check("buggy-cloud run completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
backend.stop(); // (already stopped by the failure-path scenario; stopping twice is harmless)
await app.close();
process.exit(summary() ? 0 : 1);
