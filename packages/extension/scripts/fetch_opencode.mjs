#!/usr/bin/env node
// Vendoring of the opencode chat-server binary, pinned by opencode.lock.json
// (spec §2/§3). Two sources:
//   release (default) — download the pinned release asset, verify sha256.
//   local             — build from a local clone of the fork at the pinned git
//                       ref (`ref`), stamp the ACTUAL binary sha. Replaces the
//                       hand-swap workflow (AMICODE-PATCHES.md) where the stamp
//                       was left lying at the manifest value.
// Importable module + CLI in one file.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadManifest(root = PKG_ROOT) {
  const m = JSON.parse(readFileSync(join(root, "opencode.lock.json"), "utf8"));
  if (typeof m.version !== "string" || m.version === "")
    throw new Error("manifest: version must be a non-empty string");
  const source = m.source ?? "release";
  if (source !== "release" && source !== "local")
    throw new Error(`manifest: source must be "release" or "local", got ${JSON.stringify(m.source)}`);
  if (source === "local" && !/^[0-9a-f]{40}$/.test(m.ref ?? ""))
    throw new Error('manifest: source "local" requires ref (40-hex fork commit)');
  const platforms = m.platforms ?? {};
  if (Object.keys(platforms).length === 0) throw new Error("manifest: platforms missing");
  for (const [key, p] of Object.entries(platforms)) {
    if (typeof p.asset !== "string" || p.asset === "") throw new Error(`manifest: ${key}.asset missing`);
    if (!/^[0-9a-f]{64}$/.test(p.sha256 ?? "")) throw new Error(`manifest: ${key}.sha256 must be 64 hex chars`);
  }
  return m;
}

export function resolvePlatform(manifest, flag) {
  const key = flag ?? `${process.platform}-${process.arch}`;
  if (!(key in manifest.platforms)) {
    throw new Error(`platform ${key} not supported (supported: ${Object.keys(manifest.platforms).join(", ")})`);
  }
  return key;
}

/** Release coordinates: default = upstream sst/opencode at v<version>; a manifest
 *  with `repo`/`tag` set points at our fork's release instead (harmoniqs/opencode,
 *  private — downloads go through the authenticated `gh` path in that case). */
export function releaseCoords(manifest) {
  return {
    repo: manifest.repo ?? "sst/opencode",
    tag: manifest.tag ?? `v${manifest.version}`,
    private: manifest.repo != null, // our mirror is private; upstream is not
  };
}

export function assetUrl(manifest, platform) {
  const { repo, tag } = releaseCoords(manifest);
  return `https://github.com/${repo}/releases/download/${tag}/${manifest.platforms[platform].asset}`;
}

/** Local-clone resolution: explicit path (--local) > AMICODE_OPENCODE_SRC >
 *  sibling checkout next to this repo (<amicode>/../opencode — the team layout,
 *  e.g. ~/harmoniqs/{amicode,opencode}). */
export function resolveCloneDir(root = PKG_ROOT, flagPath) {
  return flagPath ?? process.env.AMICODE_OPENCODE_SRC ?? join(root, "..", "..", "..", "opencode");
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function defaultDownload(url) {
  let r;
  try {
    r = await fetch(url);
  } catch (e) {
    throw new Error(`download failed: ${e.message} for ${url}`); // spec §6: URL on connection failures too
  }
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

/** Private-release download via the gh CLI (the team's auth path for our
 *  private repos). Plain fetch 404s on private assets — gh handles the token. */
function ghDownload(repo, tag, asset) {
  const work = mkdtempSync(join(PKG_ROOT, ".ghdl-"));
  try {
    execFileSync("gh", ["release", "download", tag, "--repo", repo, "--pattern", asset, "--dir", work], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    return readFileSync(join(work, asset));
  } catch (e) {
    throw new Error(
      `gh release download failed for ${repo}@${tag} ${asset}: ${e.message} — is \`gh\` installed and authed for ${repo}?`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

function resolveBun() {
  if (process.env.AMICODE_BUN) return process.env.AMICODE_BUN;
  try {
    const p = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    if (p !== "") return p;
  } catch {
    /* not on PATH */
  }
  const fallback = join(homedir(), ".bun", "bin", "bun");
  if (existsSync(fallback)) return fallback;
  throw new Error("bun not found — install it (https://bun.sh) or set AMICODE_BUN=/path/to/bun");
}

/** The fork's documented build recipe (its AMICODE-PATCHES.md §3): bun's dir must
 *  be on PATH (tree-sitter postinstall shims re-invoke `bun` by name), and
 *  OPENCODE_VERSION pins the version string so no release upload is attempted.
 *  OPENCODE_CHANNEL must NOT resolve to "latest": that compiles the embedded
 *  web UI with VITE_OPENCODE_CHANNEL="prod" (app/vite.js), which defaults
 *  settings.general.newLayoutDesigns OFF — hiding every amicode surface (home
 *  cards, v2 titlebar, draft flow) at runtime even though the code is compiled
 *  in. Any other channel maps to "dev" → new-layout default ON. */
function defaultBuild(cloneDir, version) {
  const bun = resolveBun();
  execFileSync(bun, ["run", "script/build.ts", "--single", "--skip-install"], {
    cwd: join(cloneDir, "packages", "opencode"),
    env: {
      ...process.env,
      OPENCODE_VERSION: version,
      OPENCODE_CHANNEL: "dev",
      PATH: `${dirname(bun)}${delimiter}${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

/** Atomic install into vendor/opencode/<key>/: write in a temp dir on the same
 *  fs, rename, chmod, then stamp LAST (spec §3 step 5). */
function installBinary(destDir, bytes, hash, sourceLine) {
  const bin = join(destDir, "opencode");
  mkdirSync(destDir, { recursive: true });
  const work = mkdtempSync(join(destDir, ".unpack-"));
  try {
    writeFileSync(join(work, "opencode"), bytes);
    renameSync(join(work, "opencode"), bin);
    chmodSync(bin, 0o755);
    writeFileSync(join(destDir, ".source"), sourceLine + "\n");
    writeFileSync(join(destDir, ".sha256"), hash + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bin;
}

function fetchFromLocal({ root, manifest, key, cloneDir, anyRef, noBuild, build }) {
  const head = git(cloneDir, "rev-parse", "HEAD");
  const dirty = git(cloneDir, "status", "--porcelain") !== "";
  if (!anyRef) {
    if (head !== manifest.ref)
      throw new Error(
        `clone ${cloneDir} is at ${head.slice(0, 10)} but the lock pins ${manifest.ref.slice(0, 10)} — ` +
          `checkout the pinned ref, update opencode.lock.json, or pass --any-ref`,
      );
    if (dirty) throw new Error(`clone ${cloneDir} has uncommitted changes — commit/stash them or pass --any-ref`);
  }
  if (!noBuild) build(cloneDir, manifest.version);
  // build.ts --single emits only the CURRENT platform's artifact.
  const artifact = join(cloneDir, "packages", "opencode", "dist", `opencode-${key}`, "bin", "opencode");
  if (!existsSync(artifact)) {
    throw new Error(
      `built binary missing at ${artifact}` +
        (noBuild ? " — rerun without --no-build" : " — local mode builds only the current platform"),
    );
  }
  const bytes = readFileSync(artifact);
  const provenance = `local ${head}${dirty ? "+dirty" : ""}`;
  const bin = installBinary(join(root, "vendor", "opencode", key), bytes, sha256(bytes), provenance);
  return { skipped: false, path: bin, source: provenance };
}

async function fetchFromRelease({ root, manifest, key, download }) {
  const { asset, sha256: want } = manifest.platforms[key];
  const destDir = join(root, "vendor", "opencode", key);
  const bin = join(destDir, "opencode");
  const stamp = join(destDir, ".sha256");
  const coords = releaseCoords(manifest);
  const provenance = `release ${coords.repo}@${coords.tag}`;

  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want) {
    return { skipped: true, path: bin, source: provenance }; // offline repeat builds
  }

  const bytes =
    coords.private && download === defaultDownload
      ? ghDownload(coords.repo, coords.tag, asset)
      : await download(assetUrl(manifest, key));
  const got = sha256(bytes);
  if (got !== want) {
    // Possible supply-chain signal: no retry, no override (spec §3 step 4).
    throw new Error(`SHA256 mismatch for ${asset}: expected ${want}, actual ${got}`);
  }

  mkdirSync(destDir, { recursive: true });
  const work = mkdtempSync(join(destDir, ".unpack-")); // same fs → rename is atomic
  try {
    const archive = join(work, asset);
    writeFileSync(archive, bytes);
    if (asset.endsWith(".zip")) execFileSync("unzip", ["-oq", archive, "-d", work]);
    else execFileSync("tar", ["-xzf", archive, "-C", work]);
    if (!existsSync(join(work, "opencode")))
      throw new Error(`archive ${asset} did not contain a flat 'opencode' binary`);
    renameSync(join(work, "opencode"), bin);
    chmodSync(bin, 0o755);
    writeFileSync(join(destDir, ".source"), provenance + "\n");
    writeFileSync(stamp, got + "\n"); // stamp last (spec §3 step 5)
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { skipped: false, path: bin, source: provenance };
}

/** mode: "release" | "local" | undefined (undefined → manifest.source).
 *  An EXPLICIT mode:"local" with no clone is a hard error; manifest-driven local
 *  falls back to the pinned release when the clone is absent (CI has no clone). */
export async function fetchOpencode({
  root = PKG_ROOT,
  platform,
  download = defaultDownload,
  mode,
  localDir,
  anyRef = false,
  noBuild = false,
  build = defaultBuild,
} = {}) {
  const manifest = loadManifest(root);
  const key = resolvePlatform(manifest, platform);
  const want = mode ?? manifest.source ?? "release";
  if (want === "local") {
    const cloneDir = resolveCloneDir(root, localDir);
    if (existsSync(join(cloneDir, ".git"))) {
      return fetchFromLocal({ root, manifest, key, cloneDir, anyRef, noBuild, build });
    }
    const hint = `clone harmoniqs/opencode there (or set AMICODE_OPENCODE_SRC / pass --local <path>)`;
    if (mode === "local") throw new Error(`no local clone at ${cloneDir} — ${hint}`);
    console.warn(
      `[fetch-opencode] WARNING: lock source=local but no clone at ${cloneDir} — ${hint}; falling back to the pinned release`,
    );
  }
  return fetchFromRelease({ root, manifest, key, download });
}

async function main(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const next = argv[i + 1];
    return next !== undefined && !next.startsWith("--") ? next : null; // null = flag present, no value
  };
  const platform = flagValue("--platform") ?? undefined;
  if (argv.includes("--record")) {
    // pin-time only (spec §3 step 6)
    const manifest = loadManifest();
    for (const key of Object.keys(manifest.platforms)) {
      const bytes = await defaultDownload(assetUrl(manifest, key));
      console.log(`${key} ${sha256(bytes)}`);
    }
    return 0;
  }
  const local = flagValue("--local");
  const r = await fetchOpencode({
    platform,
    mode: local !== undefined ? "local" : argv.includes("--release") ? "release" : undefined,
    localDir: local ?? undefined,
    anyRef: argv.includes("--any-ref"),
    noBuild: argv.includes("--no-build"),
  });
  console.log(
    r.skipped ? `[fetch-opencode] up to date: ${r.path}` : `[fetch-opencode] installed (${r.source}): ${r.path}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (c) => {
      process.exitCode = c;
    },
    (e) => {
      console.error(`[fetch-opencode] ${e.message}`);
      process.exitCode = 1;
    },
  );
}
