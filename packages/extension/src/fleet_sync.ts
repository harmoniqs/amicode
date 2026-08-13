// Fleet Sync — bidirectional replication with the canonical host.
//
// The host is ground truth in fleet mode. But if the client does dev work in
// standalone mode and pushes to origin, the host absorbs those changes on
// reconnect. Flow:
//
//   Fleet mode:     host → client (auto-sync, host is truth)
//   Standalone:     client works independently, pushes to origin
//   On reconnect:   client pushes to origin → host pulls + rebuilds → client syncs from host
//
// After reconnect sync, both sides are identical again.

import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";
import type { SshExec } from "./fleet_wizard";
import { defaultSshExec, resolveSessionDbDir, detectLocalRepos } from "./fleet_wizard";
import { readFleetConfig, getFleetRole } from "./fleet_fallback";

// ============================================================================
// Sync state
// ============================================================================

export type SyncStatus = "idle" | "checking" | "syncing" | "up-to-date" | "error";

export interface SyncState {
  status: SyncStatus;
  lastSync?: string;
  localSha?: string;
  remoteSha?: string;
  error?: string;
}

export interface SyncResult {
  synced: boolean;
  buildUpdated: boolean;
  sessionsUpdated: boolean;
  conflict?: SyncConflict;
  error?: string;
}

export interface SyncConflict {
  repo: "amicode" | "opencode";
  type: "push-rejected" | "merge-conflict" | "diverged";
  localSha: string;
  remoteSha: string;
  detail: string;
}

// ============================================================================
// SHA check — are we on the same commit as the host?
// ============================================================================

/** Get the local amicode repo git SHA. */
export function getLocalSha(repoDir?: string): string | null {
  const dir = repoDir ?? detectLocalRepos().amicode;
  try {
    return cp.execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/** Get the host's amicode repo git SHA over SSH. */
export async function getRemoteSha(
  target: string,
  opts: { exec?: SshExec } = {},
): Promise<string | null> {
  const exec = opts.exec ?? defaultSshExec;
  const result = await exec(target, "cd ~/harmoniqs/amicode && git rev-parse HEAD 2>/dev/null");
  return result.ok && result.stdout.trim() ? result.stdout.trim() : null;
}

// ============================================================================
// Build sync — pull the host's exact SHA and rebuild locally
// ============================================================================

/** Pull the host's exact commits and rebuild. After this, client = host. */
export async function syncBuild(
  target: string,
  opts: { exec?: SshExec; onProgress?: (step: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const exec = opts.exec ?? defaultSshExec;
  const progress = opts.onProgress ?? (() => {});
  const repos = detectLocalRepos();
  const repoDir = repos.amicode;
  const ocRepoDir = repos.opencode;

  // Get the host's exact SHAs + branches
  progress("Reading host state...");
  const [amSha, ocSha, amBranch, ocBranch] = await Promise.all([
    exec(target, "cd ~/harmoniqs/amicode && git rev-parse HEAD"),
    exec(target, "cd ~/harmoniqs/opencode && git rev-parse HEAD"),
    exec(target, "cd ~/harmoniqs/amicode && git rev-parse --abbrev-ref HEAD"),
    exec(target, "cd ~/harmoniqs/opencode && git rev-parse --abbrev-ref HEAD"),
  ]);
  if (!amSha.ok || !ocSha.ok) {
    return { ok: false, error: "Could not read host git state" };
  }

  const amicodeTarget = amSha.stdout.trim();
  const opencodeTarget = ocSha.stdout.trim();
  const amicodeBranch = amBranch.ok ? amBranch.stdout.trim() : "main";
  const opencodeBranch = ocBranch.ok ? ocBranch.stdout.trim() : "local/amicode";

  // Reset opencode to the host's exact state
  progress("Syncing opencode...");
  try {
    cp.execSync(
      `git fetch origin && git checkout ${opencodeBranch} && git reset --hard ${opencodeTarget}`,
      { cwd: ocRepoDir, encoding: "utf8", timeout: 60000 },
    );
  } catch (err) {
    return { ok: false, error: `opencode sync failed: ${err}` };
  }

  // Reset amicode to the host's exact state
  progress("Syncing amicode...");
  try {
    cp.execSync(
      `git fetch origin && git checkout ${amicodeBranch} && git reset --hard ${amicodeTarget}`,
      { cwd: repoDir, encoding: "utf8", timeout: 60000 },
    );
  } catch (err) {
    return { ok: false, error: `amicode sync failed: ${err}` };
  }

  // Build opencode binary
  progress("Building opencode...");
  try {
    cp.execSync("bun install && bun run script/build.ts --single --skip-install", {
      cwd: path.join(ocRepoDir, "packages", "opencode"),
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (err) {
    return { ok: false, error: `opencode build failed: ${err}` };
  }

  // Codesign (macOS)
  if (process.platform === "darwin") {
    const bin = path.join(ocRepoDir, "packages", "opencode", "dist", "opencode-darwin-arm64", "bin", "opencode");
    try { cp.execSync(`codesign --sign - --force "${bin}"`, { timeout: 10000 }); } catch {}
  }

  // Build amicode extension
  progress("Building extension...");
  try {
    cp.execSync("pnpm install && pnpm run build", {
      cwd: path.join(repoDir, "packages", "extension"),
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (err) {
    return { ok: false, error: `extension build failed: ${err}` };
  }

  return { ok: true };
}

// ============================================================================
// Push local work directly to the host (no GitHub round-trip)
// ============================================================================

/** The git remote name used for direct-to-host push. */
export const FLEET_REMOTE = "fleet-host";

/** Ensure the fleet-host remote is configured on local repos pointing at
 *  the host's repos over SSH. One-time setup per client. */
export function ensureFleetRemote(
  target: string,
  opts: { repoDir?: string; ocRepoDir?: string } = {},
): void {
  const repoDir = opts.repoDir ?? detectLocalRepos().amicode;
  const ocRepoDir = opts.ocRepoDir ?? detectLocalRepos().opencode;

  for (const dir of [repoDir, ocRepoDir]) {
    const repoName = path.basename(dir); // "amicode" or "opencode"
    try {
      // Check if remote already exists
      const existing = cp.execSync(`git remote get-url ${FLEET_REMOTE} 2>/dev/null || true`, {
        cwd: dir, encoding: "utf8", timeout: 5000,
      }).trim();
      const expectedUrl = `${target}:~/harmoniqs/${repoName}`;
      if (!existing || existing !== expectedUrl) {
        // Remove stale remote if exists, then add
        cp.execSync(`git remote remove ${FLEET_REMOTE} 2>/dev/null || true`, { cwd: dir, timeout: 5000 });
        cp.execSync(`git remote add ${FLEET_REMOTE} ${expectedUrl}`, { cwd: dir, encoding: "utf8", timeout: 5000 });
      }
    } catch {
      // Best-effort — sync will fail later with a clear error
    }
  }
}

/** Configure the host's repos to accept pushes to the checked-out branch.
 *  Run once during fleet setup. */
export async function configureHostForDirectPush(
  target: string,
  opts: { exec?: SshExec } = {},
): Promise<{ ok: boolean; error?: string }> {
  const exec = opts.exec ?? defaultSshExec;
  const result = await exec(target, `
    cd ~/harmoniqs/amicode && git config receive.denyCurrentBranch updateInstead
    cd ~/harmoniqs/opencode && git config receive.denyCurrentBranch updateInstead
  `);
  if (!result.ok) return { ok: false, error: result.stderr };
  return { ok: true };
}

/** Push any local commits directly to the host's repo over SSH.
 *  Called on reconnect so the host has the client's standalone work.
 *  Returns conflict info if the push is rejected (non-fast-forward). */
export function pushToHost(opts: { onProgress?: (step: string) => void } = {}): {
  pushed: boolean;
  amicodePushed: boolean;
  opencodePushed: boolean;
  conflict?: SyncConflict;
  error?: string;
} {
  const progress = opts.onProgress ?? (() => {});
  const repos = detectLocalRepos();
  const repoDir = repos.amicode;
  const ocRepoDir = repos.opencode;
  let amicodePushed = false;
  let opencodePushed = false;

  // Push amicode if there are commits the host doesn't have
  progress("Checking local amicode commits...");
  try {
    // Fetch to know what the host has
    cp.execSync(`git fetch ${FLEET_REMOTE} 2>/dev/null || true`, { cwd: repoDir, encoding: "utf8", timeout: 15000 });
    const ahead = cp.execSync(`git rev-list --count ${FLEET_REMOTE}/HEAD..HEAD 2>/dev/null || echo 0`, {
      cwd: repoDir, encoding: "utf8", timeout: 5000,
    });
    if (parseInt(ahead.trim()) > 0) {
      progress("Pushing amicode to host...");
      const branch = cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoDir, encoding: "utf8", timeout: 5000 }).trim();
      try {
        cp.execSync(`git push ${FLEET_REMOTE} ${branch}`, { cwd: repoDir, encoding: "utf8", timeout: 30000 });
        amicodePushed = true;
      } catch (pushErr) {
        const errMsg = String(pushErr);
        // Detect non-fast-forward (conflict)
        if (errMsg.includes("non-fast-forward") || errMsg.includes("rejected") || errMsg.includes("diverged")) {
          const localSha = cp.execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8", timeout: 5000 }).trim();
          const remoteSha = cp.execSync(`git rev-parse ${FLEET_REMOTE}/HEAD 2>/dev/null || echo unknown`, { cwd: repoDir, encoding: "utf8", timeout: 5000 }).trim();
          return {
            pushed: false, amicodePushed: false, opencodePushed: false,
            conflict: { repo: "amicode", type: "push-rejected", localSha, remoteSha, detail: errMsg },
          };
        }
        return { pushed: false, amicodePushed: false, opencodePushed: false, error: `amicode push failed: ${errMsg}` };
      }
    }
  } catch (err) {
    return { pushed: false, amicodePushed: false, opencodePushed: false, error: `amicode sync check failed: ${err}` };
  }

  // Push opencode
  progress("Checking local opencode commits...");
  try {
    cp.execSync(`git fetch ${FLEET_REMOTE} 2>/dev/null || true`, { cwd: ocRepoDir, encoding: "utf8", timeout: 15000 });
    const ahead = cp.execSync(`git rev-list --count ${FLEET_REMOTE}/HEAD..HEAD 2>/dev/null || echo 0`, {
      cwd: ocRepoDir, encoding: "utf8", timeout: 5000,
    });
    if (parseInt(ahead.trim()) > 0) {
      progress("Pushing opencode to host...");
      const branch = cp.execSync("git rev-parse --abbrev-ref HEAD", { cwd: ocRepoDir, encoding: "utf8", timeout: 5000 }).trim();
      try {
        cp.execSync(`git push ${FLEET_REMOTE} ${branch}`, { cwd: ocRepoDir, encoding: "utf8", timeout: 30000 });
        opencodePushed = true;
      } catch (pushErr) {
        const errMsg = String(pushErr);
        if (errMsg.includes("non-fast-forward") || errMsg.includes("rejected") || errMsg.includes("diverged")) {
          const localSha = cp.execSync("git rev-parse HEAD", { cwd: ocRepoDir, encoding: "utf8", timeout: 5000 }).trim();
          const remoteSha = cp.execSync(`git rev-parse ${FLEET_REMOTE}/HEAD 2>/dev/null || echo unknown`, { cwd: ocRepoDir, encoding: "utf8", timeout: 5000 }).trim();
          return {
            pushed: amicodePushed, amicodePushed, opencodePushed: false,
            conflict: { repo: "opencode", type: "push-rejected", localSha, remoteSha, detail: errMsg },
          };
        }
        return { pushed: amicodePushed, amicodePushed, opencodePushed: false, error: `opencode push failed: ${errMsg}` };
      }
    }
  } catch (err) {
    return { pushed: amicodePushed, amicodePushed, opencodePushed: false, error: `opencode sync check failed: ${err}` };
  }

  return { pushed: amicodePushed || opencodePushed, amicodePushed, opencodePushed };
}

/** Tell the host to rebuild after receiving pushed commits. */
export async function triggerHostRebuild(
  target: string,
  opts: { exec?: SshExec; onProgress?: (step: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const exec = opts.exec ?? defaultSshExec;
  const progress = opts.onProgress ?? (() => {});

  progress("Triggering host rebuild...");
  const result = await exec(target,
    "test -x ~/harmoniqs/rebuild_amicode.sh && ~/harmoniqs/rebuild_amicode.sh || (cd ~/harmoniqs/amicode && pnpm install && cd packages/extension && pnpm run build)");
  if (!result.ok) {
    return { ok: false, error: result.stderr || "Host rebuild failed" };
  }
  return { ok: true };
}

// ============================================================================
// Session sync — host DB replaces client's (host is ground truth in fleet mode)
// ============================================================================

/** Overwrite local session DB with the host's. No merge — host wins. */
export async function syncSessions(
  target: string,
  opts: { exec?: SshExec; localDir?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const exec = opts.exec ?? defaultSshExec;
  const localDir = opts.localDir ?? resolveSessionDbDir();

  // Resolve remote path
  const remoteResult = await exec(target, 'echo "${XDG_DATA_HOME:-$HOME/.local/share}/opencode"');
  const remoteDir = remoteResult.ok ? remoteResult.stdout.trim() : "~/.local/share/opencode";

  fs.mkdirSync(localDir, { recursive: true });

  // rsync: efficient delta transfer for the large DB. Host → client, overwrite.
  try {
    cp.execSync(
      `rsync -az --timeout=30 -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "${target}:${remoteDir}/opencode.db" "${localDir}/opencode.db"`,
      { encoding: "utf8", timeout: 120000 },
    );
    // WAL (may not exist)
    try {
      cp.execSync(
        `rsync -az --timeout=30 -e "ssh -o BatchMode=yes -o ConnectTimeout=10" "${target}:${remoteDir}/opencode.db-wal" "${localDir}/opencode.db-wal"`,
        { encoding: "utf8", timeout: 60000 },
      );
    } catch {}
    return { ok: true };
  } catch {
    // rsync unavailable — fall through to SCP
  }

  // Fallback: SCP (full copy, less efficient)
  try {
    cp.execSync(
      `scp -o BatchMode=yes -o ConnectTimeout=10 "${target}:${remoteDir}/opencode.db" "${localDir}/opencode.db"`,
      { encoding: "utf8", timeout: 120000 },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Session sync failed: ${err}` };
  }
}

// ============================================================================
// Full sync — the complete reconnect cycle
// ============================================================================

/** Full sync. On reconnect from standalone:
 *  1. Push local commits directly to host (client's standalone dev work)
 *     — if conflict detected, returns it for resolution via amicode chat
 *  2. Trigger host rebuild (so it picks up the pushed commits)
 *  3. Pull the host's state down (host → client, builds + sessions)
 *
 *  In normal fleet mode (no local changes): skips steps 1-2, just pulls. */
export async function syncFromHost(
  target: string,
  opts: {
    exec?: SshExec;
    onProgress?: (step: string) => void;
    forceBuild?: boolean;
  } = {},
): Promise<SyncResult> {
  const exec = opts.exec ?? defaultSshExec;
  const progress = opts.onProgress ?? (() => {});

  // Step 1: Push local work to host (if any)
  ensureFleetRemote(target);
  const pushResult = pushToHost({ onProgress: progress });

  // Conflict detected — return it so the caller can launch a resolution session
  if (pushResult.conflict) {
    progress(`Conflict in ${pushResult.conflict.repo} — needs resolution`);
    return {
      synced: false,
      buildUpdated: false,
      sessionsUpdated: false,
      conflict: pushResult.conflict,
    };
  }

  if (pushResult.error) {
    progress(`Push warning: ${pushResult.error}`);
  }

  // Step 2: If we pushed, trigger host rebuild so it integrates our changes
  if (pushResult.pushed) {
    const rebuildResult = await triggerHostRebuild(target, { exec, onProgress: progress });
    if (!rebuildResult.ok) {
      progress(`Host rebuild warning: ${rebuildResult.error}`);
    }
  }

  // Step 3: Check if builds differ and pull
  progress("Checking host state...");
  const localSha = getLocalSha();
  const remoteSha = await getRemoteSha(target, { exec });
  const buildsDiffer = !localSha || !remoteSha || localSha !== remoteSha;

  let buildUpdated = false;
  if (buildsDiffer || opts.forceBuild) {
    const buildResult = await syncBuild(target, { exec, onProgress: progress });
    if (!buildResult.ok) {
      return { synced: false, buildUpdated: false, sessionsUpdated: false, error: buildResult.error };
    }
    buildUpdated = true;
  }

  // Step 4: Sessions always sync (host → client, overwrite)
  progress("Syncing sessions...");
  const sessionResult = await syncSessions(target, { exec });

  progress(buildUpdated ? "Synced — reload window to pick up new build" : "Up to date");
  return { synced: true, buildUpdated, sessionsUpdated: sessionResult.ok, error: sessionResult.error };
}

// ============================================================================
// Auto-sync trigger
// ============================================================================

/** Should auto-sync run? (client mode + host configured) */
export function shouldAutoSync(): { should: boolean; target?: string } {
  if (getFleetRole() !== "client") return { should: false };
  const config = readFleetConfig();
  const target = config?.canonical?.sshAlias ?? config?.canonical?.host;
  if (!target) return { should: false };
  return { should: true, target };
}

// ============================================================================
// Conflict resolution — launches an amicode chat to resolve sync conflicts
// ============================================================================

/** Build the initial prompt for a conflict-resolution amicode session. */
export function buildConflictResolutionPrompt(conflict: SyncConflict): string {
  const repoDir = conflict.repo === "amicode"
    ? "~/harmoniqs/amicode"
    : "~/harmoniqs/opencode";

  return `Fleet sync conflict detected in **${conflict.repo}** (${repoDir}).

## What happened

The local branch has diverged from the fleet host. The push to the host was rejected because both sides have commits the other doesn't.

- **Local HEAD**: \`${conflict.localSha}\`
- **Host HEAD**: \`${conflict.remoteSha}\`
- **Type**: ${conflict.type}

## What needs to happen

Resolve the divergence so both client and host are on the same commit. Options:

1. **Rebase local onto host** — \`git fetch fleet-host && git rebase fleet-host/HEAD\` — preserves local work on top of the host's state. Resolve any file conflicts, then push.
2. **Force-push local** — \`git push fleet-host --force-with-lease\` — overwrites the host with local state. Only if you're sure the host's divergent commits are disposable.
3. **Reset local to host** — \`git reset --hard fleet-host/HEAD\` — discards local work, mirrors the host exactly. Use if the local changes are expendable.

Please inspect the divergence (\`git log --oneline fleet-host/HEAD..HEAD\` for local-only commits, \`git log --oneline HEAD..fleet-host/HEAD\` for host-only commits) and resolve it. After resolution, re-run the fleet sync.`;
}


