// Audit probe: SDK lifecycle in a real Chromium page against the real backend.
//   1. page refresh while a proposal is pending: what survives?
//   2. two tabs with simultaneous SDK sessions: isolated?
//   3. init/dispose five times, then one diagnose: duplicate listeners or duplicate requests?
//
//   node e2e/audit/sdk-lifecycle.mjs
import { chromium } from "playwright-core";
import { startBuggyCloud } from "../../../buggy-cloud/server.mjs";
import { recorder, startBackend } from "../lib/harness.mjs";

const { check, summary } = recorder();
const operonCfg = {};
const app = await startBuggyCloud({ operon: operonCfg });
const backend = await startBackend({ env: { CORS_ALLOW_ORIGINS: app.url } });
Object.assign(operonCfg, { backendUrl: backend.url, token: backend.tokens.user });
const browser = await chromium.launch({ executablePath: process.env.OPERON_E2E_CHROMIUM || undefined });
const settle = (page) => page.waitForFunction(() => /^(proposal|escalated|needs_|error|resolved)/.test(document.querySelector("#operon-panel").dataset.state ?? ""), null, { timeout: 90_000 });

async function open(ctx, bug) {
  const page = await ctx.newPage();
  await page.goto(`${app.url}/?bug=${bug}&reset=1`);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  await page.locator("#operon-panel[data-ready=true]").waitFor();
  return page;
}

try {
  // 1. refresh with a pending proposal
  {
    const ctx = await browser.newContext();
    const page = await open(ctx, 2);
    await page.click("#operon-diagnose");
    await settle(page);
    const sid = await page.locator("#operon-panel").getAttribute("data-session");
    await page.reload();
    await page.waitForFunction(() => window.__buggyCloud?.ready === true);
    await page.locator("#operon-panel[data-ready=true]").waitFor();
    const after = { state: await page.locator("#operon-panel").getAttribute("data-state"), session: await page.locator("#operon-panel").getAttribute("data-session") };
    const s = await backend.session(sid);
    console.log(`  refresh: panel before=proposal(${sid}) after=${JSON.stringify(after)}; backend session phase=${s.phase}`);
    check("refresh: nothing executes on its own and the backend keeps the session (phase unchanged)", ["ACTION_PROPOSED", "WAITING_FOR_APPROVAL"].includes(s.phase) && s.attempted_actions.length === 0, s.phase);
    check("refresh: the SDK panel resumes the pending proposal", after.session === sid, `after refresh the panel has session '${after.session ?? ""}' — the SDK keeps no session across a page load`);
    await ctx.close();
  }

  // 2. two tabs, two simultaneous sessions
  {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await open(ctx1, 1);
    const p2 = await open(ctx2, 4);
    await Promise.all([p1.click("#operon-diagnose"), p2.click("#operon-diagnose")]);
    await Promise.all([settle(p1), settle(p2)]);
    const [s1, s2] = await Promise.all([p1, p2].map(async (p) => backend.session(await p.locator("#operon-panel").getAttribute("data-session"))));
    check("simultaneous: two distinct sessions", s1.session_id !== s2.session_id);
    check("simultaneous: each diagnosed from its own page's evidence", s1.diagnoses.at(-1)?.category === "storage_corruption" && s2.diagnoses.at(-1)?.category === "network_error", `${s1.diagnoses.at(-1)?.category} / ${s2.diagnoses.at(-1)?.category}`);
    const ids1 = new Set(backend.storedEvidence(s1.session_id).flatMap((b) => ["console", "network", "storage", "page"].flatMap((k) => (b[k] ?? []).map((i) => JSON.stringify(i)))));
    const overlap = backend.storedEvidence(s2.session_id).flatMap((b) => (b.network ?? []).map((i) => JSON.stringify(i))).filter((x) => ids1.has(x));
    check("simultaneous: no evidence item appears in both sessions", overlap.length === 0, overlap.join(","));
    await ctx1.close();
    await ctx2.close();
  }

  // 3. repeated init/dispose
  {
    const ctx = await browser.newContext();
    const page = await open(ctx, 4);
    const created = [];
    page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/sessions") created.push(r.url()); });
    const result = await page.evaluate(async () => {
      const { init } = await import("/sdk/operon-sdk.js");
      const cfg = await (await fetch("/operon-config.json")).json();
      let client;
      for (let i = 0; i < 5; i++) {
        client = init({ ...cfg, appId: "lifecycle-probe", storageKeys: [] });
        if (i < 4) client.dispose();
      }
      const events = [];
      client.on("state", (e) => events.push(e));
      const fetchBefore = window.fetch;
      const out = await client.diagnose("the project list never loads");
      client.dispose();
      return { state: out.state, wrapperRestored: window.fetch === fetchBefore || typeof window.fetch === "function", stateEvents: events.length };
    });
    check("repeat init: one diagnose creates exactly one backend session", created.length === 1, `${created.length} POST /api/sessions`);
    check("repeat init: the client still works after earlier dispose() calls", /escalated|needs_|proposal/.test(result.state), result.state);
    await ctx.close();
  }
} catch (err) {
  check("probe completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
await backend.stop();
await app.close();
process.exit(summary() ? 0 : 1);
