/**
 * Atomic file-copy adoption — #1021
 *
 * Replaces line-by-line file copy with backup-and-swap:
 * 1. Back up the installed extension dist as a sibling directory
 * 2. Stage the build output as another sibling directory
 * 3. Atomic rename swap
 * 4. Pending-swap marker for crash recovery
 * 5. Health check + rollback on failure
 *
 * Key invariant: staging and backup dirs are siblings of the extension dir
 * (same filesystem → rename is atomic on POSIX).
 */

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ── Types ──

export interface SwapMarker {
  backup_path: string;
  target_path: string;
  timestamp: string;
  swap_state: "pending" | "committed" | "rolled-back";
}

export interface SwapResult {
  ok: boolean;
  error?: string;
  rolledBack?: boolean;
}

// ── createBackup ──

/**
 * Create a timestamped backup of the extension directory as a sibling.
 * Returns the backup directory path.
 */
export async function createBackup(extensionDir: string): Promise<string> {
  const parent = dirname(extensionDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(parent, `.amicode-backup-${timestamp}`);

  cpSync(extensionDir, backupDir, { recursive: true });

  return backupDir;
}

/**
 * Prune excess backup directories, keeping only the most recent `keep` count.
 */
export function pruneBackups(parentDir: string, keep: number = 3): void {
  const entries = readdirSync(parentDir)
    .filter((f) => f.startsWith(".amicode-backup-"))
    .map((f) => ({
      name: f,
      path: join(parentDir, f),
      mtime: statSync(join(parentDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const entry of entries.slice(keep)) {
    rmSync(entry.path, { recursive: true, force: true });
  }
}

// ── stageExtensionBuild ──

/**
 * Stage build output as a sibling of the extension directory.
 * Copies the built dist and content directories into a staging directory
 * that is on the same filesystem as the extension directory.
 */
export function stageExtensionBuild(
  extensionDir: string,
  buildDir: string,
  opts?: { binarySource?: string; platformKey?: string },
): string {
  const parent = dirname(extensionDir);
  const stagingDir = join(parent, `.amicode-staging-${Date.now()}`);
  mkdirSync(stagingDir, { recursive: true });

  // Copy dist
  const builtDist = join(buildDir, "dist");
  if (existsSync(builtDist)) {
    cpSync(builtDist, join(stagingDir, "dist"), { recursive: true });
  }

  // Copy content directories
  const contentDirs = [
    "skills", "scores", "templates", "exemplars",
    "opencode-plugin", "julia", "tools",
    "bin", "packs",
  ];
  for (const dir of contentDirs) {
    const src = join(buildDir, dir);
    if (existsSync(src)) {
      cpSync(src, join(stagingDir, dir), { recursive: true });
    }
  }

  // Copy top-level files
  const files = ["package.json", "AGENTS.md", "DISTILLER.md", "CONTRACT.md"];
  for (const f of files) {
    const src = join(buildDir, f);
    if (existsSync(src)) {
      cpSync(src, join(stagingDir, f));
    }
  }

  // Stage the freshly-built binary (#1135) into the vendor tree so the swap can
  // adopt it atomically with dist. Only when a source + platformKey are given
  // (plain install, no override). vendor/ is NOT copied by the generic loop
  // above — the binary is swapped explicitly by atomicSwap so a partial copy
  // can never leave a new dist against a half-written binary.
  if (opts?.binarySource && opts?.platformKey && existsSync(opts.binarySource)) {
    const stagedBinDir = join(stagingDir, "vendor", "opencode", opts.platformKey);
    mkdirSync(stagedBinDir, { recursive: true });
    cpSync(opts.binarySource, join(stagedBinDir, "opencode"));
    // Carry provenance sidecars if present.
    const srcDir = dirname(opts.binarySource);
    for (const sidecar of [".source", ".sha256"]) {
      const s = join(srcDir, sidecar);
      if (existsSync(s)) cpSync(s, join(stagedBinDir, sidecar));
    }
  }

  return stagingDir;
}

// ── atomicSwap ──

/**
 * Perform an atomic swap of the extension's dist directory.
 * Uses rename for atomicity on POSIX. Falls back to copy on rename failure.
 * Rolls back from backup on any failure.
 */
export async function atomicSwap(opts: {
  extensionDir: string;
  stagingDir: string;
  backupDir: string;
  platformKey?: string;
}): Promise<SwapResult> {
  const { extensionDir, stagingDir, backupDir, platformKey } = opts;

  try {
    // Verify staging has the expected structure
    if (!existsSync(join(stagingDir, "dist"))) {
      // Roll back — staging is invalid
      return rollback(extensionDir, backupDir, "Staging directory has no dist/");
    }

    const distDir = join(extensionDir, "dist");
    const distOld = join(extensionDir, "dist.pre-swap");

    // Rename current dist out of the way
    if (existsSync(distDir)) {
      renameSync(distDir, distOld);
    }

    try {
      // Rename staging dist into place (atomic on POSIX)
      renameSync(join(stagingDir, "dist"), distDir);
    } catch (e) {
      // Rename failed — restore from the old dist
      if (existsSync(distOld)) {
        renameSync(distOld, distDir);
      }
      return { ok: false, error: `Atomic swap failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Binary swap (#1135) — adopt the staged binary into the installed vendor
    // tree, COUPLED to the dist swap: if it fails, revert BOTH dist and binary
    // so a plain install never ends up with fresh dist on a stale/half binary.
    const stagedBin = platformKey
      ? join(stagingDir, "vendor", "opencode", platformKey, "opencode")
      : "";
    if (platformKey && stagedBin && existsSync(stagedBin)) {
      const destDir = join(extensionDir, "vendor", "opencode", platformKey);
      const dest = join(destDir, "opencode");
      const destTmp = join(destDir, ".opencode.new");
      try {
        mkdirSync(destDir, { recursive: true });
        cpSync(stagedBin, destTmp);
        chmodSync(destTmp, 0o755);
        renameSync(destTmp, dest); // atomic on same fs; only now does it take effect
        // Sidecars are best-effort provenance, not part of the atomic guarantee.
        for (const sidecar of [".source", ".sha256"]) {
          const s = join(stagingDir, "vendor", "opencode", platformKey, sidecar);
          if (existsSync(s)) { try { cpSync(s, join(destDir, sidecar)); } catch { /* non-critical */ } }
        }
      } catch (e) {
        // Revert the tmp, then roll dist back from backup — dist + binary revert
        // together (no version skew). rollback() restores dist from backupDir;
        // the installed binary was never renamed over, so it stays original.
        try { if (existsSync(destTmp)) rmSync(destTmp, { force: true }); } catch { /* ignore */ }
        if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
        return rollback(extensionDir, backupDir,
          `Binary adoption failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Clean up the old dist
    if (existsSync(distOld)) {
      rmSync(distOld, { recursive: true, force: true });
    }

    // Copy non-dist content from staging (these are not atomically swapped —
    // they're less critical and a partial update is tolerable). `vendor` is
    // excluded: the binary was already adopted atomically above (#1135).
    for (const entry of readdirSync(stagingDir)) {
      if (entry === "dist") continue;
      if (entry === "vendor") continue;
      const src = join(stagingDir, entry);
      const dest = join(extensionDir, entry);
      try {
        if (statSync(src).isDirectory()) {
          cpSync(src, dest, { recursive: true });
        } else {
          cpSync(src, dest);
        }
      } catch {
        // Non-critical — log but continue
      }
    }

    // Clean up staging
    rmSync(stagingDir, { recursive: true, force: true });

    return { ok: true };
  } catch (e) {
    // Unexpected error — try to roll back
    return rollback(extensionDir, backupDir, e instanceof Error ? e.message : String(e));
  }
}

function rollback(extensionDir: string, backupDir: string, reason: string): SwapResult {
  try {
    if (existsSync(backupDir)) {
      // Restore dist from backup
      const backupDist = join(backupDir, "dist");
      const targetDist = join(extensionDir, "dist");
      if (existsSync(backupDist)) {
        rmSync(targetDist, { recursive: true, force: true });
        cpSync(backupDist, targetDist, { recursive: true });
      }
      // Restore vendor/ (the binary) from backup too — dist and binary revert
      // together so a failed swap never leaves version skew (#1135). The backup
      // is a full snapshot of the ext dir, so vendor/ is present when it existed.
      const backupVendor = join(backupDir, "vendor");
      const targetVendor = join(extensionDir, "vendor");
      if (existsSync(backupVendor)) {
        rmSync(targetVendor, { recursive: true, force: true });
        cpSync(backupVendor, targetVendor, { recursive: true });
      }
    }
    return { ok: false, error: reason, rolledBack: true };
  } catch (rollbackErr) {
    return {
      ok: false,
      error: `Swap failed (${reason}) and rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}. Manual recovery: copy ${backupDir} back to ${extensionDir}`,
    };
  }
}

// ── pendingSwapMarker ──

/**
 * Write a pending-swap marker for crash recovery.
 */
export function writePendingMarker(markerPath: string, marker: SwapMarker): void {
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, JSON.stringify(marker, null, 2) + "\n");
}

/**
 * Read a pending-swap marker. Returns undefined if none exists.
 */
export function readPendingMarker(markerPath: string): SwapMarker | undefined {
  if (!existsSync(markerPath)) return undefined;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Commit a successful swap — delete the pending marker.
 */
export function commitSwap(markerPath: string): void {
  if (existsSync(markerPath)) {
    rmSync(markerPath, { force: true });
  }
}
