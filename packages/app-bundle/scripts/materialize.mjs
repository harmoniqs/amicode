#!/usr/bin/env node
// M2 materializer (#451) — produce a full app source tree:
// canonical anomalyco/opencode @ <tag> + the app-bundle overlay applied on top.
//
//   node scripts/materialize.mjs --out <dir> [--tag v1.18.10] [--repo anomalyco/opencode]
//
// The upstream tarball is fetched once per tag into a cache dir
// (.cache/ under this package, gitignored) and verified against the
// SHA256SUMS-style manifest recorded at first fetch. Overlay files overwrite
// upstream paths (bucket M) or add new ones (bucket A) — copy is the whole
// conflict policy for slice (a); the drift report is a separate concern.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const CANONICAL_REPO = "anomalyco/opencode";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const outDir = flag("out");
if (!outDir) {
  console.error("usage: node scripts/materialize.mjs --out <dir> [--tag <git-tag>] [--repo <owner/name>]");
  process.exit(1);
}
const tag = flag("tag") ?? JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf8")).upstream_base;
const repo = flag("repo") ?? CANONICAL_REPO;

const cacheDir = join(PKG_ROOT, ".cache", `${repo.replaceAll("/", "_")}@${tag}`);
const cacheTree = join(cacheDir, "tree");
const cacheStamp = join(cacheDir, "sha256");

async function fetchUpstream() {
  if (existsSync(cacheStamp)) {
    console.log(`[materialize] upstream ${repo}@${tag} (cached)`);
    return cacheTree;
  }
  const url = `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`;
  console.log(`[materialize] fetching ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`upstream fetch failed: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  rmSync(cacheDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  const work = join(tmpdir(), `materialize-${Date.now()}`);
  mkdirSync(work, { recursive: true });
  const archive = join(work, "src.tar.gz");
  writeFileSync(archive, bytes);
  const untar = spawnSync("tar", ["-xzf", archive, "-C", work]);
  if (untar.status !== 0) throw new Error(`untar failed: ${untar.stderr}`);
  // GitHub tag archives unpack to <repo>-<tag>/
  const entries = readdirSync(work).filter((e) => e !== "src.tar.gz");
  if (entries.length !== 1) throw new Error(`unexpected archive layout: ${entries.join(", ")}`);
  rmSync(cacheTree, { recursive: true, force: true });
  spawnSync("mv", [join(work, entries[0]), cacheTree]);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(cacheStamp, createHash("sha256").update(bytes).digest("hex") + "\n");
  return cacheTree;
}

const upstreamTree = await fetchUpstream();

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf8"));

// ── out = upstream tree, then overlay on top ─────────────────────────────────
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, ".."), { recursive: true });
spawnSync("cp", ["-R", cacheTree, outDir]);
if (!existsSync(join(outDir, "packages"))) throw new Error("upstream tree copy failed — no packages/ in output");

const overlayDir = join(PKG_ROOT, "overlay");
let applied = 0;
let overwritten = 0;
for (const rel of readdirSync(overlayDir, { recursive: true })) {
  const p = join(overlayDir, rel.toString());
  if (!statSync(p).isFile()) continue;
  const dest = join(outDir, rel.toString());
  if (existsSync(dest)) overwritten++;
  mkdirSync(join(dest, ".."), { recursive: true });
  cpSync(p, dest);
  applied++;
}
console.log(`[materialize] tree at ${outDir}: upstream ${repo}@${tag} + overlay (${applied} files applied, ${overwritten} overwrote upstream)`);

// ── deletions (bucket D): files the fork deleted vs the base ────────────────
let deleted = 0;
for (const rel of manifest.deletions ?? []) {
  const p = join(outDir, rel);
  if (existsSync(p)) {
    rmSync(p);
    deleted++;
  }
}
if (deleted > 0) console.log(`[materialize] applied ${deleted} overlay deletions`);

// ── verify against the manifest (hashes are the contract) ───────────────────
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let bad = 0;
for (const [rel, want] of Object.entries(manifest.files)) {
  const p = join(outDir, rel);
  if (!existsSync(p) || sha256(p) !== want) {
    console.error(`[materialize] MANIFEST MISMATCH: ${rel}`);
    bad++;
  }
}
if (bad > 0) process.exit(1);
console.log(`[materialize] manifest verified: ${Object.keys(manifest.files).length} overlay files at exact hashes`);
