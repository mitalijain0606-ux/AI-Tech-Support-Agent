// LIVE github.com escalation scenarios (docs/plan/github-scenarios.md, 3 and 4):
// genuine server-side failures from GitHub itself, which Operon must diagnose and
// hand to a human — never "fix" from the browser.
//
//   4. a real 404: a repository that does not exist. The user "reproduces" by
//      reloading the page while Operon observes; GitHub answers 404.
//   3. a real 401: an anonymous visitor's request for the signed-in user
//      (api.github.com/user), the same response an expired session gets. The
//      trigger is ours (one request, labelled as such); the response is GitHub's.
//
//   npm run e2e:github-escalation
//
// Anonymous, fresh profile, read-only: two page loads and one API request on
// github.com, nothing approved, nothing created or changed. Exit 2 = BLOCKED
// (github.com unreachable; nothing verified).
import { buildExtension, extensionState, launchWithExtension, pinActiveTab, popupDriver, recorder, startBackend } from "./lib/harness.mjs";

const MISSING = "https://github.com/octocat/operon-e2e-this-repository-does-not-exist";
const REAL = "https://github.com/octocat/Hello-World";
const { check, summary } = recorder();
const backend = await startBackend();
const extPath = buildExtension("github", backend.url);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await launchWithExtension(extPath, { args: proxy ? [`--proxy-server=${proxy}`] : [] });
const { ctx, extId } = browser;
await browser.setToken(backend.tokens.user);
console.log(`backend ${backend.url} · extension ${extId}`);

let blocked = null;
const settled = /Needs more evidence|Awaiting approval|Escalated|Resolved|Error/;

async function scenario(label, url, issue, reproduce, expect) {
  console.log(`\n== ${label}`);
  const target = await ctx.newPage();
  const res = await target.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((err) => err);
  if (res instanceof Error || !res) {
    blocked = res instanceof Error ? res.message.split("\n")[0] : "no response";
    throw new Error(`github.com not reachable: ${blocked}`);
  }
  await target.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  await pinActiveTab(browser.sw, target.url());

  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  const popup = popupDriver(popupPage);
  await popup.ask(issue);
  await popupPage.locator("header", { hasText: settled }).waitFor({ timeout: 90_000 });
  let st = await extensionState(browser.sw);
  for (let round = 0; st.phase === "needs_more_evidence" && round < 2; round++) {
    // The user reproduces the problem while Operon observes the page.
    await popup.click("Collect evidence");
    await target.waitForTimeout(800);
    await reproduce(target);
    await popupPage.waitForTimeout(500);
    await popupPage.locator("header", { hasText: settled }).waitFor({ timeout: 90_000 });
    st = await extensionState(browser.sw);
  }
  if (st.phase === "awaiting_approval") {
    await popup.click("Deny");
    await popup.waitPhase("Resolved");
    st = await extensionState(browser.sw);
  }
  const sid = st.session?.session_id;
  const s = await backend.session(sid);
  const last = (s.diagnoses ?? []).filter((d) => d.category).at(-1) ?? {};
  const evidence = backend.storedEvidence(sid).flatMap((b) => b.network ?? []);
  const cited = evidence.filter((n) => (last.evidence_ids ?? []).includes(n.id));
  check(`${label}: GitHub's real ${expect.status} was observed`, evidence.some((n) => n.status === expect.status), evidence.map((n) => `${n.status} ${n.url.slice(0, 60)}`).join(" | "));
  check(`${label}: diagnosed as ${expect.category}, citing that response`, last.category === expect.category && cited.some((n) => n.status === expect.status), `${last.category} cites [${(last.evidence_ids ?? []).join(",")}]`);
  check(`${label}: no action was proposed or executed`, !s.pending_action && (s.attempted_actions ?? []).length === 0);
  check(`${label}: escalated to a human`, s.phase === "ESCALATED", `${s.phase} ${s.resolution_state ?? ""}`);
  const ticketId = s.escalation_state?.ticket_id;
  const ticket = await backend.api("GET", `/api/tickets/${ticketId}`, undefined, backend.tokens.admin);
  check(`${label}: a ticket with the full report is open for the support team`, ticket.status === 200 && ticket.body.status === "open" && ticket.body.report.evidence.some((b) => (b.items.network ?? []).some((n) => n.status === expect.status)), ticketId);
  check(`${label}: the popup tells the user which ticket the support team received`, (await popup.text()).includes(`Handed to the support team: ticket ${ticketId}.`));
  console.log(`  outcome: ${s.resolution_state} — ${(s.escalation_state?.reason ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  await popupPage.close();
  await target.close();
}

try {
  check("extension service worker loaded", Boolean(extId));
  await scenario(
    "scenario 4 (real 404)",
    MISSING,
    "This repository link gives me an error page instead of the code.",
    (page) => page.reload({ waitUntil: "domcontentloaded" }),
    { status: 404, category: "network_error" },
  );
  await scenario(
    "scenario 3 (real 401)",
    REAL,
    "It says I'm not signed in and my account data won't load.",
    (page) => page.evaluate(() => fetch("https://api.github.com/user", { credentials: "omit" }).then((r) => r.status).catch((e) => String(e))),
    { status: 401, category: "auth_failure" },
  );
  const own = browser.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker");
  check("no extension runtime errors", own.length === 0, own.slice(0, 3).map((e) => e.text).join(" | "));
} catch (err) {
  if (!blocked) check("live run completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
backend.stop();
if (blocked) {
  console.log(`\nBLOCKED: github.com could not be reached from this environment (${blocked}). Nothing was verified.`);
  process.exit(2);
}
process.exit(summary() ? 0 : 1);
