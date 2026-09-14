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

  // No handshake or invalid → cold-spawn (fresh install)
  if (hs.status === "absent" || hs.status === "invalid") {
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

/** Health probe: HTTP GET to 127.0.0.1:<port>/, 2xx/3xx = healthy.
 *  Short timeout — we're probing loopback, so any answer is fast. */
export async function probeHealth(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
      return r.ok || (r.status >= 200 && r.status < 400);
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

/** Build the production deps for adoptOrSpawn. */
export function buildLiveDeps(
  coldSpawn: () => Promise<{ port: number; pid: number; password: string }>,
): AdoptOrSpawnDeps {
  return {
    healthCheck: probeHealth,
    pidAlive: isPidAlive,
    passwordChallenge: challengePassword,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn,
  };
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
