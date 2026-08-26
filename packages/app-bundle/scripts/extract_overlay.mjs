#!/usr/bin/env node
// M2 overlay extractor (#451) — extracts the app-bundle overlay from the
// opencode fork at a pinned tag into packages/app-bundle/overlay/, at
// UPSTREAM-RELATIVE paths, and writes manifest.json (per-file sha256 + the
// machine-derived A/M/D classification against the upstream base).
//
//   node scripts/extract_overlay.mjs [--fork <path>] [--tag v1.18.10-amicode.14] [--slice a|ab]
//
// The fork clone defaults to the sibling checkout (team layout:
// ~/armonia/repos/opencode). Extraction is deterministic: same tag →
// identical bytes → identical hashes (files are read via git archive AT the
// tag, never the working tree).
//
// SCOPE (slice b, corrected 2026-08-21): the COMPLETE fork-vs-base delta of
// the app's build graph — packages/{app,ui,session-ui,schema,core,sdk}.
//
// The additive-only scope this slice was planned around does not typecheck:
// ~10 additive app files depend on SYMBOL-LEVEL additions in modified files
// (settings.developer, tabs.openPath, model.pin, QuestionInfo.kind — the
// typed question cards spanning schema/core/sdk), and the fork's debug-bar
// deletion forces layout.tsx into the overlay (base layout imports the
// deleted module). The fork delta is a cross-cutting FEATURE delta, not an
// app-layer delta. The complete-graph overlay is the honest scope:
//
//   - equivalence is trivial (byte-identical per package) and
//   - composition (install + typecheck + build) proves the bundle buildable
//     against a fork-equivalent tree TODAY.
//
// The manifest's per-package classification + the server-coupled files
// (schema/core/sdk — types & runtime the CANONICAL server will not have)
// are the machine-derived M3 CUTOVER PORT INVENTORY: every feature that
// spans the app and the fork's server packages is on it, because the bundle
// will hit exactly these gaps against canonical at cutover.
//
// The compose-vs-fork decomposition of the true overlays (home.tsx etc.)
// remains deliberate POST-cutover maintenance work — wholesale overlay
// inclusion is correct for the one-push cutover this plan ships.
//
// BASE: v1.18.12 — tree-equal to the fork's true merge base (b0b114923,
// v1.18.12~1) except the tag commit's version-string bumps, which land in
// files the overlay owns (package.json). The fork's v1.18.12 merge (2026-08-04)
// landed everything up to just-before the tag; the "1.18.12" version string in
// the fork's package.json is that merge's residue, not a later sync.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";

const PKG_ROOT = join(import.meta.dirname, "..");
const FORK_DEFAULT = join(homedir(), "armonia", "repos", "opencode");

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

// --out: write overlay/ + manifest.json here instead of the package root (the
// drift gate re-derives without touching committed state).
const OUT_ROOT = flag("out") ?? PKG_ROOT;

const UPSTREAM_BASE = "v1.18.12";
const TAG = flag("tag") ?? "v1.18.10-amicode.14";
const SLICE = flag("slice") ?? "full";
const FORK = flag("fork") ?? process.env.AMICODE_OPENCODE_SRC ?? FORK_DEFAULT;

const git = (...a) => execFileSync("git", ["-C", FORK, ...a], { encoding: "utf8" }).trim();
const gitAt = (spec, maxBuffer = 1 << 26) =>
  execFileSync("git", ["-C", FORK, "show", spec], { maxBuffer });

// ── 1. resolve the tag + compute the deltas ───────────────────────────────────
const tagSha = git("rev-parse", `${TAG}^{commit}`);
const baseSha = git("rev-parse", `${UPSTREAM_BASE}^{commit}`);
console.log(`[extract] fork ${FORK} @ ${TAG} (${tagSha.slice(0, 10)}), upstream base ${UPSTREAM_BASE} (${baseSha.slice(0, 10)}), slice ${SLICE}`);

function diffStatus(paths) {
  return git("diff", "--name-status", UPSTREAM_BASE, TAG, "--", ...paths)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status, path: rest[rest.length - 1] };
    });
}

const GRAPH_PKGS = ["packages/app", "packages/ui", "packages/session-ui", "packages/schema", "packages/core", "packages/sdk"];
const SERVER_COUPLED_PKGS = ["packages/schema", "packages/core", "packages/sdk"];

const graphDelta = diffStatus(GRAPH_PKGS);

const uiOverlay = graphDelta.filter((d) => d.path.startsWith("packages/ui/") && d.status !== "D").map((d) => d.path);
const appSessionAdds = graphDelta.filter((d) => !SERVER_COUPLED_PKGS.some((p) => d.path.startsWith(p + "/")) && d.path.startsWith("packages/") && !d.path.startsWith("packages/ui/") && d.status === "A").map((d) => d.path);
const appSessionMods = graphDelta.filter((d) => !SERVER_COUPLED_PKGS.some((p) => d.path.startsWith(p + "/")) && !d.path.startsWith("packages/ui/") && d.status === "M").map((d) => d.path);
const appSessionDels = graphDelta.filter((d) => d.status === "D").map((d) => d.path);
const serverCoupled = graphDelta.filter((d) => SERVER_COUPLED_PKGS.some((p) => d.path.startsWith(p + "/")) && d.status !== "D").map((d) => d.path);

// ── 2. server-coupled files (schema/core/sdk): part of the overlay (the
// bundle typechecks against them today), AND the M3 cutover port inventory
// (they carry types/runtime the canonical server will NOT have at cutover). ──

// ── 3. the overlay set ───────────────────────────────────────────────────────
const overlayFiles = [...new Set([...graphDelta.filter((d) => d.status !== "D").map((d) => d.path)])].sort();
const classification = {};
for (const d of graphDelta) if (d.status !== "D") classification[d.path] = d.status;
const deletions = graphDelta.filter((d) => d.status === "D").map((d) => d.path);

const perPkg = {};
for (const d of graphDelta) {
  const pkg = d.path.split("/").slice(0, 2).join("/");
  perPkg[pkg] ??= { A: 0, M: 0, D: 0 };
  perPkg[pkg][d.status] += 1;
}
console.log("[extract] per-package delta:", JSON.stringify(perPkg));
console.log(
  `[extract] app+session-ui overlays: ${appSessionAdds.length} A + ${appSessionMods.length} M (complete); server-coupled (schema/core/sdk): ${serverCoupled.length} files — the M3 cutover port inventory`,
);
console.log(`[extract] OVERLAY TOTAL: ${overlayFiles.length} files, ${deletions.length} deletions`);

// ── 4. extract at their upstream-relative paths, AT THE TAG ──────────────────
const overlayDir = join(OUT_ROOT, "overlay");
rmSync(overlayDir, { recursive: true, force: true });
mkdirSync(overlayDir, { recursive: true });
if (overlayFiles.length > 0) {
  // git archive arg list can get long — batch it.
  for (let i = 0; i < overlayFiles.length; i += 100) {
    const batch = overlayFiles.slice(i, i + 100);
    execFileSync("sh", [
      "-c",
      `git -C '${FORK}' archive --format=tar ${TAG} ${batch.map((f) => `'${f}'`).join(" ")} | tar -x -C '${overlayDir}'`,
    ]);
  }
}

// ── 5. manifest: hashes + classification + round-trip proof ─────────────────
const sha256Buf = (b) => createHash("sha256").update(b).digest("hex");
const hashes = {};
let mismatches = 0;
for (const rel of overlayFiles) {
  const p = join(overlayDir, rel);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) {
    // Symlinks: git archive materializes them as real symlinks; `git show`
    // prints the TARGET PATH, not the content. The round-trip proof for a
    // symlink is readlink === the git blob's content.
    const link = readlinkSync(p);
    const blob = gitAt(`${TAG}:${rel}`).toString("utf8").trimEnd();
    if (link !== blob) {
      console.error(`[extract] ROUND-TRIP MISMATCH (symlink): ${rel}: ${link} != ${blob}`);
      mismatches++;
    }
    // hash the LINK TARGET STRING (the stable, content-independent identity)
    hashes[rel] = createHash("sha256").update(link).digest("hex");
    continue;
  }
  if (!st.isFile()) throw new Error(`extractor bug: ${rel} not a regular file after archive`);
  const blob = gitAt(`${TAG}:${rel}`);
  const h = sha256Buf(readFileSync(p));
  if (h !== sha256Buf(blob)) {
    console.error(`[extract] ROUND-TRIP MISMATCH: ${rel}`);
    mismatches++;
  }
  hashes[rel] = h;
}
if (mismatches > 0) process.exit(1);
console.log(`[extract] round-trip: all ${overlayFiles.length} files byte-identical to ${TAG}`);

const manifest = {
  schema: 4,
  slices: "b (complete app-graph delta)",
  scope: "complete fork-vs-base delta of packages/{app,ui,session-ui,schema,core,sdk}",
  fork_tag: TAG,
  fork_sha: tagSha,
  upstream_base: UPSTREAM_BASE,
  upstream_base_sha: baseSha,
  extracted_at: new Date().toISOString(),
  per_package: perPkg,
  counts: {
    overlay_total: overlayFiles.length,
    deletions: deletions.length,
    server_coupled: serverCoupled.length,
  },
  // The M3 CUTOVER PORT INVENTORY: schema/core/sdk files whose types or
  // runtime the canonical server will NOT have. Every app feature touching
  // these is a cutover blocker to port upstream, reimplement in the
  // extension service, or drop from the bundle.
  server_coupled_port_inventory: serverCoupled.sort(),
  // The true overlays (big M-files in app/ui upstream still evolves),
  // recorded for the POST-cutover compose-vs-fork decomposition.
  true_overlays: graphDelta
    .filter((d) => d.status === "M" && !SERVER_COUPLED_PKGS.some((p) => d.path.startsWith(p + "/")))
    .map((d) => d.path)
    .sort(),
  deletions,
  classification,
  files: hashes,
};
writeFileSync(join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`[extract] wrote manifest.json (${overlayFiles.length} entries, ${deletions.length} deletions)`);
