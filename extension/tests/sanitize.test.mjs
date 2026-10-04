// Client-side credential redaction (src/lib/sanitize.ts): what the extension
// uploads is redacted before it leaves the browser, mirroring the backend
// tripwire, so a token on a real page doesn't get the whole cycle rejected.
// Secret-shaped fixtures are assembled at runtime; none is a real credential.
import assert from "node:assert/strict";
import test from "node:test";

import { bundle, createWorld, evidenceRequest, session } from "./helpers.mjs";

const j = (...parts) => parts.join("");
const ALNUM = "A1b2C3d4E5f6G7h8J9k0";
const HEX40 = "3f786850e387550fdab836ed7e6dc881de23001b";

const { redactText, redactDeep } = await import(
  `data:text/javascript;base64,${Buffer.from(await bundle("src/lib/sanitize.ts")).toString("base64")}`
);

const SECRETS = [
  ["jwt", j("ey", "JhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxMjM0NTYifQ.", "c2lnbmF0dXJlLXZhbHVl"), "c2lnbmF0dXJlLXZhbHVl"],
  ["bearer", j("Authorization: Bea", "rer ", ALNUM, "xyz"), ALNUM],
  ["escaped json field", j('{\\"access', '_token\\": \\"', "at-", ALNUM, '\\"}'), "at-" + ALNUM],
  ["github token", j("gh", "p_", ALNUM, ALNUM), ALNUM + ALNUM],
  ["groq key", j("gs", "k_", ALNUM, ALNUM), ALNUM + ALNUM],
  ["aws key id", j("AK", "IA", "IOSFODNN7EXAMPL0"), "IOSFODNN7EXAMPL0"],
  ["pem header", j("-----BEGIN ", "PRIVATE", " KEY-----"), "PRIVATE KEY"],
  ["url userinfo", j("postgres", "ql://app:", "s3cr3tPassw0rd", "@db:5432/app"), "s3cr3tPassw0rd"],
  ["signed url query", j("https://cdn.example.com/a.js?sig", "nature=", ALNUM), ALNUM],
  ["fragment token", j("https://app.example.com/cb#access", "_token=", ALNUM), ALNUM],
  ["password assignment", j("pass", "word=", "Hunter2Hunter2"), "Hunter2Hunter2"],
  ["cookie header", j("Coo", "kie: ", "_gh_sess=", "abc123DEF456ghi789"), "abc123DEF456ghi789"],
  ["hex in query", j("https://github.com/o/r?tok", "en=", HEX40), HEX40],
];

const BENIGN = [
  "password: required",
  `HEAD is at ${HEX40}`,
  `uses: actions/checkout@${HEX40}`,
  `https://github.com/octo/repo/commit/${HEX40}`,
  "GET https://collector.github.com/telemetry -> 0 net::ERR_BLOCKED_BY_CLIENT",
  "SyntaxError: Unexpected token in JSON while parsing cached config",
  "This site uses cookies.",
];

for (const [kind, secret, raw] of SECRETS) {
  test(`redacts ${kind}`, () => {
    const out = redactText(`console said ${secret} then stopped`);
    assert.ok(!out.text.includes(raw), out.text);
    assert.ok(out.rules.length > 0);
    assert.ok(out.text.startsWith("console said "));
  });
}

test("leaves look-alikes untouched", () => {
  for (const text of BENIGN) assert.deepEqual(redactText(text), { text, rules: [] }, text);
});

test("redactDeep walks nested objects and arrays without touching non-strings", () => {
  const input = { a: [{ text: SECRETS[4][1], n: 3 }], b: true, c: null };
  const { value, rules } = redactDeep(input);
  assert.deepEqual(rules, ["api_key"]);
  assert.equal(value.a[0].n, 3);
  assert.equal(value.b, true);
  assert.equal(value.c, null);
  assert.equal(input.a[0].text, SECRETS[4][1], "input is not mutated");
});

test("collected evidence is redacted before upload and says so", async () => {
  const token = SECRETS[3][1];
  const world = await createWorld({
    content: (msg, w) => {
      if (msg.type !== "CHECK_STORAGE") return {};
      w.consoleError(`auth failed for ${token}`);
      w.failedRequest(j("https://api.example.com/x?access", "_token=", ALNUM), 401);
      return { storage: [] };
    },
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["console", "network", "storage"] }) });
      if (path.endsWith("/investigate")) return { diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) };
      return { status: 500, body: {} };
    },
  }).load();
  world.connect().send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => world.calls("/investigate").length === 1, "investigate call");
  const sent = world.calls("/investigate")[0].body.bundle;
  const wire = JSON.stringify(sent);
  assert.ok(!wire.includes(SECRETS[3][2]) && !wire.includes(`=${ALNUM}`), wire);
  assert.match(sent.console[0].text, /^auth failed for \[REDACTED:github_token\]$/);
  assert.deepEqual([...sent.redaction_applied].sort(), ["github_token", "url_query_credential"]);
});

test("a bundle with nothing secret reports no redaction", async () => {
  const world = await createWorld({
    content: (msg, w) => {
      if (msg.type === "CHECK_STORAGE") w.consoleError("SyntaxError: bad JSON");
      return { storage: [] };
    },
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["console", "storage"] }) });
      if (path.endsWith("/investigate")) return { diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) };
      return { status: 500, body: {} };
    },
  }).load();
  world.connect().send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => world.calls("/investigate").length === 1, "investigate call");
  const sent = world.calls("/investigate")[0].body.bundle;
  assert.deepEqual(sent.redaction_applied, []);
  assert.equal(sent.console[0].text, "SyntaxError: bad JSON");
});
