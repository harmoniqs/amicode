#!/usr/bin/env node
// build_binary.mjs — compile the opencode engine binary from the materialized
// overlay tree (stock upstream + overlay applied on top).  Phase 2a of
// fork-absorption (#1094): replaces the fork-release download path
// (`fetch:opencode --release`) with a local build.
//
// USAGE
//   node scripts/build_binary.mjs               # full recipe
//   node scripts/build_binary.mjs --work <dir>  # reuse an existing materialized tree
//
// Prerequisites: bun (https://bun.sh) — the build uses `bun build --compile`.
//
// The build produces a single-platform binary at
//   vendor/opencode/<platform>/opencode
// with .sha256 and .source sidecars (matching the fetch_opencode.mjs contract).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  console.error(`[build:binary] FAIL: ${msg}`);
  process.exit(code);
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ── bun resolution (same ladder as fetch_opencode.mjs) ──────────────────────
function resolveBun() {
  if (process.env.AMICODE_BUN) return process.env.AMICODE_BUN;
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) return which.stdout.trim();
  const fallback = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(fallback)) return fallback;
  fail(
    "bun not found — the binary build requires bun (https://bun.sh).\n" +
      "  Install it:  curl -fsSL https://bun.sh/install | bash\n" +
      "  Or set:      AMICODE_BUN=/path/to/bun",
  );
}

const run = (cmd, cmdArgs, cwd, note) => {
  console.log(`[build:binary] ${note}: ${cmd} ${cmdArgs.join(" ")} (cwd=${cwd})`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit" });
  if (r.status !== 0) fail(`${note} failed (exit ${r.status})`, 2);
};

// ── platform key (matches fetch_opencode.mjs KNOWN_PLATFORMS) ───────────────
// --platform <key> enables cross-compilation (e.g. --platform linux-arm64 on
// a linux-x64 host).  Without it, the host platform is used + --single flag.
const requestedPlatform = flag("platform");
const platformKey = requestedPlatform ?? `${process.platform}-${process.arch}`;
const isCross = requestedPlatform && requestedPlatform !== `${process.platform}-${process.arch}`;

// ── load the lock for OPENCODE_VERSION ──────────────────────────────────────
const lockPath = join(EXT_ROOT, "opencode.lock.json");
if (!existsSync(lockPath)) fail(`opencode.lock.json not found at ${lockPath}`);
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (!lock.version) fail("opencode.lock.json has no version field");
const version = lock.version;
console.log(`[build:binary] version from lock: ${version}`);
console.log(`[build:binary] platform: ${platformKey}`);

// ── load the app-bundle manifest for overlay provenance ─────────────────────
const manifestPath = join(BUNDLE_PKG, "manifest.json");
let manifestSha = "unknown";
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifestSha = manifest.overlay_sha ?? "unknown";
} else {
  console.warn("[build:binary] WARNING: no app-bundle manifest.json — provenance will say 'unknown'");
}

// ── materialized tree (reuse build:app's tree or create one) ────────────────
const work = flag("work") ?? process.env.AMICODE_APP_BUNDLE_WORK ?? join(BUNDLE_PKG, ".materialized");

// Overlay staleness check — same mechanism as build_app_bundle.mjs
const OVERLAY_STAMP = join(work, ".overlay-stamp");
const overlayVersion = (() => {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    return `${m.overlay_sha ?? ""}:${m.promoted_at ?? ""}`;
  } catch { return null; }
})();
const cachedVersion = (() => {
  try { return readFileSync(OVERLAY_STAMP, "utf8").trim(); }
  catch { return null; }
})();
const cacheExists = existsSync(join(work, "package.json"));
const cacheStale = cacheExists && overlayVersion && cachedVersion !== overlayVersion;

if (cacheStale) {
  console.log("[build:binary] overlay changed (manifest overlay_sha differs from cached stamp) — clearing stale .materialized");
  console.log(`[build:binary]   cached:  ${cachedVersion ?? "(none)"}`);
  console.log(`[build:binary]   current: ${overlayVersion}`);
  rmSync(work, { recursive: true, force: true });
}

if (!existsSync(join(work, "package.json"))) {
  run(
    process.execPath,
    [join(BUNDLE_PKG, "scripts", "materialize.mjs"), "--out", work],
    REPO_ROOT,
    "materialize (canonical base + overlay)",
  );
  // Stamp so subsequent builds can detect staleness
  if (overlayVersion) writeFileSync(OVERLAY_STAMP, overlayVersion + "\n");
} else {
  console.log(`[build:binary] reusing materialized tree at ${work}`);
  // Backfill stamp for trees materialized before this check existed
  if (!cachedVersion && overlayVersion) {
    writeFileSync(OVERLAY_STAMP, overlayVersion + "\n");
    console.log("[build:binary] backfilled .overlay-stamp for existing .materialized tree");
  }
}

const opencodePkg = join(work, "packages", "opencode");
if (!existsSync(opencodePkg))
  fail(`${work} has no packages/opencode — not a materialized tree`);

// ── bun install in the materialized tree ────────────────────────────────────
const bun = resolveBun();
console.log(`[build:binary] bun: ${bun}`);
// --ignore-scripts avoids tree-sitter node-gyp rebuilds on CI runners whose
// Node version may lack undici internals that node-gyp's download.js pulls in.
// bun resolves the pre-built tree-sitter binaries without needing node-gyp.
run(bun, ["install", "--ignore-scripts"], work, "bun install (materialized tree deps)");

// ── build the binary ────────────────────────────────────────────────────────
// The fork's build recipe: Script reads OPENCODE_VERSION and OPENCODE_CHANNEL
// from env.  OPENCODE_RELEASE must NOT be set (it triggers release upload).
// --single:          build only the current platform (used for native builds)
// --skip-install:    deps already installed above
// --skip-embed-web-ui: the shelf serves the app separately
//
// Cross-compilation: when --platform specifies a non-native target,
// OPENCODE_BUILD_TARGETS selects the specific target in build.ts (S3 proven).
// The --single flag is dropped because cross-compilation needs build.ts to
// consider all targets, then OPENCODE_BUILD_TARGETS filters to the one we want.
const buildEnv = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: "dev",
  PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ""}`,
};
// Defensive: ensure OPENCODE_RELEASE is NOT set
delete buildEnv.OPENCODE_RELEASE;

// For cross-compilation, set OPENCODE_BUILD_TARGETS to the specific platform
if (isCross) {
  buildEnv.OPENCODE_BUILD_TARGETS = `opencode-${platformKey}`;
}

const buildArgs = ["run", "script/build.ts"];
if (!isCross) buildArgs.push("--single");
// When cross-compiling, do NOT pass --skip-install: build.ts installs
// cross-platform optional deps (@opentui/core, @parcel/watcher, @ff-labs/fff-bun)
// with --os="*" --cpu="*" which is required for the target platform's native bindings.
// For native builds, --skip-install is safe since we already ran bun install above.
if (!isCross) buildArgs.push("--skip-install");
buildArgs.push("--skip-embed-web-ui");

console.log(`[build:binary] building with OPENCODE_CHANNEL=dev OPENCODE_VERSION=${version}${isCross ? ` (cross: ${platformKey})` : ""}`);
const buildResult = spawnSync(
  bun,
  buildArgs,
  { cwd: opencodePkg, env: buildEnv, stdio: "inherit" },
);
if (buildResult.status !== 0) fail(`binary build failed (exit ${buildResult.status})`);

// ── locate the artifact ─────────────────────────────────────────────────────
const artifactName = `opencode-${platformKey}`;
const artifact = join(opencodePkg, "dist", artifactName, "bin", "opencode");
if (!existsSync(artifact))
  fail(`built binary not found at ${artifact} — build produced no artifact for ${platformKey}`);

console.log(`[build:binary] built artifact: ${artifact}`);

// ── install into vendor/ ────────────────────────────────────────────────────
const destDir = join(EXT_ROOT, "vendor", "opencode", platformKey);
const destBin = join(destDir, "opencode");
mkdirSync(destDir, { recursive: true });

const bytes = readFileSync(artifact);
const hash = sha256(bytes);
const provenance = `overlay ${manifestSha}`;

writeFileSync(destBin, bytes);
chmodSync(destBin, 0o755);
writeFileSync(join(destDir, ".sha256"), hash + "\n");
writeFileSync(join(destDir, ".source"), provenance + "\n");

// ── .buildinfo sidecar — channel assertion for assert_ui_gate.sh (#1096) ────
const buildinfo = [
  `OPENCODE_CHANNEL=dev`,
  `OPENCODE_VERSION=${version}`,
  `BUILD_DATE=${new Date().toISOString()}`,
].join("\n") + "\n";
writeFileSync(join(destDir, ".buildinfo"), buildinfo);

console.log(`[build:binary] installed: ${destBin}`);
console.log(`[build:binary] sha256:    ${hash}`);
console.log(`[build:binary] source:    ${provenance}`);
console.log(`[build:binary] buildinfo: OPENCODE_CHANNEL=dev OPENCODE_VERSION=${version}`);

// ── smoke test: version check (native builds only) ──────────────────────────
// Cross-compiled binaries cannot be executed on the build host.
if (isCross) {
  console.log(`[build:binary] cross-compiled for ${platformKey} — skipping version smoke test`);
} else {
  const ver = spawnSync(destBin, ["--version"], { encoding: "utf8", timeout: 10000 });
  if (ver.status !== 0) {
    console.warn(`[build:binary] WARNING: version check failed (exit ${ver.status}): ${ver.stderr?.trim()}`);
  } else {
    console.log(`[build:binary] version:   ${ver.stdout.trim()}`);
  }
}

console.log("[build:binary] DONE");
