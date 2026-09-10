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
//   AMICODE_DEPLOY_OVERRIDE=<reason>                # #992: proceed despite a
//                 stale/dirty pre-flight — the reason MUST be non-empty and is
//                 stamped into dist-app/deploy.json (honest hotfixes, never
//                 silent ones)
//
// #992 DEPLOY GUARD: before any build/stage, fetch origin and refuse (exit 1,
// named reason + remedy) when HEAD ≠ origin/main or the tree is dirty, and
// when the tree is missing a #964 known-fixed hunk. Every deploy stamps
// dist-app/deploy.json {commit, branch, dirty, override_reason, built_at,
// deployed_by} so the served dist always traces to a recorded commit.
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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeployManifest,
  checkKnownFixes,
  evaluatePreflight,
  headRelation,
} from "./deploy_guard.mjs";

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

const gitOut = (cmdArgs, note) => {
  const r = spawnSync("git", cmdArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  if (r.status !== 0) fail(`${note} failed (git exit ${r.status}): ${r.stderr?.trim()}`, 2);
  return r.stdout.trim();
};

// ── #992 pre-flight: recorded main is canonical for the served dist ─────────
// Fetch origin; refuse when HEAD ≠ origin/main or the tree is dirty. An
// override (AMICODE_DEPLOY_OVERRIDE) MUST carry a non-empty reason and is
// recorded in the deploy manifest. Also the #964 known-fixes check at deploy
// time: a tree missing a recorded fix refuses with the named-remedy shape.
const preflight = () => {
  console.log("[build:app] pre-flight (#992): fetch origin, compare HEAD to origin/main, check the tree");
  run("git", ["fetch", "origin"], REPO_ROOT, "git fetch origin");
  const headSha = gitOut(["rev-parse", "HEAD"], "rev-parse HEAD");
  const originSha = gitOut(["rev-parse", "origin/main"], "rev-parse origin/main");
  const headIsAncestor =
    spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { cwd: REPO_ROOT }).status === 0;
  const originIsAncestor =
    spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: REPO_ROOT }).status === 0;
  const dirtyEntries = gitOut(["status", "--porcelain"], "git status").split("\n").filter(Boolean);
  const decision = evaluatePreflight({
    headSha,
    originMainSha: originSha,
    relation: headRelation(headSha, originSha, headIsAncestor, originIsAncestor),
    dirtyEntries,
    overrideReason: process.env.AMICODE_DEPLOY_OVERRIDE,
  });
  for (const line of decision.recorded ?? []) console.log(`[build:app] ${line}`);
  if (!decision.ok) {
    console.error("[build:app] pre-flight FAILED — refusing to build/stage a deploy from this tree:");
    for (const r of decision.reasons) console.error(`[build:app]   ${r}`);
    process.exit(1);
  }
  // The #964 known-fixes check at deploy time (the guard test
  // packages/extension/test/overlay_known_fixes_964.test.ts is the source of
  // record; deploy_guard.mjs mirrors its fixture list).
  const overlayApp = join(REPO_ROOT, "packages", "app-bundle", "overlay", "packages", "app", "src");
  if (existsSync(overlayApp)) {
    const regressed = checkKnownFixes(overlayApp);
    if (regressed.length > 0) {
      console.error("[build:app] pre-flight FAILED — the tree is missing known-fixed hunks (#964):");
      for (const r of regressed) console.error(`[build:app]   ${r}`);
      process.exit(1);
    }
    console.log("[build:app] known-fixes check (#964 hunks): all present in the overlay");
  } else {
    console.log("[build:app] known-fixes check skipped: no overlay tree at packages/app-bundle/overlay (non-app-bundle build context)");
  }
  return { headSha, dirty: dirtyEntries.length > 0, overrideReason: decision.overrideReason };
};

const stampDeployManifest = (target, { headSha, dirty, overrideReason }) => {
  const manifest = buildDeployManifest({
    commit: headSha,
    branch: gitOut(["rev-parse", "--abbrev-ref", "HEAD"], "branch name"),
    dirty,
    overrideReason,
    builtAt: new Date().toISOString(),
    deployedBy: `${userInfo().username}@${hostname()}`,
  });
  writeFileSync(join(target, "deploy.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[build:app] stamped deploy.json → commit ${manifest.commit.slice(0, 12)}${manifest.override_reason ? ` (override: ${manifest.override_reason})` : ""}`);
};

const stageDist = (distDir, manifestInputs) => {
  if (!existsSync(join(distDir, "index.html")))
    fail(`no dist to stage: ${distDir} has no index.html`);
  const target = join(EXT_ROOT, "dist", "app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, ".."), { recursive: true });
  cpSync(distDir, target, { recursive: true });
  if (!existsSync(join(target, "index.html"))) fail(`staging ${distDir} → ${target} lost the index document`);
  stampDeployManifest(target, manifestInputs);
  const files = readdirSync(target);
  console.log(`[build:app] staged ${files.length} top-level entries → packages/extension/dist/app`);
  console.log("[build:app] DONE — the amicode service's shelf serves this at its origin");
};

// ── stage-only mode: an already-built dist (the telaio probe's recipe) ───────
const prebuilt = flag("dist");
if (prebuilt) {
  const manifestInputs = preflight();
  stageDist(prebuilt, manifestInputs);
  process.exit(0);
}

// ── the full recipe ──────────────────────────────────────────────────────────
const manifestInputs = preflight();
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
stageDist(built, manifestInputs);
