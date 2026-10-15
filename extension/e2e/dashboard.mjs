// The support dashboard in a real Chromium against the real backend: an escalated
// session shows up as a ticket with its full report, markup planted in the user's
// message renders as inert text (no script runs, no element is created), the key
// stays out of storage and the URL, and tenants/users only see their own tickets.
//
//   npm run e2e:dashboard
import { chromium } from "playwright-core";
import { recorder, startBackend } from "./lib/harness.mjs";

const { check, summary } = recorder();
const backend = await startBackend();
const browser = await chromium.launch({ channel: "chromium", executablePath: process.env.OPERON_E2E_CHROMIUM || undefined, headless: process.env.OPERON_E2E_HEADED !== "1" });
console.log(`backend ${backend.url}\n`);

const PAYLOAD = `the page is blank <img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b id="injected">bold</b>`;

try {
  // An escalated session, driven through the real API as the suite's user.
  const created = await backend.api("POST", "/api/sessions", { user_issue: PAYLOAD, provider_capabilities: ["inspect_page", "console_errors", "network_requests", "reload"] });
  check("session created", created.status === 200, JSON.stringify(created.body).slice(0, 200));
  const sid = created.body.session_id;
  const bundle = {
    url: "https://github.com/o/r", timestamp: 1, request_id: created.body.evidence_request.request_id,
    network: [{ id: "ev_n1", url: "https://github.com/o/r/api/data", method: "GET", status: 502, status_text: "Bad Gateway" }],
  };
  const investigated = await backend.api("POST", `/api/sessions/${sid}/investigate`, { bundle });
  const ticketId = investigated.body?.session?.escalation_state?.ticket_id;
  check("a 502 escalates and opens a ticket", investigated.body?.session?.phase === "ESCALATED" && /^tkt_/.test(ticketId ?? ""), investigated.body?.session?.phase);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  const response = await page.goto(`${backend.url}/dashboard`);
  check("dashboard served with a CSP", /default-src 'none'/.test(response.headers()["content-security-policy"] ?? ""));

  async function load(token) {
    await page.fill("#api-key", token);
    await page.click("#load");
    await page.waitForFunction(() => /ticket\(s\)|Could not/.test(document.querySelector("#message").textContent));
    return page.locator("#tickets tr").count();
  }

  check("a wrong key is refused", (await load("opk_not-a-real-key")) === 0 && /not accepted/.test(await page.textContent("#message")));
  check("another tenant's key sees none of it", (await load(backend.tokens.other)) === 0);
  check("a teammate (same tenant, not admin) does not see another user's ticket", (await load(backend.tokens.teammate)) === 0);
  check("the session's own user sees their ticket", (await load(backend.tokens.user)) === 1);
  check("the tenant admin sees it", (await load(backend.tokens.admin)) === 1);

  await page.locator("#tickets tr").first().click();
  await page.locator("#detail h2").first().waitFor();
  const detail = await page.textContent("#detail");
  check("the detail shows the ticket, the reason and the cited evidence", detail.includes(ticketId) && /Bad Gateway|502/.test(detail) && /ev_n1/.test(detail));
  check("planted markup is shown as text", detail.includes('<img src=x onerror="window.__xss=1">') && detail.includes("<script>window.__xss=2</script>"));
  check("no planted element exists in the page", (await page.locator("#detail img, #detail script, #injected").count()) === 0);
  check("no planted script ran", (await page.evaluate(() => window.__xss)) === undefined);
  const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie, u: location.href }));
  check("the key is in neither storage, cookies nor the URL", !stored.includes(backend.tokens.admin) && !stored.includes("opk_"), stored);
  check("no CSP violation was needed to stay safe", violations.length === 0, violations.join(" | "));
  check("the dashboard is read-only (no form, no write control)", (await page.locator("form, textarea, #detail button").count()) === 0);
} catch (err) {
  check("dashboard test completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
backend.stop();
process.exit(summary() ? 0 : 1);
