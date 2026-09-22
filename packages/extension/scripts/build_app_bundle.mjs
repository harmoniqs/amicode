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
// named reason + remedy) when HEAD ≠ origin/<default-branch> (#1196: the
// DEFAULT BRANCH, resolved from the remote — the dev workflow's integration
// trunk, not the literal "main") or the tree is dirty, and when the tree is
// missing a #964 known-fixed hunk. Every deploy stamps
// dist-app/deploy.json {commit, branch, dirty, override_reason, built_at,
// deployed_by} so the served dist always traces to a recorded commit.
// EXCEPTION: under CI (the vsix-gate's packaging lane, a merge-ref build that
// is not a deploy) the stale/dirty checks are advisory and recorded in the
// manifest; the known-fixes check stays enforcing everywhere.
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
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDeployManifest,
  checkKnownFixes,
  evaluatePreflight,
  headRelation,
  resolveDefaultBranch,
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

const directWorktree = args.includes("--direct-worktree");
const verifiedMain = args.includes("--verified-main");
if (directWorktree && verifiedMain) fail("--direct-worktree and --verified-main are mutually exclusive");

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

// ── #992 pre-flight: the recorded default branch is canonical for the served dist
// Fetch origin; resolve the repository's DEFAULT BRANCH (#1196: dev workflow —
// dev = integration target; never the literal "main") and refuse when HEAD ≠
// origin/<default> or the tree is dirty. An override (AMICODE_DEPLOY_OVERRIDE)
// MUST carry a non-empty reason and is recorded in the deploy manifest. Also
// the #964 known-fixes check at deploy time: a tree missing a recorded fix
// refuses with the named-remedy shape.
//
// CI EXCEPTION (honest, never silent): the vsix-gate's packaging lane runs
// build:app from the PR MERGE REF — legitimately ahead of the default branch
// and shallow-cloned (ancestry probes can't decide). That is a packaging build,
// not a deploy: under CI the stale/dirty checks run ADVISORY (printed, and
// recorded as the manifest's override_reason) while the #964 known-fixes
// check stays ENFORCING — a merge ref containing the default branch carries
// its fixes, so a regression there still refuses. Locally, CI is not set: the
// guard is always a hard refusal, overridable only via a recorded
// AMICODE_DEPLOY_OVERRIDE.
const preflight = () => {
  const ciPackaging = process.env.CI === "true" || process.env.CI === "1";
  console.log("[build:app] pre-flight (#992): fetch origin, resolve the default branch, compare HEAD, check the tree");
  if (gitOut(["rev-parse", "--is-shallow-repository"], "shallow check") === "true") {
    console.log("[build:app] shallow clone — unshallowing so the baseline ancestry probes are honest");
    run("git", ["fetch", "--unshallow", "origin"], REPO_ROOT, "git fetch --unshallow origin");
  } else {
    run("git", ["fetch", "origin"], REPO_ROOT, "git fetch origin");
  }
  // #1196: the ahead-of-trunk baseline is the repository's DEFAULT BRANCH,
  // resolved from the remote — `git remote show origin`'s HEAD branch first
  // (authoritative; a stale local refs/remotes/origin/HEAD loses), then the
  // symbolic ref, then the "main" fallback. symbolic-ref/remote-show may
  // legitimately fail (unset ref, offline) — probed softly, never gitOut'd.
  const remoteShowOut = (() => {
    const r = spawnSync("git", ["remote", "show", "origin"], { cwd: REPO_ROOT, encoding: "utf8" });
    return r.status === 0 ? r.stdout : "";
  })();
  const symbolicRefOut = (() => {
    const r = spawnSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
    return r.status === 0 ? r.stdout : "";
  })();
  const baseline = resolveDefaultBranch({ remoteShowOutput: remoteShowOut, symbolicRefOutput: symbolicRefOut });
  const baselineRef = `origin/${baseline.branch}`;
  console.log(`[build:app] pre-flight baseline: ${baselineRef} (default branch via ${baseline.source})`);
  const headSha = gitOut(["rev-parse", "HEAD"], "rev-parse HEAD");
  const baselineSha = gitOut(["rev-parse", baselineRef], `rev-parse ${baselineRef}`);
  const headIsAncestor =
    spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", baselineRef], { cwd: REPO_ROOT }).status === 0;
  const baselineIsAncestor =
    spawnSync("git", ["merge-base", "--is-ancestor", baselineRef, "HEAD"], { cwd: REPO_ROOT }).status === 0;
  const dirtyEntries = gitOut(["status", "--porcelain"], "git status").split("\n").filter(Boolean);
  const decision = evaluatePreflight({
    headSha,
    baselineSha,
    baselineRef,
    relation: headRelation(headSha, baselineSha, headIsAncestor, baselineIsAncestor),
    dirtyEntries,
    overrideReason: process.env.AMICODE_DEPLOY_OVERRIDE,
  });
  for (const line of decision.recorded ?? []) console.log(`[build:app] ${line}`);
  if (!decision.ok) {
    if (ciPackaging) {
      const advisoryReason = `ci-packaging (merge ref ${headSha.slice(0, 12)}, branch ${gitOut(["rev-parse", "--abbrev-ref", "HEAD"], "branch name")}): ${decision.reasons.join(" | ")}`;
      console.log("[build:app] CI packaging build — stale/dirty guard is ADVISORY here (not a deploy); recorded in the manifest:");
      for (const r of decision.reasons) console.log(`[build:app]   ADVISORY: ${r}`);
      return { headSha, dirty: dirtyEntries.length > 0, overrideReason: advisoryReason };
    }
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

// Local developer rebuilds intentionally preserve the selected worktrees,
// including dirty and divergent ones. Capture the stamp without fetching,
// materializing, or inspecting the overlay.
const directWorktreeInputs = () => ({
  headSha: gitOut(["rev-parse", "HEAD"], "rev-parse HEAD"),
  dirty: gitOut(["status", "--porcelain"], "git status").split("\n").filter(Boolean).length > 0,
  overrideReason: "direct-worktree rebuild",
});

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
  const manifestInputs = directWorktree ? directWorktreeInputs() : preflight();
  stageDist(prebuilt, manifestInputs);
  process.exit(0);
}

// ── the full recipe ──────────────────────────────────────────────────────────
const work = flag("work") ?? process.env.AMICODE_APP_BUNDLE_WORK ?? join(BUNDLE_PKG, ".materialized");
const manifestInputs = directWorktree ? directWorktreeInputs() : preflight();

if (verifiedMain) {
  if (!existsSync(join(work, ".git"))) fail(`--verified-main requires a git worktree: ${work}`);
  const revision = spawnSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (revision.status !== 0) fail(`cannot resolve verified main revision: ${revision.stderr?.trim()}`);
  run(
    process.execPath,
    [join(BUNDLE_PKG, "scripts", "overlay-promotion.mjs"), "--check", "--source", work, "--revision", revision.stdout.trim()],
    REPO_ROOT,
    "verify committed overlay provenance",
  );
}

// ── overlay staleness check: re-materialize when the overlay has changed ─────
// The manifest's overlay_sha + promoted_at identify the extraction version, but
// local edits to overlay files don't change those fields. For dev builds, we
// also hash the manifest.files object (which refresh_manifest.mjs updates on
// every overlay edit via the auto-refresh in materialize.mjs). When either the
// extraction version OR the file hashes differ, the cached tree is stale.
const OVERLAY_STAMP = join(work, ".overlay-stamp");
const overlayVersion = (() => {
  try {
    const m = JSON.parse(readFileSync(join(BUNDLE_PKG, "manifest.json"), "utf8"));
    const base = `${m.overlay_sha ?? ""}:${m.promoted_at ?? ""}`;
    // Include a hash of the file-hashes so local overlay edits invalidate the cache
    const filesHash = m.files ? createHash("sha256").update(JSON.stringify(m.files)).digest("hex").slice(0, 12) : "";
    return `${base}:${filesHash}`;
  } catch { return null; }
})();
const cachedVersion = (() => {
  try { return readFileSync(OVERLAY_STAMP, "utf8").trim(); }
  catch { return null; }
})();
const cacheExists = existsSync(join(work, "package.json"));
const cacheStale = cacheExists && overlayVersion && cachedVersion !== overlayVersion;

if (cacheStale && !directWorktree && !verifiedMain) {
  console.log(`[build:app] overlay changed (manifest overlay_sha differs from cached stamp) — clearing stale .materialized`);
  console.log(`[build:app]   cached:  ${cachedVersion ?? "(none)"}`);
  console.log(`[build:app]   current: ${overlayVersion}`);
  rmSync(work, { recursive: true, force: true });
}

if (!existsSync(join(work, "package.json"))) {
  if (directWorktree || verifiedMain) fail(`${directWorktree ? "--direct-worktree" : "--verified-main"} requires an existing --work tree`);
  run("node", [join(BUNDLE_PKG, "scripts", "materialize.mjs"), "--out", work], REPO_ROOT, "materialize (canonical base + overlay)");
  // Stamp the materialized tree so the next build can detect staleness.
  if (overlayVersion) writeFileSync(OVERLAY_STAMP, overlayVersion + "\n");
} else if (cacheExists && !cachedVersion && overlayVersion) {
  // Backfill stamp for trees materialized before this check existed.
  writeFileSync(OVERLAY_STAMP, overlayVersion + "\n");
  console.log("[build:app] backfilled .overlay-stamp for existing .materialized tree");
}
if (!existsSync(join(work, "packages", "app")))
  fail(`${work} has no packages/app — not a materialized app tree (pass --work to point at one)`);

// ── clear stale vite build output ────────────────────────────────────────────
// When build:binary runs first it materializes fresh source into the tree, but
// a previous build:app's vite output (packages/app/dist) survives because the
// staleness check only wipes when the STAMP differs — not on every run. Vite's
// incremental cache can miss the changed source files (mtime race), so we
// always clear the previous dist + vite cache before building. The 14s vite
// build is cheap compared to shipping a stale UI.
const appDist = join(work, "packages", "app", "dist");
const viteCache = join(work, "packages", "app", "node_modules", ".vite");
if (existsSync(appDist)) { rmSync(appDist, { recursive: true, force: true }); console.log("[build:app] cleared stale packages/app/dist"); }
if (existsSync(viteCache)) { rmSync(viteCache, { recursive: true, force: true }); console.log("[build:app] cleared vite cache"); }

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
