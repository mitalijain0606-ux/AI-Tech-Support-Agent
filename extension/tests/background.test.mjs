import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { bundle, connectPopup, createFakeChrome, flush } from "./helpers.mjs";

async function loadBackground(fake) {
  const code = await bundle("src/background.ts", { format: "iife" });
  const context = vm.createContext({
    chrome: fake.chrome,
    fetch: async () => {
      throw new Error("no network in this test");
    },
    setTimeout,
    clearTimeout,
    console,
    URL,
    structuredClone,
  });
  vm.runInContext(code, context);
  await flush(); // let the persisted-state restore settle
}

const errorState = {
  operon_state: {
    state: { phase: "error", message: "Couldn't reach this tab", session: { session_id: "s1", phase: "INVESTIGATING" } },
    nextEvidenceId: 4,
  },
};

test("RESET returns to idle when the active tab has no content script", async () => {
  const fake = createFakeChrome({
    initialStorage: errorState,
    tabs: [{ id: 7, url: "https://example.org/" }], // not the target site
    contentScriptReachable: false,
  });
  await loadBackground(fake);
  const popup = connectPopup(fake.listeners);
  await flush();
  assert.equal(popup.received.at(-1).phase, "error");

  popup.send({ type: "RESET" });
  await flush();

  assert.equal(popup.received.at(-1).phase, "idle");
  assert.equal(popup.received.at(-1).session, undefined);
  assert.ok(!popup.received.some((s, i) => i > 0 && s.phase === "error"), "no error state after RESET");
  assert.equal(fake.storage.operon_state.state.phase, "idle", "idle state is what gets persisted");
});

test("RESET returns to idle when there is no usable active tab at all", async () => {
  const fake = createFakeChrome({ initialStorage: errorState, tabs: [] });
  await loadBackground(fake);
  const popup = connectPopup(fake.listeners);
  await flush();

  popup.send({ type: "RESET" });
  await flush();

  assert.equal(popup.received.at(-1).phase, "idle");
});

test("RESET still clears the demo key when the content script is reachable", async () => {
  const sent = [];
  const fake = createFakeChrome({
    initialStorage: errorState,
    tabs: [{ id: 3, url: "https://github.com/" }],
    contentScriptReachable: true,
  });
  const original = fake.chrome.tabs.sendMessage;
  fake.chrome.tabs.sendMessage = (tabId, message, cb) => {
    sent.push(JSON.parse(JSON.stringify({ tabId, message }))); // message comes from the vm realm
    original(tabId, message, cb);
  };
  await loadBackground(fake);
  const popup = connectPopup(fake.listeners);
  await flush();

  popup.send({ type: "RESET" });
  await flush();

  assert.equal(popup.received.at(-1).phase, "idle");
  assert.deepEqual(sent, [{ tabId: 3, message: { type: "RESET_STORAGE" } }]);
});
