// NexaDesk's Operon support widget, built on the Operon SDK (sdk/operon-sdk.js). The SDK does
// the work — evidence collection, the backend investigation, policy, approval, execution and the
// backend's verification; this file is only the interface around it.
//
// Honesty rules this widget follows:
//   - every status shown comes from the backend's actual answer or the SDK's real progress events;
//   - "Resolved" only after the BACKEND verified the fix; a fix that ran but was not verified is
//     shown as not confirmed;
//   - a ticket number is shown only when the backend returned one.
// Everything that came from the backend or the model is untrusted text and is only ever set with
// textContent. The panel appears only when the server provides /operon-config.json (local testing;
// 204 otherwise); a real deployment would obtain a short-lived token from the site's own backend.
//
// Test/automation contract (kept stable): #operon-panel[data-ready|data-state|data-session|
// data-progress], #operon-diagnose, #operon-approve, #operon-reject, #operon-status, #operon-detail.
import { init } from "/sdk/operon-sdk.js";
import { activeBug } from "./activate.js";
import { PREFS_KEY, SEARCH_KEY, SETTINGS_KEY } from "./bugs.js";
import { resetPreference } from "./prefs.js";
import { recordOutcome } from "./scenarios.js";

const SESSION_KEY = "operon.session.nexadesk"; // the session id only — never evidence or tokens
const DEFAULT_ISSUE = "Something is wrong on this page.";
const SUGGESTIONS = ["Dates are missing and an error banner appears", "The project list never loads", "Project search is unavailable", "I'm shown as signed out"];

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return node;
};

// Plain-language descriptions of the closed action set.
export function describeAction(actionId, params = {}) {
  switch (actionId) {
    case "clear_storage_key":
      return { title: "Remove one corrupted saved value", body: `Deletes the saved value "${params.key}" that NexaDesk keeps in this browser. Nothing else is touched; the app recreates it with defaults.`, changes: true };
    case "reset_user_preference":
      return { title: `Reset your ${params.preference} preference`, body: `Sets your ${params.preference} preference back to its default. Your other preferences stay as they are.`, changes: true };
    case "unregister_service_worker":
      return { title: "Remove an outdated background script", body: `Unregisters the service worker for "${params.scope}", so the next load uses the current version of NexaDesk.`, changes: true };
    case "reload":
      return { title: "Reload the page", body: "Reloads this page once.", changes: false };
    case "inspect_page":
      return { title: "Inspect the page", body: "Looks at the page without changing anything.", changes: false };
    default:
      return { title: actionId, body: "", changes: true };
  }
}
const VERIFY = {
  storage_recheck: "Operon re-reads that saved value and confirms it is gone or valid.",
  reobserve_cited: "Operon watches the page again and confirms the same errors no longer appear.",
  sw_recheck: "Operon checks that the outdated service worker is no longer registered.",
};
const STAGES = { investigate: "Collecting diagnostic information", classify: "Investigating the problem", diagnose: "Investigating the problem", plan: "Preparing a possible solution", verify: "Checking whether the fix worked" };

function sessionStore() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export async function mountOperon({ root, reobserve }) {
  let config;
  try {
    const res = await fetch("/operon-config.json", { cache: "no-store" });
    if (res.status !== 200) return null; // 204: the support widget is not configured on this server
    config = await res.json();
  } catch {
    return null;
  }

  const client = init({
    backendUrl: config.backendUrl,
    token: config.token,
    appId: "buggy-cloud",
    storageKeys: [SETTINGS_KEY, PREFS_KEY, SEARCH_KEY],
    capture: { console: true, network: true },
    actions: { reset_user_preference: ({ preference }) => resetPreference(localStorage, PREFS_KEY, preference) },
    builtinActions: ["clear_storage_key", "unregister_service_worker"],
    reobserve,
  });

  // ---- structure ----
  const pill = el("span", { className: "op-pill", textContent: "Ready" });
  const minimize = el("button", { type: "button", className: "op-icon-btn", id: "operon-minimize", ariaLabel: "Minimise the support assistant", textContent: "–" });
  const issue = el("textarea", { id: "operon-issue", rows: 3, maxLength: 1000, placeholder: "Describe what is going wrong, e.g. \"Dates are missing on my account page\"", ariaLabel: "Describe the problem" });
  const chips = el("div", { className: "op-chips" }, ...SUGGESTIONS.map((t) => {
    const chip = el("button", { type: "button", className: "op-chip", textContent: t });
    chip.addEventListener("click", () => {
      issue.value = t;
      issue.focus();
    });
    return chip;
  }));
  const diagnose = el("button", { id: "operon-diagnose", type: "button", className: "btn primary op-wide", textContent: "Start investigation" });
  const intro = el("div", { id: "operon-intro", className: "op-intro" },
    el("p", { className: "op-lead", textContent: "Hi! I'm Operon. Tell me what isn't working — I'll look at what this page is doing, explain the problem, and suggest a fix. Nothing changes without your approval." }),
    issue, chips, diagnose);
  const status = el("p", { id: "operon-status", className: "op-status", role: "status", textContent: "Operon is ready." });
  const steps = el("ol", { id: "operon-steps", className: "op-steps" });
  const detail = el("div", { id: "operon-detail", className: "op-detail" });
  const approve = el("button", { id: "operon-approve", type: "button", className: "btn primary", textContent: "Approve fix", hidden: true });
  const reject = el("button", { id: "operon-reject", type: "button", className: "btn", textContent: "Reject", hidden: true });
  const decision = el("div", { className: "op-actions" }, approve, reject);
  const answerBox = el("textarea", { id: "operon-answer", rows: 2, maxLength: 1000, ariaLabel: "Your answer" });
  const sendAnswer = el("button", { id: "operon-send-answer", type: "button", className: "btn primary", textContent: "Send answer" });
  const answerForm = el("div", { id: "operon-answer-form", className: "op-form", hidden: true }, answerBox, sendAnswer);
  const cont = el("button", { id: "operon-continue", type: "button", className: "btn primary", textContent: "I reproduced it — continue", hidden: true });
  const retry = el("button", { id: "operon-retry", type: "button", className: "btn", textContent: "Try again", hidden: true });
  const fresh = el("button", { id: "operon-new", type: "button", className: "btn", textContent: "Report another problem", hidden: true });
  const devInfo = el("dl", { className: "op-dev-props" });
  const dev = el("details", { id: "operon-dev", className: "op-dev" }, el("summary", { textContent: "Developer details" }), devInfo);
  const body = el("div", { className: "op-body" }, intro, el("div", { className: "op-status-row" }, pill, status), steps, detail, answerForm, el("div", { className: "op-actions" }, cont, retry, fresh), dev);
  const panel = el("section", { id: "operon-panel", className: "op-panel", "aria-label": "Operon support assistant" },
    el("header", { className: "op-head" }, el("span", { className: "op-logo", textContent: "O" }), el("div", { className: "op-titles" }, el("h2", { textContent: "Operon Support" }), el("span", { className: "op-sub", textContent: "AI troubleshooting for NexaDesk" })), minimize),
    body, decision);
  const launcher = el("button", { type: "button", id: "operon-launcher", className: "op-launcher", hidden: true }, el("span", { className: "op-logo", textContent: "O" }), "Need help?");
  document.body.append(panel, launcher);
  document.body.classList.add("operon-docked");

  const show = (open) => {
    panel.hidden = !open;
    launcher.hidden = open;
    document.body.classList.toggle("operon-docked", open);
    if (open) (intro.hidden ? panel : issue).focus?.();
  };
  minimize.addEventListener("click", () => show(false));
  launcher.addEventListener("click", () => show(true));
  window.addEventListener("operon:open", () => show(true));

  // ---- state rendering ----
  let lastAction = null;
  const store = sessionStore();
  const PILL = { working: ["Working", "info"], proposal: ["Needs your approval", "warn"], resolved: ["Resolved", "ok"], escalated: ["Escalated", "warn"], declined: ["No change made", ""], needs_answer: ["Question for you", "info"], needs_evidence: ["Needs more information", "info"], error: ["Problem", "bad"], unverified: ["Not confirmed", "bad"], not_executed: ["Not applied", "bad"], ready: ["Ready", ""] };
  const say = (text, state) => {
    status.textContent = text;
    panel.dataset.state = state ?? "";
    const [label, kind] = PILL[(state || "ready").split(":")[0]] ?? PILL.ready;
    pill.textContent = label;
    pill.className = `op-pill ${kind}`.trim();
  };
  const busy = (on) => {
    for (const b of [diagnose, approve, reject, sendAnswer, cont, retry, fresh]) b.disabled = on;
    issue.disabled = on;
    panel.setAttribute("aria-busy", String(on));
  };
  const section = (title, ...kids) => el("div", { className: "op-section" }, el("h3", { textContent: title }), ...kids);
  const setDev = (result) => {
    const s = result?.session;
    devInfo.replaceChildren(
      el("dt", { textContent: "Session" }), el("dd", { textContent: s?.session_id ?? "—" }),
      el("dt", { textContent: "Backend phase" }), el("dd", { textContent: s?.phase ?? "—" }),
      el("dt", { textContent: "Outcome" }), el("dd", { textContent: s?.resolution_state ?? "—" }),
      el("dt", { textContent: "Widget state" }), el("dd", { textContent: panel.dataset.state || "—" }),
    );
  };
  const remember = (result) => {
    const sid = result?.session?.session_id;
    if (!store || !sid) return;
    if (["proposal", "needs_answer", "needs_evidence"].includes(result.state)) store.setItem(SESSION_KEY, sid);
    else store.removeItem(SESSION_KEY);
  };
  const log = (result) => {
    if (!["resolved", "escalated", "declined"].includes(result.state)) return;
    const ticket = result.session?.escalation_state?.ticket_id;
    try {
      recordOutcome(localStorage, { bug: activeBug(location.search)?.id ?? null, state: result.state, session: result.session?.session_id ?? null, ticket: typeof ticket === "string" && /^tkt_[0-9a-f]{1,32}$/.test(ticket) ? ticket : null });
    } catch {
      /* storage unavailable: the outcome is still shown */
    }
  };
  const reset = (to) => {
    intro.hidden = to !== "intro";
    approve.hidden = reject.hidden = true;
    answerForm.hidden = cont.hidden = retry.hidden = fresh.hidden = true;
  };

  // The backend answered, so every stage it reported has ended (its own progress events can arrive
  // after the answer and are then missed).
  const settleSteps = (to) => {
    for (const li of steps.children) if (li.className === "active") li.className = to;
  };

  function render(result) {
    settleSteps("done");
    panel.dataset.session = result.session?.session_id ?? "";
    reset("none");
    const p = result.proposal;
    if (result.state === "proposal" && p) {
      say("Operon found the cause and proposes a fix. Nothing has been changed yet.", "proposal");
      const action = describeAction(p.action_id, p.parameters ?? {});
      const cited = Array.isArray(p.evidence_ids) ? p.evidence_ids.length : 0;
      detail.replaceChildren(
        section("What's wrong", el("p", { textContent: p.diagnosis ?? "" })),
        section("Proposed fix", el("p", {}, el("strong", { textContent: action.title })), el("p", { textContent: action.body }), el("p", { className: "op-mono", textContent: `${p.action_id} ${JSON.stringify(p.parameters ?? {})}` })),
        section("Why", el("p", { textContent: p.rationale || p.expected_effect || "" }), cited ? el("p", { className: "op-muted", textContent: `Based on ${cited} piece${cited === 1 ? "" : "s"} of evidence collected from this page.` }) : null),
        section("Before you decide", el("ul", { className: "op-facts" },
          el("li", { textContent: action.changes ? "This changes data stored in your browser for NexaDesk." : "This does not change any data." }),
          el("li", { textContent: "It runs only if you approve it, and only on this page." }),
          el("li", { textContent: `Afterwards: ${VERIFY[p.verification?.strategy] ?? "Operon checks that the problem is gone."}` }))),
      );
      approve.hidden = reject.hidden = false;
    } else if (result.state === "escalated" && result.session?.escalation_state?.resolution_state === "expired_idle") {
      say("This investigation expired because nothing happened for a long time.", "escalated");
      detail.replaceChildren(section("What you can do", el("p", { textContent: "Nothing was changed. If the problem is still there, start a new investigation." })));
      fresh.hidden = false;
    } else if (result.state === "escalated") {
      const esc = result.session?.escalation_state ?? {};
      const ticket = typeof esc.ticket_id === "string" && /^tkt_[0-9a-f]{1,32}$/.test(esc.ticket_id) ? esc.ticket_id : null;
      say("Operon couldn't fix this safely from your browser, so it handed the problem to the support team.", "escalated");
      detail.replaceChildren(
        section("What Operon found", el("p", { textContent: esc.guidance && esc.guidance !== esc.reason ? esc.guidance : esc.reason ?? "" })),
        ticket ? section("Support ticket", el("p", {}, "A support ticket was opened with everything Operon collected: ", el("strong", { id: "operon-ticket", textContent: ticket }), "."), el("p", { className: "op-muted", textContent: "Keep this reference if you contact support." })) : section("Support ticket", el("p", { className: "op-muted", textContent: "No ticket reference was returned." })),
        section("What you can do", el("p", { textContent: "Nothing was changed. If the problem is on our servers it may clear up on its own; otherwise support can take it from here." })),
      );
      fresh.hidden = false;
    } else if (result.state === "needs_answer") {
      say("Operon has a question before it can continue.", "needs_answer");
      detail.replaceChildren(section("Question", el("p", { textContent: result.question ?? "" })));
      answerForm.hidden = false;
      answerBox.value = "";
    } else if (result.state === "needs_evidence") {
      say("Operon needs more information to investigate this.", "needs_evidence");
      detail.replaceChildren(section("What to do", el("p", { textContent: result.session?.evidence_request?.reason ?? "Reproduce the problem on this page, then continue." })));
      cont.hidden = false;
    } else if (result.state === "resolved") {
      say("Fixed and verified by the Operon backend.", "resolved");
      detail.replaceChildren(section("Result", el("p", { textContent: result.session?.verification_state?.message ?? "The problem is gone." })));
      fresh.hidden = false;
    } else if (result.state === "declined") {
      say("You rejected the fix. Nothing was changed.", "declined");
      detail.replaceChildren();
      fresh.hidden = false;
    } else {
      say("Operon is still working on this.", "working");
    }
    const others = (result.session?.additional_issues ?? []).filter((i) => typeof i?.text === "string").slice(0, 5);
    if (others.length && ["proposal", "resolved", "escalated", "declined"].includes(result.state)) {
      detail.append(section("Other problems to report separately",
        el("ul", { id: "operon-other-issues" }, ...others.map((i) => el("li", { textContent: i.text }))),
        el("p", { className: "op-muted", textContent: "Operon handles one problem at a time. Start a new investigation for each of these." })));
    }
    remember(result);
    log(result);
    setDev(result);
  }

  const fail = (err) => {
    const friendly = {
      network_error: "Operon can't reach its service right now. Check your connection and try again.",
      unauthorized: "Operon isn't authorised on this workspace. Ask your administrator to check the support configuration.",
      rate_limited: "Operon is handling a lot of requests. Please wait a moment and try again.",
      timeout: "Operon took too long to answer. You can try again.",
    }[err?.code] ?? "Something went wrong while talking to Operon. You can try again.";
    settleSteps("failed");
    say(friendly, `error:${err?.code ?? "unknown"}`);
    retry.hidden = false;
    setDev(null);
    busy(false);
  };

  client.on("progress", (p) => {
    panel.dataset.progress = `${p.stage}:${p.status}`;
    const label = STAGES[p.stage];
    if (!label) return;
    let item = [...steps.children].find((li) => li.dataset.label === label);
    if (!item) {
      item = el("li", { textContent: label });
      item.dataset.label = label;
      steps.append(item);
    }
    item.className = p.status === "finished" ? "done" : p.status === "failed" ? "failed" : "active";
    if (panel.dataset.state === "working") status.textContent = `${label}…`;
  });

  async function run(kind, fn) {
    lastAction = { kind, fn };
    busy(true);
    reset("none");
    steps.replaceChildren();
    detail.replaceChildren();
    try {
      return await fn();
    } catch (err) {
      fail(err);
      return null;
    } finally {
      if (panel.dataset.state && !panel.dataset.state.startsWith("error")) busy(false);
    }
  }

  diagnose.addEventListener("click", () => run("diagnose", async () => {
    say("Receiving your issue…", "working");
    const out = await client.diagnose(issue.value.trim() || DEFAULT_ISSUE);
    render(out);
    return out;
  }));

  const decide = (yes) => () => run("decide", async () => {
    say(yes ? "Applying the approved fix…" : "Recording your decision…", "working");
    const out = await client.decide(yes);
    render(out);
    if (yes && out.executed) {
      const v = out.verification;
      say(v?.passed ? "Fixed and verified by the Operon backend." : `The fix ran, but Operon could not confirm the problem is gone: ${v?.message ?? "verification did not pass"}`, v?.passed ? "resolved" : `unverified:${v?.outcome ?? "none"}`);
      if (!v?.passed) fresh.hidden = false;
    } else if (yes && !out.executed) {
      say(`The fix was not applied (${out.reason}).`, `not_executed:${out.reason}`);
      fresh.hidden = false;
    }
    setDev(out);
    return out;
  });
  approve.addEventListener("click", decide(true));
  reject.addEventListener("click", decide(false));
  sendAnswer.addEventListener("click", () => run("answer", async () => {
    const text = answerBox.value.trim();
    if (!text) {
      answerForm.hidden = false;
      return null;
    }
    say("Sending your answer…", "working");
    await client.answer(text);
    const out = await client.continue();
    render(out);
    return out;
  }));
  cont.addEventListener("click", () => run("continue", async () => {
    say("Collecting diagnostic information…", "working");
    const out = await client.continue();
    render(out);
    return out;
  }));
  retry.addEventListener("click", () => lastAction && run(lastAction.kind, lastAction.fn));
  fresh.addEventListener("click", () => {
    store?.removeItem(SESSION_KEY);
    panel.dataset.session = "";
    steps.replaceChildren();
    detail.replaceChildren();
    say("Operon is ready.", "");
    reset("intro");
    issue.value = "";
    issue.focus();
  });

  // ---- pick up an investigation from before a page reload ----
  const saved = store?.getItem(SESSION_KEY);
  if (saved) {
    reset("none");
    say("Picking up your earlier investigation…", "working");
    try {
      const out = await client.resume(saved);
      render(out);
      panel.dataset.resumed = "true";
    } catch {
      store?.removeItem(SESSION_KEY);
      say("Operon is ready.", "");
      reset("intro");
    }
  }

  // On a phone the widget would cover the page: start minimised there (the launcher opens it).
  if (window.matchMedia?.("(max-width: 820px)").matches && !saved) show(false);
  panel.dataset.ready = "true";
  window.__operonWidget = { open: () => show(true), close: () => show(false) };
  return client;
}
