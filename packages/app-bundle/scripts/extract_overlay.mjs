#!/usr/bin/env node
// M2 slice (a) overlay extractor (#451) — extracts the app-bundle overlay from
// the opencode fork at a pinned tag into packages/app-bundle/overlay/, at
// UPSTREAM-RELATIVE paths, and writes manifest.json (per-file sha256 + the
// machine-derived A/M/D classification against the upstream base).
//
//   node scripts/extract_overlay.mjs [--fork <path>] [--tag v1.18.10-amicode.14]
//
// The fork clone defaults to the sibling checkout (team layout:
// ~/armonia/repos/opencode). Extraction is deterministic: same tag →
// identical bytes → identical hashes (files are read via git archive AT the
// tag, never the working tree).
//
// SLICE (a) SCOPE — the COMPLETE packages/ui delta:
//   overlay = every file under packages/ui that is Added or Modified vs the
//   upstream base. Complete by construction: materialize(upstream@base,
//   overlay) ≡ fork@tag packages/ui, byte for byte. The whole-directory
//   classification (A/M/D per file) is recorded in the manifest — the
//   machine-derived inventory for later decomposition slices.
//
// BASE: v1.18.12 — tree-equal to the fork's true merge base (b0b114923,
// v1.18.12~1) except the tag commit's version-string bumps, which land in
// files the overlay owns (package.json). The fork's v1.18.12 merge (2026-08-04)
// landed everything up to just-before the tag; the "1.18.12" version string in
// the fork's package.json is that merge's residue, not a later sync.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const FORK_DEFAULT = join(homedir(), "armonia", "repos", "opencode");

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const UPSTREAM_BASE = "v1.18.12";
const TAG = flag("tag") ?? "v1.18.10-amicode.14";
const FORK = flag("fork") ?? process.env.AMICODE_OPENCODE_SRC ?? FORK_DEFAULT;

const git = (...a) => execFileSync("git", ["-C", FORK, ...a], { encoding: "utf8" }).trim();
const sha256Buf = (b) => createHash("sha256").update(b).digest("hex");

// ── 1. resolve the tag + compute the complete packages/ui delta ───────────────
const tagSha = git("rev-parse", `${TAG}^{commit}`);
const baseSha = git("rev-parse", `${UPSTREAM_BASE}^{commit}`);
console.log(`[extract] fork ${FORK} @ ${TAG} (${tagSha.slice(0, 10)}), upstream base ${UPSTREAM_BASE} (${baseSha.slice(0, 10)})`);

const delta = git("diff", "--name-status", UPSTREAM_BASE, TAG, "--", "packages/ui")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [status, ...rest] = line.split("\t");
    return { status, path: rest[rest.length - 1] };
  });
const adds = delta.filter((d) => d.status === "A").map((d) => d.path);
const mods = delta.filter((d) => d.status === "M").map((d) => d.path);
const dels = delta.filter((d) => d.status === "D").map((d) => d.path);
const overlayFiles = [...adds, ...mods].sort();
console.log(`[extract] packages/ui delta vs ${UPSTREAM_BASE}: ${adds.length} added, ${mods.length} modified, ${dels.length} deleted → overlay of ${overlayFiles.length} files`);

// ── 2. extract overlay files at their upstream-relative paths, AT THE TAG ────
const overlayDir = join(PKG_ROOT, "overlay");
rmSync(overlayDir, { recursive: true, force: true });
mkdirSync(overlayDir, { recursive: true });
execFileSync("sh", ["-c", `git -C '${FORK}' archive --format=tar ${TAG} ${overlayFiles.map((f) => `'${f}'`).join(" ")} | tar -x -C '${overlayDir}'`]);

// ── 3. manifest: hashes + classification + round-trip proof ─────────────────
const hashes = {};
const classification = {};
let mismatches = 0;
for (const rel of overlayFiles) {
  const p = join(overlayDir, rel);
  if (!statSync(p).isFile()) throw new Error(`extractor bug: ${rel} not a file after archive`);
  const blob = execFileSync("git", ["-C", FORK, "show", `${TAG}:${rel}`], { maxBuffer: 1 << 26 });
  const h = sha256Buf(readFileSync(p));
  if (h !== sha256Buf(blob)) {
    console.error(`[extract] ROUND-TRIP MISMATCH: ${rel}`);
    mismatches++;
  }
  hashes[rel] = h;
  classification[rel] = adds.includes(rel) ? "A" : "M";
}
if (mismatches > 0) process.exit(1);
console.log(`[extract] round-trip: all ${overlayFiles.length} files byte-identical to ${TAG}`);

// Unchanged files (sanity: ui files at tag not in the overlay come from the base)
const uiAtTag = git("ls-tree", "-r", "--name-only", TAG, "--", "packages/ui").split("\n").filter(Boolean);
const unchanged = uiAtTag.filter((f) => !overlayFiles.includes(f) && !dels.includes(f));
console.log(`[extract] ui files at tag: ${uiAtTag.length} = ${overlayFiles.length} overlay + ${unchanged.length} base-unchanged + ${dels.length} deleted`);

const manifest = {
  schema: 2,
  slice: "a",
  scope: "packages/ui (complete delta)",
  fork_tag: TAG,
  fork_sha: tagSha,
  upstream_base: UPSTREAM_BASE,
  upstream_base_sha: baseSha,
  extracted_at: new Date().toISOString(),
  counts: { added: adds.length, modified: mods.length, deleted: dels.length, unchanged: unchanged.length },
  deletions: dels,
  classification,
  files: hashes,
};
writeFileSync(join(PKG_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[extract] wrote manifest.json (${overlayFiles.length} entries, ${dels.length} deletions)`);
