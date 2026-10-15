// Operon support dashboard — read-only view of escalation tickets.
//
// Security model: the page is static; ticket data comes from the API with the
// viewer's own key, which lives only in this tab's memory (never storage, never
// a URL). Every value is untrusted text from a customer's page or a model and is
// rendered with textContent / createElement (never as markup), so markup in a
// report shows up as text. The server's CSP forbids inline script anyway.
"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  let apiKey = "";
  let selectedRow = null;

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function text(value) {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "object") return JSON.stringify(value, null, 2);
    return String(value);
  }

  function setMessage(message, bad) {
    const node = $("message");
    node.textContent = message;
    node.className = bad ? "bad" : "muted";
  }

  async function api(path) {
    const headers = { Accept: "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    const response = await fetch(path, { headers, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok) {
      const reason = response.status === 401 ? "the API key was not accepted"
        : response.status === 404 ? "not found (or not visible to this key)"
        : response.status === 429 ? "rate limited, try again shortly"
        : "request failed (" + response.status + ")";
      throw new Error(reason);
    }
    return response.json();
  }

  function dl(pairs) {
    const list = el("dl");
    for (const [label, value] of pairs) list.append(el("dt", {}, label), el("dd", {}, text(value)));
    return list;
  }

  function pre(value) {
    return el("pre", {}, text(value));
  }

  function evidenceSection(evidence) {
    const wrap = el("div");
    if (!evidence || !evidence.length) {
      wrap.append(el("p", { class: "muted" }, "No evidence was collected."));
      return wrap;
    }
    for (const bundle of evidence) {
      wrap.append(el("h3", {}, "Bundle " + text(bundle.bundle_id) + " · cycle " + text(bundle.cycle) + " · " + text(bundle.purpose)));
      wrap.append(dl([["URL", bundle.url], ["Collectors", (bundle.collectors || []).join(", ")], ["Collection errors", (bundle.collection_errors || []).join("; ")]]));
      for (const [kind, items] of Object.entries(bundle.items || {})) {
        if (!items || !items.length) continue;
        const details = el("details", {}, el("summary", {}, kind + " (" + items.length + ")"));
        for (const item of items) details.append(pre(item));
        wrap.append(details);
      }
    }
    return wrap;
  }

  function timeline(entries, render) {
    if (!entries || !entries.length) return el("p", { class: "muted" }, "None.");
    const list = el("ol", { class: "timeline" });
    for (const entry of entries) list.append(el("li", {}, render(entry)));
    return list;
  }

  function renderDetail(ticket) {
    const report = ticket.report || {};
    const escalation = report.escalation || {};
    const summary = report.summary || {};
    const node = $("detail");
    node.replaceChildren(
      el("h2", {}, "Ticket " + ticket.ticket_id),
      dl([
        ["Status", ticket.status],
        ["Session", ticket.session_id],
        ["Opened", ticket.created_at],
        ["Raised for", ticket.created_by],
        ["Source", report.source],
      ]),
      el("h2", {}, "Why Operon stopped"),
      dl([
        ["Reason", escalation.reason],
        ["Outcome", escalation.resolution_state],
        ["From phase", escalation.from_phase],
        ["Guidance", escalation.guidance],
      ]),
      el("h2", {}, "User's message"),
      pre(report.user_message),
      el("h2", {}, "Diagnosis"),
      dl([
        ["Root cause", summary.root_cause],
        ["Category", summary.category],
        ["Engine", summary.engine],
        ["Confidence", report.confidence],
        ["Cycles", summary.investigation_cycles],
        ["LLM calls", summary.llm_calls],
      ]),
      el("h3", {}, "All diagnoses"),
      timeline(report.diagnoses, (d) => "#" + text(d.seq) + " [" + text(d.engine || d.outcome) + "] " + text(d.category) + ": " + text(d.root_cause) + " — cites " + text((d.evidence_ids || []).join(", "))),
      el("h3", {}, "Hypotheses"),
      timeline(report.hypotheses, (h) => text(h.status) + " (" + text(h.confidence) + "): " + text(h.description)),
      el("h2", {}, "Actions"),
      el("h3", {}, "Policy decision"),
      pre(report.policy_decision),
      el("h3", {}, "Attempted actions"),
      timeline(report.attempted_actions, (a) => text(a.action_id) + " " + text(a.params) + " — " + (a.succeeded ? "ran" : "did not run") + ", verified: " + text(a.verified) + " — " + text(a.detail)),
      el("h3", {}, "Verification"),
      pre(report.verification),
      el("h2", {}, "Questions asked"),
      timeline(report.questions, (q) => text(q.question) + " → " + text(q.answer)),
      el("h2", {}, "Evidence"),
      evidenceSection(report.evidence),
      el("h2", {}, "Activity timeline"),
      timeline(report.activity, (a) => text(a.at) + " · " + text(a.kind) + " · " + text(a.summary)),
      el("h2", {}, "Triage history"),
      timeline(ticket.status_history, (s) => text(s.at) + " " + text(s.from) + " → " + text(s.to) + " by " + text(s.by) + (s.note ? " — " + s.note : "")),
    );
    node.hidden = false;
  }

  async function openTicket(id, row) {
    try {
      setMessage("Loading ticket…");
      const ticket = await api("/api/tickets/" + encodeURIComponent(id));
      if (selectedRow) selectedRow.classList.remove("selected");
      selectedRow = row;
      row.classList.add("selected");
      renderDetail(ticket);
      setMessage("");
    } catch (error) {
      setMessage("Could not load the ticket: " + error.message, true);
    }
  }

  async function loadTickets() {
    apiKey = $("api-key").value.trim();
    const status = $("status-filter").value;
    const body = $("tickets");
    try {
      setMessage("Loading…");
      const query = status ? "?status=" + encodeURIComponent(status) : "";
      const data = await api("/api/tickets" + query);
      body.replaceChildren();
      $("detail").hidden = true;
      for (const t of data.tickets || []) {
        const row = el("tr", { tabindex: "0" },
          el("td", {}, text(t.created_at)),
          el("td", {}, el("span", { class: "badge" }, text(t.status))),
          el("td", {}, text(t.resolution_state)),
          el("td", {}, text(t.category)),
          el("td", {}, text(t.user_message)));
        row.addEventListener("click", () => openTicket(t.ticket_id, row));
        row.addEventListener("keydown", (e) => { if (e.key === "Enter") openTicket(t.ticket_id, row); });
        body.append(row);
      }
      setMessage((data.tickets || []).length + " ticket(s)");
    } catch (error) {
      body.replaceChildren();
      setMessage("Could not load tickets: " + error.message, true);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("load").addEventListener("click", loadTickets);
    $("api-key").addEventListener("keydown", (e) => { if (e.key === "Enter") loadTickets(); });
  });
})();
