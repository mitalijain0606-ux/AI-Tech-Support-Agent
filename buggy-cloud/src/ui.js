// Rendering only: takes plain state, produces DOM. No fetching, no storage writes.
//
// Five screens behind hash routes — Overview (#/), Projects, Reports, Account and
// Settings. Every screen renders from the same loaded state, so a seeded defect
// shows up wherever its data is used (an invalid timezone breaks every date on
// every screen), and the error banners are the app's own, on every screen.
import { BUGS } from "./bugs.js";
import { formatDate, formatMoney } from "./prefs.js";

export const ROUTES = Object.freeze([
  { hash: "#/", title: "Overview" },
  { hash: "#/projects", title: "Projects" },
  { hash: "#/reports", title: "Reports" },
  { hash: "#/account", title: "Account" },
  { hash: "#/settings", title: "Settings" },
]);

export function routeOf(hash) {
  return ROUTES.find((r) => r.hash === hash) ?? ROUTES[0];
}

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined));
  return node;
};

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

function projectItems(state) {
  return state.projects?.map((p) => {
    let budget = "—";
    let updated = "—";
    try {
      budget = formatMoney(p.budget, state.prefs);
      updated = formatDate(p.updated, state.prefs);
    } catch (err) {
      state.onFormatError?.(err);
    }
    return el("li", {}, el("strong", { textContent: p.name }), ` — ${p.owner} · ${budget} · ${updated}`);
  });
}

function overview(state) {
  const items = projectItems(state);
  return [
    el("h2", { textContent: "Projects" }),
    items ? el("ul", { id: "projects" }, ...items) : el("p", { id: "projects-empty", textContent: "No projects to show." }),
    el("h2", { textContent: "Reports" }),
    state.reports
      ? el("ul", { id: "reports" }, ...state.reports.map((r) => el("li", { textContent: r.title })))
      : el("p", { id: "reports-empty", textContent: "No reports to show." }),
  ];
}

function projectsScreen(state) {
  if (!state.projects) return [el("h2", { textContent: "Projects" }), el("p", { id: "projects-empty", textContent: "No projects to show." })];
  const rows = state.projects.map((p) =>
    el(
      "tr",
      {},
      el("td", { textContent: p.name }),
      el("td", { textContent: p.owner }),
      el("td", { textContent: safe(state, () => formatMoney(p.budget, state.prefs)) }),
      el("td", { textContent: safe(state, () => formatDate(p.updated, state.prefs)) }),
    ),
  );
  const total = state.projects.reduce((sum, p) => sum + p.budget, 0);
  return [
    el("h2", { textContent: "Projects" }),
    el(
      "table",
      { id: "projects-table" },
      el("thead", {}, el("tr", {}, ...["Name", "Owner", "Budget", "Last updated"].map((h) => el("th", { textContent: h })))),
      el("tbody", {}, ...rows),
    ),
    el("p", { id: "projects-total", textContent: `Total budget: ${safe(state, () => formatMoney(total, state.prefs))}` }),
  ];
}

function reportsScreen(state) {
  return [
    el("h2", { textContent: "Reports" }),
    state.reports
      ? el("ul", { id: "reports-list" }, ...state.reports.map((r) => el("li", {}, el("strong", { textContent: r.title }), ` (${r.id})`)))
      : el("p", { id: "reports-empty", textContent: "Reports are unavailable right now." }),
  ];
}

function accountScreen(state) {
  const { account, prefs } = state;
  return [
    el("h2", { textContent: "Account" }),
    account
      ? el(
          "dl",
          { id: "account-details" },
          el("dt", { textContent: "Name" }), el("dd", { textContent: account.name }),
          el("dt", { textContent: "Plan" }), el("dd", { textContent: account.plan }),
        )
      : el("p", { id: "account-signed-out", textContent: "You are signed out. Sign in again to see your account." }),
    el("h3", { textContent: "Display preferences" }),
    el(
      "dl",
      { id: "account-prefs" },
      el("dt", { textContent: "Time zone" }), el("dd", { textContent: prefs.timezone }),
      el("dt", { textContent: "Locale" }), el("dd", { textContent: prefs.locale }),
      el("dt", { textContent: "Currency" }), el("dd", { textContent: prefs.currency }),
      el("dt", { textContent: "Example" }),
      el("dd", { id: "prefs-example", textContent: `${safe(state, () => formatDate("2026-10-01T09:00:00Z", prefs))} · ${safe(state, () => formatMoney(1234.5, prefs))}` }),
    ),
  ];
}

function settingsScreen(state) {
  const nodes = [
    el("h2", { textContent: "Settings" }),
    el("p", { id: "settings-status", textContent: state.settingsOk === false ? "Your saved settings could not be read." : "Your saved settings are in good shape." }),
  ];
  // The hidden diagnostics control: the seeded-scenario switch, revealed only
  // with ?diagnostics=1 so the normal UI carries no "bug button".
  if (state.diagnostics) {
    nodes.push(
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
    );
  }
  return nodes;
}

const SCREENS = { "#/": overview, "#/projects": projectsScreen, "#/reports": reportsScreen, "#/account": accountScreen, "#/settings": settingsScreen };

export function render(root, state, hash = "#/") {
  const route = routeOf(hash);
  const { account, errors, bug } = state;
  // Build the screen first: a value that cannot be displayed adds to `errors`,
  // and the banners below must include it.
  const screen = SCREENS[route.hash](state);
  const nav = el(
    "nav",
    { "aria-label": "Main" },
    ...ROUTES.map((r) => {
      const link = el("a", { href: r.hash, textContent: r.title });
      if (r.hash === route.hash) {
        link.className = "current";
        link.setAttribute("aria-current", "page");
      }
      return link;
    }),
  );
  root.replaceChildren(
    el("header", {}, el("h1", { textContent: "Buggy Cloud" }), el("span", { id: "account", textContent: account ? `${account.name} · ${account.plan}` : "Signed out" })),
    nav,
    ...errors.map((e) => el("div", { className: "error", role: "alert", textContent: e })),
    el("main", { id: "screen" }, ...screen),
    el(
      "footer",
      {},
      bug ? `Demo mode: bug ${bug.id} (${bug.slug}) — ${bug.symptom} ` : "Everything is working. ",
      bug ? el("a", { id: "reset-scenario", href: `?bug=${bug.id}&reset=1`, textContent: "Reset this scenario" }) : null,
    ),
  );
  root.querySelector("#screen").dataset.screen = route.title.toLowerCase();
}
