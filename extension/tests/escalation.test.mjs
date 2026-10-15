// An escalation names the ticket the support team received — and only a well-formed one.
import assert from "node:assert/strict";
import test from "node:test";

import { createWorld, evidenceRequest, session } from "./helpers.mjs";

async function escalateWith(escalation) {
  const world = await createWorld({
    content: (msg) => (msg.type === "INSPECT_PAGE" ? { page: { url_path: "/", title: "t", ready_state: "complete", service_worker_controlled: false, service_worker_scopes: [], selector: null, selector_matches: null } } : { storage: [] }),
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
      if (path.endsWith("/investigate")) return { diagnosis: null, session: session("ESCALATED", { escalation_state: { resolution_state: "escalated_no_action_available", guidance: null, at: "t", ...escalation } }) };
      return { status: 500, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => popup.last()?.phase === "escalated", "escalated");
  return popup.last().message;
}

test("the escalation message names the support ticket", async () => {
  const message = await escalateWith({ reason: "The server returned 500.", ticket_id: "tkt_0123456789abcdef" });
  assert.match(message, /The server returned 500\./);
  assert.match(message, /Handed to the support team: ticket tkt_0123456789abcdef\./);
});

test("a missing or malformed ticket id is not shown", async () => {
  assert.doesNotMatch(await escalateWith({ reason: "r" }), /ticket/);
  assert.doesNotMatch(await escalateWith({ reason: "r", ticket_id: "<img src=x onerror=alert(1)>" }), /ticket|img/);
  assert.doesNotMatch(await escalateWith({ reason: "r", ticket_id: 42 }), /ticket/);
});
