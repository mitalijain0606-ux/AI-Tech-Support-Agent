import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/build.mjs <target>   (e.g. github)");
  process.exit(1);
}

const targetConfigPath = path.join(root, "targets", `${target}.json`);
if (!existsSync(targetConfigPath)) {
  console.error(`No target config found at targets/${target}.json`);
  process.exit(1);
}

const targetConfig = JSON.parse(readFileSync(targetConfigPath, "utf-8"));
if (!targetConfig.match) {
  console.error(
    `Target "${target}" has no "match" configured yet (targets/${target}.json) — not ready to build.`,
  );
  process.exit(1);
}

// Where the extension's backend lives. Resolved at build time so a
// production build never needs a source edit:
//   OPERON_BACKEND_URL env var  >  targets/<target>.json "backend_url"  >  local dev default.
const DEFAULT_BACKEND_URL = "http://localhost:8000";
const backendUrlRaw = process.env.OPERON_BACKEND_URL || targetConfig.backend_url || DEFAULT_BACKEND_URL;
let backendUrl;
try {
  const parsed = new URL(backendUrlRaw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("must be http(s)");
  if (parsed.search || parsed.hash) throw new Error("must not contain a query string or fragment");
  backendUrl = backendUrlRaw.replace(/\/+$/, "");
} catch (err) {
  console.error(`Invalid backend URL "${backendUrlRaw}": ${err.message}`);
  process.exit(1);
}
if (backendUrl.startsWith("http:") && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(backendUrl)) {
  console.warn(`Warning: backend URL ${backendUrl} is plain http — use https for anything but local development.`);
}

const outDir = path.join(root, "dist", target);
mkdirSync(path.join(outDir, "popup"), { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, "src/background.ts"),
    content: path.join(root, "src/content.ts"),
    "popup/popup": path.join(root, "src/popup/popup.tsx"),
  },
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome110",
  jsx: "automatic",
  outdir: outDir,
  define: {
    "process.env.NODE_ENV": '"production"',
    __OPERON_BACKEND_URL__: JSON.stringify(backendUrl),
  },
});

execFileSync(
  path.join(root, "node_modules/.bin/tailwindcss"),
  [
    "-i", path.join(root, "src/popup/styles.css"),
    "-o", path.join(outDir, "popup/popup.css"),
    "--minify",
  ],
  { stdio: "inherit" },
);

cpSync(path.join(root, "src/popup/popup.html"), path.join(outDir, "popup/popup.html"));

const manifestTemplate = readFileSync(path.join(root, "manifest.template.json"), "utf-8");
writeFileSync(path.join(outDir, "manifest.json"), manifestTemplate.replaceAll("__TARGET_MATCH__", targetConfig.match));

console.log(`Built extension/dist/${target}/ for ${targetConfig.domain} (backend: ${backendUrl})`);
