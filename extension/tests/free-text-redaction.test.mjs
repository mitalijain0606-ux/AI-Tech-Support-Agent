// Free text is redacted IN THE BROWSER before it is sent. Every assertion is on
// the serialized request the extension actually put on the wire (`world.requests`),
// not on a helper's return value. Secrets are assembled at runtime; none is real.
import assert from "node:assert/strict";
import test from "node:test";

import { awaitingApproval, createWorld, evidenceRequest, plan, session } from "./helpers.mjs";

const j = (...p) => p.join("");
const ALNUM = "A1b2C3d4E5f6G7h8J9k0";
const GH = j("gh", "p_", ALNUM, ALNUM);
const JWT = j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "dBjftJeZ4CVPmB92K27uhbUJU1p1r");
const SECRETS = [GH, JWT];

const wire = (world) => world.requests.map((r) => JSON.stringify(r.body ?? "")).join("\n");
const done = () => ({ diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) });

test("the issue text is redacted before the session is created, whatever the user pasted", async () => {
  const world = await createWorld({
    content: () => ({}),
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
      if (path.endsWith("/investigate")) return done();
      return { status: 404, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: `login broke. my token is ${GH} and the jwt is ${JWT}` });
  await world.until(() => popup.last()?.phase === "escalated", "done");
  const created = world.calls("/api/sessions").find((c) => c.method === "POST" || c.body?.user_issue);
  assert.ok(created.body.user_issue.includes("login broke"), "the useful words survive");
  assert.match(created.body.user_issue, /\[REDACTED:/);
  for (const secret of SECRETS) assert.ok(!wire(world).includes(secret), "no secret appears in any request body");
});

test("the answer to a question is redacted before it is sent", async () => {
  const req = evidenceRequest({ collectors: ["console"], question: "What did you click last?" });
  const asking = session("NEED_INFORMATION", { evidence_request: req });
  const world = await createWorld({
    initialStorage: { operon_state: { state: { phase: "needs_more_evidence", session: asking, diagnosis: null }, nextEvidenceId: 10 } },
    backend: (method, path) => (path.endsWith("/answer") ? asking : { status: 404, body: {} }),
  }).load();
  const popup = world.connect();
  popup.send({ type: "ANSWER", text: `I pasted ${GH} into the box, then ${JWT}` });
  await world.until(() => world.calls("/answer").length === 1, "answer call");
  const { answer } = world.calls("/answer")[0].body;
  assert.ok(answer.startsWith("I pasted"));
  assert.match(answer, /\[REDACTED:/);
  for (const secret of SECRETS) assert.ok(!wire(world).includes(secret));
});

test("redaction happens before truncation, so a secret near the limit is not cut into an unrecognisable fragment", async () => {
  const req = evidenceRequest({ collectors: ["console"], question: "q?" });
  const asking = session("NEED_INFORMATION", { evidence_request: req });
  const world = await createWorld({
    initialStorage: { operon_state: { state: { phase: "needs_more_evidence", session: asking, diagnosis: null }, nextEvidenceId: 10 } },
    backend: (method, path) => (path.endsWith("/answer") ? asking : { status: 404, body: {} }),
  }).load();
  const popup = world.connect();
  popup.send({ type: "ANSWER", text: `${"x".repeat(980)} ${GH}` });
  await world.until(() => world.calls("/answer").length === 1, "answer call");
  const { answer } = world.calls("/answer")[0].body;
  assert.ok(answer.length <= 1000);
  assert.ok(!answer.includes(GH.slice(0, 20)), "not even the front of the token is sent");
});

test("an outcome string supplied by the page's own code is redacted before it is reported", async () => {
  const pending = plan("reset_user_preference", { parameters: { preference: "timezone" } });
  const world = await createWorld({
    initialStorage: awaitingApproval(pending),
    debuggerAvailable: false,
    content: (msg) => (msg.type === "INVOKE_APP_ACTION" ? { app_result: { ok: false, detail: `handler failed, auth=${GH}` } } : {}),
    backend: (method, path) => {
      if (path.endsWith("/approve")) return session("EXECUTING", { pending_action: pending });
      if (path.endsWith("/action-result")) return session("NEED_INFORMATION", { pending_action: pending });
      return { status: 500, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  await world.until(() => world.calls("/action-result").length === 1, "action result");
  const { detail } = world.calls("/action-result")[0].body;
  assert.match(detail, /handler failed/);
  assert.ok(!wire(world).includes(GH));
});

test("ordinary text is not mangled", async () => {
  const world = await createWorld({
    content: () => ({}),
    backend: (method, path) => (path === "/api/sessions" ? session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) }) : done()),
  }).load();
  const popup = world.connect();
  const text = "The dashboard shows commit 4f3a9c1d2b7e (a Git SHA) and a 500 error at /api/projects";
  popup.send({ type: "ASK_OPERON", message: text });
  await world.until(() => popup.last()?.phase === "escalated", "done");
  assert.equal(world.calls("/api/sessions")[0].body.user_issue, text);
});
