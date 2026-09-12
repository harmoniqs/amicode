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
  readdirSync,
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

/** Release coordinates: default = upstream anomalyco/opencode at v<version>; a manifest
 *  with `repo`/`tag` set points at our fork's release instead (harmoniqs/opencode,
 *  private — downloads go through the authenticated `gh` path in that case).
 *  AMICODE_RELEASE_TAG / AMICODE_RELEASE_REPO override the pinned tag/repo — used by
 *  release.yml on a clean tag, which provisions a FRESHLY built fork binary (its tag
 *  cannot be in the committed lock yet; see "Provision fork binary" there). */
export function releaseCoords(manifest) {
  const repo = process.env.AMICODE_RELEASE_REPO || manifest.repo || "anomalyco/opencode";
  const tag = process.env.AMICODE_RELEASE_TAG || manifest.tag || `v${manifest.version}`;
  return {
    repo,
    tag,
    // #1019: renamed from `private` — this flag means "is our fork" (keyed on
    // manifest.repo != null or env override), not "repo is private on GitHub."
    // It controls download-path selection (HTTPS+gh fallback), not auth.
    isFork: manifest.repo != null || !!process.env.AMICODE_RELEASE_TAG,
    // Back-compat alias (deprecated — use isFork)
    get private() { return this.isFork; },
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

// ── #1019: Download robustness — retry, error classification, fallback ──

/**
 * Classify a download error as transient (retriable), permanent (not retriable),
 * or auth (credentials issue).
 */
export function classifyDownloadError(err) {
  const msg = err?.message ?? String(err);
  // 5xx = server-side, retriable
  if (/HTTP\s+5\d\d/i.test(msg)) return "transient";
  // Network errors = retriable
  if (/timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|network/i.test(msg)) return "transient";
  // 404 = permanent (asset or release doesn't exist)
  if (/HTTP\s+404/i.test(msg)) return "permanent";
  // 403 = auth issue (rate limit or missing credentials)
  if (/HTTP\s+403/i.test(msg)) return "auth";
  // gh not found / not logged in
  if (/gh:?\s*(command)?\s*not found|not logged in|not installed/i.test(msg)) return "auth";
  // Default to transient (give it one more shot)
  return "transient";
}

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {Object} opts - { maxAttempts, baseDelay, factor, isPermanent?, onRetry? }
 */
export async function withRetry(fn, opts = {}) {
  const { maxAttempts = 3, baseDelay = 1000, factor = 2, isPermanent, onRetry } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      // Check if the error is permanent (not retriable)
      const classification = isPermanent
        ? (isPermanent(err) ? "permanent" : "transient")
        : classifyDownloadError(err);
      if (classification === "permanent" || classification === "auth") throw err;
      if (attempt < maxAttempts) {
        if (onRetry) onRetry(attempt, err);
        const delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), 4000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

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

/** Channel assertion (the fail-closed backstop): a release body must record the
 *  channel it was BUILT with AND the badge that channel implies, so a dev-channel
 *  binary can never ride a beta-tagged promotion. Reads the release notes via
 *  `gh` (the fork's release body is authored by its workflow — see
 *  amicode-release.yml's "Create GitHub release" step). `api` is injectable
 *  (tests stub it; it stands in for `gh api repos/<repo>/<path> --jq <jq>`). */
export async function assertReleaseChannel(coords, channel, api = ghApi) {
  const BADGE = channel === "beta" ? "BETA" : "DEV";
  let body;
  try {
    body = api(coords.repo, `releases/tags/${coords.tag}`, ".body");
  } catch (e) {
    throw new Error(
      `cannot read release notes for ${coords.repo}@${coords.tag}: ${e.message} — is \`gh\` installed and authed for ${coords.repo}?`,
    );
  }
  const m = body.match(/OPENCODE_CHANNEL=(\S+)/);
  if (!m || m[1] !== channel)
    throw new Error(
      `release ${coords.tag} was NOT built with OPENCODE_CHANNEL=${channel} (body says ${m ? m[1] : "nothing"}) — refusing to vendor it into a promoted release`,
    );
  if (!body.includes(`Badge: ${BADGE}`))
    throw new Error(`release ${coords.tag} does not declare Badge: ${BADGE} — refusing to vendor it into a promoted release`);
}

/** `gh api repos/<repo>/<path> --jq <jq>` — the release-notes read path. */
function ghApi(repo, path, jq) {
  return execFileSync("gh", ["api", `repos/${repo}/${path}`, "--jq", jq], { encoding: "utf8" });
}

/** Hash authority when AMICODE_RELEASE_TAG overrides the pin: the release's own
 *  SHA256SUMS.txt — the committed lock cannot know a tag that did not exist
 *  when it was written. */
function shaFromSums(text, asset) {
  const line = text.split("\n").find((l) => l.trimEnd().endsWith(asset));
  if (!line) throw new Error(`SHA256SUMS.txt has no entry for ${asset}`);
  const hash = line.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`SHA256SUMS.txt entry for ${asset} is not a sha256: ${line.trim()}`);
  return hash;
}

async function fetchFromRelease({ root, manifest, key, download, ghApi: api = ghApi, retryOpts }) {
  const { asset } = manifest.platforms[key];
  const destDir = join(root, "vendor", "opencode", key);
  const bin = join(destDir, "opencode");
  const stamp = join(destDir, ".sha256");
  const coords = releaseCoords(manifest);
  const override = process.env.AMICODE_RELEASE_TAG || null;
  // A tag override only ever happens on the promoted path — fail closed to beta
  // if the channel requirement was somehow not passed alongside it.
  const channel = process.env.AMICODE_REQUIRE_CHANNEL || (override ? "beta" : null);
  const provenance = `release ${coords.repo}@${coords.tag}` + (channel ? ` channel=${channel}` : "");
  let want = manifest.platforms[key].sha256;
  if (channel) await assertReleaseChannel(coords, channel, api);
  if (override) {
    want = shaFromSums(
      (
        await download(
          `https://github.com/${coords.repo}/releases/download/${coords.tag}/SHA256SUMS.txt`,
        )
      ).toString("utf8"),
      asset,
    );
  }

  if (existsSync(bin) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === want) {
    return { skipped: true, path: bin, source: provenance }; // offline repeat builds
  }

  // #1019: Download with retry + HTTPS-first, gh-fallback.
  // Fork releases (repo set in the lock) try plain HTTPS first (works for any
  // public release, tokenless), gh ONLY as the fallback for network issues or
  // CDN corruption (sha256 mismatch on HTTPS but clean on gh).
  const retry = retryOpts ?? { maxAttempts: 3, baseDelay: 1000, factor: 2 };
  let bytes;
  if (coords.isFork) {
    // HTTPS with retry
    let httpsOk = false;
    let httpsSha256Mismatch = false;
    try {
      bytes = await withRetry(
        () => download(assetUrl(manifest, key)),
        {
          ...retry,
          isPermanent: (e) => {
            const cls = classifyDownloadError(e);
            return cls === "permanent" || cls === "auth";
          },
          onRetry: (attempt, err) => {
            console.log(`[fetch-opencode] HTTPS attempt ${attempt} failed: ${err.message} — retrying`);
          },
        },
      );
      httpsOk = true;
      // Verify sha256 before accepting HTTPS result
      const got = sha256(bytes);
      if (got !== want) {
        httpsSha256Mismatch = true;
        httpsOk = false;
        console.log(`[fetch-opencode] HTTPS sha256 mismatch for ${asset} — trying gh fallback`);
      }
    } catch (httpsErr) {
      console.log(`[fetch-opencode] HTTPS download failed: ${httpsErr.message} — trying gh fallback`);
    }

    if (!httpsOk) {
      // gh fallback: one attempt (no retry on gh — it's the fallback itself)
      try {
        bytes = ghDownload(coords.repo, coords.tag, asset);
        // Verify sha256 on gh download — mismatch here is permanent
        const got = sha256(bytes);
        if (got !== want) {
          throw new Error(`SHA256 mismatch for ${asset}: expected ${want}, actual ${got}`);
        }
      } catch (ghErr) {
        if (httpsSha256Mismatch) {
          throw new Error(
            `SHA256 mismatch for ${asset} via HTTPS (CDN corruption?) and the gh fallback failed: ${ghErr.message} — is \`gh\` installed and authed for ${coords.repo}?`,
          );
        }
        throw new Error(
          `asset not publicly fetchable and the gh fallback failed: ${ghErr.message} — is \`gh\` installed and authed for ${coords.repo}?`,
        );
      }
    }
  } else {
    // Non-fork (upstream): HTTPS only, with retry
    bytes = await withRetry(
      () => download(assetUrl(manifest, key)),
      { ...retry },
    );
    const got = sha256(bytes);
    if (got !== want) {
      throw new Error(`SHA256 mismatch for ${asset}: expected ${want}, actual ${got}`);
    }
  }

  // Verify sha256 (for HTTPS-succeeded path where we didn't already check)
  if (coords.isFork) {
    // Already verified above in the fork path
  } else {
    // Already verified above in the non-fork path
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
    writeFileSync(stamp, sha256(bytes) + "\n"); // stamp last (spec §3 step 5)
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
  ghApi: ghApiImpl,
  mode,
  localDir,
  anyRef = false,
  noBuild = false,
  build = defaultBuild,
  retryOpts,
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
  return fetchFromRelease({ root, manifest, key, download, ghApi: ghApiImpl, retryOpts });
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
