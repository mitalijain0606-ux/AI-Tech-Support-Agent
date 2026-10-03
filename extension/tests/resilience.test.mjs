// Backend errors, malformed responses, stale sessions, restarts: the
// extension must end in a clear state and never decide a phase itself.
import assert from "node:assert/strict";
import test from "node:test";

import { createWorld, evidenceRequest, plan, session } from "./helpers.mjs";

const createThen = (investigateResponse) => (method, path) => {
  if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
  if (path.endsWith("/investigate")) return investigateResponse;
  return { status: 500, body: {} };
};

async function ask(backend) {
  const world = createWorld({ backend });
  await world.load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "x" });
  await world.until(() => ["error", "escalated", "resolved", "needs_more_evidence", "awaiting_approval"].includes(popup.last()?.phase));
  return { world, popup };
}

test("malformed session in a response -> error state, nothing acted on", async () => {
  const { world, popup } = await ask(createThen({ diagnosis: null, session: { phase: "TOTALLY_MADE_UP" } }));
  assert.equal(popup.last().phase, "error");
  assert.match(popup.last().message, /malformed/);
  assert.equal(world.calls("/policy").length, 0);
});

test("non-JSON response -> error state", async () => {
  const { popup } = await ask(createThen({ status: 200, raw: "<html>gateway</html>" }));
  assert.equal(popup.last().phase, "error");
  assert.match(popup.last().message, /isn't JSON/);
});

test("backend unreachable -> clear error", async () => {
  const { popup } = await ask(() => new Error("connection refused"));
  assert.equal(popup.last().phase, "error");
  assert.match(popup.last().message, /Can't reach the Operon backend/);
});

test("backend rejection is shown with its reason", async () => {
  const { popup } = await ask(createThen({ status: 422, body: { detail: "Security Tripwire Triggered: jwt_token" } }));
  assert.equal(popup.last().phase, "error");
  assert.match(popup.last().message, /Tripwire/);
});

test("stale session (404) -> tells the user to reset", async () => {
  const world = createWorld({
    initialStorage: { operon_state: { state: { phase: "needs_more_evidence", session: session("NEED_INFORMATION", { evidence_request: evidenceRequest() }) }, nextEvidenceId: 3 } },
    backend: () => ({ status: 404, body: { detail: "No session" } }),
  });
  await world.load();
  const popup = world.connect();
  popup.send({ type: "INVESTIGATE_AGAIN" });
  await world.until(() => popup.last()?.phase === "error");
  assert.match(popup.last().message, /no longer exists/);
});

test("escalated session renders the backend's reason and guidance (diagnosis may be null)", async () => {
  const escalated = session("ESCALATED", {
    escalation_state: { reason: "Investigation halted: hard limit", resolution_state: "escalated_max_tool_calls_exceeded", guidance: "Check your ad blocker.", at: "t" },
  });
  const { popup } = await ask(createThen({ diagnosis: null, session: escalated }));
  assert.equal(popup.last().phase, "escalated");
  assert.match(popup.last().message, /hard limit[\s\S]*ad blocker/);
});

test("restart mid-EXECUTING: the backend is asked, and the step is closed honestly", async () => {
  const pending = plan("clear_storage_key");
  const world = createWorld({
    initialStorage: { operon_state: { state: { phase: "executing", session: session("EXECUTING", { pending_action: pending }) }, nextEvidenceId: 5 } },
    backend: (method, path, body) => {
      if (method === "GET") return session("EXECUTING", { pending_action: pending });
      if (path.endsWith("/action-result")) return session("NEED_INFORMATION", { pending_action: pending, evidence_request: evidenceRequest({ purpose: "retry", reason: "re-collecting" }) });
      return { status: 500, body: {} };
    },
  });
  await world.load();
  const popup = world.connect();
  await world.until(() => popup.last()?.phase === "needs_more_evidence");
  const [report] = world.calls("/action-result");
  assert.equal(report.body.succeeded, false);
  assert.match(report.body.detail, /interrupted/);
});

test("restart mid-VERIFYING: reported as an interrupted observation, not a pass", async () => {
  const pending = plan("reload");
  const world = createWorld({
    initialStorage: { operon_state: { state: { phase: "verifying", session: session("VERIFYING", { pending_action: pending }) }, nextEvidenceId: 5 } },
    backend: (method, path) => {
      if (method === "GET") return session("VERIFYING", { pending_action: pending });
      if (path.endsWith("/verify")) return session("NEED_INFORMATION", { evidence_request: evidenceRequest({ purpose: "retry" }) });
      return { status: 500, body: {} };
    },
  });
  await world.load();
  world.connect();
  await world.until(() => world.calls("/verify").length === 1);
  assert.equal(world.calls("/verify")[0].body.observation.error, "interrupted");
});

test("restart while idle at approval: backend state is re-rendered, nothing re-executed", async () => {
  const world = createWorld({
    initialStorage: { operon_state: { state: { phase: "awaiting_approval", session: session("WAITING_FOR_APPROVAL", { pending_action: plan("reload") }) }, nextEvidenceId: 5 } },
    backend: () => ({ status: 500, body: {} }),
  });
  await world.load();
  const popup = world.connect();
  await world.until(() => popup.received.length > 0);
  assert.equal(popup.last().phase, "awaiting_approval");
  assert.equal(world.requests.length, 0);
});
