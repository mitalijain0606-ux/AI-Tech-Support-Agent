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
export async function startBuggyCloud({ port = 0, host = "127.0.0.1", operon = null } = {}) {
  let reportsOrigin = "";
  let appOrigin = "";

  const reportsServer = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/api/reports") return json(res, 404, { error: "not found" });
    // Bug 6: no Access-Control-Allow-Origin, so the browser blocks the response.
    const cors = bugOf(url) === 6 ? {} : { "access-control-allow-origin": appOrigin };
    json(res, 200, { reports: REPORTS }, cors);
  });

  const appServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const bug = bugOf(url);
    if (url.pathname === "/api/projects") return bug === 4 ? json(res, 500, { error: "internal error" }) : json(res, 200, { projects: PROJECTS });
    if (url.pathname === "/operon-config.json") return operon ? json(res, 200, operon) : json(res, 404, { error: "Operon is not configured" });
    if (url.pathname === "/api/me") return bug === 5 ? json(res, 401, { error: "session expired" }) : json(res, 200, ACCOUNT);

    const file =
      url.pathname === "/" ? path.join(HERE, "index.html")
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

  await new Promise((r) => reportsServer.listen(port ? port + 1 : 0, host, r));
  reportsOrigin = `http://${host}:${reportsServer.address().port}`;
  await new Promise((r) => appServer.listen(port, host, r));
  appOrigin = `http://${host}:${appServer.address().port}`;
  return {
    url: appOrigin,
    reportsUrl: reportsOrigin,
    close: () => Promise.all([new Promise((r) => appServer.close(r)), new Promise((r) => reportsServer.close(r))]),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startBuggyCloud({ port: Number(process.argv[2] ?? 4300) });
  console.log(`Buggy Cloud on ${app.url}  (add ?bug=1..7)   reports API on ${app.reportsUrl}`);
}
