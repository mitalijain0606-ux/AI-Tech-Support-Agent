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
  define: { "process.env.NODE_ENV": '"production"' },
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

console.log(`Built extension/dist/${target}/ for ${targetConfig.domain}`);
