// Buggy Cloud's server: static files, a mock API on the app's origin, and a
// second "reports" API on another origin that sends no CORS headers unless the
// bug is off. Deterministic; keeps no state.
//
//   node server.mjs [port]        # app on port (default 4300), reports API on port+1
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT, PROJECTS, REPORTS } from "./src/mock-data.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(HERE, "../sdk");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};
const bugOf = (url) => Number(url.searchParams.get("bug") || 0);

/**
 * `operon` ({ backendUrl, token }) is for LOCAL TESTING ONLY: it makes the server hand the page
 * a ready-made Operon token at /operon-config.json. A real site mints a short-lived token in its
 * own backend and never puts a long-lived key in a page.
 */
/** The "reports" API, which must live on a different origin from the app (bug 6 is a CORS fault). */
function reportsHandler(getAppOrigin) {
  return (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/health") return json(res, 200, { status: "ok" });
    if (url.pathname !== "/api/reports") return json(res, 404, { error: "not found" });
    // Bug 6: no Access-Control-Allow-Origin, so the browser blocks the response.
    const cors = bugOf(url) === 6 ? {} : { "access-control-allow-origin": getAppOrigin() };
    json(res, 200, { reports: REPORTS }, cors);
  };
}

/** Hosted mode: the reports API alone, as its own service (it needs its own origin). */
export async function startReportsApi({ port = 0, host = "127.0.0.1", appOrigin }) {
  const server = createServer(reportsHandler(() => appOrigin));
  await new Promise((r) => server.listen(port, host, r));
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * `reportsUrl` (hosted mode): the public origin of a separately running reports API; when it is
 * set, no local reports server is started.
 */
export async function startBuggyCloud({ port = 0, host = "127.0.0.1", operon = null, reportsUrl = null } = {}) {
  let reportsOrigin = reportsUrl ?? "";
  let appOrigin = "";

  const reportsServer = reportsUrl ? null : createServer(reportsHandler(() => appOrigin));

  const appServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const bug = bugOf(url);
    if (url.pathname === "/api/projects") return bug === 4 ? json(res, 500, { error: "internal error" }) : json(res, 200, { projects: PROJECTS });
    // Not configured is an expected answer, not a failure: 204, so the page's optional check never
    // shows up as a failed request (Operon would otherwise see a 404 it did not cause).
    if (url.pathname === "/operon-config.json") {
      if (operon) return json(res, 200, operon);
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    if (url.pathname === "/health") return json(res, 200, { status: "ok" });
    if (url.pathname === "/api/me") return bug === 5 ? json(res, 401, { error: "session expired" }) : json(res, 200, ACCOUNT);

    const file =
      url.pathname === "/" ? path.join(HERE, "index.html")
      : url.pathname === "/demo" ? path.join(HERE, "demo.html")
      : url.pathname.startsWith("/sdk/dist/") ? path.join(SDK, "dist", path.basename(url.pathname))
      : url.pathname.startsWith("/sdk/examples/") ? path.join(SDK, "examples", path.basename(url.pathname))
      : url.pathname.startsWith("/sdk/") ? path.join(SDK, path.basename(url.pathname))
      : url.pathname === "/sw.js" ? path.join(HERE, "sw.js")
      : url.pathname.startsWith("/src/") ? path.join(HERE, "src", path.basename(url.pathname))
      : null;
    if (!file) return json(res, 404, { error: "not found" });
    try {
      let body = await readFile(file, "utf-8");
      if (file.endsWith("index.html")) body = body.replace("__REPORTS_API__", reportsOrigin);
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "text/plain", "cache-control": "no-store" });
      res.end(body);
    } catch {
      json(res, 404, { error: "not found" });
    }
  });

  if (reportsServer) {
    await new Promise((r) => reportsServer.listen(port ? port + 1 : 0, host, r));
    reportsOrigin = `http://${host}:${reportsServer.address().port}`;
  }
  await new Promise((r) => appServer.listen(port, host, r));
  appOrigin = `http://${host}:${appServer.address().port}`;
  return {
    url: appOrigin,
    reportsUrl: reportsOrigin,
    close: () => Promise.all([new Promise((r) => appServer.close(r)), reportsServer && new Promise((r) => reportsServer.close(r))]),
  };
}

/**
 * Hosted mode (Render sets PORT). Two services run this file:
 *   NEXADESK_MODE=reports  APP_ORIGIN=https://<nexadesk host>          → the reports API only
 *   (default)              REPORTS_API_URL=https://<reports host>      → the app
 *                          OPERON_BACKEND_URL + OPERON_DEMO_TOKEN      → optional: shows the support widget.
 * The demo token is handed to every visitor, so use a short-lived user key of a demo-only tenant.
 */
export function hostedConfig(env) {
  const origin = (name) => {
    const raw = env[name];
    if (!raw) return null;
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error(`${name} must be https`);
    return u.origin;
  };
  const port = Number(env.PORT);
  if (env.NEXADESK_MODE === "reports") {
    const appOrigin = origin("APP_ORIGIN");
    if (!appOrigin) throw new Error("APP_ORIGIN is required for the reports API");
    return { mode: "reports", port, appOrigin };
  }
  const reportsUrl = origin("REPORTS_API_URL");
  if (!reportsUrl) throw new Error("REPORTS_API_URL is required in hosted mode");
  const backendUrl = origin("OPERON_BACKEND_URL");
  const token = env.OPERON_DEMO_TOKEN || null;
  return { mode: "app", port, reportsUrl, operon: backendUrl && token ? { backendUrl, token } : null };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.PORT) {
    const cfg = hostedConfig(process.env);
    if (cfg.mode === "reports") {
      await startReportsApi({ port: cfg.port, host: "0.0.0.0", appOrigin: cfg.appOrigin });
      console.log(`NexaDesk reports API on :${cfg.port} (CORS for ${cfg.appOrigin})`);
    } else {
      await startBuggyCloud({ port: cfg.port, host: "0.0.0.0", reportsUrl: cfg.reportsUrl, operon: cfg.operon });
      console.log(`NexaDesk on :${cfg.port} · reports API ${cfg.reportsUrl} · support widget ${cfg.operon ? `→ ${cfg.operon.backendUrl}` : "off"}`);
    }
  } else {
    const app = await startBuggyCloud({ port: Number(process.argv[2] ?? 4300) });
    console.log(`Buggy Cloud on ${app.url}  (add ?bug=1..7)   reports API on ${app.reportsUrl}`);
  }
}
