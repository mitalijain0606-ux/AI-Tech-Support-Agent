// Shared plumbing for the browser E2E suites: a real backend process, a local
// fixture site, the actual built extension loaded into Chromium, and a small
// PASS/FAIL recorder. Nothing here needs credentials.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const REPO_ROOT = path.resolve(EXTENSION_ROOT, "..");
const FIXTURES = path.join(EXTENSION_ROOT, "e2e/fixtures");

// ---- results -----------------------------------------------------------------------------

export function recorder() {
  const results = [];
  return {
    results,
    check(name, cond, extra = "") {
      extra = String(extra ?? "").replace(/\s+/g, " ").slice(0, 300);
      results.push({ ok: Boolean(cond), name, extra });
      console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
      return Boolean(cond);
    },
    summary() {
      const failed = results.filter((r) => !r.ok);
      console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
      for (const f of failed) console.log(`  FAILED: ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
      return failed.length === 0;
    },
  };
}

// ---- processes -----------------------------------------------------------------------------

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (${last.message})` : ""}`);
}

/**
 * Starts the real FastAPI backend (uvicorn) on a free port with a throwaway
 * SQLite database. GROQ_API_KEY is forced empty so the labelled offline
 * engine diagnoses: the suite is deterministic and needs no credentials.
 */
export async function startBackend({ python = process.env.OPERON_E2E_PYTHON || "python3" } = {}) {
  const port = await freePort();
  const dir = mkdtempSync(path.join(os.tmpdir(), "operon-e2e-db-"));
  const dbPath = path.join(dir, "e2e.db");
  const logs = [];
  const proc = spawn(python, ["-m", "uvicorn", "operon_backend.main:app", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: path.join(REPO_ROOT, "backend"),
    env: { ...process.env, DATABASE_URL: `sqlite:///${dbPath}`, GROQ_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(String(d)));
  proc.stderr.on("data", (d) => logs.push(String(d)));
  const url = `http://localhost:${port}`;
  try {
    await waitFor(async () => (await fetch(`${url}/health`)).ok, "backend /health", 60_000);
  } catch (err) {
    proc.kill();
    throw new Error(`${err.message}\n--- backend log ---\n${logs.join("").slice(-3000)}`);
  }
  return {
    url,
    dbPath,
    logs,
    api: async (method, p, body) => {
      const res = await fetch(`${url}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      let json = null;
      try {
        json = await res.json();
      } catch {}
      return { status: res.status, body: json };
    },
    session: async (id) => (await fetch(`${url}/api/sessions/${id}`)).json(),
    dbBytes: () => (existsSync(dbPath) ? readFileSync(dbPath).toString("latin1") : ""),
    /** The evidence bundles stored for a session, read straight from the database. */
    storedEvidence: (sessionId) =>
      JSON.parse(
        execFileSync(python, ["-c", STORED_EVIDENCE_PY, dbPath, sessionId], { encoding: "utf-8" }) || "[]",
      ),
    stop: () => {
      proc.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const STORED_EVIDENCE_PY = `
import json, sqlite3, sys
row = sqlite3.connect(sys.argv[1]).execute("select collected_evidence from sessions where id = ?", (sys.argv[2],)).fetchone()
print(json.dumps([r.get("bundle", r) for r in json.loads(row[0] or "[]")] if row else []))
`;

/** Serves e2e/fixtures on 127.0.0.1 (the e2e-local target's match). */
export async function startFixtureSite() {
  const port = await freePort();
  const types = { ".html": "text/html", ".js": "text/javascript" };
  const server = createServer((req, res) => {
    const name = path.basename(new URL(req.url, "http://x").pathname) || "clean.html";
    const file = path.join(FIXTURES, name);
    if (!existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": types[path.extname(name)] ?? "text/plain", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
}

/** Builds the actual extension for `target`, pointed at `backendUrl`. */
export function buildExtension(target, backendUrl) {
  execFileSync(process.execPath, [path.join(EXTENSION_ROOT, "scripts/build.mjs"), target], {
    cwd: EXTENSION_ROOT,
    env: { ...process.env, OPERON_BACKEND_URL: backendUrl },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return path.join(EXTENSION_ROOT, "dist", target);
}

// ---- browser ---------------------------------------------------------------------------------

/**
 * Launches Chromium with only the built extension loaded. Headless by default
 * (new headless mode runs MV3 extensions); OPERON_E2E_HEADED=1 shows it.
 * Browser console errors, page errors and service-worker errors are captured.
 */
export async function launchWithExtension(extPath, { args = [] } = {}) {
  const profile = mkdtempSync(path.join(os.tmpdir(), "operon-e2e-profile-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: process.env.OPERON_E2E_HEADED !== "1",
    executablePath: process.env.OPERON_E2E_CHROMIUM || undefined,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, ...args],
  });
  const browserErrors = [];
  const watchPage = (page) => {
    page.on("pageerror", (err) => browserErrors.push({ where: page.url(), kind: "pageerror", text: err.message }));
    page.on("console", (msg) => {
      if (msg.type() === "error") browserErrors.push({ where: page.url(), kind: "console", text: msg.text() });
    });
  };
  ctx.on("page", watchPage);
  const watchWorker = (w) => {
    w.on("console", (msg) => {
      if (msg.type() === "error") browserErrors.push({ where: "service-worker", kind: "console", text: msg.text() });
    });
  };
  // Track the live extension worker: after a restart, a new Worker object replaces the old one.
  // Fixture pages register service workers too; only chrome-extension:// ones are ours.
  const isExtension = (w) => w.url().startsWith("chrome-extension://");
  let current = ctx.serviceWorkers().find(isExtension) ?? null;
  ctx.on("serviceworker", (w) => {
    if (!isExtension(w)) return;
    watchWorker(w);
    current = w;
  });
  current ??= await ctx.waitForEvent("serviceworker", { predicate: isExtension, timeout: 20_000 });
  watchWorker(current);
  const extId = new URL(current.url()).host;
  return {
    ctx,
    extId,
    browserErrors,
    get sw() {
      return current;
    },
    close: async () => {
      await ctx.close();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

// ---- popup driving ---------------------------------------------------------------------------

/** Points the extension's "active tab" at `targetUrl` (the popup is opened as a tab, not over it). */
export async function pinActiveTab(sw, targetUrl) {
  await sw.evaluate(async (url) => {
    self.__origQuery ??= chrome.tabs.query.bind(chrome.tabs);
    const [t] = await self.__origQuery({ url });
    self.__target = t;
    chrome.tabs.query = async () => (self.__target ? [self.__target] : []);
  }, targetUrl);
}

export function popupDriver(popup) {
  return {
    page: popup,
    ask: async (message) => {
      await popup.fill("textarea", message);
      await popup.click('button:text-is("Ask Operon")');
    },
    click: (label) => popup.click(`button:text-is("${label}")`),
    waitPhase: (label, timeout = 45_000) => popup.locator("header", { hasText: label }).waitFor({ timeout }),
    text: () => popup.locator("body").innerText(),
  };
}

/** The extension's persisted UI state, read via the worker or any extension page (e.g. the popup). */
export async function extensionState(handle) {
  return handle.evaluate(async () => (await chrome.storage.session.get("operon_state")).operon_state?.state ?? null);
}

/** Runtime-assembled secret-shaped strings: no literal token lives in the repo. None is real. */
export const FAKE_SECRETS = {
  githubToken: ["gh", "p_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0"].join(""),
  groqKey: ["gs", "k_", "Z9y8X7w6V5u4T3s2R1q0", "Z9y8X7w6V5u4T3s2R1q0"].join(""),
};
