// Rendering only: takes plain state, produces DOM. No fetching, no storage.
import { formatDate, formatMoney } from "./prefs.js";

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k !== null && k !== undefined));
  return node;
};

export function render(root, state) {
  const { projects, account, reports, prefs, errors, bug } = state;
  // Format first: a value that cannot be displayed adds to `errors`, and the
  // banners below must include it.
  const items = projects?.map((p) => {
    let budget = "—";
    let updated = "—";
    try {
      budget = formatMoney(p.budget, prefs);
      updated = formatDate(p.updated, prefs);
    } catch (err) {
      state.onFormatError?.(err);
    }
    return el("li", {}, el("strong", { textContent: p.name }), ` — ${p.owner} · ${budget} · ${updated}`);
  });
  root.replaceChildren(
    el("header", {}, el("h1", { textContent: "Buggy Cloud" }), el("span", { id: "account", textContent: account ? `${account.name} · ${account.plan}` : "Signed out" })),
    ...errors.map((e) => el("div", { className: "error", role: "alert", textContent: e })),
    el("h2", { textContent: "Projects" }),
    items ? el("ul", { id: "projects" }, ...items) : el("p", { id: "projects-empty", textContent: "No projects to show." }),
    el("h2", { textContent: "Reports" }),
    reports ? el("ul", { id: "reports" }, ...reports.map((r) => el("li", { textContent: r.title }))) : el("p", { id: "reports-empty", textContent: "No reports to show." }),
    el(
      "footer",
      {},
      bug ? `Demo mode: bug ${bug.id} (${bug.slug}) — ${bug.symptom} ` : "Everything is working. ",
      bug ? el("a", { id: "reset-scenario", href: `?bug=${bug.id}&reset=1`, textContent: "Reset this scenario" }) : null,
    ),
  );
}
