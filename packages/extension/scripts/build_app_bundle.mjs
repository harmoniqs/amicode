#!/usr/bin/env node
// build_app_bundle.mjs — stage the built app-bundle dist into the extension
// (#822, the fetch:opencode precedent for a build product riding the VSIX).
// The app-bundle README's proven recipe: materialize (canonical base +
// overlay) → bun install → build the app (vite production build) → copy the
// app dist into <extension>/dist/app — the path resolveAppDistRoot's DEFAULT
// expects, which the amicode service's shelf serves at its origin.
//
// USAGE
//   node scripts/build_app_bundle.mjs               # full recipe
//   node scripts/build_app_bundle.mjs --dist <dir>  # stage an already-built dist
//   node scripts/build_app_bundle.mjs --work <dir>  # materialize/reuse this tree
//   AMICODE_APP_BUNDLE_WORK=<dir>                   # --work via env
//
// FAILS LOUDLY, never a silent skip: a packaging step that no-ops is the
// "silently no-op'd fetch" trap the vsix-gate exists to catch. The RUNTIME half
// is honest independently of this script: with no dist staged, the shelf
// serves the needs-setup placeholder (never a silent 404-as-app).
//
// CI NOTE (honest stub): the full bun build (≈4,700 packages + upstream
// tarball fetch) is NOT wired into ci.yml in this slice — build:app is a
// manual/release-pipeline hook until the packaging-chore issue lands. The
// app-shelf-boot-proof CI lane runs the env-gated probe, which skips with the
// reason printed until a dist is built there.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(EXT_ROOT, "..", "..");
const BUNDLE_PKG = join(REPO_ROOT, "packages", "app-bundle");

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const fail = (msg, code = 1) => {
  console.error(`[build:app] FAIL: ${msg}`);
  process.exit(code);
};

const run = (cmd, cmdArgs, cwd, note) => {
  console.log(`[build:app] ${note}: ${cmd} ${cmdArgs.join(" ")} (cwd=${cwd})`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(`${note} failed (exit ${r.status})`, 2);
};

const stageDist = (distDir) => {
  if (!existsSync(join(distDir, "index.html")))
    fail(`no dist to stage: ${distDir} has no index.html`);
  const target = join(EXT_ROOT, "dist", "app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(distDir, target, { recursive: true });
  if (!existsSync(join(target, "index.html"))) fail(`staging ${distDir} → ${target} lost the index document`);
  const files = readdirSync(target);
  console.log(`[build:app] staged ${files.length} top-level entries → packages/extension/dist/app`);
  console.log("[build:app] DONE — the amicode service's shelf serves this at its origin");
};

// ── stage-only mode: an already-built dist (the telaio probe's recipe) ───────
const prebuilt = flag("dist");
if (prebuilt) {
  stageDist(prebuilt);
  process.exit(0);
}

// ── the full recipe ──────────────────────────────────────────────────────────
const work = flag("work") ?? process.env.AMICODE_APP_BUNDLE_WORK ?? join(BUNDLE_PKG, ".materialized");

if (!existsSync(join(work, "package.json"))) {
  run("node", [join(BUNDLE_PKG, "scripts", "materialize.mjs"), "--out", work], REPO_ROOT, "materialize (canonical base + overlay)");
}
if (!existsSync(join(work, "packages", "app")))
  fail(`${work} has no packages/app — not a materialized app tree (pass --work to point at one)`);

const bun = spawnSync("which", ["bun"], { encoding: "utf8" });
if (bun.status !== 0 || !bun.stdout.trim())
  fail("bun is not on PATH — the app-bundle README's recipe installs with bun (https://bun.sh)");
run("bun", ["install"], work, "bun install (the app tree's ~4,700 packages)");
// bun, not pnpm, and cwd-scoped: the materialized tree pins
// `"packageManager": "bun@…"` (corepack-managed pnpm refuses to run scripts
// in it) and bun's --filter finds no packages (the tree's workspace layout);
// running the app package's OWN `vite build` script in its directory just
// works — the README's proven 14s build.
run("bun", ["run", "build"], join(work, "packages", "app"), "app build (vite production build)");

const built = join(work, "packages", "app", "dist");
if (!existsSync(join(built, "index.html"))) {
  const appDir = join(work, "packages", "app");
  const candidates = existsSync(appDir) ? readdirSync(appDir).filter((e) => existsSync(join(appDir, e, "index.html"))) : [];
  fail(
    `no built dist at ${built} (packages/app build output with index.html). ` +
      (candidates.length > 0 ? `Found index.html in: ${candidates.join(", ")}` : "No index.html anywhere under packages/app — the build did not emit the app document."),
  );
}
stageDist(built);
