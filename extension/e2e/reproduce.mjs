// The sandbox-reproduction tool (scripts/reproduce-ticket.mjs) end to end: real backend, real
// escalation tickets, real headless Chromium against a small local site.
//
//   npm run e2e:reproduce
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recorder, startBackend } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { check, summary } = recorder();

// A site with one server-side failure and one failure that only exists in a user's browser state.
const site = createServer((req, res) => {
  const html = (body) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<!doctype html><title>t</title>${body}`); };
  if (req.url === "/broken") return html(`<img src="http://third-party.invalid/pixel.png"><script>fetch("/api/data"); console.error("TypeError: widgets is undefined");</script>`);
  if (req.url === "/client-state") return html(`<script>try { JSON.parse(localStorage.getItem("app_cfg") ?? "{}") } catch (e) { console.error("SyntaxError: app_cfg is corrupted: " + e.message) }</script>`);
  if (req.url === "/api/data") { res.writeHead(500, { "content-type": "application/json" }); return res.end("{}"); }
  res.writeHead(404); res.end();
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;
const backend = await startBackend();

async function escalatedTicket(url, items, capabilities = ["inspect_page", "console_errors", "network_requests", "reload"]) {
  const s = await backend.api("POST", "/api/sessions", { user_issue: "the page is broken", provider_capabilities: capabilities });
  const r = await backend.api("POST", `/api/sessions/${s.body.session_id}/investigate`, { bundle: { url, timestamp: 1, request_id: s.body.evidence_request.request_id, ...items } });
  let session = r.body.session;
  if (session.phase === "ACTION_PROPOSED") session = (await backend.api("POST", `/api/sessions/${session.session_id}/policy`, {})).body.session;
  return session.escalation_state?.ticket_id;
}

function tool(args, key = backend.tokens.admin, extra = ["--allow-host", "127.0.0.1"]) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "scripts/reproduce-ticket.mjs"), ...args, "--backend", backend.url, "--observe-ms", "1500", ...extra], {
      env: { ...process.env, OPERON_API_KEY: key }, encoding: "utf-8", timeout: 120_000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr }));
  });
}
const outFile = (name) => path.join(os.tmpdir(), `operon-repro-${process.pid}-${name}.json`);

try {
  // 1. A server-side failure reproduces in a clean browser.
  const server = await escalatedTicket(`${SITE}/broken`, {
    console: [{ id: "ev_c1", level: "error", text: "TypeError: widgets is undefined" }],
    network: [{ id: "ev_n1", method: "GET", url: `${SITE}/api/data`, status: 500, status_text: "Internal Server Error" }],
  });
  check("a server-side failure escalates to a ticket", /^tkt_/.test(server ?? ""), server);
  const a = await tool(["--ticket", server, "--out", outFile("a")]);
  const ra = JSON.parse(readFileSync(outFile("a"), "utf-8"));
  check("it reproduces in the sandbox", a.code === 0 && ra.verdict === "reproduced", `${ra.verdict} ${a.out.slice(-300)}`);
  check("requests to other hosts were blocked inside the sandbox", ra.observed.blocked_hosts.includes("third-party.invalid"), JSON.stringify(ra.observed.blocked_hosts));
  check("the API key appears in neither the output nor the saved result", !a.out.includes(backend.tokens.admin) && !JSON.stringify(ra).includes(backend.tokens.admin));

  // 2. A client-state failure does not reproduce in a clean browser — unless its shape is recreated.
  const client = await escalatedTicket(`${SITE}/client-state`, {
    console: [{ id: "ev_c2", level: "error", text: "SyntaxError: app_cfg is corrupted: Unexpected token o in JSON at position 1" }],
    storage: [{ id: "ev_s2", key: "app_cfg", present: true, parse_status: "syntax_error", error_message: "Unexpected token" }],
  });
  check("a client-state failure (fix denied by policy) escalates to a ticket", /^tkt_/.test(client ?? ""), client);
  const b = await tool(["--ticket", client, "--out", outFile("b")]);
  check("in a clean browser it does not reproduce, and the tool says so", JSON.parse(readFileSync(outFile("b"), "utf-8")).verdict === "not_reproduced", b.out.slice(-200));
  const c = await tool(["--ticket", client, "--recreate-storage", "--out", outFile("c")]);
  const rc = JSON.parse(readFileSync(outFile("c"), "utf-8"));
  check("with --recreate-storage (a synthetic invalid value) it reproduces", rc.verdict === "reproduced", c.out.slice(-200));

  // 3. Safety.
  const g = await tool(["--ticket", server, "--out", outFile("g")], backend.tokens.admin, []);
  check("even localhost must be allowed explicitly (a ticket's URL is customer-supplied)", g.code !== 0 && /not allowed/.test(g.out), g.out.slice(-200));
  const remote = await escalatedTicket("https://github.com/octocat/Hello-World", { network: [{ id: "ev_n9", method: "GET", url: "https://github.com/api/x", status: 503 }] });
  const d = await tool(["--ticket", remote, "--out", outFile("d")]);
  check("a host that is not explicitly allowed is refused", d.code !== 0 && /not allowed/.test(d.out), d.out.slice(-200));
  const e = await tool(["--ticket", server, "--out", outFile("e")], backend.tokens.other);
  check("another tenant's key cannot read the ticket", e.code !== 0 && /HTTP 404/.test(e.out), e.out.slice(-200));
  const f = await tool(["--ticket", "../../etc/passwd"]);
  check("a malformed ticket id is refused before any request", f.code !== 0 && /must look like/.test(f.out));
} catch (err) {
  check("reproduce test completed without exception", false, err.message.split("\n")[0]);
}

for (const name of ["a", "b", "c", "d", "e", "g"]) rmSync(outFile(name), { force: true });
backend.stop();
site.close();
process.exit(summary() ? 0 : 1);
