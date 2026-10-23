// An investigation is bound to the tab it started on: later evidence, the approved action and its
// verification run on THAT tab while it still shows the same site — never on whatever tab is active.
import assert from "node:assert/strict";
import test from "node:test";

import { TAB, awaitingApproval, createWorld, evidenceRequest, plan, session } from "./helpers.mjs";

const OTHER = { id: 9, url: "https://github.com/someone/else" };
const pending = plan("clear_storage_key", { cited: { storage: [{ id: "ev_002", key: "operon_demo_cache", present: true, parse_status: "syntax_error" }] } });

function approvalWorld() {
  const tabsSeen = new Set();
  const world = createWorld({
    initialStorage: awaitingApproval(pending),
    content: (msg, w) => {
      tabsSeen.add(w.lastMessageTab);
      return msg.type === "CHECK_STORAGE" ? { storage: [{ key: "operon_demo_cache", present: false, parse_status: "empty" }] } : {};
    },
    backend: (method, path) => {
      if (path.endsWith("/approve")) return session("EXECUTING", { pending_action: pending });
      if (path.endsWith("/action-result")) return session("VERIFYING", { pending_action: pending });
      if (path.endsWith("/verify")) return session("RESOLVED", { pending_action: pending, verification_state: { outcome: "passed", passed: true, message: "ok", at: "t" } });
      return { status: 500, body: {} };
    },
  });
  return { world, tabsSeen };
}

test("switching to another tab before approving: the fix still runs on the investigated tab only", async () => {
  const { world, tabsSeen } = approvalWorld();
  await world.load();
  world.openTabs.set(OTHER.id, OTHER);
  world.activate(OTHER); // the person is now looking at an unrelated tab
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  await world.until(() => popup.last()?.phase === "resolved", "resolved");
  assert.deepEqual([...tabsSeen], [TAB.id], "every content-script message went to the investigated tab");
});

test("the investigated tab was closed: nothing is approved or run, and the person is told", async () => {
  const { world, tabsSeen } = approvalWorld();
  await world.load();
  world.openTabs.delete(TAB.id);
  world.openTabs.set(OTHER.id, OTHER);
  world.activate(OTHER);
  world.openTabs.delete(TAB.id);
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  await world.until(() => popup.last()?.phase === "error", "error");
  assert.match(popup.last().message, /tab this investigation is about was closed/);
  assert.equal(world.calls("/approve").length, 0, "no approval was recorded");
  assert.equal(tabsSeen.size, 0, "nothing was sent to any tab");
});

test("the investigated tab now shows another site: nothing is approved or run", async () => {
  const { world, tabsSeen } = approvalWorld();
  await world.load();
  world.openTabs.set(TAB.id, { id: TAB.id, url: "https://evil.example/page" });
  const popup = world.connect();
  popup.send({ type: "APPROVE" });
  await world.until(() => popup.last()?.phase === "error", "error");
  assert.match(popup.last().message, /different site \(https:\/\/evil\.example\)/);
  assert.equal(world.calls("/approve").length, 0);
  assert.equal(tabsSeen.size, 0);
});

test("more evidence is collected from the investigated tab, not from the newly active one", async () => {
  const tabsSeen = new Set();
  const request = evidenceRequest({ collectors: ["page"] });
  const world = await createWorld({
    content: (msg, w) => {
      tabsSeen.add(w.lastMessageTab);
      return msg.type === "INSPECT_PAGE" ? { page: { url_path: "/", title: "t", ready_state: "complete", service_worker_controlled: false, service_worker_scopes: [], selector: null, selector_matches: null } } : { storage: [] };
    },
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: request });
      if (path.endsWith("/investigate")) return { diagnosis: null, session: session("NEED_INFORMATION", { evidence_request: evidenceRequest({ collectors: ["page"], request_id: "req_2", requires_user_action: true }) }) };
      if (/\/api\/sessions\/[^/]+$/.test(path)) return session("NEED_INFORMATION", { evidence_request: evidenceRequest({ collectors: ["page"], request_id: "req_2", requires_user_action: true }) });
      return { status: 500, body: {} };
    },
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => popup.last()?.phase === "needs_more_evidence", "needs more evidence");
  world.openTabs.set(OTHER.id, OTHER);
  world.activate(OTHER);
  popup.send({ type: "INVESTIGATE_AGAIN" });
  await world.until(() => world.calls("/investigate").length === 2, "second cycle");
  assert.deepEqual([...tabsSeen], [TAB.id]);
});
