// Browser-level proof that free text is redacted BEFORE it leaves the browser.
//
//   npm run e2e:wire
//
// The extension is built to talk to a recording proxy instead of the backend
// directly. The proxy sees the exact bytes Chromium's extension service worker
// puts on the network, stores them, and forwards them unchanged to the real
// backend. Then the real popup is driven with a fake secret typed into the
// issue box, and the recorded bytes are searched for it. (A backend-side
// redaction cannot hide a leak here: the proxy sits in front of the backend.)
// The fake values are assembled at runtime and are not real credentials.
import {
  buildExtension,
  extensionState,
  launchWithExtension,
  pinActiveTab,
  popupDriver,
  recorder,
  startBackend,
  startRecordingProxy,
  startFixtureSite,
} from "./lib/harness.mjs";

const j = (...p) => p.join("");
const ALNUM = "A1b2C3d4E5f6G7h8J9k0";
const FAKES = {
  "github token": j("gh", "p_", ALNUM, ALNUM),
  "jwt": j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"),
  "unknown-format key": "Zq9Xk2LmN8vB4cR7tY1wE5uI3oP6aS0d",
  "stated password": "hunter2x9",
};
const { check, summary } = recorder();

const backend = await startBackend();
const proxy = await startRecordingProxy(backend.url);
const recorded = proxy.recorded;
const proxyUrl = proxy.url;

const site = await startFixtureSite();
const extPath = buildExtension("e2e-local", proxyUrl);
const browser = await launchWithExtension(extPath);
const { ctx, extId } = browser;
await browser.setToken(backend.tokens.user);
console.log(`backend ${backend.url} · recording proxy ${proxyUrl} · fixtures ${site.origin}\n`);

try {
  const target = await ctx.newPage();
  await target.goto(`${site.origin}/clean.html`);
  await pinActiveTab(browser.sw, target.url());
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  const popup = popupDriver(popupPage);
  await target.bringToFront();

  const typed = `My login is broken. token ${FAKES["github token"]} and jwt ${FAKES.jwt}, the key is ${FAKES["unknown-format key"]}, my password is ${FAKES["stated password"]}. Please help with the dashboard.`;
  await popup.ask(typed);
  await popupPage.locator("header", { hasText: /Needs more evidence|Awaiting approval|Escalated|Resolved/ }).waitFor({ timeout: 60_000 });

  const created = recorded.find((r) => r.method === "POST" && r.path === "/api/sessions");
  check("the extension's session-creation request was captured on the wire", Boolean(created));
  const everything = recorded.map((r) => r.body).join("\n");
  for (const [name, value] of Object.entries(FAKES)) {
    check(`${name}: absent from every byte the extension sent`, !everything.includes(value));
  }
  check("the wire request still carries the useful words", /Please help with the dashboard/.test(created?.body ?? ""), (created?.body ?? "").slice(0, 160));
  check("the wire request shows redaction markers", /\[REDACTED:/.test(created?.body ?? ""));

  const sid = (await extensionState(popupPage)).session.session_id;
  const stored = await backend.session(sid);
  check("the session the backend stored contains none of them either", !Object.values(FAKES).some((v) => JSON.stringify(stored).includes(v)));
  check("and no fake secret is in the backend's database file", !Object.values(FAKES).some((v) => backend.dbBytes().includes(v)));
  check("and none is in the backend's logs", !Object.values(FAKES).some((v) => backend.logs.join("").includes(v)));
  check("the proxy captured the Authorization header separately from bodies (the access token is not in any body)", !everything.includes(backend.tokens.user));
} catch (err) {
  check("wire test completed without exception", false, err.message.split("\n")[0]);
}

await browser.close();
proxy.stop();
site.stop();
backend.stop();
process.exit(summary() ? 0 : 1);
