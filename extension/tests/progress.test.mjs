// Live progress: the popup shows what the backend is doing while /investigate
// is still running, and a missing or broken stream never affects the result.
import assert from "node:assert/strict";
import test from "node:test";

import { bundle, createWorld, evidenceRequest, session } from "./helpers.mjs";

const { describeProgress } = await import(
  `data:text/javascript;base64,${Buffer.from(await bundle("src/lib/progress.ts")).toString("base64")}`
);

const frame = (event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const stage = (id, name, status, extra = {}) => frame({ id, type: "stage", stage: name, status, ...extra });
const done = (extra = {}) => ({ diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" }, ...extra }) });

test("describeProgress turns stage and activity events into short lines", () => {
  assert.equal(describeProgress({ type: "stage", stage: "diagnose", status: "started" }), "Asking the model for a diagnosis");
  assert.equal(describeProgress({ type: "stage", stage: "investigate", status: "finished", retrieval: "ok" }), "Evidence and knowledge search done (ok)");
  assert.equal(describeProgress({ type: "stage", stage: "plan", status: "finished", outcome: "action_proposed" }), "Next step planned (action_proposed)");
  assert.equal(describeProgress({ type: "activity", entry: { summary: "found 2 relevant knowledge chunk(s)" } }), "found 2 relevant knowledge chunk(s)");
  assert.equal(describeProgress({ type: "stage", stage: "unknown", status: "started" }), null);
  assert.equal(describeProgress({ type: "end" }), null);
});

async function runWith(eventsRoute) {
  const world = await createWorld({
    content: () => ({}),
    backend: async (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
      if (path.includes("/events")) return eventsRoute();
      if (path.endsWith("/investigate")) {
        await new Promise((r) => setTimeout(r, 150)); // the model call: long enough for progress to arrive
        return done();
      }
      return { status: 500, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => popup.last()?.phase === "escalated", "final state");
  return { world, popup };
}

test("the popup receives progress lines from the event stream while investigating", async () => {
  const { popup } = await runWith(() => ({
    stream: [stage(1, "investigate", "started"), stage(2, "diagnose", "started"), stage(3, "diagnose", "finished", { engine: "groq" })],
  }));
  const lines = popup.received.filter((s) => s.phase === "investigating" && s.progress?.length).map((s) => s.progress.map((l) => l.text));
  assert.ok(lines.length >= 1, "progress was shown");
  const longest = lines.at(-1);
  assert.ok(longest.includes("Gathering and searching the evidence") && longest.includes("Asking the model for a diagnosis"), longest.join(" | "));
  assert.equal(popup.last().progress, undefined, "the final screen is driven by the session, not the stream");
});

test("a backend without a stream (or a failing one) does not break the investigation", async () => {
  const { popup } = await runWith(() => ({ status: 404, body: {} }));
  assert.equal(popup.last().phase, "escalated");
});

test("garbage in the stream is ignored", async () => {
  const { popup } = await runWith(() => ({ stream: ["data: {not json}\n\n", ": heartbeat\n\n", stage(1, "diagnose", "started")] }));
  assert.equal(popup.last().phase, "escalated");
  const texts = popup.received.flatMap((s) => (s.progress ?? []).map((l) => l.text));
  assert.ok(texts.includes("Asking the model for a diagnosis"));
});

test("the stream is closed when the step ends", async () => {
  const { world } = await runWith(() => ({ stream: [stage(1, "investigate", "started")] }));
  const opened = world.requests.filter((r) => r.path.includes("/events"));
  assert.ok(opened.length >= 1);
  assert.match(opened[0].path, /\/api\/sessions\/[^/]+\/events\?after=0$/);
});
