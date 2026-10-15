#!/usr/bin/env node
// Sandbox reproduction of an escalated ticket — LOCAL ONLY, for a support engineer.
//
//   OPERON_API_KEY=<admin key> node scripts/reproduce-ticket.mjs --ticket tkt_… --allow-host 127.0.0.1 [--backend http://127.0.0.1:8000]
//   node scripts/reproduce-ticket.mjs --report ticket.json --allow-host github.com   # a saved GET /api/tickets/{id}
//
// Options: --allow-host HOST (repeatable, required: the ticket's host must be listed — even
//            localhost, since a ticket's URL comes from a customer's page and must not be able to
//            point the sandbox at services on the engineer's own machine)
//          --observe-ms N (default 5000, max 20000)   --reload (observe one reload as well)
//          --recreate-storage (plant a deliberately invalid value under each storage key the
//            report says failed to parse — synthetic, never the customer's data)
//          --out FILE (default .local/repro/<ticket>.json)   --headed
//
// What it does: opens the ticket's page in a disposable headless Chromium (fresh profile: no
// cookies, no storage, no extension, no sign-in, downloads and permissions denied, dialogs
// dismissed), observes console errors and failed requests, and compares them with the evidence in
// the ticket. The verdict says which reported signals reproduced without the customer's session —
// server-side failures (404/5xx, CORS) usually do; problems tied to the customer's own browser
// state usually do not, and the tool says so instead of guessing.
//
// Safety: only http(s) pages on a host the engineer explicitly allowed are opened; requests to any other host
// are aborted inside the sandbox; nothing is ever sent back to the backend; the key is read from the
// environment (never argv, so it is not visible in the process list) and is never written out;
// everything the page produced is redacted with the shared redaction (sdk/redact.js) before it is
// printed or saved. Never deploy this: it is a tool for one engineer's machine.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactFreeText, scrubUrl } from "../sdk/redact.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_OBSERVE_MS = 20_000;

// ---- pure logic (unit-tested) ------------------------------------------------------------------

const normalise = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/\[redacted:[a-z_]+\]/g, "")
    .replace(/https?:\/\/[^\s)]+/g, "")
    .replace(/[0-9a-f]{6,}/g, "")
    .replace(/:\d+(:\d+)?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

const pathOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url ?? "");
  }
};

/** What to open and what to look for, from a ticket report. Throws on anything unsafe. */
export function planFromReport(report, { allowHosts = [] } = {}) {
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const latest = evidence.at(-1);
  const pageUrl = latest?.url;
  if (!pageUrl) throw new Error("The ticket has no page URL to reproduce.");
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error("The ticket's page URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Refusing to open a ${url.protocol} URL.`);
  if (url.username || url.password) throw new Error("Refusing a URL that carries credentials.");
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()));
  if (!allowed.has(url.hostname.toLowerCase())) {
    throw new Error(`Host '${url.hostname}' is not allowed. Pass --allow-host ${url.hostname} to reproduce on it.`);
  }
  const items = evidence.flatMap((b) => Object.entries(b.items ?? {}).flatMap(([kind, list]) => (list ?? []).map((i) => ({ kind, ...i }))));
  return {
    url: url.origin + url.pathname,
    allowedHosts: [...allowed],
    expect: {
      console: items.filter((i) => i.kind === "console" && i.level === "error").map((i) => ({ id: i.id, text: i.text, key: normalise(i.text) })),
      network: items.filter((i) => i.kind === "network" && (i.status === 0 || i.status >= 400)).map((i) => ({ id: i.id, url: i.url, status: i.status, key: `${pathOf(i.url)} ${i.status}` })),
      storage: items.filter((i) => i.kind === "storage" && i.present && i.parse_status === "syntax_error").map((i) => ({ id: i.id, key: i.key, storage_type: i.storage_type ?? "localStorage" })),
    },
  };
}

// The same error, allowing for what legitimately differs between two runs: line numbers, URLs,
// ids (stripped by normalise) and the tail of a parser message, which quotes the value it read.
function sameError(a, b) {
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= Math.min(30, a.length, b.length);
}

/** Which expected signals the sandbox observed. */
export function compare(expect, observed) {
  const seenConsole = new Set(observed.console.map((c) => normalise(c.text)));
  const seenNetwork = new Set(observed.network.map((n) => `${pathOf(n.url)} ${n.status}`));
  const matches = [
    ...expect.console.map((c) => ({ id: c.id, kind: "console", reported: c.text, reproduced: [...seenConsole].some((s) => sameError(s, c.key)) })),
    ...expect.network.map((n) => ({ id: n.id, kind: "network", reported: `${n.status} ${n.url}`, reproduced: seenNetwork.has(n.key) })),
  ];
  const reproduced = matches.filter((m) => m.reproduced).length;
  const verdict = !matches.length ? "nothing_to_compare" : reproduced === matches.length ? "reproduced" : reproduced ? "partially_reproduced" : "not_reproduced";
  const explanation = {
    reproduced: "Every reported error reproduced in a clean browser: the cause is not the customer's own browser state.",
    partially_reproduced: "Some reported errors reproduced in a clean browser; the rest likely depend on the customer's session or browser state.",
    not_reproduced: "None of the reported errors reproduced in a clean browser: the cause likely depends on the customer's session, data or browser state.",
    nothing_to_compare: "The ticket reports no console error or failed request to compare against.",
  }[verdict];
  return { verdict, explanation, matches };
}

// ---- the sandbox --------------------------------------------------------------------------------

export async function runSandbox(plan, { observeMs = 5000, reload = false, recreateStorage = false, headed = false, chromium } = {}) {
  observeMs = Math.min(Math.max(Number(observeMs) || 5000, 500), MAX_OBSERVE_MS);
  const profile = mkdtempSync(path.join(os.tmpdir(), "operon-repro-"));
  const observed = { console: [], network: [], blocked_hosts: new Set(), navigations: [] };
  const browser = await chromium.launch({ headless: !headed, executablePath: process.env.OPERON_E2E_CHROMIUM || undefined });
  try {
    const ctx = await browser.newContext({ acceptDownloads: false, permissions: [], serviceWorkers: "allow", javaScriptEnabled: true, bypassCSP: false });
    await ctx.route("**/*", (route) => {
      let host = "";
      try {
        host = new URL(route.request().url()).hostname.toLowerCase();
      } catch {}
      if (plan.allowedHosts.includes(host) || route.request().url().startsWith("data:")) return route.continue();
      observed.blocked_hosts.add(host || "unknown");
      return route.abort("blockedbyclient");
    });
    if (recreateStorage && plan.expect.storage.length) {
      // Synthetic invalid values under the reported keys — the customer's values were never collected.
      await ctx.addInitScript((entries) => {
        if (sessionStorage.getItem("__operon_repro_planted")) return;
        for (const { key, storage_type } of entries) (storage_type === "sessionStorage" ? sessionStorage : localStorage).setItem(key, "{operon-repro-invalid");
        sessionStorage.setItem("__operon_repro_planted", "1");
      }, plan.expect.storage);
    }
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    page.on("console", (m) => { if (m.type() === "error") observed.console.push({ text: m.text().slice(0, 2000) }); });
    page.on("pageerror", (e) => observed.console.push({ text: String(e?.stack || e?.message || e).split("\n")[0].slice(0, 2000) }));
    page.on("response", (r) => { if (r.status() >= 400) observed.network.push({ url: r.url(), status: r.status(), method: r.request().method() }); });
    page.on("requestfailed", (r) => {
      const text = r.failure()?.errorText ?? "";
      if (/BLOCKED_BY_CLIENT/i.test(text) && !plan.allowedHosts.includes(new URL(r.url()).hostname)) return; // the sandbox's own blocking
      observed.network.push({ url: r.url(), status: 0, method: r.method(), failure: text });
    });
    const response = await page.goto(plan.url, { waitUntil: "load", timeout: 30_000 }).catch((err) => err);
    observed.navigations.push(response instanceof Error ? { error: response.message.split("\n")[0] } : { status: response?.status() });
    await page.waitForTimeout(observeMs);
    if (reload) {
      const again = await page.reload({ waitUntil: "load", timeout: 30_000 }).catch((err) => err);
      observed.navigations.push(again instanceof Error ? { error: again.message.split("\n")[0] } : { status: again?.status() });
      await page.waitForTimeout(observeMs);
    }
    await ctx.close();
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }
  return { ...observed, blocked_hosts: [...observed.blocked_hosts] };
}

/** Everything the page produced, redacted before it is shown or saved. */
export function redactObserved(observed) {
  return {
    ...observed,
    console: observed.console.slice(0, 100).map((c) => ({ text: redactFreeText(c.text).text.slice(0, 600) })),
    network: observed.network.slice(0, 100).map((n) => ({ ...n, url: scrubUrl(n.url.split("?")[0]).slice(0, 300), failure: n.failure })),
  };
}

// ---- CLI ------------------------------------------------------------------------------------------

async function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
  const ticketId = opt("--ticket");
  const reportFile = opt("--report");
  if (!ticketId && !reportFile) {
    console.error("usage: OPERON_API_KEY=… node scripts/reproduce-ticket.mjs (--ticket tkt_… | --report file.json) --allow-host HOST");
    return 2;
  }
  let ticket;
  if (reportFile) {
    ticket = JSON.parse(readFileSync(reportFile, "utf-8"));
  } else {
    if (!/^tkt_[0-9a-f]{1,32}$/.test(ticketId)) throw new Error("--ticket must look like tkt_<hex>");
    const backend = (opt("--backend") ?? process.env.OPERON_BACKEND_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "");
    const key = process.env.OPERON_API_KEY ?? "";
    const res = await fetch(`${backend}/api/tickets/${ticketId}`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!res.ok) throw new Error(`Could not read the ticket (HTTP ${res.status}).`);
    ticket = await res.json();
  }
  const report = ticket.report ?? ticket;
  const plan = planFromReport(report, { allowHosts: all("--allow-host") });
  const require = createRequire(path.join(ROOT, "extension", "package.json"));
  const { chromium } = require("playwright-core");
  console.log(`sandbox: ${plan.url}  (allowed hosts: ${plan.allowedHosts.join(", ")})`);
  const observed = redactObserved(
    await runSandbox(plan, {
      observeMs: Number(opt("--observe-ms") ?? 5000),
      reload: argv.includes("--reload"),
      recreateStorage: argv.includes("--recreate-storage"),
      headed: argv.includes("--headed"),
      chromium,
    }),
  );
  const result = compare(plan.expect, observed);
  const out = {
    ticket_id: ticket.ticket_id ?? null,
    session_id: report.session_id ?? null,
    url: plan.url,
    at: new Date().toISOString(),
    options: { reload: argv.includes("--reload"), recreate_storage: argv.includes("--recreate-storage") },
    ...result,
    observed,
  };
  const file = opt("--out") ?? path.join(ROOT, ".local", "repro", `${ticket.ticket_id ?? "report"}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\n${result.verdict.toUpperCase()}: ${result.explanation}`);
  for (const m of result.matches) console.log(`  ${m.reproduced ? "reproduced    " : "not reproduced"}  ${m.kind}  ${m.reported.slice(0, 120)}`);
  if (observed.blocked_hosts.length) console.log(`  (sandbox blocked requests to: ${observed.blocked_hosts.join(", ")})`);
  console.log(`\nfull result: ${path.relative(process.cwd(), file)}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`reproduce-ticket: ${err.message}`);
      process.exit(1);
    },
  );
}
