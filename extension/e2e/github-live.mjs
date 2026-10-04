// LIVE github.com check: the actual built extension (dist/github, the real
// target) against a real public GitHub page and the real backend process.
//
//   npm run e2e:github                       (needs outbound HTTPS to github.com)
//   OPERON_E2E_GITHUB_URL=https://github.com/<owner>/<repo> npm run e2e:github
//
// Strictly read-only and anonymous: a fresh browser profile (never signed in),
// one page load, the extension's own read-only collectors, and no approvals —
// anything that needs approval is denied. The only action the policy lets run
// unattended is a page reload. Nothing is created, changed or deleted on
// github.com. If github.com can't be reached, the run reports BLOCKED with the
// reason instead of passing.
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

const { check, summary } = recorder();
const backend = await startBackend();
const extPath = buildExtension("github", backend.url);
// Route through the environment's HTTPS proxy when there is one (sandboxed CI).
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await launchWithExtension(extPath, { args: proxy ? [`--proxy-server=${proxy}`] : [] });
const { ctx, extId } = browser;
console.log(`backend ${backend.url} · extension ${extId} · page ${PAGE}`);

let blocked = null;
try {
  console.log("\n== extension on a real github.com page");
  check("extension service worker loaded", Boolean(extId));
  const target = await ctx.newPage();
  const res = await target.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((err) => err);
  if (res instanceof Error || !res || res.status() >= 400) {
    blocked = res instanceof Error ? res.message.split("\n")[0] : `HTTP ${res?.status()}`;
    throw new Error(`github.com not reachable: ${blocked}`);
  }
  check("github.com page loaded", res.status() < 400, `HTTP ${res.status()} · ${(await target.title()).slice(0, 60)}`);
  await target.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  await pinActiveTab(browser.sw, target.url());

  const inspect = await browser.sw.evaluate(
    (url) =>
      new Promise(async (resolve) => {
        const [t] = await self.__origQuery({ url });
        chrome.tabs.sendMessage(t.id, { type: "INSPECT_PAGE" }, (r) => resolve(r ?? { lastError: chrome.runtime.lastError?.message }));
      }),
    target.url(),
  );
  check("content script loaded on github.com", Boolean(inspect?.page?.url_path), JSON.stringify(inspect?.page ?? inspect).slice(0, 160));

  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  const popup = popupDriver(popupPage);
  await popupPage.locator("textarea").waitFor({ timeout: 10_000 });
  await popup.ask("This repository page looks off to me — can you check whether anything is broken?");
  const settled = /Needs more evidence|Awaiting approval|Escalated|Resolved|Error/;
  await popupPage.locator("header", { hasText: settled }).waitFor({ timeout: 90_000 });
  let st = await extensionState(browser.sw);
  if (st.phase === "awaiting_approval") {
    console.log(`  (proposed ${st.session.pending_action?.action_id} — denying; this run never approves anything on github.com)`);
    await popup.click("Deny");
    await popup.waitPhase("Resolved");
    st = await extensionState(browser.sw);
  }
  check("investigation ran without a backend/extension error", st.phase !== "error", st.message ?? st.phase);
  if (st.phase === "needs_more_evidence") {
    // A healthy page gives no grounds for a fix: answer the follow-up request
    // once (the extension observes the real page again) and expect the
    // session to stay bounded — still asking or escalated, never a made-up fix.
    await popup.click("Collect evidence");
    await popupPage.waitForTimeout(500);
    await popupPage.locator("header", { hasText: settled }).waitFor({ timeout: 90_000 });
    st = await extensionState(browser.sw);
    if (st.phase === "awaiting_approval") {
      await popup.click("Deny");
      await popup.waitPhase("Resolved");
      st = await extensionState(browser.sw);
    }
    check("second cycle on the real page stayed bounded", ["needs_more_evidence", "escalated", "resolved"].includes(st.phase), `${st.phase} · ${st.session?.resolution_state ?? ""}`);
  }

  const sid = st.session.session_id;
  const b = await backend.session(sid);
  const bundles = backend.storedEvidence(sid);
  const ids = new Set(bundles.flatMap((x) => ["console", "network", "cookies", "storage", "page"].flatMap((k) => (x[k] ?? []).map((i) => i.id))));
  const counts = ["console", "network", "cookies", "storage", "page"].map((k) => `${k} ${bundles.reduce((n, x) => n + (x[k]?.length ?? 0), 0)}`).join(", ");
  check("backend session created and evidence request answered", b.evidence_bundles.length >= 1 && b.diagnostic_steps.length >= 1);
  check("evidence collected from github.com reached the backend", bundles.length >= 1 && ids.size >= 1, counts);
  check("bundle provenance matches the request", b.evidence_bundles.every((e, i) => e.request_id === b.diagnostic_steps[i]?.request_id));
  check("cookies are metadata only (no values)", bundles.every((x) => (x.cookies ?? []).every((c) => !("value" in c))));
  const redactions = [...new Set(bundles.flatMap((x) => x.redaction_applied ?? []))];
  console.log(`  redaction applied by the extension: ${redactions.length ? redactions.join(", ") : "none needed"}`);
  check("investigation cycle ran", b.diagnoses.length >= 1 || b.phase === "NEED_INFORMATION" || b.phase === "ESCALATED", `${b.phase} · ${b.resolution_state ?? ""}`);
  const cited = b.diagnoses.flatMap((d) => d.evidence_ids);
  check("every diagnosis cites only collected evidence", cited.every((id) => ids.has(id)), `cited [${cited.join(", ")}]`);
  check("retrieval recorded with an honest status", b.retrievals.every((r) => ["ok", "no_match", "error", "skipped_unchanged", "skipped_budget"].includes(r.status)), b.retrievals.map((r) => `${r.status}${r.error ? `(${r.error})` : ""}`).join(", "));
  const approvals = b.activity.filter((a) => a.kind === "approval");
  check("nothing was approved", approvals.every((a) => a.data.approved === false));
  const executed = b.attempted_actions.map((a) => a.action_id);
  check("only an unattended reload could ever run", executed.every((a) => a === "reload"), executed.join(",") || "no action executed");
  const verifiedPass = b.verification_state?.outcome === "passed";
  check(
    "no verification false positive",
    !verifiedPass || (b.attempted_actions.length > 0 && b.verification_state.observed),
    b.verification_state ? `${b.verification_state.outcome}: ${b.verification_state.message}` : "no verification needed",
  );
  check(
    "activity and phase history are coherent",
    b.activity.every((a, i) => a.seq === i + 1) && b.phase_history.every((p, i) => i === 0 || p.from === b.phase_history[i - 1].to),
    b.phase_history.map((p) => p.to).join(" → "),
  );
  console.log(`  outcome: ${b.phase} ${b.resolution_state ?? ""} — ${(st.message || b.escalation_state?.reason || "").replace(/\s+/g, " ").slice(0, 200)}`);

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
