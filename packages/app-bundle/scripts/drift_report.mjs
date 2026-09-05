#!/usr/bin/env node
// Drift report (#796) — classify every overlay file against the upstream tree
// at a given tag. Machine-derived (re-runnable), never hand-written.
//
//   node scripts/drift_report.mjs [--tag v1.18.29] [--upstream <dir>] [--out <json>]
//
// For every file in manifest.files (the overlay contract):
//   - not present in the upstream tree at the tag  -> "added"   (overlay-only)
//   - present, byte-identical (symlinks: link target) -> "unchanged"
//   - present, differs                             -> "modified"
// manifest.deletions are classified separately:
//   - still present upstream -> "deletion-active" (the overlay deletion still bites)
//   - gone upstream          -> "deletion-stale"  (upstream deleted it too)
//
// Default output: drift-report.json next to the manifest (committed artifact).
// The upstream tree comes from the materializer's cache when warm; otherwise
// it fetches the tag archive (same URL the materializer uses).
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const CANONICAL_REPO = "anomalyco/opencode";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf8"));
const tag = flag("tag") ?? manifest.upstream_base;
const repo = CANONICAL_REPO;
const outPath = flag("out") ?? join(PKG_ROOT, "drift-report.json");

const cacheDir = join(PKG_ROOT, ".cache", `${repo.replaceAll("/", "_")}@${tag}`);
const cacheTree = join(cacheDir, "tree");

async function upstreamTree() {
  if (flag("upstream")) return flag("upstream");
  if (existsSync(join(cacheTree, "package.json"))) return cacheTree;
  const url = `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`;
  console.log(`[drift-report] fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`upstream fetch failed: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  const archiveSha = createHash("sha256").update(bytes).digest("hex");
  const work = join(tmpdir(), `drift-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, "src.tar.gz");
  writeFileSync(archive, bytes);
  if (spawnSync("tar", ["-xzf", archive, "-C", work]).status !== 0) throw new Error("untar failed");
  const entries = readdirSync(work).filter((e) => e !== "src.tar.gz");
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  spawnSync("mv", [join(work, entries[0]), cacheTree]);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(cacheDir, "sha256"), archiveSha + "\n");
  return cacheTree;
}

const tree = await upstreamTree();

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const identity = (p) => {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  return st.isSymbolicLink() ? createHash("sha256").update(readlinkSync(p)).digest("hex") : sha256(p);
};

const files = {};
for (const [rel, overlayHash] of Object.entries(manifest.files)) {
  const up = identity(join(tree, rel));
  if (up === null) files[rel] = "added";
  else if (up === overlayHash) files[rel] = "unchanged";
  else files[rel] = "modified";
}

const deletions = {};
for (const rel of manifest.deletions ?? []) {
  deletions[rel] = existsSync(join(tree, rel)) ? "deletion-active" : "deletion-stale";
}

const count = (v, k) => Object.values(v).filter((c) => c === k).length;
const report = {
  schema: 1,
  generated_by: "packages/app-bundle/scripts/drift_report.mjs",
  repo,
  tag,
  upstream_tree: existsSync(join(tree, ".git")) ? "git" : "archive",
  counts: {
    overlay_total: Object.keys(files).length,
    added: count(files, "added"),
    modified: count(files, "modified"),
    unchanged: count(files, "unchanged"),
    deletions_active: count(deletions, "deletion-active"),
    deletions_stale: count(deletions, "deletion-stale"),
  },
  files,
  deletions,
};

rmSync(outPath, { force: true });
writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
console.log(`[drift-report] ${tag}: ${report.counts.added} added / ${report.counts.modified} modified / ${report.counts.unchanged} unchanged (of ${report.counts.overlay_total}) — ${report.counts.deletions_active} deletions active, ${report.counts.deletions_stale} stale`);
console.log(`[drift-report] wrote ${outPath}`);
