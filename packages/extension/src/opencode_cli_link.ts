// AMICODE (#561): stage a ~/.local/bin/opencode symlink pointing to the best
// available binary (managed canonical > vendored bootstrap > skip). Called from
// activate() and after updater adoption so the CLI is always fresh.
import { existsSync, accessSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The managed canonical binary installed by the updater. */
function managedBinPath(): string {
  return path.join(os.homedir(), ".amico", "opencode", "canonical", "current", "opencode");
}

/** The vendored binary bundled with the extension. */
function vendoredBinPath(extensionPath: string): string {
  return path.join(extensionPath, "vendor", "opencode", `${process.platform}-${process.arch}`, "opencode");
}

/** Where the symlink lives. */
function symlinkTarget(): string {
  return path.join(os.homedir(), ".local", "bin", "opencode");
}

/** Check if a path exists and is executable. */
function isExecutable(p: string): boolean {
  try {
    if (!existsSync(p)) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or update `~/.local/bin/opencode` → the best available binary.
 * Priority: managed canonical > vendored bootstrap > skip.
 *
 * Idempotent and never throws — wraps all FS operations in try/catch.
 */
export function stageOpencodeCliLink(extensionPath: string): void {
  try {
    // Determine target using priority ladder
    const managed = managedBinPath();
    const vendored = vendoredBinPath(extensionPath);

    let target: string | undefined;
    if (isExecutable(managed)) {
      target = managed;
    } else if (isExecutable(vendored)) {
      target = vendored;
    }

    // Skip: nothing available
    if (!target) return;

    const link = symlinkTarget();
    const linkDir = path.dirname(link);

    // If symlink already exists and points to the correct target, no-op
    try {
      if (existsSync(link)) {
        const current = readlinkSync(link);
        if (current === target) return; // idempotent
        // Points elsewhere — unlink before relinking
        unlinkSync(link);
      }
    } catch {
      // readlink/unlink failed — try to create fresh anyway
      try { unlinkSync(link); } catch { /* may not exist */ }
    }

    // Create ~/.local/bin/ if needed
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(target, link);
  } catch {
    // Never throws — extension activation must not fail due to a symlink issue
  }
}
