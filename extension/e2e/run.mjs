// Deterministic browser E2E: the actual built extension (dist/e2e-local) in
// Chromium, talking to the real backend process, against local fixture pages.
// No credentials, no external sites, no destructive actions — see README.md.
//
//   npm run e2e            (from extension/; needs the backend's Python deps)
//
// The backend runs with GROQ_API_KEY empty, so diagnoses come from the
// labelled offline engine. Retrieval is real: the backend's own startup
// indexes the knowledge base into the fresh database (nothing is seeded
// around it here). If the embedding model can't load, startup says so and
// retrieval must report empty_index / error — never a fake no_match.
import {
  FAKE_SECRETS,
  buildExtension,
  extensionState,
  launchWithExtension,
  pinActiveTab,
  popupDriver,
  recorder,
  startBackend,
  startFixtureSite,
} from "./lib/harness.mjs";

const { check, summary } = recorder();
const only = process.argv[2] ? new RegExp(process.argv[2], "i") : null;

const backend = await startBackend();
const site = await startFixtureSite();
const extPath = buildExtension("e2e-local", backend.url);
const browser = await launchWithExtension(extPath);
const { ctx, extId } = browser;
console.log(`backend ${backend.url} · fixtures ${site.origin} · extension ${extId}`);

// Real startup behaviour: a fresh database, indexed by the backend itself.
console.log("\n== backend startup");
const kb = backend.kbChunks();
const curatedChunks = Object.entries(kb).filter(([type]) => type !== "history").reduce((n, [, c]) => n + c, 0);
const kbIndexed = curatedChunks > 0;
if (kbIndexed) {
  check("startup indexed the knowledge base into a fresh database", !("history" in kb), JSON.stringify(kb));
} else {
  check(
    "startup could not index the knowledge base and says why (embedding model unavailable)",
    /Knowledge base not initialized/.test(backend.logs.join("")),
    backend.logs.join("").match(/Knowledge base not initialized[^\n]*/)?.[0] ?? "no startup warning logged",
  );
}
// With an indexed KB a search either finds something or genuinely doesn't;
// without one it must say the index is empty (or the embedder failed).
const RETRIEVAL_STATUSES = new Set(kbIndexed ? ["ok", "no_match", "skipped_unchanged", "skipped_budget"] : ["empty_index", "error", "skipped_budget"]);

async function scenario(name, fixture, fn) {
  if (only && !only.test(name)) return;
  console.log(`\n== ${name}`);
  const target = await ctx.newPage();
  await target.goto(`${site.origin}/${fixture}`);
  // Pin the extension's "active tab" to the fixture. After a worker restart
  // there is no worker handle to pin with; the fixture is then made the real
  // active tab instead (below).
  const pinned = await pinActiveTab(browser.sw, target.url()).then(() => true, () => false);
  const popupPage = await ctx.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup/popup.html`);
  const popup = popupDriver(popupPage);
  // Reset first: it also clears the demo key in the active tab, so the
  // fixture is (re)loaded afterwards with its own starting state.
  await popupPage.evaluate(() => chrome.runtime.connect().postMessage({ type: "RESET" }));
  await popupPage.locator("textarea").waitFor({ timeout: 15_000 });
  await target.evaluate(() => {
    localStorage.removeItem("operon_demo_cache");
    sessionStorage.clear();
  });
  await target.reload();
  if (!pinned) await target.bringToFront();
  try {
    await fn({ target, popup, popupPage });
  } catch (err) {
    check(`${name}: completed without exception`, false, err.message.split("\n")[0]);
    const st = await extensionState(popupPage).catch(() => null);
    console.log("   extension:", st?.phase, "| backend:", st?.session?.phase, st?.session?.resolution_state, "|", st?.message ?? "");
  }
  // Via the popup page (an extension page), which works even after a worker restart.
  await popupPage.evaluate(() => chrome.storage.session.clear()).catch(() => {});
  await popupPage.close().catch(() => {});
  await target.close().catch(() => {});
}

const session = async () => backend.session((await extensionState(browser.sw)).session.session_id);
const coherent = (b) =>
  b.activity.every((a, i) => a.seq === i + 1) && b.phase_history.every((p, i) => i === 0 || p.from === b.phase_history[i - 1].to);

// Authentication, as deployed: nothing works until the user saves an access token.
await scenario("no access token: the extension explains what to do and nothing reaches the backend", "clean.html", async ({ popup }) => {
  await popup.ask("my dashboard is blank");
  await popup.waitPhase("Error", 20_000);
  const shown = await popup.text();
  check("the user is told to enter an access token", /access token/i.test(shown), shown.replace(/\s+/g, " ").slice(0, 140));
  const raw = await fetch(`${backend.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user_issue: "x" }) });
  check("the backend itself answers 401 to an unauthenticated call", raw.status === 401);
  const forged = await fetch(`${backend.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer opk_forged" }, body: JSON.stringify({ user_issue: "x" }) });
  check("a forged token gets the same 401", forged.status === 401 && (await forged.text()) === (await raw.text()));
});
await browser.setToken(backend.tokens.user);

// 1-12: create → request → collect → investigate → retrieval → NEED_INFORMATION → plan → policy → approval → action → verification
await scenario("full lifecycle: insufficient evidence, user reproduces, approved fix verified", "clean.html", async ({ target, popup }) => {
  await popup.ask("my dashboard is blank");
  await popup.waitPhase("Needs more evidence");
  let st = await extensionState(browser.sw);
  const sid = st.session.session_id;
  const created = await backend.session(sid);
  check("session created; first evidence request issued and answered", created.evidence_bundles.length === 1 && created.evidence_bundles[0].request_id === created.diagnostic_steps[0].request_id);
  check("NEED_INFORMATION with a specific request (not escalated)", st.session.phase === "NEED_INFORMATION" && st.session.evidence_request?.collectors.length > 0, st.session.evidence_request?.collectors.join(","));
  check("diagnosis may be null and the popup still renders the request", (await popup.text()).includes("Collect evidence"));

  await target.evaluate(() => localStorage.setItem("operon_demo_cache", "{invalid-json"));
  await popup.click("Collect evidence");
  await popup.waitPhase("Awaiting approval");
  st = await extensionState(browser.sw);
  const plan = st.session.pending_action;
  check("same session across cycles", st.session.session_id === sid);
  check("plan is grounded in collected evidence", plan.evidence_ids.length > 0 && plan.verification.cited_evidence.storage[0]?.key === "operon_demo_cache");
  check("policy requires approval for a destructive action", st.session.policy_decision?.decision === "REQUIRE_APPROVAL");
  check("nothing executed before approval", (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) !== null);
  // Approval is authorized on the server, not by the popup.
  const foreign = await backend.api("GET", `/api/sessions/${sid}`, undefined, backend.tokens.other);
  check("a user of another tenant cannot even see the session (404)", foreign.status === 404);
  const hijack = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: plan.proposal_id }, backend.tokens.teammate);
  check("a teammate cannot approve someone else's action (404)", hijack.status === 404);
  const stale = await backend.api("POST", `/api/sessions/${sid}/approve`, { approved: true, proposal_id: "prop_stale" });
  check("an approval naming a different plan is refused (409)", stale.status === 409);
  check("none of that changed the session or the page", (await backend.session(sid)).phase === "WAITING_FOR_APPROVAL" && (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) !== null);

  await popup.click("Approve");
  await popup.waitPhase("Resolved");
  const b = await backend.session(sid);
  check("resolved by server-side verification", b.phase === "RESOLVED" && b.verification_state.outcome === "passed", b.verification_state.message);
  check("the key was really cleared in the page", (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) === null);
  check("retrieval ran and was recorded honestly", b.retrievals.length > 0 && b.retrievals.every((r) => RETRIEVAL_STATUSES.has(r.status)), b.retrievals.map((r) => r.status).join(","));
  if (kbIndexed) {
    const hit = b.retrievals.find((r) => r.chunk_ids.includes("kb_kb_corrupted_cache"));
    check("the corrupted-cache cycle retrieved its own KB entry", Boolean(hit), b.retrievals.map((r) => `${r.status}[${r.chunk_ids.join(" ")}]`).join(", "));
  }
  check("diagnosis labelled with its engine", b.diagnoses.every((d) => d.engine === "rule_based"));
  check("activity and phase history are coherent", coherent(b), b.phase_history.map((p) => p.to).join(" → "));
  const stream = await (await fetch(`${backend.url}/api/sessions/${sid}/events`, { headers: backend.headers() })).text();
  const strangers = await fetch(`${backend.url}/api/sessions/${sid}/events`, { headers: backend.headers(backend.tokens.other) });
  check("the event stream is tenant-scoped too (404 for another tenant)", strangers.status === 404);
  const streamed = stream.split("\n\n").filter((f) => f.includes("data: ")).map((f) => JSON.parse(f.split("data: ")[1]));
  const stages = streamed.filter((e) => e.type === "stage").map((e) => `${e.stage}:${e.status}`);
  check("the live event stream replays every pipeline stage and ends with the session", ["investigate:started", "investigate:finished", "classify:finished", "diagnose:started", "diagnose:finished", "plan:finished", "verify:finished"].every((x) => stages.includes(x)) && streamed.at(-1).type === "end", `${stages.length} stage events`);
});

// 13-14, 20: verification false positive protection, retry, escalation
await scenario("fix that doesn't stick: verification fails, automatic retry, then escalation", "resurrect.html", async ({ popup }) => {
  await popup.ask("dashboard broken");
  await popup.waitPhase("Awaiting approval");
  await popup.click("Approve");
  await popup.waitPhase("Escalated", 60_000);
  const b = await session();
  check("verification failed server-side (no false positive)", b.attempted_actions[0].verified === false);
  check("retry re-collected evidence automatically", b.diagnostic_steps.some((d) => d.intent === "retry"));
  check("the failed fix is not re-proposed", b.resolution_state === "escalated_remediation_already_failed", b.resolution_state);
  check("escalation record keeps the attempt", b.escalation_state?.attempted_actions?.length === 1);
  check("never claims resolved", b.phase === "ESCALATED" && b.resolution_state !== "resolved");
});

await scenario("reload that does not fix the page is not reported as fixed", "errors.html", async ({ popup }) => {
  await popup.ask("something threw an error");
  await popup.waitPhase("Escalated", 60_000);
  const b = await session();
  check("reload was allowed without approval", b.attempted_actions[0]?.action_id === "reload");
  check("cited error reappeared → verification failed", b.attempted_actions[0].verified === false);
  check("escalated, not resolved", b.phase === "ESCALATED");
});

await scenario("reload that does fix the page is verified by re-observation", "errors_once.html", async ({ popup }) => {
  await popup.ask("something threw an error");
  await popup.waitPhase("Resolved", 60_000);
  const b = await session();
  check("verification passed on fresh observation", b.verification_state.outcome === "passed", b.verification_state.message);
});

await scenario("declined action never executes", "clean.html", async ({ target, popup }) => {
  await target.evaluate(() => localStorage.setItem("operon_demo_cache", "{invalid-json"));
  await popup.ask("dashboard broken");
  await popup.waitPhase("Awaiting approval");
  await popup.click("Deny");
  await popup.waitPhase("Resolved");
  const b = await session();
  check("declined_by_user and the key is untouched", b.resolution_state === "declined_by_user" && (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) !== null);
  check("no action attempt recorded", b.attempted_actions.length === 0);
});

await scenario("repeated insufficient evidence is bounded and escalates", "clean.html", async ({ popup }) => {
  await popup.ask("something is off");
  for (let i = 0; i < 2; i++) {
    await popup.waitPhase("Needs more evidence");
    await popup.click("Collect evidence");
  }
  await popup.waitPhase("Escalated");
  const b = await session();
  check("escalated on a repeated identical request", b.resolution_state === "escalated_repeated_information_request", b.resolution_state);
});

// 16: invalid / stale request handling
await scenario("stale evidence request: replay rejected; the extension resyncs instead of submitting it", "clean.html", async ({ popup }) => {
  await popup.ask("my dashboard is blank");
  await popup.waitPhase("Needs more evidence");
  const st = await extensionState(browser.sw);
  const sid = st.session.session_id;
  const staleRequest = st.session.evidence_request.request_id;
  // Another client answers the outstanding request first, so the extension's copy goes stale.
  const bundle = (id) => ({
    url: "http://127.0.0.1/clean.html",
    timestamp: Date.now() / 1000,
    request_id: staleRequest,
    storage: [{ id, key: "operon_demo_cache", present: true, parse_status: "syntax_error", error_message: "Unexpected token" }],
  });
  const answered = await backend.api("POST", `/api/sessions/${sid}/investigate`, { bundle: bundle("ev_900") });
  check("out-of-band answer accepted", answered.status === 200, answered.body?.session?.phase);
  const replay = await backend.api("POST", `/api/sessions/${sid}/investigate`, { bundle: bundle("ev_901") });
  check("replaying the used request id is rejected (409)", replay.status === 409, replay.body?.detail);
  const before = await backend.session(sid);
  await popup.click("Collect evidence");
  await popup.page.locator("header", { hasText: /Awaiting approval|Checking policy|Error/ }).waitFor({ timeout: 30_000 });
  const after = await backend.session(sid);
  const shown = await extensionState(browser.sw);
  check("the extension did not submit the stale request", after.evidence_bundles.length === before.evidence_bundles.length);
  check("the extension now shows the backend's state", shown.session?.phase === after.phase && shown.phase !== "needs_more_evidence", `${shown.phase} / ${after.phase}`);
  check("nothing was executed", after.attempted_actions.length === 0);
});

// 17-18: credential redaction and git SHA handling, through the real page → extension → backend path
await scenario("secrets on the page are redacted before upload; git SHAs survive", "secrets.html", async ({ popup }) => {
  await popup.ask("requests to the API fail");
  await popup.page.locator("header", { hasText: /Awaiting approval|Escalated|Resolved|Needs more evidence/ }).waitFor({ timeout: 60_000 });
  const st = await extensionState(browser.sw);
  check("investigation was not rejected by the tripwire", st.phase !== "error", st.message ?? "");
  const b = await backend.session(st.session.session_id);
  const db = backend.dbBytes();
  const token = FAKE_SECRETS.githubToken;
  check("raw token absent from the API response", !JSON.stringify(b).includes(token.slice(4)));
  check("raw token absent from the database file", !db.includes(token.slice(4)));
  check("redaction placeholder stored instead", db.includes("[REDACTED:github_token]"));
  check("hex in a URL query was redacted too", db.includes("[REDACTED:url_query_credential]"));
  check("git commit id kept as context (HEAD is at <sha>)", db.includes("HEAD is at 3f786850e387550fdab836ed7e6dc881de23001b"));
  const unredacted = await backend.api("POST", `/api/sessions/${b.session_id}/investigate`, {
    bundle: { url: "http://127.0.0.1/secrets.html", timestamp: 1, console: [{ id: "ev_901", level: "error", text: `auth ${FAKE_SECRETS.groqKey}` }] },
  });
  check("backend tripwire still rejects an unredacted payload (422)", unredacted.status === 422 && !JSON.stringify(unredacted.body).includes(FAKE_SECRETS.groqKey.slice(4)));
});

// 19: unsupported action rejection and a client-declared verdict — from the extension's own origin
await scenario("unsupported action and client-declared success are rejected", "clean.html", async ({ target, popup }) => {
  await target.evaluate(() => localStorage.setItem("operon_demo_cache", "{invalid-json"));
  await popup.ask("dashboard broken");
  await popup.waitPhase("Awaiting approval");
  const sid = (await extensionState(browser.sw)).session.session_id;
  const res = await browser.sw.evaluate(async ({ api, sid }) => {
    const { operon_token: token } = await chrome.storage.local.get("operon_token");
    const post = async (path, body) => {
      const r = await fetch(`${api}/api/sessions/${sid}/${path}`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return r.status;
    };
    return {
      policy: await post("policy", { action_id: "run_javascript", params: { code: "alert(1)" } }),
      verify: await post("verify", { action_id: "clear_storage_key", observation: { console: [], network: [] }, passed: true }),
      result: await post("action-result", { action_id: "clear_storage_key", succeeded: true }),
    };
  }, { api: backend.url, sid });
  check("policy for an action that wasn't proposed → 409", res.policy === 409, String(res.policy));
  check("verify with a client 'passed' → 422", res.verify === 422, String(res.verify));
  check("action result before approval → 409", res.result === 409, String(res.result));
  const b = await backend.session(sid);
  check("session untouched by the rejected calls", b.phase === "WAITING_FOR_APPROVAL" && b.attempted_actions.length === 0);
  check("key untouched", (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) !== null);
  await popup.click("Deny");
  await popup.waitPhase("Resolved");
});

await scenario("content script inspects and unregisters a real service worker", "sw.html", async ({ target }) => {
  await target.waitForFunction(() => navigator.serviceWorker.getRegistrations().then((r) => r.length > 0), null, { timeout: 10_000 });
  const send = (message) =>
    browser.sw.evaluate(
      ({ url, message }) =>
        new Promise(async (resolve) => {
          const [t] = await self.__origQuery({ url });
          chrome.tabs.sendMessage(t.id, message, (r) => resolve(r ?? { lastError: chrome.runtime.lastError?.message }));
        }),
      { url: target.url(), message },
    );
  const inspect = await send({ type: "INSPECT_PAGE" });
  check("INSPECT_PAGE reports the registration scope", JSON.stringify(inspect?.page?.service_worker_scopes) === '["/"]', JSON.stringify(inspect?.page));
  const unknown = await send({ type: "RUN_JAVASCRIPT", code: "1" });
  check("content script ignores message types outside its closed set", Boolean(unknown?.lastError) && !("result" in (unknown ?? {})), JSON.stringify(unknown));
  const unreg = await send({ type: "UNREGISTER_SERVICE_WORKER", scope: "/" });
  check("UNREGISTER_SERVICE_WORKER really unregisters", unreg?.unregistered === 1 && unreg.remaining_scopes.length === 0, JSON.stringify(unreg));
});

await scenario("reset works on a tab the content script can't reach", "clean.html", async ({ popup }) => {
  await browser.sw.evaluate(() => {
    chrome.tabs.query = async () => [{ id: 999999, url: "http://127.0.0.1/clean.html" }];
  });
  await popup.page.click('button:has-text("Seed demo bug")');
  await popup.page.locator("header", { hasText: /error/i }).waitFor({ timeout: 10_000 });
  await popup.click("Reset");
  await popup.waitPhase("Idle", 5000);
  check("Reset returns to Idle", (await extensionState(browser.sw)).phase === "idle");
});

// 15: extension restart / resync. Last, because Playwright doesn't hand back
// a Worker for a restarted service worker: from here on the extension is
// driven through its popup page and the real active tab, not the worker.
async function restartServiceWorker(popupPage, target) {
  const cdp = await ctx.newCDPSession(popupPage);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers"); // what Chrome does to an idle or crashed worker
  await cdp.detach();
  await new Promise((r) => setTimeout(r, 1000));
  await target.bringToFront(); // the fresh worker uses the real active tab
  await popupPage.reload(); // reconnecting wakes a fresh service worker
}

await scenario("service worker restart while awaiting approval: state restored, approval still works", "clean.html", async ({ target, popup, popupPage }) => {
  await target.evaluate(() => localStorage.setItem("operon_demo_cache", "{invalid-json"));
  await popup.ask("dashboard broken");
  await popup.waitPhase("Awaiting approval");
  const sid = (await extensionState(popupPage)).session.session_id;
  await restartServiceWorker(popupPage, target);
  await popup.waitPhase("Awaiting approval", 15_000);
  check("same session after restart", (await extensionState(popupPage)).session.session_id === sid);
  await target.bringToFront();
  await popup.click("Approve");
  await popup.waitPhase("Resolved");
  const b = await backend.session(sid);
  check("approved after restart and verified", b.verification_state?.outcome === "passed", b.verification_state?.message);
  check("the key was cleared in the real active tab", (await target.evaluate(() => localStorage.getItem("operon_demo_cache"))) === null);
});

await scenario("service worker restart mid-verification: reported as interrupted, never as a pass", "resurrect.html", async ({ target, popup, popupPage }) => {
  await popup.ask("dashboard broken");
  await popup.waitPhase("Awaiting approval");
  const sid = (await extensionState(popupPage)).session.session_id;
  await popup.click("Approve");
  await popup.waitPhase("Verifying", 20_000);
  await restartServiceWorker(popupPage, target);
  const deadline = Date.now() + 30_000;
  let b;
  do {
    b = await backend.session(sid);
    if (b.phase !== "VERIFYING" && b.phase !== "EXECUTING") break;
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < deadline);
  const outcomes = b.activity.filter((a) => a.kind === "verification").map((a) => a.data.outcome);
  check("backend left VERIFYING after the restart (resync closed the step)", !["VERIFYING", "EXECUTING"].includes(b.phase), b.phase);
  check("the interrupted check was not a pass", b.phase !== "RESOLVED" && !outcomes.includes("passed"), outcomes.join(","));
  check("the interruption is on record", b.verification_state?.observed?.error === "interrupted" || outcomes.includes("inconclusive"), JSON.stringify(b.verification_state?.observed));
});

// Browser runtime errors: anything from the extension itself is a failure;
// errors the fixture pages log on purpose are expected and filtered out.
if (!only) {
  console.log("\n== browser runtime errors");
  const own = browser.browserErrors.filter((e) => e.where.startsWith(`chrome-extension://${extId}`) || e.where === "service-worker" || e.kind === "pageerror");
  const unexpected = own.filter((e) => !/Couldn't reach this tab|status of 409|status of 422|Failed to load resource/.test(e.text));
  check("no unexpected extension/page runtime errors", unexpected.length === 0, unexpected.slice(0, 3).map((e) => `${e.where}: ${e.text}`).join(" | "));
}

await browser.close();
site.stop();
backend.stop();
process.exit(summary() ? 0 : 1);
