// Buggy Cloud's five screens in a real Chromium: every screen renders under every
// seeded bug, each defect shows up on the screens that use its data, switching
// screens does not re-fetch, and the scenario switcher stays hidden unless asked for.
//
//   npm run e2e:screens
import { chromium } from "playwright-core";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import { recorder } from "./lib/harness.mjs";

const { check, summary } = recorder();
const app = await startBuggyCloud();
const browser = await chromium.launch({ channel: "chromium", executablePath: process.env.OPERON_E2E_CHROMIUM || undefined, headless: process.env.OPERON_E2E_HEADED !== "1" });
const SCREENS = ["overview", "projects", "reports", "account", "settings"];
const HASH = { overview: "#/", projects: "#/projects", reports: "#/reports", account: "#/account", settings: "#/settings" };

async function open(page, query) {
  await page.goto(`${app.url}/${query}`);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
}
async function show(page, screen) {
  await page.evaluate((h) => { location.hash = h; }, HASH[screen]);
  await page.waitForFunction((s) => document.querySelector("#screen")?.dataset.screen === s, screen);
}
const text = (page, sel) => page.locator(sel).first().textContent();
const count = (page, sel) => page.locator(sel).count();

try {
  for (const bug of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const apiCalls = [];
    page.on("request", (r) => { if (/\/api\//.test(r.url())) apiCalls.push(r.url()); });
    await open(page, bug ? `?bug=${bug}&reset=1` : "?reset=1");
    if (bug === 7) await open(page, "?bug=7"); // the stale worker is in control from the second load on
    const label = bug ? `bug ${bug}` : "healthy";
    const before = apiCalls.length;
    const seen = {};
    for (const s of SCREENS) {
      await show(page, s);
      seen[s] = { errors: await count(page, ".error"), nav: await count(page, "nav a") };
    }
    check(`${label}: all five screens render with navigation`, SCREENS.every((s) => seen[s].nav === 5));
    check(`${label}: switching screens does not re-fetch`, apiCalls.length === before, `${apiCalls.length - before} extra`);
    if (!bug) {
      check("healthy: no screen shows an error", SCREENS.every((s) => seen[s].errors === 0), JSON.stringify(seen));
      await show(page, "projects");
      check("healthy: projects table has three rows and a total", (await count(page, "#projects-table tbody tr")) === 3 && /\$70,051\.25/.test(await text(page, "#projects-total")));
      await show(page, "account");
      check("healthy: account and formatted preferences", /Dana Whitfield/.test(await text(page, "#account-details")) && /\$1,234\.50/.test(await text(page, "#prefs-example")));
      await show(page, "settings");
      check("healthy: settings fine and no diagnostics control by default", /good shape/.test(await text(page, "#settings-status")) && (await count(page, "#diagnostics")) === 0);
    } else {
      check(`${label}: the defect is visible on every screen's banner`, SCREENS.every((s) => seen[s].errors > 0), JSON.stringify(seen));
    }
    if (bug === 1) {
      await show(page, "settings");
      check("bug 1: settings screen says the saved settings cannot be read", /could not be read/.test(await text(page, "#settings-status")));
    }
    if (bug === 2 || bug === 3) {
      await show(page, "account");
      check(`${label}: the account screen cannot format with the bad preference`, /—/.test(await text(page, "#prefs-example")) && (bug === 2 ? /Mars\/Phobos/ : /^US$/).test((await page.locator("#account-prefs dd").nth(bug === 2 ? 0 : 2).textContent()).trim()));
      await show(page, "projects");
      check(`${label}: project values are blanked, not wrong`, (await page.locator("#projects-table td", { hasText: "—" }).count()) > 0);
    }
    if (bug === 4) {
      await show(page, "projects");
      check("bug 4: the projects screen has nothing to show", (await count(page, "#projects-empty")) === 1);
    }
    if (bug === 5) {
      await show(page, "account");
      check("bug 5: the account screen shows signed out", (await count(page, "#account-signed-out")) === 1 && /Signed out/.test(await text(page, "#account")));
    }
    if (bug === 6 || bug === 7) {
      await show(page, "reports");
      check(`${label}: the reports screen is unavailable`, (await count(page, "#reports-empty")) === 1);
    }
    await ctx.close();
  }

  // The hidden diagnostics control.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await open(page, "?diagnostics=1&reset=1#/settings");
  await page.waitForFunction(() => document.querySelector("#screen")?.dataset.screen === "settings");
  check("diagnostics: revealed only with ?diagnostics=1 (and the hash survives the reset)", (await count(page, "#diagnostics a")) === 8);
  await page.locator("#diagnostics a", { hasText: "Saved timezone is invalid" }).click();
  await page.waitForFunction(() => window.__buggyCloud?.ready === true && window.__buggyCloud.bug === 2);
  check("diagnostics: a scenario link switches the seeded bug on", (await count(page, ".error")) > 0);
  await ctx.close();
} catch (err) {
  check("screens test completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
await app.close();
process.exit(summary() ? 0 : 1);
