/**
 * Pre-deploy server teardown (#1146, ADR 0020 lifecycle gap; hardened by #1178).
 *
 * The detached-spawn model lets the opencode server survive the extension
 * host's exit. A rebuild swaps the binary + dist underneath it; on reload,
 * the new extension tries to cold-spawn on the same port and hits a
 * ServeError (port occupied), while the health probe gets 401 from the old
 * server's password -> boot failure.
 *
 * Fix (#1178) — CONFIRM BEFORE DELETE. The handshake is the ONLY record of the
 * surviving server's password; deleting it while the server still holds the
 * port orphans that server (nothing can adopt it, nothing can cold-spawn past
 * it). So teardown targets the PORT, using the recorded PID only as a hint:
 *
 *   1. If the port is already free  -> safe to clear the (stale) handshake.
 *   2. If occupied, SIGTERM the recorded PID; re-probe the port.
 *   3. Still occupied -> escalate to kill-by-port (SIGTERM then SIGKILL the
 *      process actually holding the port); re-probe.
 *   4. Port verified free -> delete the handshake.
 *   5. Port could NOT be freed -> HARD FAILURE, handshake PRESERVED (never
 *      orphan the server; the rebuild surfaces the failure instead).
 */

import { readHandshake, deleteHandshake, handshakePath } from "../server_handshake";

export interface TeardownResult {
  stopped: boolean;
  /** True when the port could not be freed — the handshake was preserved. */
  failed?: boolean;
  /** Present on a hard failure — names the port that could not be freed. */
  error?: string;
  pid?: number;
  port?: number;
  method: "handshake" | "kill-by-port" | "already-dead" | "no-server";
}

export interface TeardownDeps {
  log: (line: string) => void;
  /** Port for the no-handshake fallback (default 43117). */
  fallbackPort?: number;
  /** Override the handshake path (tests). */
  handshakePath?: string;
  /** Is the port currently bound? (default: lsof probe) */
  isPortOccupied?: (port: number) => boolean;
  /** Which PID currently holds the port? (default: lsof -ti) */
  pidOnPort?: (port: number) => number | undefined;
  /** PID existence check (default: process.kill(pid, 0)). */
  isAlive?: (pid: number) => boolean;
  /** Send a signal (default: process.kill). */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  /** Sleep between port re-probes (default: real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

/** Re-probe the port a bounded number of times; true once it's free. */
async function waitForFree(
  port: number,
  isPortOccupied: (port: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  attempts = 8,
  delayMs = 300,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (!isPortOccupied(port)) return true;
    await sleep(delayMs);
  }
  return !isPortOccupied(port);
}

export async function stopSurvivingServer(deps: TeardownDeps): Promise<TeardownResult> {
  const hsPath = deps.handshakePath ?? handshakePath();
  const isPortOccupied = deps.isPortOccupied ?? defaultIsPortOccupied;
  const pidOnPort = deps.pidOnPort ?? defaultPidOnPort;
  const isAlive = deps.isAlive ?? defaultIsAlive;
  const kill = deps.kill ?? defaultKill;
  const sleep = deps.sleep ?? defaultSleep;

  const hs = readHandshake(hsPath);
  const recordedPid = hs.status === "ok" ? hs.record.pid : undefined;
  const port = hs.status === "ok" ? hs.record.port : (deps.fallbackPort ?? 43117);

  // 1. Port already free — nothing holds it, so clearing the record is safe.
  if (!isPortOccupied(port)) {
    deleteHandshake(hsPath);
    if (recordedPid !== undefined) {
      deps.log(`[teardown] port ${port} free; recorded PID ${recordedPid} already gone — handshake cleared`);
      return { stopped: false, pid: recordedPid, port, method: "already-dead" };
    }
    deps.log(`[teardown] no surviving server on port ${port}`);
    return { stopped: false, port, method: "no-server" };
  }

  // 2. Port occupied — try the recorded PID first (the common, clean case).
  let method: TeardownResult["method"] = "handshake";
  if (recordedPid !== undefined && isAlive(recordedPid)) {
    deps.log(`[teardown] SIGTERM recorded PID ${recordedPid} (port ${port})`);
    try { kill(recordedPid, "SIGTERM"); } catch { /* already gone — re-probe decides */ }
    if (await waitForFree(port, isPortOccupied, sleep)) {
      deleteHandshake(hsPath);
      deps.log(`[teardown] port ${port} freed via recorded PID`);
      return { stopped: true, pid: recordedPid, port, method: "handshake" };
    }
  }

  // 3. Escalate — the recorded PID was stale or stubborn. Target whoever
  //    actually holds the port. THIS is what prevents orphaning: the recorded
  //    PID is a hint, the port is the authority.
  method = "kill-by-port";
  const holder = pidOnPort(port);
  if (holder !== undefined) {
    deps.log(`[teardown] kill-by-port: SIGTERM ${holder} (port ${port})`);
    try { kill(holder, "SIGTERM"); } catch { /* re-probe decides */ }
    if (!(await waitForFree(port, isPortOccupied, sleep))) {
      deps.log(`[teardown] kill-by-port: SIGKILL ${holder} (port ${port})`);
      try { kill(holder, "SIGKILL"); } catch { /* re-probe decides */ }
      await waitForFree(port, isPortOccupied, sleep);
    }
  }

  // 4. Verify free BEFORE deleting — this is the confirm-before-delete gate.
  if (!isPortOccupied(port)) {
    deleteHandshake(hsPath);
    deps.log(`[teardown] port ${port} freed; handshake cleared`);
    return { stopped: true, pid: recordedPid, port, method };
  }

  // 5. Could not free the port — HARD FAILURE. Preserve the handshake so the
  //    surviving server stays adoptable; never leave a live server orphaned.
  const stillHolder = pidOnPort(port);
  const err =
    `Could not free port ${port} (recorded PID ${recordedPid ?? "none"}, ` +
    `holder ${stillHolder ?? "unknown"}); handshake preserved to avoid orphaning the server.`;
  deps.log(`[teardown] ${err}`);
  return { stopped: false, failed: true, pid: recordedPid, port, method, error: err };
}

// ── Default (production) seams ──────────────────────────────────────────────

function defaultIsPortOccupied(port: number): boolean {
  return defaultPidOnPort(port) !== undefined;
}

function defaultPidOnPort(port: number): number | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
    const first = out.split("\n")[0]?.trim();
    if (first && /^\d+$/.test(first)) return parseInt(first, 10);
    return undefined;
  } catch {
    // lsof error or no listener → treat as free.
    return undefined;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
