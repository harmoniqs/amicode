#!/usr/bin/env node
// Manifest refresh (#796) — recompute manifest.json from the committed overlay
// against the upstream tree at manifest.upstream_base. Post-re-base this is how
// the manifest stays honest: the overlay is now maintained against upstream
// (repairs applied directly), no longer a byte-exact extraction of the fork.
//
//   node scripts/refresh_manifest.mjs [--upstream <dir>]
//
// Recomputes: files (hashes), classification (A/M vs upstream base),
// per_package counts, counts, deletions (dropped when stale upstream).
// Preserves: schema, slices, scope, fork_tag/fork_sha (extraction origin).
// Bumps: extracted_at.
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const manifestPath = join(PKG_ROOT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const tag = manifest.upstream_base;
const upstream = flag("upstream") ?? join(PKG_ROOT, ".cache", `anomalyco_opencode@${tag}`, "tree");
if (!existsSync(join(upstream, "package.json"))) {
  console.error(`[refresh-manifest] no upstream tree at ${upstream} — materialize first`);
  process.exit(1);
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const identity = (p) => {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st) return null;
  return st.isSymbolicLink() ? createHash("sha256").update(readlinkSync(p)).digest("hex") : sha256(p);
};

const overlayDir = join(PKG_ROOT, "overlay");
const files = {};
const classification = {};
const perPackage = {};
for (const rel of readdirSync(overlayDir, { recursive: true })) {
  const p = join(overlayDir, rel.toString());
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (!st || !(st.isFile() || st.isSymbolicLink())) continue;
  const key = rel.toString();
  const h = st.isSymbolicLink() ? createHash("sha256").update(readlinkSync(p)).digest("hex") : sha256(p);
  files[key] = h;
  const up = identity(join(upstream, key));
  classification[key] = up === null || up === h ? "A" : "M";
  const pkg = "packages/" + key.split("/")[1];
  perPackage[pkg] = perPackage[pkg] ?? { A: 0, M: 0, D: 0 };
  perPackage[pkg][classification[key]]++;
}

const deletions = (manifest.deletions ?? []).filter((rel) => existsSync(join(upstream, rel)));

const next = {
  ...manifest,
  upstream_base_sha: flag("base-sha") ?? manifest.upstream_base_sha,
  extracted_at: new Date().toISOString(),
  per_package: Object.fromEntries(Object.entries(perPackage).sort(([a], [b]) => a.localeCompare(b))),
  counts: {
    overlay_total: Object.keys(files).length,
    deletions: deletions.length,
    server_coupled: (manifest.server_coupled_port_inventory ?? []).length,
  },
  true_overlays: manifest.true_overlays,
  server_coupled_port_inventory: manifest.server_coupled_port_inventory,
  deletions,
  classification,
  files,
};

writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n");
const counts = next.counts;
const modified = Object.values(classification).filter((c) => c === "M").length;
console.log(`[refresh-manifest] ${counts.overlay_total} overlay files (${modified} M vs ${tag}, ${counts.deletions} deletions) — manifest refreshed`);
