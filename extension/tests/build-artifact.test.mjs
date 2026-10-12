// The BUILT extension directory is what Chrome loads, so test that, not the source: every file the
// manifest names exists and is a real bundle, the popup page has no inline script (MV3 forbids it),
// the backend URL given at build time is the one baked in, and nothing secret-shaped was bundled.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BACKEND = "https://operon.example.com";

// Built into a temp directory (OPERON_BUILD_OUT), so running the tests never overwrites the dist/<target>
// you may have loaded into Chrome.
function build(target, backend = BACKEND) {
  const out = mkdtempSync(path.join(os.tmpdir(), `operon-build-${target}-`));
  execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), target], { cwd: root, env: { ...process.env, OPERON_BACKEND_URL: backend, OPERON_BUILD_OUT: out }, stdio: "ignore" });
  return out;
}
const read = (dir, file) => readFileSync(path.join(dir, file), "utf-8");

for (const target of ["github", "local-demo", "e2e-local"]) {
  test(`dist/${target}: the manifest only names files that exist, and they are real bundles`, () => {
    const dir = build(target);
    const manifest = JSON.parse(read(dir, "manifest.json"));
    const named = [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap((c) => c.js)];
    for (const file of named) {
      assert.ok(existsSync(path.join(dir, file)), `${file} is missing`);
      assert.ok(statSync(path.join(dir, file)).size > (file.endsWith(".html") ? 50 : 500), `${file} is suspiciously small`);
    }
    for (const file of ["background.js", "content.js", "popup/popup.js"]) new vm.Script(read(dir, file), { filename: file }); // parses as JavaScript
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual([...manifest.permissions].sort(), ["cookies", "debugger", "storage"]);
    assert.ok(manifest.host_permissions.includes(`${BACKEND}/*`), "the backend origin is a host permission");
    assert.equal(manifest.host_permissions.length, 2, "exactly: the target site and the backend");
    assert.deepEqual(readdirSync(dir).sort(), ["background.js", "content.js", "manifest.json", "popup"]);
  });

  test(`dist/${target}: popup page has no inline script, and its assets exist`, () => {
    const dir = build(target);
    const html = read(dir, "popup/popup.html");
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(html), "inline <script> is not allowed in MV3 pages");
    assert.ok(!/\son\w+\s*=/i.test(html), "inline event handlers are not allowed");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((r) => !/^https?:|^#/.test(r));
    assert.ok(refs.length >= 2, "expected the popup script and stylesheet");
    for (const ref of refs) assert.ok(existsSync(path.join(dir, "popup", ref)), `popup references missing file ${ref}`);
  });

  test(`dist/${target}: the build-time backend URL is baked in, nothing else is, and no secret-shaped string was bundled`, () => {
    const dir = build(target);
    const worker = read(dir, "background.js");
    assert.ok(worker.includes(BACKEND), "the configured backend URL is in the service worker");
    assert.ok(!worker.includes("localhost:8000"), "the development default must not leak into a configured build");
    for (const file of ["background.js", "content.js", "popup/popup.js"]) {
      const code = read(dir, file);
      assert.ok(!/gsk_[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{30}|AKIA[0-9A-Z]{16}|opk_[A-Za-z0-9_-]{30}|-----BEGIN [A-Z ]*PRIVATE KEY/.test(code), `${file} contains a secret-shaped string`);
      assert.ok(!/GROQ_API_KEY|process\.env\.[A-Z_]+(?!"production")/.test(code.replace(/process\.env\.NODE_ENV/g, "")), `${file} references a server-side setting`);
      assert.ok(!/sourceMappingURL/.test(code), `${file} ships a source map reference`);
    }
  });
}

test("the development default is used only when no backend URL is given, and bad URLs are refused", () => {
  const without = execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "github"], { cwd: root, env: { ...process.env, OPERON_BACKEND_URL: "", OPERON_BUILD_OUT: mkdtempSync(path.join(os.tmpdir(), "operon-build-default-")) }, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  assert.match(without, /http:\/\/localhost:8000/);
  for (const bad of ["not a url", "ftp://x.test", "https://x.test/?a=1"]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(root, "scripts/build.mjs"), "github"], { cwd: root, env: { ...process.env, OPERON_BACKEND_URL: bad, OPERON_BUILD_OUT: os.tmpdir() + "/operon-build-bad" }, stdio: "ignore" }), bad);
  }
});
