/**
 * Main Source Resolver — #1018
 *
 * Resolves the fork binary for "Rebuild from Main" by reading the promoted
 * manifest (opencode.lock.json on main) and downloading the pinned release
 * asset. Replaces the fork-build path (bun install → bun run build) with
 * the release-download path (fetchFromRelease).
 *
 * Design constraints:
 * - No fork clone, no bun invocation in the Main path
 * - sha256 mismatch is a hard refusal
 * - git pull uses --ff-only (not --rebase)
 * - Pending-promotion info is display-only
 * - Unsupported platforms detected before any mutation
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unsupportedHostAdvice, SUPPORTED } from "../opencode_binary";

// ── Types ──

export interface LockFile {
  version: string;
  source: string;
  ref: string;
  repo: string;
  tag: string;
  platforms: Record<string, { asset: string; sha256: string }>;
}

export interface ExecResult {
  ok: boolean;
  stdout?: string;
  error?: string;
}

export type ExecFn = (cmd: string, cwd?: string) => Promise<ExecResult>;

export class UnsupportedPlatformError extends Error {
  constructor(public advice: string) {
    super(advice);
    this.name = "UnsupportedPlatformError";
  }
}

export class LockFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockFileError";
  }
}

// ── readLockFile ──

/**
 * Read and validate opencode.lock.json from the amicode repo root.
 * Validates the fields required by Rebuild from Main: tag, ref, repo,
 * and at least one platform entry.
 */
export function readLockFile(amicodePath: string): LockFile {
  const lockPath = join(amicodePath, "opencode.lock.json");
  if (!existsSync(lockPath)) {
    throw new LockFileError(
      `opencode.lock.json not found at ${lockPath}. ` +
      `Ensure you are pointing at the amicode repo root.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch (e) {
    throw new LockFileError(
      `opencode.lock.json is malformed: ${e instanceof Error ? e.message : "parse error"}`,
    );
  }

  const m = raw as Record<string, unknown>;

  if (typeof m.version !== "string" || m.version === "") {
    throw new LockFileError("opencode.lock.json: version must be a non-empty string");
  }
  if (!m.tag || typeof m.tag !== "string") {
    throw new LockFileError(
      "opencode.lock.json: tag is required for Rebuild from Main " +
      "(it identifies the GitHub Release to download)",
    );
  }
  if (!m.ref || typeof m.ref !== "string" || !/^[0-9a-f]{40}$/.test(m.ref)) {
    throw new LockFileError(
      "opencode.lock.json: ref must be a 40-character hex SHA " +
      "(it identifies the promoted fork commit)",
    );
  }
  if (!m.repo || typeof m.repo !== "string") {
    throw new LockFileError("opencode.lock.json: repo is required (e.g. 'harmoniqs/opencode')");
  }

  const platforms = (m.platforms ?? {}) as Record<string, unknown>;
  if (Object.keys(platforms).length === 0) {
    throw new LockFileError("opencode.lock.json: no platform entries found");
  }

  for (const [key, p] of Object.entries(platforms)) {
    const plat = p as Record<string, unknown>;
    if (typeof plat.asset !== "string" || plat.asset === "") {
      throw new LockFileError(`opencode.lock.json: ${key}.asset missing`);
    }
    if (!/^[0-9a-f]{64}$/.test((plat.sha256 as string) ?? "")) {
      throw new LockFileError(`opencode.lock.json: ${key}.sha256 must be 64 hex chars`);
    }
  }

  return m as unknown as LockFile;
}

// ── resolveMainPlatform ──

/**
 * Resolve the current platform key and verify it exists in the lock file.
 * Detects unsupported platforms (darwin-x64, win32) before any download.
 */
export function resolveMainPlatform(
  lock: LockFile,
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  const key = `${platform}-${arch}`;

  // Check against the SUPPORTED constant first for unsupported-host advice
  if (!(SUPPORTED as readonly string[]).includes(key)) {
    throw new UnsupportedPlatformError(unsupportedHostAdvice(platform, arch));
  }

  // Then check the lock file has this platform
  if (!(key in lock.platforms)) {
    throw new UnsupportedPlatformError(
      `Platform ${key} is supported but not in the lock file ` +
      `(found: ${Object.keys(lock.platforms).join(", ")}). ` +
      `Update opencode.lock.json or run opencode:pin.`,
    );
  }

  return key;
}

// ── checkDirtyTree ──

/**
 * Check if the working tree has uncommitted changes.
 * Returns { dirty: false } for clean, { dirty: true, message } for dirty.
 */
export async function checkDirtyTree(
  repoPath: string,
  exec: ExecFn,
): Promise<{ dirty: boolean; message?: string }> {
  const result = await exec("git status --porcelain", repoPath);
  if (!result.ok) {
    return { dirty: true, message: `Could not check tree status: ${result.error}` };
  }
  const output = (result.stdout ?? "").trim();
  if (output !== "") {
    return {
      dirty: true,
      message: "Commit or stash your local changes before rebuilding from main.",
    };
  }
  return { dirty: false };
}

// ── pullMainBranch ──

/**
 * Pull the main branch with --ff-only (not --rebase).
 * Runs: git fetch origin → git checkout main → git pull --ff-only origin main
 */
export async function pullMainBranch(
  amicodePath: string,
  exec: ExecFn,
): Promise<{ ok: boolean; error?: string }> {
  const fetch = await exec("git fetch origin", amicodePath);
  if (!fetch.ok) {
    return { ok: false, error: `git fetch failed: ${fetch.error}` };
  }

  const checkout = await exec("git checkout main", amicodePath);
  if (!checkout.ok) {
    return { ok: false, error: `git checkout main failed: ${checkout.error}` };
  }

  const pull = await exec("git pull --ff-only origin main", amicodePath);
  if (!pull.ok) {
    return { ok: false, error: `git pull failed (non-fast-forward?): ${pull.error}` };
  }

  return { ok: true };
}

// ── checkPendingPromotion ──

/**
 * Check if the fork's local/amicode branch is ahead of the lock file's ref.
 * This is informational only — a failure is non-blocking and silently skipped.
 */
export async function checkPendingPromotion(
  forkRepo: string,
  lockRef: string,
  exec: ExecFn,
): Promise<{ pending: boolean; remoteHead?: string; unreachable?: boolean }> {
  // Use git ls-remote to check the fork's local/amicode HEAD without a clone.
  // Output format: "<sha>\trefs/heads/local/amicode"
  const result = await exec(
    `git ls-remote https://github.com/${forkRepo}.git refs/heads/local/amicode`,
  );

  if (!result.ok) {
    return { pending: false, unreachable: true };
  }

  const remoteHead = (result.stdout ?? "").trim().split(/\s+/)[0];
  if (!remoteHead || !/^[0-9a-f]{40}$/.test(remoteHead)) {
    return { pending: false, unreachable: true };
  }

  return {
    pending: remoteHead !== lockRef,
    remoteHead,
  };
}

// ── downloadForkBinary ──

export interface DownloadOpts {
  amicodePath: string;
  platform?: string;
  download?: (url: string) => Promise<Buffer>;
  ghApi?: (repo: string, path: string, jq: string) => string;
}

/**
 * Download the fork binary using the existing fetchFromRelease infrastructure.
 * Reads opencode.lock.json, resolves the platform, downloads and verifies.
 */
export async function downloadForkBinary(opts: DownloadOpts): Promise<{
  path: string;
  source: string;
  skipped: boolean;
}> {
  // Dynamic import of the ESM fetch_opencode module
  const { fetchOpencode } = await import("../../scripts/fetch_opencode.mjs");

  try {
    const result = await fetchOpencode({
      root: join(opts.amicodePath, "packages", "extension"),
      platform: opts.platform,
      download: opts.download,
      ghApi: opts.ghApi,
      mode: "release", // Always release for Main rebuild — never local
    });
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Wrap deleted-release errors with actionable guidance
    if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
      const lock = readLockFile(opts.amicodePath);
      throw new Error(
        `The release \`${lock.tag}\` is no longer available. ` +
        `This may be a repository issue — contact your team.`,
      );
    }
    throw e;
  }
}

// ── rebuildFromMain (orchestrator) ──

export interface RebuildFromMainOpts {
  amicodePath: string;
  exec?: ExecFn;
  platformOverride?: string;
  archOverride?: string;
  download?: (url: string) => Promise<Buffer>;
  ghApi?: (repo: string, path: string, jq: string) => string;
  onPhase?: (phase: string, detail?: string) => void;
}

export interface RebuildResult {
  ok: boolean;
  error?: string;
  binaryPath?: string;
  pendingPromotion?: { pending: boolean; remoteHead?: string };
}

/**
 * Orchestrate the full Rebuild from Main flow:
 * 1. Check dirty tree
 * 2. Detect unsupported platform
 * 3. Pull main (--ff-only)
 * 4. Read lock file
 * 5. Download fork binary (fetchFromRelease)
 * 6. Check pending promotion (informational)
 */
export async function rebuildFromMain(opts: RebuildFromMainOpts): Promise<RebuildResult> {
  const exec: ExecFn = opts.exec ?? defaultExec;
  const onPhase = opts.onPhase ?? (() => {});

  // ── Step 1: Check dirty tree ──
  onPhase("checking", "Checking working tree...");
  const dirty = await checkDirtyTree(opts.amicodePath, exec);
  if (dirty.dirty) {
    return { ok: false, error: dirty.message };
  }

  // ── Step 2: Detect unsupported platform (before any mutation) ──
  // Read lock first to check platform — but we need to handle the case where
  // the lock file doesn't exist yet (pre-pull). Try reading it; if missing,
  // proceed to pull first.
  let lock: LockFile | undefined;
  try {
    lock = readLockFile(opts.amicodePath);
  } catch {
    // Lock file may not exist before pull — that's OK, we'll read it after
  }

  if (lock) {
    try {
      resolveMainPlatform(lock, opts.platformOverride, opts.archOverride);
    } catch (e) {
      if (e instanceof UnsupportedPlatformError) {
        return { ok: false, error: e.advice };
      }
      throw e;
    }
  }

  // ── Step 3: Pull main (--ff-only) ──
  onPhase("pulling", "Pulling main...");
  const pull = await pullMainBranch(opts.amicodePath, exec);
  if (!pull.ok) {
    return { ok: false, error: pull.error };
  }

  // ── Step 4: Read lock file (after pull, in case it was updated) ──
  onPhase("reading", "Reading lock file...");
  try {
    lock = readLockFile(opts.amicodePath);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Failed to read lock file",
    };
  }

  // Re-check platform after pull (lock may have changed)
  let platformKey: string;
  try {
    platformKey = resolveMainPlatform(lock, opts.platformOverride, opts.archOverride);
  } catch (e) {
    if (e instanceof UnsupportedPlatformError) {
      return { ok: false, error: e.advice };
    }
    throw e;
  }

  // ── Step 5: Download fork binary ──
  onPhase("downloading", `Downloading binary for ${platformKey}...`);
  let binaryResult: { path: string; source: string; skipped: boolean };
  try {
    binaryResult = await downloadForkBinary({
      amicodePath: opts.amicodePath,
      platform: platformKey,
      download: opts.download,
      ghApi: opts.ghApi,
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Binary download failed",
    };
  }

  // ── Step 6: Check pending promotion (informational, non-blocking) ──
  onPhase("checking-promotion", "Checking for pending promotion...");
  let pendingPromotion: { pending: boolean; remoteHead?: string } | undefined;
  try {
    pendingPromotion = await checkPendingPromotion(lock.repo, lock.ref, exec);
  } catch {
    // Non-blocking — silently skip
  }

  return {
    ok: true,
    binaryPath: binaryResult.path,
    pendingPromotion,
  };
}

// ── Default exec implementation ──

function defaultExec(cmd: string, cwd?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { exec } = require("node:child_process");
    exec(cmd, { cwd, timeout: 180_000 }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) resolve({ ok: false, error: stderr?.trim() || err.message });
      else resolve({ ok: true, stdout: stdout?.toString() ?? "" });
    });
  });
}
