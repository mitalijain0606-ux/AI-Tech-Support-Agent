import assert from "node:assert/strict";
import test from "node:test";

import { createWorld, flush, session } from "./helpers.mjs";

const errorState = {
  operon_state: {
    state: { phase: "error", message: "Couldn't reach this tab", session: session("NEED_INFORMATION") },
    nextEvidenceId: 4,
  },
};

const unreachable = () => {
  throw new Error("Could not establish connection. Receiving end does not exist.");
};

test("RESET returns to idle when the active tab has no content script", async () => {
  const world = await createWorld({ initialStorage: errorState, tabs: [{ id: 7, url: "https://example.org/" }], content: unreachable }).load();
  const popup = world.connect();
  await flush();
  assert.equal(popup.last().phase, "error");

  popup.send({ type: "RESET" });
  await flush();

  assert.equal(popup.last().phase, "idle");
  assert.equal(popup.last().session, undefined);
  assert.ok(!popup.received.some((s, i) => i > 0 && s.phase === "error"), "no error state after RESET");
  assert.equal(world.storage.operon_state.state.phase, "idle", "idle state is what gets persisted");
});

test("RESET returns to idle when there is no usable active tab at all", async () => {
  const world = await createWorld({ initialStorage: errorState, tabs: [] }).load();
  const popup = world.connect();
  await flush();
  popup.send({ type: "RESET" });
  await flush();
  assert.equal(popup.last().phase, "idle");
});

test("RESET still clears the demo key when the content script is reachable", async () => {
  const world = await createWorld({ initialStorage: errorState }).load();
  const popup = world.connect();
  await flush();
  popup.send({ type: "RESET" });
  await flush();
  assert.equal(popup.last().phase, "idle");
  assert.deepEqual(world.log.filter((e) => e.startsWith("content:")), ["content:RESET_STORAGE"]);
});
