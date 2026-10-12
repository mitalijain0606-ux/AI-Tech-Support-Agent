// Builds the classic-script (direct <script src>) distribution of the SDK:
//   dist/operon-sdk.iife.js      readable
//   dist/operon-sdk.iife.min.js  minified
// Both define one global, `Operon` ({ init, registerOperon, OperonError, VERSION, ... }).
// The ES module (operon-sdk.js + redact.js) needs no build and is the primary artifact.
// esbuild is taken from this package if installed, otherwise from ../extension/node_modules.
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadEsbuild() {
  for (const base of [root, path.resolve(root, "../extension")]) {
    try {
      return createRequire(path.join(base, "package.json"))("esbuild");
    } catch {}
  }
  console.error("esbuild not found. Run `npm ci` in extension/ (or install esbuild in sdk/).");
  process.exit(1);
}
const { build } = loadEsbuild();
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")).version;
const sourceVersion = /export const VERSION = "([^"]+)"/.exec(readFileSync(path.join(root, "operon-sdk.js"), "utf-8"))?.[1];
if (version !== sourceVersion) {
  console.error(`package.json version (${version}) and VERSION in operon-sdk.js (${sourceVersion}) differ.`);
  process.exit(1);
}

mkdirSync(path.join(root, "dist"), { recursive: true });
for (const minify of [false, true]) {
  const outfile = path.join(root, "dist", minify ? "operon-sdk.iife.min.js" : "operon-sdk.iife.js");
  await build({
    entryPoints: [path.join(root, "operon-sdk.js")],
    bundle: true,
    format: "iife",
    globalName: "Operon",
    target: "es2022",
    minify,
    banner: { js: `/* Operon SDK ${version} — https://github.com/ (not published) */` },
    outfile,
  });
  console.log(`built ${path.relative(process.cwd(), outfile)} (${statSync(outfile).size} bytes)`);
}
