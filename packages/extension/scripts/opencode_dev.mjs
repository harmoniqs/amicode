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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, resolveCloneDir, sha256 } from "./fetch_opencode.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (dir, ...args) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Stamp vendor/opencode/<platform>/.buildinfo so anyone holding the built
 *  extension (dev host, remote machine, a vsix) can tell EXACTLY which fork
 *  state produced the vendored binary — the .source/.sha256 stamps record
 *  source+hash but not branch or dirty state, and --any-ref builds deliberately
 *  accept any checkout. JSON, one object per platform dir. */
export function stampBuildInfo({ source, repo, version, cloneDir, tag, root = PKG_ROOT }) {
  const vendorRoot = join(root, "vendor", "opencode");
  if (!existsSync(vendorRoot)) return;
  const info = {
    source,
    version,
    builtAt: new Date().toISOString(),
    ...(repo ? { repo } : {}),
    ...(tag ? { tag } : {}),
  };
  if (cloneDir) {
    info.clonePath = cloneDir;
    try {
      info.branch = git(cloneDir, "symbolic-ref", "--short", "-q", "HEAD") || "(detached)";
    } catch {
      // Detached checkout (CI checks out the merge ref, not the branch): the
      // checked-out ref is still attributable — GitHub Actions names it in
      // GITHUB_HEAD_REF (PRs) / GITHUB_REF_NAME (pushes). Absent both, the
      // stamp is honestly "(unknown)" rather than a guessed name.
      info.branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "(unknown)";
    }
    info.commit = git(cloneDir, "rev-parse", "HEAD");
    info.dirty = git(cloneDir, "status", "--porcelain") !== "";
  }
  for (const key of readdirSync(vendorRoot)) {
    const dir = join(vendorRoot, key);
    if (!existsSync(join(dir, "opencode"))) continue;
    writeFileSync(join(dir, ".buildinfo"), JSON.stringify(info, null, 2) + "\n");
  }
}

/** Check a vendored binary's provenance. Prints one line per platform dir. */
export function checkBuildInfo(root = PKG_ROOT) {
  const vendorRoot = join(root, "vendor", "opencode");
  if (!existsSync(vendorRoot)) return "[opencode] no vendored binary yet";
  const lines = [];
  for (const key of readdirSync(vendorRoot).sort()) {
    const dir = join(vendorRoot, key);
    if (!existsSync(join(dir, "opencode"))) continue;
    const stamp = readdirSync(dir).includes(".buildinfo")
      ? readFileSync(join(dir, ".buildinfo"), "utf8").trim().replace(/\n/g, " ")
      : "(no .buildinfo — built before stamping was added; check .source/.sha256)";
    lines.push(`[opencode] ${key}: ${stamp}`);
  }
  return lines.length > 0 ? lines.join("\n") : "[opencode] no vendored binary yet";
}

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

/** Resolve a release tag to the 40-hex COMMIT it points at, via the authenticated
 *  gh CLI. Annotated tags (what amicode-release cuts) resolve to a tag object that
 *  must be dereferenced; lightweight tags point straight at the commit. Injectable
 *  for tests. */
export function ghResolveTagCommit(repo, tag) {
  const api = (path) =>
    JSON.parse(execFileSync("gh", ["api", `repos/${repo}/${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const obj = api(`git/ref/tags/${tag}`).object;
  if (obj.type === "commit") return obj.sha;
  if (obj.type === "tag") return api(`git/tags/${obj.sha}`).object.sha;
  throw new Error(`pin: tag ${tag} points at a ${obj.type}, expected commit or tag`);
}

/** Rewrite opencode.lock.json to a cut release: set tag + each platform's ACTUAL
 *  downloaded sha256 (+ ref when provided). Preserves key order and formatting.
 *  Returns { tag, ref, platforms: { <key>: <sha> } }. */
export function pinFromRelease({ root = PKG_ROOT, tag, ref, download = ghDownloadAsset, resolveTagCommit = ghResolveTagCommit } = {}) {
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
  // Resolve the ref from the tag unless one is given explicitly. Leaving it stale
  // is worse than absent: `source: "local"` VALIDATES ref against the clone HEAD
  // (fetch_opencode.mjs), so a ref left pointing at the PREVIOUS release tells a
  // fork developer to check out the wrong commit. Release mode ignores ref — the
  // tag drives the download and sha256 verifies it — so this is provenance, but
  // provenance that is load-bearing the moment anyone switches to source mode.
  let resolved = ref;
  if (!resolved) {
    try {
      resolved = resolveTagCommit(repo, tag);
    } catch (e) {
      throw new Error(
        `pin: could not resolve ${repo}@${tag} to a commit (${e.message}). ` +
          `Pass --ref <40-hex> explicitly if the tag is not reachable via gh.`,
      );
    }
  }
  if (!/^[0-9a-f]{40}$/.test(resolved))
    throw new Error(`pin: ref must be a 40-hex commit, got ${resolved}`);
  m.ref = resolved;
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
  const manifest = loadManifest();
  stampBuildInfo({ source: "local", repo: manifest.repo, version: manifest.version, cloneDir });
  console.log(
    `[opencode:build] done — vendored from ${cloneDir} @ ${git(cloneDir, "symbolic-ref", "--short", "-q", "HEAD")} ${git(cloneDir, "rev-parse", "HEAD").slice(0, 10)} ` +
      `(dirty: ${git(cloneDir, "status", "--porcelain") !== ""}) — reload the Extension Dev Host (Cmd/Ctrl+R) to pick up the new binary.`,
  );
  console.log(checkBuildInfo());
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
    const manifest = loadManifest();
    stampBuildInfo({ source: "release", repo: manifest.repo, version: manifest.version, tag: r.tag });
    console.log(`[opencode:pin] opencode.lock.json → ${r.tag}${r.ref ? ` @ ${r.ref.slice(0, 10)}` : ""}`);
    for (const [k, v] of Object.entries(r.platforms)) console.log(`  ${k}  ${v}`);
    console.log(checkBuildInfo());
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
