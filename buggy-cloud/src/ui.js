// NexaDesk rendering: takes plain state, produces DOM. No fetching. The only writes are the
// user's own edits on Settings / Notifications, handed back through `state.actions`.
//
// Seven screens behind hash routes. Every screen renders from the same loaded state, so a seeded
// defect shows up wherever its data is used (an invalid timezone breaks every date on every
// screen), and the error banners are the app's own, on every screen. All text is set with
// textContent; nothing from data is ever parsed as HTML.
import { BUGS } from "./bugs.js";
import { HELP_ARTICLES, NOTIFICATIONS } from "./mock-data.js";
import { formatDate, formatMoney } from "./prefs.js";

export const ROUTES = Object.freeze([
  { hash: "#/", title: "Overview", icon: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { hash: "#/projects", title: "Projects", icon: "M3 7h6l2 2h10v10H3z" },
  { hash: "#/reports", title: "Reports", icon: "M5 20V10M12 20V4M19 20v-7" },
  { hash: "#/notifications", title: "Notifications", icon: "M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20h4" },
  { hash: "#/account", title: "Account", icon: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0" },
  { hash: "#/settings", title: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 .5-1.5-1.2L15 4h-6l-.5 2.3L7 7.5 5 7l-2 4 2 1v0l-2 1 2 4 2-.5 1.5 1.2L9 20h6l.5-2.3 1.5-1.2 2 .5 2-4z" },
  { hash: "#/help", title: "Help", icon: "M12 22a10 10 0 100-20 10 10 0 000 20zM9.5 9a2.5 2.5 0 115 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01" },
]);

export const TIMEZONES = ["UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Tokyo"];
export const CURRENCIES = ["USD", "EUR", "GBP", "INR", "JPY"];
export const STATUS_LABEL = { active: "On track", at_risk: "At risk", done: "Done" };

export function routeOf(hash) {
  return ROUTES.find((r) => r.hash === hash) ?? ROUTES[0];
}

/** Projects matching a search text and status filter (pure: unit-tested). */
export function filterProjects(projects, { text = "", status = "all" } = {}) {
  const q = String(text).trim().toLowerCase();
  return projects.filter((p) => (status === "all" || p.status === status) && (!q || p.name.toLowerCase().includes(q) || p.owner.toLowerCase().includes(q)));
}

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return node;
};
const SVG = "http://www.w3.org/2000/svg";
function icon(d) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}
const card = (...kids) => el("section", { className: "card" }, ...kids);
const badge = (text, kind = "") => el("span", { className: `badge ${kind}`.trim(), textContent: text });

// A value that cannot be displayed (Intl throws on a bad preference) becomes a
// dash and is reported once through state.onFormatError — the app's real error path.
function safe(state, fn) {
  try {
    return fn();
  } catch (err) {
    state.onFormatError?.(err);
    return "—";
  }
}

function statusBadge(status) {
  return badge(STATUS_LABEL[status] ?? status, status === "at_risk" ? "warn" : status === "done" ? "info" : "ok");
}

function overview(state) {
  const projects = state.projects;
  const items = projects?.map((p) => {
    let budget = "—";
    let updated = "—";
    try {
      budget = formatMoney(p.budget, state.prefs);
      updated = formatDate(p.updated, state.prefs);
    } catch (err) {
      state.onFormatError?.(err);
    }
    return el(
      "li",
      {},
      el("div", { className: "spacer" }, el("strong", { textContent: p.name }), el("div", { className: "muted", textContent: ` — ${p.owner} · ${budget} · ${updated}` })),
      statusBadge(p.status),
    );
  });
  const total = projects ? safe(state, () => formatMoney(projects.reduce((s, p) => s + p.budget, 0), state.prefs)) : "—";
  const atRisk = projects ? projects.filter((p) => p.status === "at_risk").length : "—";
  return [
    el(
      "div",
      { className: "grid kpis" },
      el("section", { className: "card kpi" }, el("div", { className: "label", textContent: "Active projects" }), el("div", { className: "value", id: "kpi-projects", textContent: projects ? String(projects.length) : "—" })),
      el("section", { className: "card kpi" }, el("div", { className: "label", textContent: "Total budget" }), el("div", { className: "value", textContent: total })),
      el("section", { className: "card kpi" }, el("div", { className: "label", textContent: "At risk" }), el("div", { className: "value", textContent: String(atRisk) })),
      el("section", { className: "card kpi" }, el("div", { className: "label", textContent: "Reports" }), el("div", { className: "value", textContent: state.reports ? String(state.reports.length) : "—" })),
    ),
    el(
      "div",
      { className: "grid two" },
      card(
        el("h2", { textContent: "Projects" }),
        items ? el("ul", { id: "projects", className: "plain" }, ...items) : el("div", { id: "projects-empty", className: "empty" }, el("strong", { textContent: "No projects to show." }), "The project service did not answer."),
      ),
      card(
        el("h2", { textContent: "Reports" }),
        state.reports
          ? el("ul", { id: "reports", className: "plain" }, ...state.reports.map((r) => el("li", { textContent: r.title })))
          : el("div", { id: "reports-empty", className: "empty" }, el("strong", { textContent: "No reports to show." }), "Reports could not be loaded."),
      ),
    ),
  ];
}

function projectsScreen(state) {
  if (!state.projects) {
    return [card(el("h2", { textContent: "Projects" }), el("div", { id: "projects-empty", className: "empty" }, el("strong", { textContent: "No projects to show." }), "The project service did not answer. Try again later."))];
  }
  const search = state.search; // { text, status } or null when the saved filters are unreadable
  const shown = search ? filterProjects(state.projects, search) : state.projects;
  const rows = shown.map((p) =>
    el(
      "tr",
      {},
      el("td", {}, el("strong", { textContent: p.name })),
      el("td", { textContent: p.owner }),
      el("td", {}, statusBadge(p.status)),
      el("td", {}, el("div", { className: "progress", title: `${p.progress}%` }, el("span", { style: `width:${Number(p.progress) || 0}%` }))),
      el("td", { textContent: safe(state, () => formatMoney(p.budget, state.prefs)) }),
      el("td", { textContent: safe(state, () => formatDate(p.updated, state.prefs)) }),
    ),
  );
  const total = state.projects.reduce((sum, p) => sum + p.budget, 0);
  const text = el("input", { type: "search", id: "project-search", placeholder: "Search by project or owner", value: search?.text ?? "", disabled: !search, ariaLabel: "Search projects" });
  const status = el("select", { id: "project-status", disabled: !search, ariaLabel: "Filter by status" }, ...[["all", "All statuses"], ["active", "On track"], ["at_risk", "At risk"]].map(([v, t]) => el("option", { value: v, textContent: t, selected: (search?.status ?? "all") === v })));
  if (search) {
    text.addEventListener("input", () => state.actions?.search({ text: text.value, status: status.value }));
    status.addEventListener("change", () => state.actions?.search({ text: text.value, status: status.value }));
  }
  return [
    card(
      el("div", { className: "row" }, el("h2", { textContent: "Projects", style: "margin:0" }), el("span", { className: "spacer" }), el("div", { style: "width:260px" }, text), el("div", { style: "width:160px" }, status)),
      !search ? el("p", { id: "search-unavailable", className: "notice", textContent: "Search is unavailable: your saved search filters could not be read." }) : null,
      el(
        "div",
        { className: "table-wrap" },
        el(
          "table",
          { id: "projects-table" },
          el("thead", {}, el("tr", {}, ...["Name", "Owner", "Status", "Progress", "Budget", "Last updated"].map((h) => el("th", { textContent: h })))),
          el("tbody", {}, ...rows),
        ),
      ),
      shown.length === 0 ? el("div", { className: "empty", id: "projects-no-match" }, el("strong", { textContent: "No matching projects" }), "Try another name or status.") : null,
      el("p", { id: "projects-total", className: "muted", textContent: `Total budget: ${safe(state, () => formatMoney(total, state.prefs))}` }),
    ),
  ];
}

function reportsScreen(state) {
  return [
    card(
      el("h2", { textContent: "Reports" }),
      state.reports
        ? el("ul", { id: "reports-list", className: "plain" }, ...state.reports.map((r) => el("li", {}, el("div", { className: "spacer" }, el("strong", { textContent: r.title }), ` (${r.id})`, el("div", { className: "muted", textContent: r.description ?? "" })), badge("Ready", "ok"))))
        : el("div", { id: "reports-empty", className: "empty" }, el("strong", { textContent: "Reports are unavailable right now." }), "The reporting service could not be reached."),
    ),
  ];
}

function notificationsScreen(state) {
  const prefs = state.notificationPrefs;
  const toggle = (key, label, hint) => {
    const input = el("input", { type: "checkbox", id: `notify-${key}`, checked: Boolean(prefs[key]) });
    input.addEventListener("change", () => state.actions?.notify(key, input.checked));
    return el("label", { className: "toggle" }, el("span", {}, el("strong", { textContent: label }), el("div", { className: "muted", textContent: hint })), input);
  };
  return [
    card(
      el("h2", { textContent: "Recent notifications" }),
      el("ul", { id: "notifications", className: "plain" }, ...NOTIFICATIONS.map((n) => el("li", {}, el("div", { className: "spacer" }, el("strong", { textContent: n.title }), el("div", { className: "muted", textContent: `${n.body} · ${safe(state, () => formatDate(n.at, state.prefs))}` })), badge(n.kind === "warning" ? "Attention" : n.kind === "success" ? "Done" : "Info", n.kind === "warning" ? "warn" : n.kind === "success" ? "ok" : "info")))),
    ),
    card(
      el("h2", { textContent: "Notification preferences" }),
      toggle("email", "Email digests", "A daily summary of project activity."),
      toggle("risk", "At-risk alerts", "Tell me when a project falls behind."),
      toggle("reports", "Report ready", "Tell me when a scheduled report is generated."),
      el("p", { className: "muted", id: "notify-saved", textContent: "Changes are saved automatically." }),
    ),
  ];
}

function accountScreen(state) {
  const { account, prefs } = state;
  return [
    card(
      el("h2", { textContent: "Account" }),
      account
        ? el(
            "dl",
            { id: "account-details", className: "props" },
            el("dt", { textContent: "Name" }), el("dd", { textContent: account.name }),
            el("dt", { textContent: "Plan" }), el("dd", { textContent: account.plan }),
            ...(account.email ? [el("dt", { textContent: "Email" }), el("dd", { textContent: account.email })] : []),
          )
        : el("div", { id: "account-signed-out", className: "notice", textContent: "You are signed out. Sign in again to see your account." }),
    ),
    card(
      el("h2", { textContent: "Display preferences" }),
      el(
        "dl",
        { id: "account-prefs", className: "props" },
        el("dt", { textContent: "Time zone" }), el("dd", { textContent: prefs.timezone }),
        el("dt", { textContent: "Locale" }), el("dd", { textContent: prefs.locale }),
        el("dt", { textContent: "Currency" }), el("dd", { textContent: prefs.currency }),
        el("dt", { textContent: "Example" }),
        el("dd", { id: "prefs-example", textContent: `${safe(state, () => formatDate("2026-10-01T09:00:00Z", prefs))} · ${safe(state, () => formatMoney(1234.5, prefs))}` }),
      ),
    ),
  ];
}

function settingsScreen(state) {
  const tz = el("select", { id: "pref-timezone", ariaLabel: "Time zone" }, ...TIMEZONES.map((t) => el("option", { value: t, textContent: t, selected: state.prefs.timezone === t })));
  const cur = el("select", { id: "pref-currency", ariaLabel: "Currency" }, ...CURRENCIES.map((c) => el("option", { value: c, textContent: c, selected: state.prefs.currency === c })));
  const save = el("button", { type: "button", className: "btn primary", id: "pref-save", textContent: "Save preferences" });
  save.addEventListener("click", () => state.actions?.savePrefs({ timezone: tz.value, currency: cur.value }));
  const nodes = [
    card(
      el("h2", { textContent: "Settings" }),
      el("p", { id: "settings-status", className: state.settingsOk === false ? "error" : "notice", textContent: state.settingsOk === false ? "Your saved settings could not be read." : "Your saved settings are in good shape." }),
    ),
    card(
      el("h2", { textContent: "Display preferences" }),
      el("div", { className: "grid two" }, el("label", { className: "field" }, "Time zone", tz), el("label", { className: "field" }, "Currency", cur)),
      el("div", { className: "row", style: "margin-top:16px" }, save, el("span", { id: "pref-saved", className: "muted", textContent: state.prefsSaved ? "Saved." : "" })),
    ),
  ];
  // The hidden diagnostics control: the seeded-scenario switch, revealed only with
  // ?diagnostics=1 so the normal UI carries no "bug button". (The full presenter console is /demo.)
  if (state.diagnostics) {
    nodes.push(
      card(
        el(
          "section",
          { id: "diagnostics", "aria-label": "Diagnostics" },
          el("h3", { textContent: "Diagnostics (demo scenarios)" }),
          el(
            "ul",
            {},
            el("li", {}, el("a", { href: "?diagnostics=1&reset=1#/settings", textContent: "Healthy (no defect)" })),
            ...BUGS.map((b) => el("li", {}, el("a", { href: `?bug=${b.id}&reset=1&diagnostics=1`, textContent: `${b.id}. ${b.title}` }))),
          ),
        ),
      ),
    );
  }
  return nodes;
}

function helpScreen(state) {
  const ask = el("button", { type: "button", className: "btn primary", id: "help-ask-operon", textContent: "Ask Operon about a problem" });
  ask.disabled = !state.operonAvailable;
  ask.addEventListener("click", () => state.actions?.openOperon());
  return [
    card(
      el("h2", { textContent: "Help & support" }),
      el("p", { className: "muted", textContent: "Something not working? Operon, our support assistant, can look at what this page is doing, explain the problem and — with your approval — fix it." }),
      el("div", { className: "row" }, ask, state.operonAvailable ? null : el("span", { className: "muted", textContent: "The support assistant is not enabled on this server." })),
    ),
    card(el("h2", { textContent: "Articles" }), el("ul", { id: "help-articles", className: "plain" }, ...HELP_ARTICLES.map((a) => el("li", {}, el("div", {}, el("strong", { textContent: a.title }), el("div", { className: "muted", textContent: a.body })))))),
  ];
}

const SCREENS = {
  "#/": overview, "#/projects": projectsScreen, "#/reports": reportsScreen, "#/notifications": notificationsScreen,
  "#/account": accountScreen, "#/settings": settingsScreen, "#/help": helpScreen,
};

export function render(root, state, hash = "#/") {
  const route = routeOf(hash);
  const { account, errors, bug } = state;
  // Build the screen first: a value that cannot be displayed adds to `errors`,
  // and the banners below must include it.
  const screen = SCREENS[route.hash](state);
  const nav = el(
    "nav",
    { className: "main-nav", "aria-label": "Main" },
    ...ROUTES.map((r) => {
      const link = el("a", { href: r.hash }, icon(r.icon), r.title);
      if (r.hash === route.hash) {
        link.className = "current";
        link.setAttribute("aria-current", "page");
      }
      return link;
    }),
  );
  const initials = account ? account.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2) : "?";
  root.replaceChildren(
    el(
      "div",
      { className: "shell" },
      el(
        "aside",
        { className: "sidebar" },
        el("div", { className: "brand" }, el("span", { className: "brand-mark", textContent: "N" }), "NexaDesk"),
        el("div", { className: "workspace", textContent: account?.workspace ?? "Workspace" }),
        nav,
        el("div", { className: "sidebar-foot", textContent: "NexaDesk · demo workspace" }),
      ),
      el(
        "div",
        { className: "content" },
        el(
          "header",
          { className: "topbar" },
          el("h1", { textContent: route.title }),
          el("div", { className: "who" }, el("span", { className: "avatar", textContent: initials }), el("span", { id: "account", textContent: account ? `${account.name} · ${account.plan}` : "Signed out" })),
        ),
        errors.length ? el("div", { className: "banners" }, ...errors.map((e) => el("div", { className: "error", role: "alert", textContent: e }))) : null,
        el("main", { id: "screen" }, ...screen),
        el(
          "footer",
          { className: "demo-bar" },
          !bug ? "Everything is working. "
          : errors.length ? `Demo mode: bug ${bug.id} (${bug.slug}) — ${bug.symptom} `
          : `Demo mode: bug ${bug.id} (${bug.slug}) is selected, but it is not active in this browser any more (it was fixed or reset). `,
          bug ? el("a", { id: "reset-scenario", href: `?bug=${bug.id}&reset=1`, textContent: errors.length ? "Reset this scenario" : "Plant it again" }) : null,
          el("a", { href: "/demo", id: "open-demo-console", textContent: "Demo console" }),
        ),
      ),
    ),
  );
  root.querySelector("#screen").dataset.screen = route.title.toLowerCase();
}
