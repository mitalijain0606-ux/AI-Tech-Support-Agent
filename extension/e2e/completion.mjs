// The features added to complete the project, end to end in a real browser against real backends:
// multi-issue complaints (widget and extension), idle-session expiry (widget resume), and the admin
// key-management API. Outcomes are checked from the backend's records and the app's real state.
//
//   npm run e2e:completion
import { chromium } from "playwright-core";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import { buildExtension, extensionState, launchWithExtension, pinActiveTab, popupDriver, recorder, startBackend } from "./lib/harness.mjs";

const { check, summary } = recorder();
const cfg = {};
const app = await startBuggyCloud({ operon: cfg });
const backend = await startBackend({ env: { CORS_ALLOW_ORIGINS: app.url, RATE_LIMIT_PER_MINUTE: "600" } });
// A second backend whose sessions expire after ~2 seconds without activity.
const shortLived = await startBackend({ env: { CORS_ALLOW_ORIGINS: app.url, RATE_LIMIT_PER_MINUTE: "600", SESSION_IDLE_EXPIRY_HOURS: "0.0006" } });
Object.assign(cfg, { backendUrl: backend.url, token: backend.tokens.user });
console.log(`backend ${backend.url} · short-lived backend ${shortLived.url} · NexaDesk ${app.url}`);

const TWO_PROBLEMS = "The dates are missing on my account page, and also the reports page will not load";
const pageErrors = [];
const ready = (p) => p.waitForFunction(() => window.__buggyCloud?.ready === true, null, { timeout: 20_000 });
const state = (p) => p.locator("#operon-panel").getAttribute("data-state");
const settle = (p) =>
  p.waitForFunction(() => /^(proposal|escalated|needs_|error|resolved|declined|unverified|not_executed)/.test(document.querySelector("#operon-panel")?.dataset.state ?? ""), null, { timeout: 120_000 });

async function widgetMultiIssue(browser) {
  console.log("\n== Widget: one complaint, two problems");
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${app.url}/?bug=2&reset=1#/account`);
  await ready(page);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  await page.fill("#operon-issue", TWO_PROBLEMS);
  await page.click("#operon-diagnose");
  await settle(page);
  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  let s = await backend.session(sid);
  check("widget: Operon investigates the first problem and proposes its fix", (await state(page)) === "proposal" && s.pending_action?.action_id === "reset_user_preference");
  check("widget: the session records the second problem", s.user_issue === "The dates are missing on my account page" && s.additional_issues?.[0]?.text === "The reports page will not load");
  const listed = await page.locator("#operon-other-issues li").allInnerTexts();
  check("widget: the user is shown the other problem to report separately", listed.length === 1 && /reports page will not load/.test(listed[0]), JSON.stringify(listed));
  await page.click("#operon-approve");
  await page.waitForFunction(() => document.querySelector("#operon-panel")?.dataset.state === "resolved", null, { timeout: 60_000 });
  s = await backend.session(sid);
  check("widget: the first problem is fixed and verified by the backend", s.verification_state?.outcome === "passed");
  check("widget: the resolved view still lists the problem that was not handled", (await page.locator("#operon-other-issues li").count()) === 1);
  await page.goto(`${app.url}/?bug=2#/account`);
  await ready(page);
  check("widget: independent check — a fresh load is clean", (await page.locator(".error").count()) === 0);
  await page.context().close();
}

async function widgetExpiry(browser) {
  console.log("\n== Widget: an abandoned session expires");
  Object.assign(cfg, { backendUrl: shortLived.url, token: shortLived.tokens.user });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${app.url}/?bug=2&reset=1#/account`);
  await ready(page);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  await page.fill("#operon-issue", "Dates are missing on my account page");
  await page.click("#operon-diagnose");
  await settle(page);
  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  check("expiry: a fix is waiting for approval", (await state(page)) === "proposal");
  await page.waitForTimeout(3500); // longer than the ~2 s idle limit
  await page.reload();
  await ready(page);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  await page.waitForFunction(() => document.querySelector("#operon-panel")?.dataset.state === "escalated", null, { timeout: 20_000 });
  const text = await page.locator("#operon-panel").innerText();
  const s = await shortLived.session(sid);
  check("expiry: after the reload the widget says the investigation expired", /expired/i.test(text) && !/handed the problem to the support team/.test(text), text.slice(0, 200));
  check("expiry: the backend closed it without a ticket and nothing ran", s.escalation_state?.resolution_state === "expired_idle" && !s.escalation_state?.ticket_id && s.attempted_actions.length === 0);
  check("expiry: the approve button is gone", !(await page.locator("#operon-approve").isVisible()));
  const late = await shortLived.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: "x" });
  check("expiry: a late approval is refused by the server", late.status === 409);
  check("expiry: the app is unchanged (the fault is still there)", (await page.locator(".error").count()) > 0);
  await page.context().close();
  Object.assign(cfg, { backendUrl: backend.url, token: backend.tokens.user });
}

async function extensionMultiIssue() {
  console.log("\n== Extension: one complaint, two problems");
  const ext = await launchWithExtension(buildExtension("e2e-local", backend.url));
  await ext.setToken(backend.tokens.user);
  const { ctx, extId, sw } = ext;
  const target = await ctx.newPage();
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  const popup = popupDriver(popupPage);
  await target.goto(`${app.url}/?bug=2&reset=1`);
  await ready(target);
  await pinActiveTab(sw, target.url());
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor();
  await popup.ask(TWO_PROBLEMS);
  await popupPage.locator("header", { hasText: /Awaiting approval|Escalated|Resolved|Error/ }).waitFor({ timeout: 120_000 });
  const st = await extensionState(popupPage);
  check("extension: proposes the fix for the first problem", st.phase === "awaiting_approval" && st.session.pending_action?.action_id === "reset_user_preference");
  const box = popupPage.locator('[data-testid="other-issues"]');
  check("extension: the popup lists the other problem", (await box.count()) === 1 && /reports page will not load/.test(await box.innerText()));
  const own = ext.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
  check("extension: no extension runtime errors", own.length === 0, own.map((e) => e.text).join(" | "));
  await ext.close();
}

async function adminKeys() {
  console.log("\n== Admin key-management API (real server)");
  const admin = backend.tokens.admin;
  const created = await backend.api("POST", "/api/admin/keys", { subject: "e2e-new", role: "user", label: "e2e", expires_in_days: 30 }, admin);
  check("admin: creates a key (token shown once, expiry set)", created.status === 201 && created.body.token.startsWith("opk_") && Boolean(created.body.key.expires_at));
  const fresh = created.body.token;
  check("admin: the new key works", (await backend.api("GET", "/api/sessions/does-not-exist", undefined, fresh)).status === 404);
  const list = await backend.api("GET", "/api/admin/keys", undefined, admin);
  check("admin: the list shows the key but never a token or hash", list.status === 200 && list.body.keys.some((k) => k.subject === "e2e-new") && !JSON.stringify(list.body).includes(fresh) && !JSON.stringify(list.body).includes("hash"));
  const rotated = await backend.api("POST", `/api/admin/keys/${created.body.key.id}/rotate`, {}, admin);
  check("admin: rotation replaces the key", rotated.status === 201 && (await backend.api("GET", "/api/sessions/x", undefined, fresh)).status === 401);
  const revoked = await backend.api("POST", `/api/admin/keys/${rotated.body.key.id}/revoke`, undefined, admin);
  check("admin: revocation stops the key at once", revoked.status === 200 && (await backend.api("GET", "/api/sessions/x", undefined, rotated.body.token)).status === 401);
  check("admin: a user key cannot manage keys", (await backend.api("GET", "/api/admin/keys", undefined, backend.tokens.user)).status === 403);
  check("admin: a key from another tenant cannot see this tenant's keys", !JSON.stringify((await backend.api("GET", "/api/admin/keys", undefined, backend.tokens.other)).body ?? {}).includes("e2e-new"));
}

try {
  const browser = await chromium.launch({ executablePath: process.env.OPERON_E2E_CHROMIUM || undefined });
  await widgetMultiIssue(browser);
  await widgetExpiry(browser);
  await browser.close();
  await extensionMultiIssue();
  await adminKeys();
  check("no uncaught page errors in NexaDesk", pageErrors.length === 0, pageErrors.join(" | "));
} catch (err) {
  check("completion suite finished without exception", false, err.message.split("\n")[0]);
}

await backend.stop();
await shortLived.stop();
await app.close();
process.exit(summary() ? 0 : 1);
