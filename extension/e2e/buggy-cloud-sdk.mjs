// The Operon SDK, integrated into Buggy Cloud, in a real Chromium page (NO extension), talking to
// the real backend process over HTTP (authentication ON, CORS limited to the app's origin).
//
//   npm run e2e:sdk
//
// For each seeded bug: the symptom is present; the person clicks "Diagnose with Operon"; the
// backend (not the page) decides the diagnosis and the proposed fix; REJECTING a fix changes
// nothing; APPROVING it runs only that action; and the result is checked INDEPENDENTLY — by the
// backend's own session record and by reloading the app and inspecting its real state — never by
// the panel's own message. Then the failure paths (no/forged credentials, backend down, replayed
// and cross-session approvals) and a healthy control.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { BUGS, PREFS_KEY, SETTINGS_KEY } from "../../buggy-cloud/src/bugs.js";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import { recorder, startBackend } from "./lib/harness.mjs";

// The documented classic-script distribution must exist before the example page can load it.
execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "../../sdk/scripts/build.mjs")], { stdio: "ignore" });
const { check, summary } = recorder();
// OPERON_E2E_GROQ=1 runs the same checks with the REAL model (needs GROQ_API_KEY, or the egress proxy's
// injection) on the bugs listed in OPERON_E2E_BUGS (default "2,4"), spacing calls for the free tier's
// token limit. Without it the deterministic offline engine is used.
const useGroq = process.env.OPERON_E2E_GROQ === "1";
const only = (process.env.OPERON_E2E_BUGS ?? (useGroq ? "2,4" : "")).split(",").filter(Boolean).map(Number);
const engine = useGroq ? "groq" : "rule_based";
const pace = () => (useGroq ? new Promise((r) => setTimeout(r, 25_000)) : Promise.resolve());
const operonCfg = {};
const app = await startBuggyCloud({ operon: operonCfg });
const backend = await startBackend({ groq: useGroq, env: { CORS_ALLOW_ORIGINS: app.url } });
Object.assign(operonCfg, { backendUrl: backend.url, token: backend.tokens.user });
const browser = await chromium.launch({ channel: "chromium", executablePath: process.env.OPERON_E2E_CHROMIUM || undefined, headless: process.env.OPERON_E2E_HEADED !== "1" });
console.log(`backend ${backend.url} · app ${app.url} (CORS allowed only for that origin) · no extension\n`);

const pageErrors = [];
async function open(ctx, bug, base = app.url) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${base}/${bug ? `?bug=${bug}` : ""}`);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true, null, { timeout: 15_000 });
  await page.locator("#operon-panel[data-ready=true]").waitFor({ timeout: 10_000 });
  return page;
}
async function cleanState(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${app.url}/`);
  await page.evaluate(async () => {
    localStorage.clear();
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });
  await page.close();
}
const fresh = async () => {
  const ctx = await browser.newContext();
  await cleanState(ctx);
  return ctx;
};
const settle = (page, ...states) => page.waitForFunction((s) => s.some((x) => document.querySelector("#operon-panel").dataset.state?.startsWith(x)), states, { timeout: 90_000 });
const sessionOf = async (page) => backend.session(await page.locator("#operon-panel").getAttribute("data-session"));
const appErrors = (page) => page.locator(".error").count();
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

for (const bug of BUGS.filter((b) => !only.length || only.includes(b.id))) {
  const want = bug.expected;
  console.log(`\n== bug ${bug.id}: ${bug.slug}`);
  const ctx = await fresh();
  let page = await open(ctx, bug.id);
  check(`bug ${bug.id}: the symptom is present before Operon is asked`, (await appErrors(page)) > 0);
  check(`bug ${bug.id}: the app is running the SDK integration (not the extension)`, (await page.evaluate(() => window.__buggyCloud.operon)) === "sdk");

  await pace();
  await page.click("#operon-diagnose");
  await settle(page, "proposal", "escalated", "needs_", "error");
  const state = await page.locator("#operon-panel").getAttribute("data-state");
  const b = await sessionOf(page);
  const last = b.diagnoses.at(-1);
  check(`bug ${bug.id}: the BACKEND diagnosed ${want.category}`, last?.category === want.category, `${last?.category} · panel state ${state}`);
  check(`bug ${bug.id}: evidence reached the backend (${b.evidence_bundles.length} bundle(s), engine ${last?.engine})`, b.evidence_bundles.length >= 1 && last?.engine === engine);
  check(`bug ${bug.id}: the backend recorded it as an SDK session with the app's declared, closed capability set`, b.source === "sdk" && ["inspect_page", "console_errors", "network_requests", "reset_user_preference", "clear_storage_key", "unregister_service_worker"].every((c) => b.provider_capabilities.includes(c)) && !b.provider_capabilities.includes("reload"), b.provider_capabilities.join(","));

  if (!want.action_id) {
    check(`bug ${bug.id}: proposes NO action and escalates`, b.pending_action === null && b.phase === "ESCALATED" && state === "escalated", `${b.phase} · ${state}`);
    check(`bug ${bug.id}: nothing was executed`, b.attempted_actions.length === 0);
    await ctx.close();
    continue;
  }

  const plan = b.pending_action;
  check(`bug ${bug.id}: proposes ${want.action_id} ${JSON.stringify(want.params)}`, plan?.action_id === want.action_id && JSON.stringify(plan.parameters) === JSON.stringify(want.params), `${plan?.action_id} ${JSON.stringify(plan?.parameters)}`);
  check(`bug ${bug.id}: policy requires approval and nothing has executed`, state === "proposal" && b.policy_decision == null && b.attempted_actions.length === 0);

  // ---- reject: nothing may run --------------------------------------------------------------
  const before = { settings: await stored(page, SETTINGS_KEY), prefs: await stored(page, PREFS_KEY), errors: await appErrors(page) };
  await page.click("#operon-reject");
  await settle(page, "declined");
  const rejected = await sessionOf(page);
  check(`bug ${bug.id}: REJECT is recorded by the backend (declined_by_user)`, rejected.resolution_state === "declined_by_user" && rejected.phase === "RESOLVED");
  check(`bug ${bug.id}: REJECT executed nothing (no attempt, app state byte-identical)`, rejected.attempted_actions.length === 0 && (await stored(page, SETTINGS_KEY)) === before.settings && (await stored(page, PREFS_KEY)) === before.prefs && (await appErrors(page)) === before.errors);
  const replay = await backend.api("POST", `/api/sessions/${rejected.session_id}/approve`, { approved: true, proposal_id: plan.proposal_id });
  check(`bug ${bug.id}: a rejected session cannot be approved afterwards (409)`, replay.status === 409);
  check(`bug ${bug.id}: …and still nothing ran`, (await backend.session(rejected.session_id)).attempted_actions.length === 0);

  // ---- approve, on a clean second run -----------------------------------------------------------
  await ctx.close();
  const ctx2 = await fresh();
  page = await open(ctx2, bug.id);
  check(`bug ${bug.id}: a second run starts from a clean state with the symptom again`, (await appErrors(page)) > 0);
  await pace();
  await page.click("#operon-diagnose");
  await settle(page, "proposal");
  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  const proposed = await backend.session(sid);
  check(`bug ${bug.id}: a fresh session, not the rejected one`, sid !== rejected.session_id);
  // an approval naming another proposal / another caller must fail BEFORE the real approval
  const wrongProposal = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: "prop_forged" });
  const teammate = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: proposed.pending_action.proposal_id }, backend.tokens.teammate);
  const otherTenant = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: proposed.pending_action.proposal_id }, backend.tokens.other);
  check(`bug ${bug.id}: approval before policy / with a forged proposal id / by a teammate / by another tenant is refused`, wrongProposal.status === 409 && teammate.status === 404 && otherTenant.status === 404, `${wrongProposal.status}/${teammate.status}/${otherTenant.status}`);

  await page.click("#operon-approve");
  await settle(page, "resolved", "unverified", "not_executed", "error");
  const done = await backend.session(sid);
  check(`bug ${bug.id}: exactly one attempt, ${want.action_id}, succeeded`, done.attempted_actions.length === 1 && done.attempted_actions[0].action_id === want.action_id && done.attempted_actions[0].succeeded === true);
  check(`bug ${bug.id}: the BACKEND verified it (client sent only an observation)`, done.verification_state?.outcome === "passed" && done.phase === "RESOLVED", done.verification_state?.message);
  const trail = done.activity.map((a) => a.kind);
  const wanted = ["action_proposed", "policy_decided", "approval", "action_executed", "verification", "resolved"];
  check(`bug ${bug.id}: activity shows proposal → policy → approval → execution → verification → resolved in order`, wanted.every((k, i) => trail.indexOf(k) > (i ? trail.indexOf(wanted[i - 1]) : -1)), trail.join(">"));
  // Independent of the panel: the app's real state, after a fresh load.
  await page.reload();
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  check(`bug ${bug.id}: INDEPENDENT CHECK — a fresh load of the app shows no errors`, (await appErrors(page)) === 0, (await page.locator(".error").allInnerTexts()).join(" | "));
  if (want.action_id === "clear_storage_key") check(`bug ${bug.id}: INDEPENDENT CHECK — the corrupted key is really gone`, (await stored(page, want.params.key)) === null);
  if (want.action_id === "reset_user_preference") check(`bug ${bug.id}: INDEPENDENT CHECK — only ${want.params.preference} was reset, to its default`, JSON.parse(await stored(page, PREFS_KEY))[want.params.preference] === { timezone: "UTC", currency: "USD", locale: "en-US" }[want.params.preference]);
  if (want.action_id === "unregister_service_worker") check(`bug ${bug.id}: INDEPENDENT CHECK — the service worker is really unregistered`, (await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0);
  const again = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: proposed.pending_action.proposal_id });
  check(`bug ${bug.id}: replaying the approval is refused (409) and does not run it twice`, again.status === 409 && (await backend.session(sid)).attempted_actions.length === 1);
  // The scenario can be reset and run again: the symptom is back and the URL is clean.
  await page.click("#reset-scenario");
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  check(`bug ${bug.id}: "Reset this scenario" brings the symptom back, for a rerun`, (await appErrors(page)) > 0 && new URL(page.url()).search === `?bug=${bug.id}`, page.url());
  await ctx2.close();
}

// ---- the documented example page (classic <script>, built by sdk/scripts/build.mjs) --------------------------
if (!useGroq) {
  console.log("\n== SDK example page (classic script distribution)");
  const ctx = await fresh();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${app.url}/sdk/examples/minimal.html`);
  await page.waitForFunction(() => document.querySelector("#date").className === "broken", null, { timeout: 15_000 });
  check("example: the page starts with a real, visible problem (an invalid saved timezone)", (await page.locator("#date").innerText()) === "(cannot show the date)");
  await page.click("#diagnose");
  await page.waitForFunction(() => /Operon proposes|Operon says|Operon error/.test(document.querySelector("#log").textContent), null, { timeout: 90_000 });
  check("example: Operon proposes reset_user_preference for the timezone", /reset_user_preference \{"preference":"timezone"\}/.test(await page.locator("#log").innerText()), await page.locator("#log").innerText());
  await page.click("#reject");
  await page.waitForFunction(() => /Rejected/.test(document.querySelector("#log").textContent));
  check("example: reject changes nothing", (await page.locator("#date").getAttribute("class")) === "broken" && JSON.parse(await stored(page, "example_prefs")).timezone === "Mars/Phobos");
  await page.click("#diagnose");
  await page.waitForFunction(() => !document.querySelector("#approve").hidden, null, { timeout: 90_000 });
  await page.click("#approve");
  await page.waitForFunction(() => /Executed/.test(document.querySelector("#log").textContent), null, { timeout: 60_000 });
  check("example: approve runs the fix and the BACKEND's verdict is 'passed'", /Executed: true\. Backend verification: passed/.test(await page.locator("#log").innerText()), await page.locator("#log").innerText());
  check("example: independent check — the date renders and the saved timezone really changed", (await page.locator("#date").getAttribute("class")) === "" && JSON.parse(await stored(page, "example_prefs")).timezone === "UTC");
  await ctx.close();
}

// ---- healthy control ------------------------------------------------------------------------------
console.log("\n== control: no bug");
if (!useGroq) {
  const ctx = await fresh();
  const page = await open(ctx, null);
  check("control: the app is healthy", (await appErrors(page)) === 0 && (await page.locator("#projects li").count()) === 3);
  await page.click("#operon-diagnose");
  await settle(page, "escalated", "needs_", "proposal");
  const b = await sessionOf(page);
  check("control: Operon proposes nothing and executes nothing on a healthy app", b.pending_action === null && b.attempted_actions.length === 0, `${b.phase}`);
  await ctx.close();
}

// ---- inconclusive verification: the SDK cannot re-observe, so the backend must NOT say "passed" -----
console.log("\n== inconclusive verification");
if (!useGroq) {
  const ctx = await fresh();
  const page = await open(ctx, 2);
  const out = await page.evaluate(async ({ prefsKey }) => {
    const { init } = await import("/sdk/operon-sdk.js");
    const cfg = await (await fetch("/operon-config.json")).json();
    const client = init({
      ...cfg, appId: "no-reobserve", storageKeys: [prefsKey], capture: { console: true },
      actions: { reset_user_preference: ({ preference }) => { const p = JSON.parse(localStorage.getItem(prefsKey)); p[preference] = { timezone: "UTC", currency: "USD", locale: "en-US" }[preference]; localStorage.setItem(prefsKey, JSON.stringify(p)); return { detail: "reset" }; } },
    }); // NOTE: no `reobserve` hook
    try {
      await window.__buggyCloud.repaint(); // the app re-runs its real load path; this client captures the real error
      const r = await client.diagnose("dates are wrong");
      const d = await client.decide(true);
      return { proposed: r.proposal?.action_id, executed: d.executed, state: d.state, outcome: d.verification?.outcome, sid: d.session.session_id };
    } finally {
      client.dispose();
    }
  }, { prefsKey: PREFS_KEY });
  const b = await backend.session(out.sid);
  check("inconclusive: the action itself ran (the preference really was reset)", out.proposed === "reset_user_preference" && out.executed === true && JSON.parse(await stored(page, PREFS_KEY)).timezone === "UTC");
  check("inconclusive: with no way to re-observe, the BACKEND says inconclusive, not passed", out.outcome === "inconclusive" && b.verification_state?.outcome === "inconclusive", `${out.outcome} · ${b.verification_state?.message}`);
  check("inconclusive: the session is not reported as resolved", out.state !== "resolved" && b.resolution_state !== "resolved", `${out.state} · ${b.phase} ${b.resolution_state}`);
  await ctx.close();
}

// ---- failure paths --------------------------------------------------------------------------------------
console.log("\n== failure paths");
{
  const noAuth = await startBuggyCloud({ operon: { backendUrl: backend.url, token: "opk_forged-token-value" } });
  const reallyDown = await startBuggyCloud({ operon: { backendUrl: "http://localhost:9", token: backend.tokens.user } });
  // CORS is only allowed for `app`, so the other origins also exercise "blocked by CORS" being reported clearly.
  const ctx = await fresh();
  const forged = await open(ctx, 2, noAuth.url).catch((e) => e);
  check("failure: a page served from an origin the backend does not allow reports a network/CORS error, not success", !(forged instanceof Error) && (await (async () => {
    await forged.click("#operon-diagnose");
    await settle(forged, "error");
    return /network_error/.test(await forged.locator("#operon-panel").getAttribute("data-state"));
  })()));
  await ctx.close();

  // Forged token, from the allowed origin: serve the forged token via the allowed app instance.
  operonCfg.token = "opk_forged-token-value";
  const ctx2 = await fresh();
  const p2 = await open(ctx2, 2);
  await p2.click("#operon-diagnose");
  await settle(p2, "error");
  check("failure: a forged token is rejected by the backend and reported as unauthorized", (await p2.locator("#operon-panel").getAttribute("data-state")) === "error:unauthorized");
  check("failure: …no session was created for it", (await p2.locator("#operon-panel").getAttribute("data-session")) == null || (await p2.locator("#operon-panel").getAttribute("data-session")) === "");
  check("failure: …and the app was not touched", (await appErrors(p2)) > 0);
  operonCfg.token = backend.tokens.user;
  await ctx2.close();

  operonCfg.backendUrl = "http://localhost:9";
  const ctx3 = await fresh();
  const p3 = await open(ctx3, 2);
  await p3.click("#operon-diagnose");
  await settle(p3, "error");
  check("failure: backend unreachable is reported as network_error, never as success", (await p3.locator("#operon-panel").getAttribute("data-state")) === "error:network_error");
  operonCfg.backendUrl = backend.url;
  await ctx3.close();
  await noAuth.close();
  await reallyDown.close();
}

check("no uncaught errors in the app's own code", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
await browser.close();
backend.stop();
await app.close();
process.exit(summary() ? 0 : 1);
