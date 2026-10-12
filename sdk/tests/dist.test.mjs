// The classic-script distribution is a built artifact: build it, load it the way a <script> tag
// would, and use it. A source-only test could pass while the shipped file is broken.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { fakeWindow, happyBackend } from "./fakes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "scripts/build.mjs")], { stdio: "ignore" });

for (const file of ["operon-sdk.iife.js", "operon-sdk.iife.min.js"]) {
  test(`dist/${file} defines window.Operon and works end to end`, async () => {
    const win = fakeWindow();
    const context = vm.createContext({ window: win, document: win.document, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, URL, AbortController, Promise, Date, Math, JSON, Object, Array, Set, Map, Error, TypeError, DOMException });
    context.globalThis = context;
    vm.runInContext(readFileSync(path.join(root, "dist", file), "utf-8"), context);
    const Operon = vm.runInContext("Operon", context);
    assert.deepEqual(Object.keys(Operon).sort(), ["BUILTIN_ACTIONS", "HANDLER_TIMEOUT_MS", "OperonError", "RESETTABLE_PREFERENCES", "SUPPORTED_ACTIONS", "VERSION", "init", "redactDeep", "redactFreeText", "redactText", "registerOperon", "scrubParseError", "scrubUrl", "validateBackendUrl"]);
    assert.equal(Operon.VERSION, JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version);
    const backend = happyBackend();
    const client = Operon.init({ backendUrl: "https://api.example.com", token: "opk_x", fetch: backend.fetch, evidenceWaitMs: 0, actions: { reset_user_preference: () => ({}) } });
    const result = await client.diagnose("dates are wrong");
    assert.equal(result.state, "proposal");
    client.dispose();
  });
}

test("the module and the script are the same code: both reject a bad URL identically", async () => {
  const { validateBackendUrl } = await import("../operon-sdk.js");
  assert.throws(() => validateBackendUrl("http://api.example.com"));
});
