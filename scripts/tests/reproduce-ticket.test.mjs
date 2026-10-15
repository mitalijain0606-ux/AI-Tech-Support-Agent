// The sandbox-reproduction tool's own logic: what it agrees to open, and how it compares.
//   node --test scripts/tests/
import assert from "node:assert/strict";
import test from "node:test";
import { compare, planFromReport, redactObserved } from "../reproduce-ticket.mjs";

const report = (url, items = {}) => ({ session_id: "s", evidence: [{ url, items }] });
const LOCAL = { allowHosts: ["localhost"] };

test("opens only http(s) pages on an allowed host, without credentials or a query string", () => {
  assert.equal(planFromReport(report("http://127.0.0.1:4300/app"), { allowHosts: ["127.0.0.1"] }).url, "http://127.0.0.1:4300/app");
  // a ticket's URL is customer-supplied: even localhost must be allowed explicitly
  assert.throws(() => planFromReport(report("http://127.0.0.1:6379/")), /not allowed/);
  assert.throws(() => planFromReport(report("http://localhost:8000/")), /not allowed/);
  assert.equal(planFromReport(report("https://github.com/o/r?x=1#y"), { allowHosts: ["github.com"] }).url, "https://github.com/o/r");
  assert.throws(() => planFromReport(report("https://github.com/o/r")), /not allowed/);
  assert.throws(() => planFromReport(report("https://evil.example/")), /not allowed/);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,hi"]) {
    assert.throws(() => planFromReport(report(bad), { allowHosts: ["etc"] }), /Refusing|not a valid/, bad);
  }
  assert.throws(() => planFromReport(report("http://user:pw@localhost/"), { allowHosts: ["localhost"] }), /credentials/);
  assert.throws(() => planFromReport({ evidence: [] }), /no page URL/);
});

test("the plan looks for the reported errors, failed requests and corrupted keys only", () => {
  const plan = planFromReport(report("http://localhost/x", {
    console: [{ id: "ev_1", level: "error", text: "TypeError: a is undefined" }, { id: "ev_2", level: "warn", text: "deprecated" }],
    network: [{ id: "ev_3", url: "http://localhost/api/data", status: 500 }, { id: "ev_4", url: "http://localhost/ok", status: 200 }],
    storage: [{ id: "ev_5", key: "cfg", present: true, parse_status: "syntax_error" }, { id: "ev_6", key: "ok", present: true, parse_status: "valid_json" }],
  }), LOCAL);
  assert.deepEqual(plan.expect.console.map((c) => c.id), ["ev_1"]);
  assert.deepEqual(plan.expect.network.map((n) => n.id), ["ev_3"]);
  assert.deepEqual(plan.expect.storage.map((s) => s.key), ["cfg"]);
});

test("comparison: reproduced, partial, not reproduced, nothing to compare", () => {
  const plan = planFromReport(report("http://localhost/x", {
    console: [{ id: "ev_1", level: "error", text: "Uncaught TypeError: a is undefined at http://localhost/app.js:12:5" }],
    network: [{ id: "ev_3", url: "http://localhost/api/data", status: 500 }],
  }), LOCAL);
  const both = compare(plan.expect, { console: [{ text: "Uncaught TypeError: a is undefined at http://localhost/app.js:14:9" }], network: [{ url: "http://localhost/api/data?t=1", status: 500 }] });
  assert.equal(both.verdict, "reproduced");
  assert.equal(compare(plan.expect, { console: [], network: [{ url: "http://localhost/api/data", status: 500 }] }).verdict, "partially_reproduced");
  assert.equal(compare(plan.expect, { console: [], network: [{ url: "http://localhost/api/data", status: 502 }] }).verdict, "not_reproduced");
  const parser = planFromReport(report("http://localhost/x", { console: [{ id: "ev_9", level: "error", text: "SyntaxError: app_cfg is corrupted: Unexpected token o in JSON at position 1" }] }), LOCAL);
  assert.equal(compare(parser.expect, { console: [{ text: "SyntaxError: app_cfg is corrupted: Expected property name in JSON at position 1" }], network: [] }).verdict, "reproduced");
  assert.equal(compare(parser.expect, { console: [{ text: "TypeError: something else entirely" }], network: [] }).verdict, "not_reproduced");
  assert.equal(compare({ console: [], network: [] }, { console: [], network: [] }).verdict, "nothing_to_compare");
});

test("what the page produced is redacted before it is shown or saved", () => {
  const secret = ["gh", "p_", "A1b2C3d4E5f6G7h8J9k0", "A1b2C3d4E5f6G7h8J9k0"].join("");
  const out = redactObserved({ console: [{ text: `token ${secret}` }], network: [{ url: `http://localhost/api?token=${secret}`, status: 401 }], blocked_hosts: [], navigations: [] });
  assert.ok(!JSON.stringify(out).includes(secret));
  assert.match(out.console[0].text, /\[REDACTED:/);
  assert.equal(out.network[0].url, "http://localhost/api");
});
