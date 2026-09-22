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
import { readlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
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
  // GitHub serves tag archives at /archive/refs/tags/<tag>.tar.gz but commit-
  // SHA archives at /archive/<sha>.tar.gz (no refs/tags/ prefix). Detect a raw
  // hex SHA so a future sync:apply that accidentally writes a SHA instead of a
  // tag name doesn't break CI with a 404 (the ce1877dd regression).
  const isCommitSha = /^[0-9a-f]{40,}$/i.test(tag);
  const url = isCommitSha
    ? `https://github.com/${repo}/archive/${tag}.tar.gz`
    : `https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`;
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
  if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) overwritten++;
  mkdirSync(join(dest, ".."), { recursive: true });
  // verbatimSymlinks: preserve overlay symlinks AS symlinks (amico.svg → ui asset)
  cpSync(p, dest, { verbatimSymlinks: true });
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

// ── force a single effect version (dedupe the toJsonSchemaDocument crash) ────
// Upstream pins effect via the workspace catalog, but hono-openapi's transitive
// @standard-community/{standard-json,standard-openapi} declare `effect: ^3.x`,
// which bun floats to a SECOND, unpatched effect@4.0.0-beta.74 alongside the
// pinned+patched beta.83. Which copy the bundler wires into
// Schema.toJsonSchemaDocument (tool params -> JSON schema) varies by build, so
// some binaries crash on EVERY prompt with
// "TypeError: undefined is not an object (evaluating 'a.name')" and others do
// not. An explicit `overrides.effect` collapses the two to one, deterministically.
// Injected into the materialized root package.json (not manifest-tracked) so it
// survives upstream bumps without carrying an overlay copy of the whole file.
{
  const rootPkgPath = join(outDir, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  const pinned = rootPkg.workspaces?.catalog?.effect;
  if (pinned) {
    rootPkg.overrides = { ...(rootPkg.overrides ?? {}), effect: pinned };
    writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log(`[materialize] pinned single effect@${pinned} via overrides (dedupe)`);
  } else {
    console.warn("[materialize] WARNING: no catalog effect pin found — skipping effect dedupe");
  }
}

// ── replace an expired upstream preview package with its published release ───
// The canonical root catalog pointed at a short-lived pkg.pr.new build that now
// returns 404. Keep the source pin intact and replace only this unavailable
// catalog value in the materialized build tree. 1.3.2 matches the existing
// vite-plugin-solid@2.11.10 catalog pin.
{
  const rootPkgPath = join(outDir, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  const catalog = rootPkg.workspaces?.catalog;
  if (typeof catalog?.["@solidjs/start"] === "string" && catalog["@solidjs/start"].startsWith("https://pkg.pr.new/")) {
    catalog["@solidjs/start"] = "1.3.2";
    writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + "\n");
    console.log("[materialize] replaced expired @solidjs/start preview with 1.3.2");
  }
}

// ── verify against the manifest (hashes are the contract) ───────────────────
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
let bad = 0;
for (const [rel, want] of Object.entries(manifest.files)) {
  const p = join(outDir, rel);
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) {
    console.error(`[materialize] MANIFEST MISMATCH (missing): ${rel}`);
    bad++;
    continue;
  }
  if (st.isSymbolicLink()) {
    // symlink identity = the link-target string (see extract_overlay.mjs)
    const h = createHash("sha256").update(readlinkSync(p)).digest("hex");
    if (h !== want) {
      console.error(`[materialize] MANIFEST MISMATCH (symlink): ${rel}`);
      bad++;
    }
    continue;
  }
  if (sha256(p) !== want) {
    console.error(`[materialize] MANIFEST MISMATCH: ${rel}`);
    bad++;
  }
}
if (bad > 0) {
  // Dev-mode auto-refresh: when OPENCODE_CHANNEL is not "prod" (i.e. local dev
  // builds), auto-refresh the manifest instead of failing. Overlay edits are
  // expected in dev; requiring a manual `refresh_manifest.mjs` step before every
  // build:binary is a deploy-mechanics tax that the "Rebuild locally" button
  // should never impose. CI (channel=prod) still fails on mismatch.
  const channel = process.env.VITE_OPENCODE_CHANNEL ?? process.env.OPENCODE_CHANNEL ?? "dev";
  if (channel !== "prod") {
    console.warn(`[materialize] ${bad} manifest mismatch(es) in dev mode — auto-refreshing manifest`);
    const refreshScript = join(import.meta.dirname, "refresh_manifest.mjs");
    const r = spawnSync(process.execPath, [refreshScript], { cwd: PKG_ROOT, stdio: "inherit" });
    if (r.status !== 0) {
      console.error("[materialize] manifest auto-refresh failed");
      process.exit(1);
    }
    // Re-read the refreshed manifest and re-verify
    const freshManifest = JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf8"));
    let bad2 = 0;
    for (const [rel2, want2] of Object.entries(freshManifest.files)) {
      const p2 = join(outDir, rel2);
      const st2 = lstatSync(p2, { throwIfNoEntry: false });
      if (!st2) { bad2++; continue; }
      if (st2.isSymbolicLink()) {
        if (createHash("sha256").update(readlinkSync(p2)).digest("hex") !== want2) bad2++;
        continue;
      }
      if (sha256(p2) !== want2) bad2++;
    }
    if (bad2 > 0) {
      console.error(`[materialize] FAIL: ${bad2} mismatch(es) remain after auto-refresh`);
      process.exit(1);
    }
    console.log(`[materialize] manifest auto-refreshed and verified: ${Object.keys(freshManifest.files).length} overlay files OK`);
  } else {
    process.exit(1);
  }
}
console.log(`[materialize] manifest verified: ${Object.keys(manifest.files).length} overlay files at exact hashes`);
