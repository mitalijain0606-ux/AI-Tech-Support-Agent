// NexaDesk demo console — for presenters only, not part of the product. Lists every seeded
// scenario with its real status in this browser (read from the app's own state, see
// scenarios.js), what to expect from Operon, and links that activate, open and reset it.
// Nothing here talks to Operon on anyone's behalf or holds a credential beyond what the local
// demo server already hands the page.
import { BUGS, SCENARIO_NOTES } from "./bugs.js";
import { SEEDED_MARKER } from "./activate.js";
import { OUTCOME_LOG_KEY, readOutcomes, scenarioStatus } from "./scenarios.js";

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return node;
};
const STATUS = {
  active: ["Active — the fault is present", "bad"],
  fixed: ["Fixed in this browser", "ok"],
  idle: ["Not active", ""],
  server: ["Server-side (active whenever opened)", "info"],
};
const OUTCOME = { resolved: ["Resolved and verified", "ok"], escalated: ["Escalated", "warn"], declined: ["Fix rejected", ""], proposal: ["Waiting for approval", "info"], needs_answer: ["Asked a question", "info"], needs_evidence: ["Needs more information", "info"] };
const badge = (text, kind) => el("span", { className: `badge ${kind}`.trim(), textContent: text });

async function backendStatus() {
  try {
    const res = await fetch("/operon-config.json", { cache: "no-store" });
    if (res.status !== 200) return { widget: false, text: "The Operon widget is not enabled on this server (use the Chrome extension, or start with scripts/dev-local.mjs)." };
    const { backendUrl } = await res.json();
    try {
      const health = await fetch(`${backendUrl}/health`, { cache: "no-store" });
      return { widget: true, ok: health.ok, text: health.ok ? `Operon backend reachable at ${backendUrl}` : `Operon backend at ${backendUrl} answered ${health.status}` };
    } catch {
      return { widget: true, ok: false, text: `Operon backend at ${backendUrl} is not reachable` };
    }
  } catch {
    return { widget: false, text: "Could not read the Operon configuration." };
  }
}

async function render() {
  const workers = (await navigator.serviceWorker?.getRegistrations?.().catch(() => []))?.length ?? 0;
  const outcomes = readOutcomes(localStorage);
  const planted = localStorage.getItem(SEEDED_MARKER);
  const operon = await backendStatus();
  const cards = BUGS.map((b) => {
    const n = SCENARIO_NOTES[b.id] ?? {};
    const status = scenarioStatus(b.id, localStorage, { workers });
    const [statusText, statusKind] = STATUS[status];
    const last = outcomes.filter((o) => o.bug === b.id).at(-1);
    const [outText, outKind] = last ? OUTCOME[last.state] ?? [last.state, ""] : ["No Operon run recorded in this browser", ""];
    const expected = b.expected.action_id ? `Proposes ${b.expected.action_id}` : "Escalates with a ticket (no browser fix exists)";
    return el(
      "article",
      { className: "card scenario" },
      el("header", {}, el("span", { className: "num", textContent: String(b.id) }), el("div", {}, el("h2", { textContent: b.title }), el("div", { className: "muted", textContent: b.slug }))),
      el(
        "dl",
        {},
        el("dt", { textContent: "Symptom" }), el("dd", { textContent: b.symptom }),
        el("dt", { textContent: "Cause" }), el("dd", { textContent: n.cause ?? "" }),
        el("dt", { textContent: "Operon" }), el("dd", { textContent: `${expected}. ${n.fix ?? ""}` }),
        el("dt", { textContent: "Verified by" }), el("dd", { textContent: n.verify ?? "—" }),
        el("dt", { textContent: "Status" }), el("dd", {}, Object.assign(badge(statusText, statusKind), { className: `badge ${statusKind} status`.trim() })),
        el("dt", { textContent: "Last result" }), el("dd", {}, badge(outText, outKind), last?.ticket ? el("span", { className: "muted", textContent: ` ticket ${last.ticket}` }) : null),
      ),
      el(
        "div",
        { className: "actions" },
        el("a", { className: "btn primary small", href: `/?bug=${b.id}&reset=1${n.page ?? "#/"}`, textContent: status === "active" ? "Re-activate (reset)" : "Activate" }),
        el("a", { className: "btn small", href: `/?bug=${b.id}${n.page ?? "#/"}`, textContent: "Open affected page" }),
      ),
    );
  });
  cards.forEach((c, i) => {
    c.dataset.bug = String(BUGS[i].id);
    c.dataset.status = scenarioStatus(BUGS[i].id, localStorage, { workers });
  });
  const clear = el("button", { type: "button", className: "btn small", textContent: "Clear Operon history" });
  clear.addEventListener("click", () => {
    localStorage.removeItem(OUTCOME_LOG_KEY);
    render();
  });
  document.getElementById("demo").replaceChildren(
    el(
      "div",
      { className: "console" },
      el(
        "div",
        { className: "console-head" },
        el("div", { className: "spacer" }, el("div", { className: "row" }, el("h1", { textContent: "NexaDesk demo console" }), el("span", { className: "presenter-only", textContent: "Presenter only" })),
          el("p", { textContent: "Each scenario plants one real, reproducible fault in NexaDesk. Activate it, open the app, then ask Operon — through the support widget or the Chrome extension — and approve or reject what it proposes. Status below is read from this browser's actual application state." })),
        el("div", { className: "row" }, el("a", { className: "btn", href: "/?reset=1", id: "healthy", textContent: "Open healthy app (reset all)" }), clear),
      ),
      el("section", { className: "card" }, el("div", { className: "row" }, el("strong", { textContent: "Operon" }), badge(operon.widget ? (operon.ok ? "Connected" : "Unavailable") : "Widget off", operon.widget ? (operon.ok ? "ok" : "bad") : ""), el("span", { className: "muted", id: "operon-backend", textContent: operon.text })),
        el("p", { className: "muted", style: "margin:8px 0 0", textContent: planted ? `Scenario ${planted} was the last one planted in this browser.` : "No scenario is planted in this browser." })),
      el("section", { className: "card" }, el("h2", { textContent: "How to run a scenario" }), el("ol", { className: "steps" },
        el("li", { textContent: "Activate a scenario: the app opens on the affected page with the fault planted (and any earlier scenario cleared)." }),
        el("li", { textContent: "Show the symptom (error banner, missing dates, empty list…)." }),
        el("li", { textContent: "Open the Operon support widget (bottom right) or the Chrome extension, describe the problem and start the investigation." }),
        el("li", { textContent: "Review the proposed fix: approve it to apply and verify it, or reject it and nothing changes. Server-side scenarios escalate with a ticket instead." }),
        el("li", { textContent: "Come back here: the status shows whether the fault is really gone. \"Re-activate\" plants it again for the next run." }),
      )),
      el("section", { className: "scenarios", id: "scenarios" }, ...cards),
    ),
  );
}

render();
window.addEventListener("focus", render);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && render());
