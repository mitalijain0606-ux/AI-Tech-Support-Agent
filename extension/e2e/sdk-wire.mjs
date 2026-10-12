// Wire-level proof for the SDK: a recording proxy between a real Chromium page and the real backend
// shows the exact bytes the SDK sends. Fake secrets are planted everywhere the SDK reads from —
// console output, a failing request's URL, a corrupted storage value, a title, the typed
// description and an answer — and none may appear in any request body. (A backend-side redaction
// cannot hide a leak: the proxy is in front of the backend.) The fake values are built at runtime
// and are not real credentials.
//
//   npm run e2e:sdk-wire
import { chromium } from "playwright-core";
import { SETTINGS_KEY } from "../../buggy-cloud/src/bugs.js";
import { startBuggyCloud } from "../../buggy-cloud/server.mjs";
import { recorder, startBackend, startRecordingProxy } from "./lib/harness.mjs";

const j = (...p) => p.join("");
const ALNUM = "A1b2C3d4E5f6G7h8J9k0";
const FAKES = {
  "github token": j("gh", "p_", ALNUM, ALNUM),
  "jwt": j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
  "unknown-format key": "Zq9Xk2LmN8vB4cR7tY1wE5uI3oP6aS0d",
  "stated password": "hunter2x9",
  "vendor key": j("sk_li", "ve_", "4eC39HqLyjWDarjtT1zdp7dc"),
};
const { check, summary } = recorder();
const operonCfg = {};
const app = await startBuggyCloud({ operon: operonCfg });
const backend = await startBackend({ env: { CORS_ALLOW_ORIGINS: app.url } });
const proxy = await startRecordingProxy(backend.url);
Object.assign(operonCfg, { backendUrl: proxy.url, token: backend.tokens.user });
const browser = await chromium.launch({ channel: "chromium", executablePath: process.env.OPERON_E2E_CHROMIUM || undefined, headless: process.env.OPERON_E2E_HEADED !== "1" });
console.log(`backend ${backend.url} · recording proxy ${proxy.url} · app ${app.url}\n`);

try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${app.url}/?bug=1`);
  await page.waitForFunction(() => window.__buggyCloud?.ready === true);
  await page.locator("#operon-panel[data-ready=true]").waitFor();

  // Plant secrets where the SDK collects evidence from.
  await page.evaluate(async ({ f, key }) => {
    console.error(`login failed for token ${f["github token"]} and jwt ${f.jwt}; key=${f["unknown-format key"]}`);
    console.error(new Error(`password is ${f["stated password"]} for ${f["vendor key"]}`));
    await fetch(`/api/does-not-exist?access_token=${encodeURIComponent(f["github token"])}&sig=${f["unknown-format key"]}`).catch(() => {});
    localStorage.setItem(key, `{"session_id":"${f.jwt}","note":"${f["unknown-format key"]}"`); // corrupt JSON containing secrets
    document.title = `Dashboard ${f["github token"]}`;
  }, { f: FAKES, key: SETTINGS_KEY });

  // 1. The panel's own flow (evidence collection + investigation).
  await page.click("#operon-diagnose");
  await page.waitForFunction(() => /^(proposal|escalated|needs_|error)/.test(document.querySelector("#operon-panel").dataset.state ?? ""), null, { timeout: 90_000 });

  // 2. The SDK's free-text paths: a typed description and an answer.
  const typed = `My login is broken. token ${FAKES["github token"]}, jwt ${FAKES.jwt}, the key is ${FAKES["unknown-format key"]}, my password is ${FAKES["stated password"]}, vendor ${FAKES["vendor key"]}. Please help with the dashboard.`;
  await page.evaluate(async (text) => {
    const { init } = await import("/sdk/operon-sdk.js");
    const cfg = await (await fetch("/operon-config.json")).json();
    const client = init({ ...cfg, appId: "wire-test", storageKeys: [] });
    try {
      await client.diagnose(text);
    } finally {
      client.dispose();
    }
  }, typed);

  const created = proxy.recorded.filter((r) => r.method === "POST" && r.path === "/api/sessions");
  const bodies = proxy.recorded.map((r) => r.body).join("\n");
  const investigates = proxy.recorded.filter((r) => r.method === "POST" && r.path.endsWith("/investigate")); // (OPTIONS preflights have the same path and no body)
  check("the SDK's requests were captured on the wire", created.length >= 2 && investigates.length >= 1, `${proxy.recorded.length} requests`);
  for (const [name, value] of Object.entries(FAKES)) {
    check(`${name}: absent from every byte the SDK sent`, !bodies.includes(value) && !bodies.includes(encodeURIComponent(value)));
  }
  check("the evidence still carries the useful, non-secret facts", /does-not-exist/.test(investigates[0].body) && /syntax_error/.test(investigates[0].body) && /Please help with the dashboard/.test(created.at(-1).body), `net=${/does-not-exist/.test(investigates[0].body)} storage=${/syntax_error/.test(investigates[0].body)} issue=${/Please help/.test(created.at(-1).body)} :: ${investigates[0].body.slice(0, 700)}`);
  check("redaction markers show where values were removed", /\[REDACTED:/.test(bodies));
  check("the query string of the failing request was dropped, not just masked", !/access_token|sig=/.test(investigates[0].body));
  check("the stored value's content never left; only its shape did", !bodies.includes("session_id") && /"parse_status":"syntax_error"/.test(investigates[0].body), `session_id at ${bodies.indexOf("session_id")}: ${bodies.slice(Math.max(0, bodies.indexOf("session_id") - 120), bodies.indexOf("session_id") + 120)}`);
  check("the access token travels only in the Authorization header, never in a body or URL", !bodies.includes(backend.tokens.user) && !proxy.recorded.some((r) => r.path.includes(backend.tokens.user)) && proxy.recorded.every((r) => r.method === "OPTIONS" || r.headers.authorization === `Bearer ${backend.tokens.user}`));
  check("no cookies were sent to the backend", proxy.recorded.every((r) => !r.headers.cookie));

  const sid = await page.locator("#operon-panel").getAttribute("data-session");
  const stored = JSON.stringify(await backend.session(sid));
  check("the stored session contains none of them", !Object.values(FAKES).some((v) => stored.includes(v)));
  check("the database file contains none of them", !Object.values(FAKES).some((v) => backend.dbBytes().includes(v)));
  check("the backend logs contain none of them", !Object.values(FAKES).some((v) => backend.logs.join("").includes(v)));
} catch (err) {
  check("sdk wire test completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
proxy.stop();
backend.stop();
await app.close();
process.exit(summary() ? 0 : 1);
