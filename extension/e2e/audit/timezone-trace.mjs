// Audit probe: trace Buggy Cloud bug 2 (invalid timezone) through the EXTENSION and through the SDK,
// against the same real backend, and print what each interface actually sent and got back:
// every evidence request, every bundle's contents (console texts, storage shape), every diagnosis,
// the proposal and the outcome. Not a pass/fail suite — a recorder for the discrepancy analysis.
//
//   node e2e/audit/timezone-trace.mjs                 # offline engine
//   OPERON_E2E_GROQ=1 node e2e/audit/timezone-trace.mjs   # real model
//   TRACE_REPRODUCE=0 …   extension: click "Collect evidence" but never reload the page
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { startBuggyCloud } from "../../../buggy-cloud/server.mjs";
import { buildExtension, extensionState, launchWithExtension, pinActiveTab, popupDriver, startBackend } from "../lib/harness.mjs";

const useGroq = process.env.OPERON_E2E_GROQ === "1";
const reproduce = process.env.TRACE_REPRODUCE !== "0";
const out = process.env.TRACE_OUT;
const operonCfg = {};
const app = await startBuggyCloud({ operon: operonCfg });
// TRACE_NO_PANEL=1: the extension runs against Buggy Cloud served WITHOUT the SDK panel
// (dev-local --no-sdk-panel); the SDK run always needs the panel.
const extApp = process.env.TRACE_NO_PANEL === "1" ? await startBuggyCloud() : app;
const backend = await startBackend({ groq: useGroq, env: { CORS_ALLOW_ORIGINS: app.url } });
Object.assign(operonCfg, { backendUrl: backend.url, token: backend.tokens.user });
const trace = { engine: useGroq ? "groq" : "rule_based", extension: null, sdk: null };

function summarise(sid) {
  return backend.session(sid).then((s) => ({
    phase: s.phase,
    resolution_state: s.resolution_state,
    source: s.source,
    capabilities: s.provider_capabilities,
    requests: s.diagnostic_steps.map((d) => ({ intent: d.intent, tool: d.tool, reason: (d.reason ?? "").slice(0, 120) })),
    bundles: backend.storedEvidence(sid).map((b) => ({
      collectors: b.collectors,
      console: (b.console ?? []).map((c) => `${c.level}: ${c.text.slice(0, 110)}`),
      storage: (b.storage ?? []).map((x) => `${x.key}=${x.parse_status}`),
      network: (b.network ?? []).map((n) => `${n.status} ${n.url.slice(0, 60)}`),
      errors: b.collection_errors,
    })),
    diagnoses: s.diagnoses.map((d) => ({ cycle: d.cycle, engine: d.engine, category: d.category, root_cause: d.root_cause, action: d.proposed_action, outcome: d.outcome })),
    pending: s.pending_action ? { action: s.pending_action.action_id, params: s.pending_action.parameters } : null,
    escalation: s.escalation_state?.reason ?? null,
  }));
}

// ---- extension ----
{
  const extPath = buildExtension("e2e-local", backend.url);
  const browser = await launchWithExtension(extPath);
  await browser.setToken(backend.tokens.user);
  const target = await browser.ctx.newPage();
  await target.goto(`${extApp.url}/?bug=2&reset=1`);
  await target.waitForFunction(() => window.__buggyCloud?.ready === true);
  if (process.env.TRACE_PRIOR_FIX === "1") {
    // Same browser profile, after an earlier run already fixed the timezone (what the approved
    // reset_user_preference does), the page is opened again with ?bug=2 but WITHOUT &reset=1.
    await target.evaluate(() => localStorage.setItem("buggycloud_prefs", JSON.stringify({ timezone: "UTC", locale: "en-US", currency: "USD" })));
    await target.goto(`${extApp.url}/?bug=2`);
    await target.waitForFunction(() => window.__buggyCloud?.ready === true);
    trace.prior_fix_page = { error_banners: await target.locator(".error").count(), footer: (await target.locator("footer").innerText()).slice(0, 120) };
  }
  await pinActiveTab(browser.sw, target.url());
  const popupPage = await browser.ctx.newPage();
  await popupPage.goto(`chrome-extension://${browser.extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor();
  const popup = popupDriver(popupPage);
  await popup.ask("Dates are missing and an error banner appears.");
  const states = [];
  for (let i = 0; i < 8; i++) {
    await popupPage.locator("header", { hasText: /Needs more evidence|Awaiting approval|Escalated|Resolved|Error/ }).waitFor({ timeout: 120_000 });
    const header = (await popupPage.locator("header").innerText()).replace(/\s+/g, " ");
    states.push(header);
    if (!/Needs more evidence/i.test(header)) break;
    await popup.click("Collect evidence");
    if (reproduce) {
      await target.waitForTimeout(600);
      await target.reload(); // the person reproduces the problem while Operon watches
    }
    await popupPage.waitForTimeout(1500);
  }
  const st = await extensionState(popupPage);
  trace.extension = { reproduce, sdk_panel_on_page: extApp === app, popup_states: states, popup_message: st.message?.slice(0, 300), ...(await summarise(st.session.session_id)) };
  await browser.close();
}

// ---- SDK ----
{
  const b = await chromium.launch({ executablePath: process.env.OPERON_E2E_CHROMIUM || undefined });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto(`${app.url}/?bug=2&reset=1`);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  await page.click("#operon-diagnose");
  await page.waitForFunction(() => /^(proposal|escalated|needs_|error|resolved)/.test(document.querySelector("#operon-panel").dataset.state ?? ""), null, { timeout: 120_000 });
  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  trace.sdk = { panel_state: await page.locator("#operon-panel").getAttribute("data-state"), ...(await summarise(sid)) };
  await b.close();
}

const text = JSON.stringify(trace, null, 1);
if (out) writeFileSync(out, text);
console.log(text);
backend.stop();
await app.close();
if (extApp !== app) await extApp.close();
