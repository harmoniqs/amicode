#!/usr/bin/env node
// One-command loop for developing the vendored opencode fork against amicode.
//
// Default vendoring is `release` (opencode.lock.json source=release): a plain
// `pnpm install` / `package` / F5 downloads the pinned, features-ON binary — no
// clone, no bun. You only enter source mode when you are CHANGING opencode, and
// you do it by RUNNING a command here, never by editing the committed lock.
//
//   pnpm opencode:build         rebuild the binary from your ../opencode clone
//                               (OPENCODE_CHANNEL=dev → amicode UI ON) and
//                               re-vendor it. Reload the dev host to pick it up.
//   pnpm opencode:pin <tag>     adopt a cut release (e.g. v1.17.3-amicode.5):
//                               download + sha256-verify both platform assets,
//                               rewrite opencode.lock.json. Commit that + PR.
//
// Web-UI iteration (packages/app surfaces) requires a rebuild — the channel
// define is baked at build time, so there is no hot path through `serve`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, resolveCloneDir, sha256 } from "./fetch_opencode.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Download a private-release asset via the authenticated gh CLI (same path the
 *  fetcher uses). Injectable for tests. */
export function ghDownloadAsset(repo, tag, asset) {
  const work = mkdtempSync(join(PKG_ROOT, ".pin-"));
  try {
    execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", work], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return readFileSync(join(work, asset));
  } catch (e) {
    throw new Error(`gh release download failed for ${repo}@${tag} ${asset}: ${e.message}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Rewrite opencode.lock.json to a cut release: set tag + each platform's ACTUAL
 *  downloaded sha256 (+ ref when provided). Preserves key order and formatting.
 *  Returns { tag, ref, platforms: { <key>: <sha> } }. */
export function pinFromRelease({ root = PKG_ROOT, tag, ref, download = ghDownloadAsset } = {}) {
  if (!tag) throw new Error("pin: a release tag is required (e.g. pnpm opencode:pin v1.17.3-amicode.5)");
  const lockPath = join(root, "opencode.lock.json");
  const m = JSON.parse(readFileSync(lockPath, "utf8"));
  const repo = m.repo ?? "sst/opencode";
  const shas = {};
  for (const [key, p] of Object.entries(m.platforms ?? {})) {
    const bytes = download(repo, tag, p.asset);
    p.sha256 = sha256(bytes);
    shas[key] = p.sha256;
  }
  m.tag = tag;
  if (ref) {
    if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`pin: --ref must be a 40-hex commit, got ${ref}`);
    m.ref = ref;
  }
  writeFileSync(lockPath, JSON.stringify(m, null, 2) + "\n");
  return { tag, ref: m.ref, platforms: shas };
}

function build() {
  const cloneDir = resolveCloneDir(PKG_ROOT);
  console.log(`[opencode:build] building from ${cloneDir} with OPENCODE_CHANNEL=dev, re-vendoring…`);
  // --any-ref: during active dev your clone is off the pinned ref by design.
  execFileSync("node", [join(PKG_ROOT, "scripts", "fetch_opencode.mjs"), "--local", "--any-ref"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  console.log("[opencode:build] done — reload the Extension Dev Host (Cmd/Ctrl+R) to pick up the new binary.");
}

function help() {
  console.log(
    [
      "opencode dev loop (default vendoring is `release` — no clone/bun needed unless you change opencode):",
      "",
      "  pnpm opencode:build        rebuild the binary from ../opencode (UI ON) and re-vendor it",
      "  pnpm opencode:pin <tag>    adopt a cut release into opencode.lock.json (download + verify + rewrite)",
      "",
      "Flow: edit ../opencode → pnpm opencode:build → reload dev host → verify.",
      "      Happy? push the opencode branch, tag a release (its workflow builds both binaries),",
      "      then here: pnpm opencode:pin <tag> && commit the lock bump + PR.",
      "Never hand-edit opencode.lock.json `source`; changing opencode is a command, not a commit.",
    ].join("\n"),
  );
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "build") return build();
  if (cmd === "pin") {
    const tag = rest.find((a) => !a.startsWith("--"));
    const i = rest.indexOf("--ref");
    const ref = i >= 0 ? rest[i + 1] : undefined;
    const r = pinFromRelease({ tag, ref });
    console.log(`[opencode:pin] opencode.lock.json → ${r.tag}${r.ref ? ` @ ${r.ref.slice(0, 10)}` : ""}`);
    for (const [k, v] of Object.entries(r.platforms)) console.log(`  ${k}  ${v}`);
    console.log("[opencode:pin] commit the lock bump and open a PR.");
    return;
  }
  help();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[opencode-dev] ${e.message}`);
    process.exitCode = 1;
  }
}
