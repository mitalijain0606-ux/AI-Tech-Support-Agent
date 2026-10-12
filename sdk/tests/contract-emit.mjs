// Prints, as JSON, every request body the SDK sends during a full flow (diagnose with a question,
// answer, approve, execute, verify). backend/tests/test_sdk_contract.py validates each body against
// the backend's own pydantic models, so a change on either side that breaks the contract fails a test.
import { init } from "../operon-sdk.js";
import { evidenceRequest, fakeBackend, fakeWindow, install, proposal, session } from "./fakes.mjs";

const win = fakeWindow({ storage: { app_settings: "{bad" } });
install(win);
const pending = proposal("reset_user_preference", { preference: "timezone" });
let investigated = 0;
const backend = fakeBackend({
  "POST /api/sessions": () => [200, session("UNDERSTANDING", { evidence_request: evidenceRequest({ collectors: ["console", "network", "storage", "page"], params: { storage_keys: ["app_settings"], selector: "body", observe_ms: 0 } }) })],
  "POST /api/sessions/s1/investigate": () => [200, { session: investigated++ === 0 ? session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "What did you click?" }) }) : session("ACTION_PROPOSED", { pending_action: pending }) }],
  "POST /api/sessions/s1/answer": () => [200, session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: "What did you click?" }) })],
  "POST /api/sessions/s1/policy": () => [200, { policy: { decision: "REQUIRE_APPROVAL", validated_params: pending.parameters }, session: session("WAITING_FOR_APPROVAL", { pending_action: pending }) }],
  "POST /api/sessions/s1/approve": () => [200, session("EXECUTING", { pending_action: pending })],
  "POST /api/sessions/s1/action-result": () => [200, session("VERIFYING", { pending_action: pending })],
  "POST /api/sessions/s1/verify": () => [200, session("RESOLVED", { resolution_state: "resolved", pending_action: pending })],
  "GET /api/sessions/s1": () => [200, session("NEED_INFORMATION", { evidence_request: evidenceRequest({ question: null }) })],
});
const client = init({
  backendUrl: "https://api.example.com", token: "opk_x", fetch: backend.fetch, evidenceWaitMs: 0, maxObserveMs: 20,
  storageKeys: ["app_settings"], capture: { console: true, network: true },
  actions: { reset_user_preference: () => ({ detail: "reset" }) }, builtinActions: ["clear_storage_key"], reobserve: async () => win.console.error("late error from re-render"),
});
win.console.error("Failed to load settings");
await client.diagnose("my dashboard is broken");
await client.answer("I clicked save");
await client.continue();
await client.decide(true);
const bodies = {};
for (const c of backend.calls.filter((c) => c.method === "POST")) bodies[c.path.split("/").pop() === "sessions" ? "create" : c.path.split("/").pop()] = c.body;
console.log(JSON.stringify(bodies));
client.dispose();
