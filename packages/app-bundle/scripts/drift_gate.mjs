#!/usr/bin/env node
// M2 CI drift gate (#451) — verifies the committed overlay + manifest are in
// sync with what the fork at the pinned tag would extract, WITHOUT touching
// them. Runs in CI on PRs that touch packages/app-bundle.
//
// Checks, in order:
//   1. manifest.json's fork_tag/fork_sha and upstream_base/upstream_base_sha
//      resolve in the fork at the pinned commits.
//   2. A fresh extraction (into a temp dir, via --out) reproduces the
//      committed manifest EXACTLY (same file set, same per-file hashes).
//   3. Every file in the committed overlay/ is in the manifest and exists on
//      disk with the manifest's hash (catches hand-edits + stray files).
//
//   node scripts/drift_gate.mjs [--fork <path>] [--tag v1.18.10-amicode.14]
//
// Exit 0 = in sync. Exit 1 = drift (names the first divergence).
// NOTE: the fork clone is a private repo — in CI the gate runs only when the
// checkout is present (AMICODE_OPENCODE_SRC or the sibling layout); otherwise
// it SKIPS with exit 0 and a printed reason (the committed overlay itself is
// the artifact CI protects; the re-derivation needs fork access).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const FORK_DEFAULT = join(homedir(), "armonia", "repos", "opencode");

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifestPath = join(PKG_ROOT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const TAG = flag("tag") ?? manifest.fork_tag;
const FORK = flag("fork") ?? process.env.AMICODE_OPENCODE_SRC ?? FORK_DEFAULT;

const fail = (msg) => {
  console.error(`[drift-gate] FAIL: ${msg}`);
  process.exit(1);
};

if (!existsSync(FORK) || !existsSync(join(FORK, ".git"))) {
  console.log(`[drift-gate] SKIP: no fork clone at ${FORK} (set AMICODE_OPENCODE_SRC) — protecting committed state only`);
}

// ── 1. manifest pins resolve ────────────────────────────────────────────────
if (existsSync(FORK)) {
  const git = (...a) => execFileSync("git", ["-C", FORK, ...a], { encoding: "utf8" }).trim();
  const tagSha = git("rev-parse", `${TAG}^{commit}`);
  if (tagSha !== manifest.fork_sha) {
    fail(`manifest.fork_sha ${manifest.fork_sha.slice(0, 10)} != ${TAG} (${tagSha.slice(0, 10)}) — re-run the extractor`);
  }
  const baseSha = git("rev-parse", `${manifest.upstream_base}^{commit}`);
  if (baseSha !== manifest.upstream_base_sha) {
    fail(`manifest.upstream_base_sha disagrees with ${manifest.upstream_base}`);
  }
  console.log(`[drift-gate] pins resolve: ${TAG} (fork) on base ${manifest.upstream_base}`);

  // ── 2. fresh extraction reproduces the committed manifest ────────────────
  const work = mkdtempSync(join(tmpdir(), "app-bundle-drift-"));
  try {
    execFileSync("node", [join(PKG_ROOT, "scripts", "extract_overlay.mjs"), "--fork", FORK, "--tag", TAG, "--out", work], {
      cwd: PKG_ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const fresh = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
    if (Object.keys(fresh.files).length !== Object.keys(manifest.files).length) {
      fail(`file-set drift: fresh extraction has ${Object.keys(fresh.files).length} files, committed manifest has ${Object.keys(manifest.files).length} — re-run the extractor`);
    }
    for (const [rel, want] of Object.entries(manifest.files)) {
      if (fresh.files[rel] !== want) {
        fail(`hash drift on ${rel}: committed ${want.slice(0, 10)}, fresh ${String(fresh.files[rel] ?? "(missing)").slice(0, 10)} — re-run the extractor`);
      }
    }
    console.log(`[drift-gate] fresh extraction matches the committed manifest (${Object.keys(manifest.files).length} files)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ── 3. committed overlay/ matches the manifest (always runs) ────────────────
const overlayDir = join(PKG_ROOT, "overlay");
const onDisk = new Set();
for (const rel of readdirSync(overlayDir, { recursive: true })) {
  const p = join(overlayDir, rel.toString());
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    onDisk.add(rel.toString()); // hashed as the link-target string
    continue;
  }
  if (st.isFile()) onDisk.add(rel.toString());
}
const inManifest = new Set(Object.keys(manifest.files));
const stray = [...onDisk].filter((f) => !inManifest.has(f));
const missing = [...inManifest].filter((f) => !onDisk.has(f));
if (stray.length > 0) fail(`stray files in overlay/ not in the manifest: ${stray.slice(0, 3).join(", ")}${stray.length > 3 ? " …" : ""}`);
if (missing.length > 0) fail(`manifest files missing from overlay/: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " …" : ""}`);
for (const [rel, want] of Object.entries(manifest.files)) {
  const p = join(overlayDir, rel);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) fail(`overlay file missing on disk: ${rel}`);
  const h = st.isSymbolicLink()
    ? createHash("sha256").update(readlinkSync(p)).digest("hex")
    : createHash("sha256").update(readFileSync(p)).digest("hex");
  if (h !== want) fail(`overlay file hash mismatch (hand-edit?): ${rel} — re-run the extractor`);
}
console.log(`[drift-gate] committed overlay verified against the manifest (${onDisk.size} files)`);
console.log("[drift-gate] PASS: overlay, manifest, and (when the fork is present) the extraction are in sync");
