import {
  readHandshake,
  classifyGate,
  PROTOCOL_VERSION,
  type GateInputs,
} from "./server_handshake";
import { serverAuthHeader } from "./server_auth";

// ============================================================================
// Server lifecycle — adopt-or-spawn (#1145, ADR 0020)
//
// On activation, read the handshake record and run the four-check gate:
//   1. Health probe: HTTP GET to the recorded port's health endpoint
//   2. PID alive:    process.kill(pid, 0) — signal 0 = existence check
//   3. Password:     authenticated request to the server
//   4. Protocol:     compare handshake protocolVersion vs this build
//
// Verdict → outcome:
//   adoptable        → adopt (reuse recorded password + port, no spawn)
//   stale            → cold-spawn (port is free — rotate password)
//   foreign          → error (port occupied by someone else's process)
//   incompatible     → error (our own server but wrong protocolVersion)
// ============================================================================

/** Dependencies injected for testability — every live check is a seam. */
export interface AdoptOrSpawnDeps {
  /** HTTP health probe to the recorded port. */
  healthCheck: (port: number) => Promise<boolean>;
  /** PID existence check (process.kill(pid, 0)). */
  pidAlive: (pid: number) => boolean;
  /** Authenticated request to verify the recorded password works. */
  passwordChallenge: (port: number, password: string) => Promise<boolean>;
  /** The current build's protocol version. */
  protocolVersion: string;
  /** Cold-spawn a new server — returns the new server's port, PID, and password. */
  coldSpawn: () => Promise<{ port: number; pid: number; password: string }>;
  // ── Reclaim seam (#1178) — only used on the NO-handshake path ──
  /** The port a cold-spawn would bind. When set (with probePort), the
   *  no-handshake path checks it for an orphaned survivor before spawning. */
  configuredPort?: number;
  /** Probe the configured port: is it occupied, and is the occupant one of
   *  OUR opencode servers (an orphan we may reclaim) vs. a foreign process? */
  probePort?: (port: number) => Promise<{ occupied: boolean; isOurServer: boolean; pid?: number }>;
  /** Free an orphaned port (kill the opencode server holding it). Returns
   *  whether the port was actually freed. Never called for a foreign holder. */
  reclaimPort?: (port: number) => Promise<boolean>;
}

export type AdoptOrSpawnOutcome =
  | "adopted"
  | "cold-spawned"
  | "foreign-error"
  | "incompatible-error";

export interface AdoptOrSpawnResult {
  outcome: AdoptOrSpawnOutcome;
  port: number;
  pid: number;
  password: string;
  /** Present on error outcomes — describes what went wrong. */
  error?: string;
  /** Present on "adopted" — the server's recorded hashes for stale-engine
   *  detection (#1148). The caller compares these against on-disk hashes. */
  adoptedHashes?: { binaryHash: string; configHash: string };
  /** Present on "cold-spawned" — true when an orphaned port was reclaimed
   *  before the cold-spawn (#1178). */
  reclaimed?: boolean;
}

/**
 * Adopt-or-spawn: the activation decision (#1145).
 *
 * Read the handshake → run the four-check gate → adopt / cold-spawn / error.
 */
export async function adoptOrSpawn(
  handshakePath: string,
  deps: AdoptOrSpawnDeps,
): Promise<AdoptOrSpawnResult> {
  // Step 1: read the handshake
  const hs = readHandshake(handshakePath);

  // No handshake or invalid → cold-spawn (fresh install) — but first check the
  // configured port for an ORPHANED survivor (#1178): a server we spawned that
  // outlived its handshake. Without this, the cold-spawn ServeErrors on the
  // occupied port forever (the stuck state). We reclaim ours; we never touch a
  // foreign holder.
  if (hs.status === "absent" || hs.status === "invalid") {
    if (deps.configuredPort !== undefined && deps.probePort) {
      const probe = await deps.probePort(deps.configuredPort);
      if (probe.occupied) {
        if (!probe.isOurServer) {
          return {
            outcome: "foreign-error",
            port: deps.configuredPort,
            pid: probe.pid ?? -1,
            password: "",
            error: `Port ${deps.configuredPort} is occupied by a foreign process` +
              (probe.pid ? ` (PID ${probe.pid})` : "") +
              ` and there is no handshake to adopt it. Not reclaiming — choose a different port or stop that process.`,
          };
        }
        // Our orphan (no handshake, but our server holds the port) → reclaim.
        const freed = deps.reclaimPort ? await deps.reclaimPort(deps.configuredPort) : false;
        if (!freed) {
          return {
            outcome: "foreign-error",
            port: deps.configuredPort,
            pid: probe.pid ?? -1,
            password: "",
            error: `Could not reclaim orphaned server on port ${deps.configuredPort}` +
              (probe.pid ? ` (PID ${probe.pid})` : "") + `.`,
          };
        }
        const spawned = await deps.coldSpawn();
        return { outcome: "cold-spawned", ...spawned, reclaimed: true };
      }
    }
    const spawned = await deps.coldSpawn();
    return { outcome: "cold-spawned", ...spawned };
  }

  const record = hs.record;

  // Step 2: run the four live checks
  const pidAlive = deps.pidAlive(record.pid);
  const healthy = pidAlive ? await deps.healthCheck(record.port) : false;
  const passwordChallengePass = healthy
    ? await deps.passwordChallenge(record.port, record.password)
    : false;
  const protocolCompatible = record.protocolVersion === deps.protocolVersion;

  // Step 3: classify
  const inputs: GateInputs = { healthy, pidAlive, passwordChallengePass, protocolCompatible };
  const verdict = classifyGate(inputs);

  switch (verdict) {
    case "adoptable":
      return {
        outcome: "adopted",
        port: record.port,
        pid: record.pid,
        password: record.password,
        adoptedHashes: {
          binaryHash: record.binaryHash,
          configHash: record.configHash,
        },
      };

    case "stale":
      // Distinguish: if the server is alive (healthy + auth passes) but protocol
      // is incompatible, that's OUR server at the wrong version — do not spawn
      // on the occupied port. classifyGate lumps this into "stale", but the
      // lifecycle must treat it as an error.
      if (healthy && passwordChallengePass && !protocolCompatible) {
        return {
          outcome: "incompatible-error",
          port: record.port,
          pid: record.pid,
          password: record.password,
          error: `Server on port ${record.port} (PID ${record.pid}) runs protocol version ` +
            `"${record.protocolVersion}" but this build requires "${deps.protocolVersion}". ` +
            `Restart the server to apply the new build.`,
        };
      }
      // Genuinely stale — dead PID or no responder → cold-spawn
      const spawned = await deps.coldSpawn();
      return { outcome: "cold-spawned", ...spawned };

    case "foreign":
      return {
        outcome: "foreign-error",
        port: record.port,
        pid: record.pid,
        password: record.password,
        error: `Port ${record.port} is occupied by a foreign process (PID ${record.pid}). ` +
          `The process was not killed. Choose a different port or stop the other process.`,
      };
  }
}

// ============================================================================
// Production implementations of the four live checks
// ============================================================================

/** Reachability probe: HTTP GET to 127.0.0.1:<port>/. ANY HTTP response —
 *  including a 401 — means a server is up on this port; only a connection
 *  refused / timeout means nothing is there. The password challenge, not this
 *  probe, decides whether the server is OURS.
 *
 *  #1185: this used to return `r.ok || 2xx–3xx`, but every server is spawned
 *  with OPENCODE_SERVER_PASSWORD armed (#163), so an anonymous GET / gets a 401.
 *  That made `healthy` false for every real survivor, so classifyGate could
 *  never reach `adoptable` and adopt-on-reload never fired. Reachability is the
 *  question here — answer it honestly and let challengePassword do ownership. */
export async function probeHealth(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      // Resolving (no throw) means the server answered — 200 or 401, it's up.
      await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** PID-alive check: signal 0 = existence probe, no signal sent. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Password challenge: authenticated GET to 127.0.0.1:<port>/ with the
 *  recorded password. A 200/3xx = challenge passes; 401/403 = fails. */
export async function challengePassword(port: number, password: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, {
        signal: ctrl.signal,
        headers: { Authorization: serverAuthHeader(password) },
      });
      return r.ok || (r.status >= 200 && r.status < 400);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Build the production deps for adoptOrSpawn.
 *  When `configuredPort` is given, the reclaim seam (#1178) is wired so the
 *  no-handshake path can recover an orphaned port instead of ServeError-looping. */
export function buildLiveDeps(
  coldSpawn: () => Promise<{ port: number; pid: number; password: string }>,
  configuredPort?: number,
): AdoptOrSpawnDeps {
  return {
    healthCheck: probeHealth,
    pidAlive: isPidAlive,
    passwordChallenge: challengePassword,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn,
    configuredPort,
    probePort: configuredPort !== undefined ? probePortOccupant : undefined,
    reclaimPort: configuredPort !== undefined ? reclaimOrphanPort : undefined,
  };
}

/** Which PID (if any) holds the port, via lsof. */
function pidHoldingPort(port: number): number | undefined {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
    const first = out.split("\n")[0]?.trim();
    return first && /^\d+$/.test(first) ? parseInt(first, 10) : undefined;
  } catch {
    return undefined;
  }
}

/** Is this PID one of OUR opencode servers? Reads its command line. */
function isOpencodeServer(pid: number): boolean {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const cmd = execSync(`ps -o command= -p ${pid}`, { timeout: 5000 }).toString().trim();
    return /opencode/.test(cmd) && /serve/.test(cmd);
  } catch {
    return false;
  }
}

/** Production probe: is the port occupied, and is the occupant our server? */
export async function probePortOccupant(
  port: number,
): Promise<{ occupied: boolean; isOurServer: boolean; pid?: number }> {
  const pid = pidHoldingPort(port);
  if (pid === undefined) return { occupied: false, isOurServer: false };
  return { occupied: true, isOurServer: isOpencodeServer(pid), pid };
}

/** Production reclaim: SIGTERM then SIGKILL the port holder; verify freed.
 *  Only ever called by adoptOrSpawn AFTER probePort confirms the holder is
 *  our opencode server — never against a foreign process. */
export async function reclaimOrphanPort(port: number): Promise<boolean> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const pid = pidHoldingPort(port);
  if (pid === undefined) return true; // already free
  try { process.kill(pid, "SIGTERM"); } catch { /* re-probe decides */ }
  for (let i = 0; i < 6; i++) {
    if (pidHoldingPort(port) === undefined) return true;
    await sleep(250);
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* re-probe decides */ }
  await sleep(500);
  return pidHoldingPort(port) === undefined;
}


// ============================================================================
// Stale-engine detection (#1148, ADR 0020)
// ============================================================================

export interface StaleEngineResult {
  stale: boolean;
  binaryChanged: boolean;
  configChanged: boolean;
}

export function detectStaleEngine(
  adoptedHashes: { binaryHash: string; configHash: string },
  onDiskHashes: { binaryHash: string; configHash: string },
): StaleEngineResult {
  const binaryChanged = adoptedHashes.binaryHash !== onDiskHashes.binaryHash;
  const configChanged = adoptedHashes.configHash !== onDiskHashes.configHash;
  return { stale: binaryChanged || configChanged, binaryChanged, configChanged };
}

export interface StaleNoticeDeps {
  showInformationMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  onRestartRequested: () => Promise<void>;
}

export function surfaceStaleNotice(
  result: StaleEngineResult,
  deps: StaleNoticeDeps,
): void {
  if (!result.stale) return;
  const detail = result.binaryChanged && result.configChanged
    ? "engine binary and config"
    : result.binaryChanged
      ? "engine binary"
      : "config";
  void deps.showInformationMessage(
    `Amicode: the running server's ${detail} differs from the current build.`,
    "Restart Engine",
  ).then((choice) => {
    if (choice === "Restart Engine") void deps.onRestartRequested();
  });
}

export interface RestartEngineDeps {
  hasInflightTurns: () => boolean;
  showWarningMessage: (message: string, ...items: string[]) => Thenable<string | undefined>;
  stopServer: () => Promise<void>;
  deleteHandshake: () => void;
  coldSpawn: () => Promise<void>;
}

export async function restartEngine(deps: RestartEngineDeps): Promise<void> {
  if (deps.hasInflightTurns()) {
    const choice = await deps.showWarningMessage(
      "Amicode: there are in-flight turns — restarting the engine will interrupt them.",
      "Restart anyway",
      "Cancel",
    );
    if (choice !== "Restart anyway") return;
  }
  await deps.stopServer();
  deps.deleteHandshake();
  await deps.coldSpawn();
}
