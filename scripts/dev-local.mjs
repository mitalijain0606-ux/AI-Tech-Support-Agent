#!/usr/bin/env node
// One command that starts the whole local Operon project:
//
//   node scripts/dev-local.mjs            # backend :8000 + Buggy Cloud :4300 (reports API :4301)
//   node scripts/dev-local.mjs --fresh    # also wipe the local database and mint new keys
//   node scripts/dev-local.mjs --check    # start everything, verify it answers, then stop (exit 0/1)
//
// Options: --backend-port N  --app-port N  --groq (use GROQ_API_KEY from your environment)
//          --no-sdk-panel (serve Buggy Cloud without the SDK panel, to try the extension alone)
//          --no-build (skip building the SDK script and the extension)
//
// Environment: OPERON_PYTHON (default python3) must be able to import the backend's requirements
// (`cd backend && pip install -r requirements.txt`). Nothing here needs production credentials; the
// model is the offline engine unless you pass --groq. State lives in ./.local (git-ignored).
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = path.join(ROOT, "backend");
const STATE = path.join(ROOT, ".local");
const DB = path.join(STATE, "operon.db");
const TOKENS = path.join(STATE, "tokens.json");
const PIDS = path.join(STATE, "pids.json");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : Number(args[i + 1]);
};
const backendPort = opt("--backend-port", 8000);
const appPort = opt("--app-port", 4300);
const python = process.env.OPERON_PYTHON || "python3";
const useGroq = flag("--groq");
const say = (msg = "") => console.log(msg);
const die = (msg) => {
  console.error(`\nERROR: ${msg}\n`);
  process.exit(1);
};

// ---- 0. stale processes from an earlier run of this script ------------------------------------------------
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
// The command line of a running process: /proc on Linux, `ps` elsewhere (macOS has no /proc).
function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ");
  } catch {
    try {
      return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  }
}
if (existsSync(PIDS)) {
  const old = JSON.parse(readFileSync(PIDS, "utf-8"));
  for (const pid of [old.backend, old.launcher].filter(Boolean)) {
    // Only ever stop a process that is still OUR backend / launcher (the PID may have been reused).
    if (pid !== process.pid && alive(pid) && /operon_backend\.main:app|dev-local\.mjs/.test(cmdline(pid))) {
      say(`Stopping a stale Operon process from an earlier run (pid ${pid}).`);
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  rmSync(PIDS, { force: true });
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
for (const [what, port] of [["backend", backendPort], ["Buggy Cloud", appPort], ["Buggy Cloud reports API", appPort + 1]]) {
  for (let i = 0; i < 20 && !(await portFree(port)); i++) await new Promise((r) => setTimeout(r, 250)); // a just-stopped process may still be closing
  if (!(await portFree(port))) die(`port ${port} (${what}) is already in use. Stop whatever uses it, or pick other ports with --backend-port / --app-port.`);
}

// ---- 1. prerequisites -------------------------------------------------------------------------------------------
try {
  execFileSync(python, ["-c", "import uvicorn, fastapi, sqlalchemy, alembic, operon_backend"], { cwd: BACKEND, stdio: "pipe" });
} catch {
  die(`${python} cannot import the backend's dependencies.\n  Fix: cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt\n  then:  OPERON_PYTHON=$PWD/backend/.venv/bin/python node scripts/dev-local.mjs   (or activate the venv first)`);
}
if (useGroq && !process.env.GROQ_API_KEY) die("--groq needs GROQ_API_KEY in your environment (it is never written to disk or printed).");

// ---- 2. local database and keys ---------------------------------------------------------------------------------
mkdirSync(STATE, { recursive: true });
if (flag("--fresh")) {
  rmSync(DB, { force: true });
  rmSync(TOKENS, { force: true });
}
const dbUrl = `sqlite:///${DB}`;
const backendEnv = {
  ...process.env,
  DATABASE_URL: dbUrl,
  ENVIRONMENT: "development",
  AUTH_REQUIRED: "true", // authentication stays ON locally: the demo uses real keys
  CORS_ALLOW_ORIGINS: `http://127.0.0.1:${appPort}`, // exactly the demo site, nothing else
  GROQ_API_KEY: useGroq ? process.env.GROQ_API_KEY : "",
  LOG_FORMAT: "text",
};
const run = (file, fileArgs) => execFileSync(file, fileArgs, { cwd: BACKEND, env: backendEnv, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
say("Preparing the local database (alembic upgrade head) …");
run(python, ["-m", "alembic", "upgrade", "head"]);
const mint = (subject, role) => {
  const out = run(python, ["scripts/manage_keys.py", "create", "--tenant", "local", "--subject", subject, "--role", role]);
  return out.split("\n").find((l) => l.startsWith("token")).split(":")[1].trim();
};
let tokens;
if (existsSync(TOKENS)) tokens = JSON.parse(readFileSync(TOKENS, "utf-8"));
else {
  tokens = { user: mint("dev-user", "user"), admin: mint("dev-admin", "admin") };
  writeFileSync(TOKENS, JSON.stringify(tokens, null, 2));
  chmodSync(TOKENS, 0o600);
}

// ---- 3. builds ----------------------------------------------------------------------------------------------------
const backendUrl = `http://localhost:${backendPort}`;
if (!flag("--no-build")) {
  say("Building the SDK script (sdk/dist) and the extension (extension/dist/local-demo) …");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "sdk/scripts/build.mjs")], { stdio: "pipe" });
    execFileSync(process.execPath, [path.join(ROOT, "extension/scripts/build.mjs"), "local-demo"], { cwd: path.join(ROOT, "extension"), env: { ...process.env, OPERON_BACKEND_URL: backendUrl }, stdio: "pipe" });
  } catch (err) {
    die(`a build failed (${String(err.stderr || err.message).split("\n")[0]}).\n  Fix: cd extension && npm ci   (this installs esbuild), then run this again.`);
  }
}

// ---- 4. start the backend -----------------------------------------------------------------------------------------
say(`Starting the backend on ${backendUrl} (the first start indexes the knowledge base and may download the embedding model) …`);
const backend = spawn(python, ["-m", "uvicorn", "operon_backend.main:app", "--host", "127.0.0.1", "--port", String(backendPort)], { cwd: BACKEND, env: backendEnv, stdio: ["ignore", "pipe", "pipe"] });
const logs = [];
backend.stdout.on("data", (d) => logs.push(String(d)));
backend.stderr.on("data", (d) => logs.push(String(d)));
backend.on("exit", (code) => {
  if (!stopping) die(`the backend exited early (code ${code}).\n${logs.join("").slice(-2000)}`);
});
writeFileSync(PIDS, JSON.stringify({ backend: backend.pid, launcher: process.pid }));
let stopping = false;
const app = await import(pathToFileURL(path.join(ROOT, "buggy-cloud/server.mjs")).href);
let site;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  say("\nStopping …");
  try {
    await site?.close();
  } catch {}
  backend.kill("SIGTERM");
  rmSync(PIDS, { force: true });
  process.exit(code);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

async function waitFor(fn, label, ms = 300_000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await fn()) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  die(`timed out waiting for ${label}.\n${logs.join("").slice(-2000)}`);
}
await waitFor(async () => (await fetch(`${backendUrl}/health`)).ok, "the backend's /health");

// ---- 5. start Buggy Cloud ---------------------------------------------------------------------------------------------
site = await app.startBuggyCloud({ port: appPort, operon: flag("--no-sdk-panel") ? null : { backendUrl, token: tokens.user } });

// ---- 6. verify -----------------------------------------------------------------------------------------------------
const ready = await (await fetch(`${backendUrl}/ready`, { headers: { Authorization: `Bearer ${tokens.admin}` } })).json();
const noKey = await fetch(`${backendUrl}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const home = await fetch(`${site.url}/`);
const config = await fetch(`${site.url}/operon-config.json`);
const problems = [];
if (!["ready", "degraded"].includes(ready.status)) problems.push(`/ready says ${ready.status}`);
if (noKey.status !== 401) problems.push(`the backend answered ${noKey.status} (not 401) to a request without a key`);
if (!home.ok) problems.push("Buggy Cloud did not serve its home page");
if (!flag("--no-sdk-panel") && !config.ok) problems.push("Buggy Cloud did not serve /operon-config.json");

say(`
Operon is running locally.

  Backend        ${backendUrl}      health: ${backendUrl}/health   (detail: send the admin token to /ready)
  Buggy Cloud    ${site.url}/   scenarios: ?bug=1 … ?bug=7  (healthy control: no ?bug)  reset: add &reset=1
  SDK example    ${site.url}/sdk/examples/minimal.html
  Model          ${useGroq ? "Groq (GROQ_API_KEY from your environment)" : "offline rule-based engine (deterministic; set --groq for the real model)"}
  Database       ${DB}
  Your token     ${tokens.user}
  Admin token    ${tokens.admin}   (read-only diagnostics; keep it out of the extension)
  Knowledge base ${ready.checks?.knowledge_base?.curated_chunks ?? "?"} chunks · embeddings ${ready.checks?.embeddings?.loaded ? "loaded" : "not loaded yet"}

Chrome extension (desktop Chrome, once):
  1. chrome://extensions → turn on "Developer mode" → "Load unpacked" → choose  ${path.join(ROOT, "extension/dist/local-demo")}
  2. Open ${site.url}/?bug=2 in a tab, click the Operon toolbar icon, open "Backend access", paste your token.
  3. Press "Ask Operon". (After rebuilding, click the reload icon on chrome://extensions and reload the tab.)
`);
if (problems.length) {
  console.error(`Self-check FAILED: ${problems.join("; ")}`);
  await stop(1);
}
say("Self-check passed: /health, /ready (admin), 401 without a key, Buggy Cloud, Operon config.");
if (flag("--check")) await stop(0);
say("Press Ctrl+C to stop.");
