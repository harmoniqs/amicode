#!/usr/bin/env node
// Vendoring of the opencode chat-server binary, pinned by opencode.lock.json.
// Post-absorption: binaries are built from the committed overlay via
// build_binary.mjs. This script handles the stock-canonical download path
// (upstream anomalyco/opencode at v<version>) used by `pnpm install` /
// `pnpm fetch:opencode` to bootstrap the vendored binary when one isn't
// already built.
//
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
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// When bundled as CJS by esbuild, import.meta.url is undefined and
// fileURLToPath throws.  Guard so the module initialises; callers from the
// bundle always pass an explicit `root` so the fallback is never used for
// real manifest reads — only for the gh-download temp dir.
let PKG_ROOT;
try {
  PKG_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
} catch {
  PKG_ROOT = process.cwd();
}

export function loadManifest(root = PKG_ROOT) {
  const m = JSON.parse(readFileSync(join(root, "opencode.lock.json"), "utf8"));
  if (typeof m.version !== "string" || m.version === "")
    throw new Error("manifest: version must be a non-empty string");
  return m;
}

/** The three platforms we ship binaries for. */
const KNOWN_PLATFORMS = ["darwin-arm64", "linux-arm64", "linux-x64"];

/** Platform asset names — post-absorption these are derived from the platform
 *  key, not read from the lock (the lock no longer carries per-platform data). */
function assetForPlatform(key) {
  if (key === "darwin-arm64") return "opencode-darwin-arm64.zip";
  return `opencode-${key}.tar.gz`;
}

export function resolvePlatform(_manifest, flag) {
  const key = flag ?? `${process.platform}-${process.arch}`;
  if (!KNOWN_PLATFORMS.includes(key)) {
    throw new Error(`platform ${key} not supported (supported: ${KNOWN_PLATFORMS.join(", ")})`);
  }
  return key;
}

/** Release coordinates: upstream anomalyco/opencode at v<version>. */
export function releaseCoords(manifest) {
  const repo = "anomalyco/opencode";
  const tag = `v${manifest.version}`;
  return { repo, tag };
}

export function assetUrl(manifest, platform) {
  const { repo, tag } = releaseCoords(manifest);
  const asset = assetForPlatform(platform);
  return `https://github.com/${repo}/releases/download/${tag}/${asset}`;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ── #1019: Download robustness — retry, error classification, fallback ──

/**
 * Classify a download error as transient (retriable), permanent (not retriable),
 * or auth (credentials issue).
 */
export function classifyDownloadError(err) {
  const msg = err?.message ?? String(err);
  if (/HTTP\s+5\d\d/i.test(msg)) return "transient";
  if (/timeout|ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|network/i.test(msg)) return "transient";
  if (/HTTP\s+404/i.test(msg)) return "permanent";
  if (/HTTP\s+403/i.test(msg)) return "auth";
  if (/gh:?\s*(command)?\s*not found|not logged in|not installed/i.test(msg)) return "auth";
  return "transient";
}

/**
 * Retry an async function with exponential backoff.
 */
export async function withRetry(fn, opts = {}) {
  const { maxAttempts = 3, baseDelay = 1000, factor = 2, isPermanent, onRetry } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
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
    throw new Error(`download failed: ${e.message} for ${url}`);
  }
  if (!r.ok) throw new Error(`download failed: HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

async function fetchFromRelease({ root, manifest, key, download, retryOpts }) {
  const asset = assetForPlatform(key);
  const destDir = join(root, "vendor", "opencode", key);
  const bin = join(destDir, "opencode");
  const stamp = join(destDir, ".sha256");
  const coords = releaseCoords(manifest);
  const provenance = `release ${coords.repo}@${coords.tag}`;

  const url = `https://github.com/${coords.repo}/releases/download/${coords.tag}/${asset}`;
  const retry = retryOpts ?? { maxAttempts: 3, baseDelay: 1000, factor: 2 };

  // Upstream stock-canonical download: HTTPS only, with retry.
  const bytes = await withRetry(() => download(url), { ...retry });

  mkdirSync(destDir, { recursive: true });
  const work = mkdtempSync(join(destDir, ".unpack-"));
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
    writeFileSync(stamp, sha256(bytes) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { skipped: false, path: bin, source: provenance };
}

export async function fetchOpencode({
  root = PKG_ROOT,
  platform,
  download = defaultDownload,
  mode,
  retryOpts,
} = {}) {
  const manifest = loadManifest(root);
  const key = resolvePlatform(manifest, platform);
  return fetchFromRelease({ root, manifest, key, download, retryOpts });
}

async function main(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const next = argv[i + 1];
    return next !== undefined && !next.startsWith("--") ? next : null;
  };
  const platform = flagValue("--platform") ?? undefined;
  const r = await fetchOpencode({ platform });
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
