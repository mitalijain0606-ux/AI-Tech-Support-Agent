// Buggy Cloud's Operon SDK integration: a small panel that lets the person using the app ask
// Operon about a problem, review the proposed fix, and approve or reject it.
//
// Everything shown here that came from the backend or the model is untrusted text and is only
// ever assigned with textContent. The panel appears only when the server provides
// /operon-config.json (local testing); a real deployment would obtain a short-lived token from
// the site's own backend instead.

import { init } from "/sdk/operon-sdk.js";
import { PREFS_KEY, SETTINGS_KEY } from "./bugs.js";
import { resetPreference } from "./prefs.js";

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

export async function mountOperon({ root, reobserve }) {
  let config;
  try {
    const res = await fetch("/operon-config.json", { cache: "no-store" });
    if (!res.ok) return null;
    config = await res.json();
  } catch {
    return null;
  }

  const client = init({
    backendUrl: config.backendUrl,
    token: config.token,
    appId: "buggy-cloud",
    storageKeys: [SETTINGS_KEY, PREFS_KEY],
    capture: { console: true, network: true },
    actions: { reset_user_preference: ({ preference }) => resetPreference(localStorage, PREFS_KEY, preference) },
    builtinActions: ["clear_storage_key", "unregister_service_worker"],
    reobserve,
  });

  const status = el("p", { id: "operon-status", textContent: "Operon is ready." });
  const detail = el("div", { id: "operon-detail" });
  const diagnose = el("button", { id: "operon-diagnose", type: "button", textContent: "Diagnose with Operon" });
  const approve = el("button", { id: "operon-approve", type: "button", textContent: "Approve fix", hidden: true });
  const reject = el("button", { id: "operon-reject", type: "button", textContent: "Reject", hidden: true });
  const panel = el("section", { id: "operon-panel", "aria-label": "Operon" }, el("h2", { textContent: "Operon" }), diagnose, approve, reject, status, detail);
  root.after(panel);

  const say = (text, state) => {
    status.textContent = text;
    panel.dataset.state = state ?? "";
  };
  const show = (lines) => {
    detail.replaceChildren(...lines.map((l) => el("p", { textContent: l })));
  };
  const busy = (on) => {
    for (const b of [diagnose, approve, reject]) b.disabled = on;
  };
  const fail = (err) => {
    say(`Operon could not complete that: ${err.code ?? "error"}.`, `error:${err.code ?? "unknown"}`);
    busy(false);
  };

  function render(result) {
    panel.dataset.session = result.session?.session_id ?? "";
    approve.hidden = reject.hidden = result.state !== "proposal";
    const p = result.proposal;
    if (result.state === "proposal" && p) {
      say("Operon proposes a fix. Nothing has been changed yet.", "proposal");
      show([`Diagnosis: ${p.diagnosis}`, `Fix: ${p.action_id} ${JSON.stringify(p.parameters)}`, `Expected: ${p.expected_effect}`]);
    } else if (result.state === "escalated") {
      say("Operon could not safely fix this and has escalated it.", "escalated");
      const ticket = result.session?.escalation_state?.ticket_id;
      show([
        result.session?.escalation_state?.guidance ?? result.session?.escalation_state?.reason ?? "",
        ...(typeof ticket === "string" && /^tkt_[0-9a-f]{1,32}$/.test(ticket) ? [`Handed to the support team: ticket ${ticket}.`] : []),
      ]);
    } else if (result.state === "needs_answer") {
      say(`Operon asks: ${result.question}`, "needs_answer");
    } else if (result.state === "needs_evidence") {
      say("Operon needs more evidence than it could collect.", "needs_evidence");
    } else if (result.state === "resolved") {
      say("Fixed and verified by the Operon backend.", "resolved");
    } else if (result.state === "declined") {
      say("You rejected the fix. Nothing was changed.", "declined");
    }
  }

  client.on("progress", (p) => {
    panel.dataset.progress = `${p.stage}:${p.status}`;
    if (panel.dataset.state === "working") status.textContent = `Working: ${p.stage} (${p.status})`;
  });

  diagnose.addEventListener("click", async () => {
    busy(true);
    say("Working…", "working");
    try {
      render(await client.diagnose("Something is wrong on this page."));
    } catch (err) {
      return fail(err);
    }
    busy(false);
  });

  const decide = (yes) => async () => {
    busy(true);
    say(yes ? "Applying the approved fix…" : "Recording your decision…", "working");
    try {
      const out = await client.decide(yes);
      render(out);
      if (yes && out.executed) {
        const v = out.verification;
        say(v?.passed ? "Fixed and verified by the Operon backend." : `Not confirmed: ${v?.message ?? "verification did not pass"}`, v?.passed ? "resolved" : `unverified:${v?.outcome ?? "none"}`);
        approve.hidden = reject.hidden = true;
      } else if (yes && !out.executed) {
        say(`The fix did not run (${out.reason}).`, `not_executed:${out.reason}`);
      }
    } catch (err) {
      return fail(err);
    }
    busy(false);
  };
  approve.addEventListener("click", decide(true));
  reject.addEventListener("click", decide(false));
  panel.dataset.ready = "true";
  return client;
}
