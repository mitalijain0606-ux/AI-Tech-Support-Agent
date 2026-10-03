// Request-driven evidence collection: the extension collects exactly what the
// backend's EvidenceRequest asks for, bounded, and reports what it couldn't.
import assert from "node:assert/strict";
import test from "node:test";

import { createWorld, evidenceRequest, session } from "./helpers.mjs";

const STORAGE_ROW = { key: "operon_demo_cache", present: true, parse_status: "syntax_error", error_message: "bad" };

function contentFor(extra = {}) {
  return (msg) => {
    if (msg.type === "CHECK_STORAGE") return { storage: [STORAGE_ROW, { key: "absent_key", present: false, parse_status: "empty" }] };
    if (msg.type === "INSPECT_PAGE") return { page: { url_path: "/octo", title: "Repo", ready_state: "complete", service_worker_controlled: false, service_worker_scopes: [], selector: msg.selector ?? null, selector_matches: msg.selector ? 2 : null } };
    return extra[msg.type]?.(msg) ?? {};
  };
}

// Runs ASK_OPERON against a backend whose first request is `request`, and
// returns the bundle the extension submitted.
async function collect(request, worldOptions = {}) {
  const world = await createWorld({
    content: contentFor(),
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: request });
      if (path.endsWith("/investigate")) return { diagnosis: null, session: session("ESCALATED", { escalation_state: { reason: "done", resolution_state: "x", guidance: null, at: "t" } }) };
      return { status: 500, body: {} };
    },
    ...worldOptions,
  }).load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "page broken" });
  await world.until(() => world.calls("/investigate").length === 1, "investigate call");
  return { world, bundle: world.calls("/investigate")[0].body.bundle };
}

test("session creation declares capabilities and collectors", async () => {
  const { world } = await collect(evidenceRequest({ collectors: ["page"] }));
  const create = world.calls("/api/sessions")[0].body;
  assert.ok(create.provider_capabilities.includes("clear_storage_key"));
  assert.deepEqual(create.collectors, ["console", "network", "storage", "cookies", "page", "reload_observe"]);
});

test("only requested collectors run: storage + page needs no debugger", async () => {
  const { world, bundle } = await collect(
    evidenceRequest({ collectors: ["storage", "page"], params: { storage_keys: ["absent_key"], selector: "#app", observe_ms: 4000 } }),
  );
  assert.ok(!world.log.includes("attach"), "debugger must not attach");
  assert.equal(bundle.request_id, "req_1");
  assert.deepEqual(bundle.collectors, ["storage", "page"]);
  assert.deepEqual(bundle.console, []);
  assert.deepEqual(bundle.network, []);
  assert.deepEqual(bundle.cookies, []);
  assert.deepEqual(bundle.storage.map((s) => [s.key, s.parse_status]), [["operon_demo_cache", "syntax_error"], ["absent_key", "empty"]]);
  assert.equal(bundle.page[0].selector_matches, 2);
  const checkStorage = world.log.indexOf("content:CHECK_STORAGE");
  assert.ok(checkStorage >= 0);
  // ids are unique and well-formed
  const ids = [...bundle.storage, ...bundle.page].map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^ev_\d+$/.test(id)));
});

test("absent keys are only reported when they were asked about", async () => {
  const { bundle } = await collect(evidenceRequest({ collectors: ["storage"] }));
  assert.deepEqual(bundle.storage.map((s) => s.key), ["operon_demo_cache"]);
});

test("console + network are observed with the debugger, which is always detached", async () => {
  const { world, bundle } = await collect(evidenceRequest({ collectors: ["console", "network", "storage"] }), {
    content: (msg, w) => {
      if (msg.type !== "CHECK_STORAGE") return {};
      w.consoleError("SyntaxError: bad JSON while parsing cached config");
      w.failedRequest("https://github.com/api/x", 503);
      return { storage: [STORAGE_ROW] };
    },
  });
  assert.deepEqual(world.log.filter((e) => e === "attach" || e === "detach"), ["attach", "detach"]);
  assert.equal(bundle.console[0].text, "SyntaxError: bad JSON while parsing cached config");
  assert.equal(bundle.network[0].status, 503);
  assert.deepEqual(bundle.collection_errors, []);
});

test("debugger unavailable: reported as a collection error, other collectors still run", async () => {
  const { bundle } = await collect(evidenceRequest({ collectors: ["console", "storage"] }), { debuggerAvailable: false });
  assert.deepEqual(bundle.collection_errors, ["debugger_unavailable"]);
  assert.equal(bundle.storage[0].key, "operon_demo_cache");
  assert.deepEqual(bundle.console, []);
});

test("unreachable tab: storage/page failures are reported, not thrown", async () => {
  const { bundle } = await collect(evidenceRequest({ collectors: ["storage", "page"] }), {
    content: () => {
      throw new Error("Receiving end does not exist.");
    },
  });
  assert.deepEqual(bundle.collection_errors, ["storage_unreachable", "page_unreachable"]);
});

test("cookie values are never collected", async () => {
  const { bundle } = await collect(evidenceRequest({ collectors: ["cookies"] }), {
    cookies: [{ name: "user_session", value: "SECRET_VALUE", domain: "github.com", path: "/", secure: true, httpOnly: true }],
  });
  assert.equal(bundle.cookies[0].name, "user_session");
  assert.ok(!JSON.stringify(bundle).includes("SECRET_VALUE"));
});

test("reload_observe reloads with the debugger attached and drops the old page's console", async () => {
  const world = createWorld({
    backend: (method, path) =>
      path === "/api/sessions"
        ? session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["reload_observe"] }) })
        : { diagnosis: null, session: session("ESCALATED") },
    onReload: (w) => {
      w.consoleError("old page error before navigation");
      w.emit("Runtime.executionContextsCleared");
      w.consoleError("error during the new page's load");
    },
  });
  await world.load();
  world.connect().send({ type: "ASK_OPERON", message: "x" });
  await world.until(() => world.calls("/investigate").length === 1);
  const bundle = world.calls("/investigate")[0].body.bundle;
  assert.deepEqual(world.log.filter((e) => ["attach", "reload", "detach"].includes(e)), ["attach", "reload", "detach"]);
  assert.deepEqual(bundle.console.map((c) => c.text), ["error during the new page's load"]);
});

test("NEED_INFORMATION without user action is collected automatically — but bounded locally", async () => {
  let investigations = 0;
  const world = createWorld({
    content: contentFor(),
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
      investigations++;
      return { diagnosis: null, session: session("NEED_INFORMATION", { evidence_request: evidenceRequest({ request_id: `req_${investigations + 1}`, purpose: "information", collectors: ["page"], reason: "look again" }) }) };
    },
  });
  await world.load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "x" });
  await world.until(() => popup.last()?.phase === "needs_more_evidence", "needs_more_evidence");
  assert.equal(investigations, 7); // the first cycle + MAX_AUTO_CYCLES (6) automatic continuations
  assert.equal(popup.last().message, "look again");
});

test("NEED_INFORMATION that needs the user waits for the user", async () => {
  const world = createWorld({
    content: contentFor(),
    backend: (method, path) => {
      if (path === "/api/sessions") return session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["page"] }) });
      if (path === "/api/sessions/s1" && method === "GET")
        return session("NEED_INFORMATION", { evidence_request: evidenceRequest({ request_id: "req_2", collectors: ["page"], requires_user_action: true }) });
      return { diagnosis: null, session: session("NEED_INFORMATION", { evidence_request: evidenceRequest({ request_id: "req_2", collectors: ["page"], requires_user_action: true, reason: "reproduce it" }) }) };
    },
  });
  await world.load();
  const popup = world.connect();
  popup.send({ type: "ASK_OPERON", message: "x" });
  await world.until(() => popup.last()?.phase === "needs_more_evidence");
  assert.equal(world.calls("/investigate").length, 1);

  popup.send({ type: "INVESTIGATE_AGAIN" });
  await world.until(() => world.calls("/investigate").length === 2, "second investigation");
  assert.equal(world.calls("/investigate")[1].body.bundle.request_id, "req_2");
});
