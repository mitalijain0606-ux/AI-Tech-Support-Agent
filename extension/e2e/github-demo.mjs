// LIVE github.com demo: seeded bug -> diagnosis -> approval-gated fix -> server
// verification, driven through the real built extension on a real public
// GitHub page, with the real backend process.
//
//   npm run e2e:demo
//   OPERON_E2E_GITHUB_URL=https://github.com/<owner>/<repo> npm run e2e:demo
//   OPERON_E2E_GROQ=1 npm run e2e:demo     # real Groq instead of the offline engine
//
// What it touches on github.com: ONE namespaced localStorage key,
// `operon_demo_cache`, in a fresh anonymous browser profile (never signed in).
// GitHub itself never reads that key. It creates, changes and deletes nothing
// on GitHub's servers or in any account. The key is removed again at the end.
//
// Two sessions:
//   A. the user DENIES the proposed fix -> nothing may execute, the key stays.
//   B. the user APPROVES -> the key is cleared and the BACKEND verifies it.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 BLOCKED (github.com
// unreachable; nothing was verified).
import {
  buildExtension,
  extensionState,
  launchWithExtension,
  pinActiveTab,
  popupDriver,
  recorder,
  startBackend,
} from "./lib/harness.mjs";

const PAGE = process.env.OPERON_E2E_GITHUB_URL || "https://github.com/octocat/Hello-World";
if (!/^https:\/\/github\.com\//.test(PAGE)) throw new Error("OPERON_E2E_GITHUB_URL must be a https://github.com/ page");
const KEY = "operon_demo_cache";
const useGroq = process.env.OPERON_E2E_GROQ === "1";

const { check, summary } = recorder();
const backend = await startBackend({ groq: useGroq });
const extPath = buildExtension("github", backend.url);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await launchWithExtension(extPath, { args: proxy ? [`--proxy-server=${proxy}`] : [] });
const { ctx, extId } = browser;
await browser.setToken(backend.tokens.user);
console.log(`backend ${backend.url} · extension ${extId} · page ${PAGE} · diagnosis engine: ${useGroq ? "Groq" : "offline rule_based"}`);

const readKey = (page) => page.evaluate((k) => window.localStorage.getItem(k), KEY);
let blocked = null;
let target;

async function openSession(label) {
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  const popup = popupDriver(popupPage);
  await target.bringToFront();
  // "Seed demo bug" is the extension's own, labelled button: it writes the corrupted marker key.
  await popupPage.click('button:has-text("Seed demo bug")');
  await popup.waitPhase("Seeded", 10_000);
  check(`${label}: the demo bug is planted (the marker key is present and corrupted)`, (await readKey(target)) === "{invalid-json");
  await popup.ask("This page looks broken to me — something seems wrong with my saved settings.");
  await popup.waitPhase("Awaiting approval", useGroq ? 120_000 : 60_000);
  const st = await extensionState(popupPage);
  const sid = st.session.session_id;
  const b = await backend.session(sid);
  const plan = b.pending_action;
  check(`${label}: a plain website (no SDK) gets the baseline capability set only — nothing app-specific is declared`, b.source === "extension" && !b.provider_capabilities.includes("reset_user_preference"), b.provider_capabilities.join(","));
  check(`${label}: the diagnosis is grounded in the page's evidence`, plan && plan.evidence_ids.length > 0, `cited ${plan?.evidence_ids?.join(",")}`);
  check(`${label}: the proposed fix is the closed-set action clear_storage_key on the marker key`, plan?.action_id === "clear_storage_key" && plan.parameters.key === KEY, `${plan?.action_id} ${JSON.stringify(plan?.parameters)}`);
  check(`${label}: policy requires approval`, b.policy_decision?.decision === "REQUIRE_APPROVAL" && b.phase === "WAITING_FOR_APPROVAL");
  check(`${label}: nothing has executed yet (the key is untouched)`, (await readKey(target)) === "{invalid-json" && b.attempted_actions.length === 0);
  return { popupPage, popup, sid };
}

try {
  target = await ctx.newPage();
  const res = await target.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((err) => err);
  if (res instanceof Error || !res || res.status() >= 400) {
    blocked = res instanceof Error ? res.message.split("\n")[0] : `HTTP ${res?.status()}`;
    throw new Error(`github.com not reachable: ${blocked}`);
  }
  await target.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  await target.evaluate((k) => window.localStorage.removeItem(k), KEY);
  await pinActiveTab(browser.sw, target.url());
  console.log(`\n== real github.com page loaded: HTTP ${res.status()} · ${(await target.title()).slice(0, 60)}`);

  // ---- A. the user denies ---------------------------------------------------------------
  console.log("\n== A. user DENIES the proposed fix");
  {
    const { popupPage, popup, sid } = await openSession("A");
    await popup.click("Deny");
    await popup.waitPhase("Resolved", 15_000);
    const b = await backend.session(sid);
    check("A: the session ends as declined_by_user", b.resolution_state === "declined_by_user", `${b.phase} ${b.resolution_state}`);
    check("A: the rejected action was NOT executed (no attempt recorded)", b.attempted_actions.length === 0);
    check("A: the page is untouched (the key still holds the corrupted value)", (await readKey(target)) === "{invalid-json");
    check("A: no action-result or verification was ever recorded", !b.activity.some((a) => a.kind === "action_executed" || a.kind === "verification"));
    await popupPage.close();
  }

  // ---- B. the user approves -------------------------------------------------------------
  console.log("\n== B. user APPROVES the proposed fix");
  {
    await target.evaluate((k) => window.localStorage.removeItem(k), KEY);
    const { popupPage, popup, sid } = await openSession("B");
    await popup.click("Approve");
    await popup.waitPhase("Resolved", 60_000);
    const b = await backend.session(sid);
    check("B: the approved fix executed (the key is gone from the page)", (await readKey(target)) === null);
    check("B: exactly one attempt was recorded and succeeded", b.attempted_actions.length === 1 && b.attempted_actions[0].succeeded === true);
    check("B: the BACKEND verified it (not the extension)", b.verification_state?.outcome === "passed" && b.attempted_actions[0].verified === true, b.verification_state?.message);
    check("B: the session is RESOLVED", b.phase === "RESOLVED" && b.resolution_state === "resolved");
    const trail = b.activity.map((a) => a.kind);
    const order = ["action_proposed", "policy_decided", "approval", "action_executed", "verification", "resolved"];
    check("B: activity records the whole chain in order", order.every((k, i) => trail.indexOf(k) > (i ? trail.indexOf(order[i - 1]) : -1)), trail.join(" > "));
    check("B: the diagnosis engine is labelled", b.diagnoses.every((d) => d.engine === (useGroq ? "groq" : "rule_based")), b.diagnoses.map((d) => d.engine).join(","));
    await popupPage.close();
  }

  const own = browser.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
  check("no extension runtime errors", own.length === 0, own.slice(0, 3).map((e) => e.text).join(" | "));
} catch (err) {
  if (!blocked) check("live demo completed without exception", false, err.message.split("\n")[0]);
}

try {
  if (target) await target.evaluate((k) => window.localStorage.removeItem(k), KEY); // leave nothing behind
} catch {}
await browser.close();
backend.stop();
if (blocked) {
  console.log(`\nBLOCKED: github.com could not be reached from this environment (${blocked}). Nothing was verified.`);
  process.exit(2);
}
process.exit(summary() ? 0 : 1);
