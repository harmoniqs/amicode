// Fleet SSH utilities — shared helpers used by fleet_sync, fleet_compat, and
// fleet_host_settings. Extracted from fleet_wizard.ts when the wizard was
// replaced by the agentic fleet skill (#363).

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

// ============================================================================
// SSH execution helpers (pure, testable with mocked exec)
// ============================================================================

export interface SshExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export type SshExec = (target: string, command: string) => Promise<SshExecResult>;

/** Default SSH executor: spawns `ssh <target> <command>`. */
export function defaultSshExec(target: string, command: string): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const proc = cp.spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, command], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }));
    proc.on("error", (err) => resolve({ ok: false, stdout: "", stderr: err.message, code: null }));
  });
}

/** Default SCP executor: copies a file to the remote. */
export function scpFile(localPath: string, target: string, remotePath: string): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const proc = cp.spawn("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", localPath, `${target}:${remotePath}`], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }));
    proc.on("error", (err) => resolve({ ok: false, stdout: "", stderr: err.message, code: null }));
  });
}

// ============================================================================
// Session DB directory resolution
// ============================================================================

/** Resolve the opencode data directory (where session DBs live).
 *  Uses XDG_DATA_HOME/opencode if set, otherwise ~/.local/share/opencode.
 *  This mirrors opencode's own resolution in packages/core/src/global.ts:
 *  `path.join(xdgData, "opencode")` */
export function resolveSessionDbDir(): string {
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
  return path.join(xdgData, "opencode");
}

// ============================================================================
// Local repo detection — find amicode + opencode repos from the running build
// ============================================================================

/** Find the git repo root by walking up from a starting directory. */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Detect the local amicode repo root from the extension path.
 *  The extension lives inside the repo — walk up to .git.
 *  Falls back to ~/harmoniqs/amicode if detection fails. */
export function detectAmicodeRepoDir(extensionPath?: string): string {
  if (extensionPath) {
    const root = findGitRoot(extensionPath);
    if (root) return root;
  }
  return path.join(homedir(), "harmoniqs", "amicode");
}

/** Detect the local opencode repo root from the configured binary path.
 *  The binary lives inside the repo — walk up to .git.
 *  Falls back to ~/harmoniqs/opencode if detection fails. */
export function detectOpencodeRepoDir(binaryPath?: string): string {
  if (binaryPath) {
    const root = findGitRoot(path.dirname(binaryPath));
    if (root) return root;
  }
  return path.join(homedir(), "harmoniqs", "opencode");
}

/** Detect both repo paths from the running build context. */
export function detectLocalRepos(opts?: { extensionPath?: string; binaryPath?: string }): {
  amicode: string;
  opencode: string;
} {
  return {
    amicode: detectAmicodeRepoDir(opts?.extensionPath),
    opencode: detectOpencodeRepoDir(opts?.binaryPath),
  };
}
