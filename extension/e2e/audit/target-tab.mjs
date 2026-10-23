// Audit probe: is an investigation bound to the tab it started on?
//
// Tab A: Buggy Cloud with bug 1 (corrupted settings). Tab B: a second, healthy Buggy Cloud on another
// origin. Ask Operon on A, then make B the active tab, then approve the proposed fix. The fix and the
// verification must concern A — never B — and A must end up fixed; a "resolved" while A is still
// broken would be a false resolution.
//
//   node e2e/audit/target-tab.mjs
import { startBuggyCloud } from "../../../buggy-cloud/server.mjs";
import { buildExtension, extensionState, launchWithExtension, pinActiveTab, popupDriver, recorder, startBackend } from "../lib/harness.mjs";

const { check, summary } = recorder();
const backend = await startBackend();
const appA = await startBuggyCloud();
const appB = await startBuggyCloud();
const browser = await launchWithExtension(buildExtension("e2e-local", backend.url));
await browser.setToken(backend.tokens.user);
const { ctx, extId, sw } = browser;
const KEY = "buggycloud_settings";

async function openApp(url) {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  return page;
}
const keyOf = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
const settled = /Awaiting approval|Escalated|Resolved|Error|Needs more evidence/i;

try {
  // --- 1. switch tabs between diagnosis and approval ---
  const a = await openApp(`${appA.url}/?bug=1&reset=1`);
  const b = await openApp(`${appB.url}/?reset=1`);
  await b.evaluate((k) => localStorage.setItem(k, '{"theme":"dark"}'), KEY); // B has its own, healthy value
  await pinActiveTab(sw, a.url());
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor();
  const popup = popupDriver(popupPage);
  await popup.ask("The dashboard shows an error instead of my projects.");
  await popupPage.locator("header", { hasText: settled }).waitFor({ timeout: 60_000 });
  let st = await extensionState(popupPage);
  check("diagnosed on tab A: proposes clearing A's corrupted key", st.phase === "awaiting_approval" && st.session?.pending_action?.action_id === "clear_storage_key", `${st.phase} ${st.session?.pending_action?.action_id}`);

  await pinActiveTab(sw, b.url()); // the person switches to an unrelated tab, then approves
  await popup.click("Approve");
  await popupPage.locator("header", { hasText: /Resolved|Escalated|Error/i }).waitFor({ timeout: 60_000 });
  st = await extensionState(popupPage);
  const s = await backend.session(st.session.session_id);
  const aKey = await keyOf(a);
  const bKey = await keyOf(b);
  console.log(`  outcome: popup=${st.phase} backend=${s.phase}/${s.resolution_state} · A key=${JSON.stringify(aKey)} · B key=${JSON.stringify(bKey)}`);
  check("the unrelated tab B was not touched", bKey === '{"theme":"dark"}', `B=${bKey}`);
  check("no false resolution: RESOLVED only if A is actually fixed", s.phase !== "RESOLVED" || aKey === null, `${s.phase} with A=${aKey}`);
  check("the fix ran on A (or nothing ran and the user was told why)", aKey === null || (st.phase === "error" && /tab/i.test(st.message ?? "")), `${st.phase}: ${(st.message ?? "").slice(0, 160)}`);

  // --- 2. the target tab is closed before approval ---
  const a2 = await openApp(`${appA.url}/?bug=1&reset=1&tab=2`); // distinct URL: the probe pins tabs by URL
  await pinActiveTab(sw, a2.url());
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.waitForTimeout(300);
  await popup.ask("The dashboard shows an error instead of my projects.");
  await popupPage.locator("header", { hasText: /Awaiting approval/i }).waitFor({ timeout: 60_000 });
  await a2.close();
  await pinActiveTab(sw, b.url());
  await popup.click("Approve");
  await popupPage.locator("header", { hasText: /Resolved|Escalated|Error/i }).waitFor({ timeout: 60_000 });
  st = await extensionState(popupPage);
  const s2 = await backend.session(st.session.session_id);
  check("closed target tab: nothing runs elsewhere, no resolution, the user is told", s2.phase !== "RESOLVED" && (await keyOf(b)) === '{"theme":"dark"}' && st.phase === "error" && /tab/i.test(st.message ?? ""), `${st.phase}/${s2.phase}: ${(st.message ?? "").slice(0, 160)}`);
} catch (err) {
  check("probe completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
await backend.stop();
await appA.close();
await appB.close();
process.exit(summary() ? 0 : 1);
