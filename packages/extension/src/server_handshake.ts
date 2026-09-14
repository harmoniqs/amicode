import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// Server handshake record — the durable adoption record for the standalone
// server (ADR 0020). Written by the extension host on cold spawn, read by a
// later activation to adopt a surviving server.
//
// The record lives at `~/.amico/ops/server/standalone.json`, mode 0600.
// It carries the surviving server's port, PID, password, binary/config
// hashes, and protocol version — everything a re-activating extension needs
// to authenticate and classify the record as adoptable, stale, or foreign.
//
// The password is persisted at rest (amends ADR 0002) — mitigated exactly
// as ADR 0005's Fleet token (loopback-only binding, 0600, rotation on
// genuine spawn). It NEVER appears in logs, telemetry, or error payloads.
// ============================================================================

/** The current protocol version. Exact string equality = compatible. */
export const PROTOCOL_VERSION = "1";

/** The handshake record fields persisted to disk. */
export interface HandshakeRecord {
  port: number;
  pid: number;
  startedAt: string; // ISO 8601
  password: string;
  binaryHash: string;
  configHash: string;
  protocolVersion: string;
}

/** Result of reading the handshake file. */
export type HandshakeReadResult =
  | { status: "ok"; record: HandshakeRecord }
  | { status: "absent" }
  | { status: "invalid"; reason: string };

/** Gate classification: can a surviving server be adopted? */
export type GateVerdict = "adoptable" | "stale" | "foreign";

// ── Path ────────────────────────────────────────────────────────────────────

/** Default handshake path: ~/.amico/ops/server/standalone.json */
export function handshakePath(opsRoot?: string): string {
  return join(opsRoot ?? join(homedir(), ".amico", "ops"), "server", "standalone.json");
}

// ── Write ───────────────────────────────────────────────────────────────────

/** Write (or rewrite) the handshake record atomically with mode 0600. */
export function writeHandshake(record: HandshakeRecord, filePath?: string): void {
  const p = filePath ?? handshakePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
}

// ── Read ────────────────────────────────────────────────────────────────────

/** Read and validate the handshake record. Never throws — malformed / absent
 *  files return a typed result. */
export function readHandshake(filePath?: string): HandshakeReadResult {
  const p = filePath ?? handshakePath();
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: `read error: ${err?.message ?? err}` };
  }
  return parseHandshake(raw);
}

function parseHandshake(raw: string): HandshakeReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: "invalid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { status: "invalid", reason: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const required: (keyof HandshakeRecord)[] = [
    "port", "pid", "startedAt", "password", "binaryHash", "configHash", "protocolVersion",
  ];
  for (const key of required) {
    if (!(key in obj)) return { status: "invalid", reason: `missing field: ${key}` };
  }
  if (typeof obj.port !== "number") return { status: "invalid", reason: "port is not a number" };
  if (typeof obj.pid !== "number") return { status: "invalid", reason: "pid is not a number" };
  if (typeof obj.startedAt !== "string") return { status: "invalid", reason: "startedAt is not a string" };
  if (typeof obj.password !== "string") return { status: "invalid", reason: "password is not a string" };
  if (typeof obj.binaryHash !== "string") return { status: "invalid", reason: "binaryHash is not a string" };
  if (typeof obj.configHash !== "string") return { status: "invalid", reason: "configHash is not a string" };
  if (typeof obj.protocolVersion !== "string") return { status: "invalid", reason: "protocolVersion is not a string" };
  return {
    status: "ok",
    record: {
      port: obj.port as number,
      pid: obj.pid as number,
      startedAt: obj.startedAt as string,
      password: obj.password as string,
      binaryHash: obj.binaryHash as string,
      configHash: obj.configHash as string,
      protocolVersion: obj.protocolVersion as string,
    },
  };
}

// ── Delete ──────────────────────────────────────────────────────────────────

/** Delete the handshake record. Deleting an absent file is a no-op. */
export function deleteHandshake(filePath?: string): void {
  const p = filePath ?? handshakePath();
  try {
    unlinkSync(p);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

// ── Gate classifier ─────────────────────────────────────────────────────────

export interface GateInputs {
  /** Server responds to a health probe (HTTP 2xx/3xx on port). */
  healthy: boolean;
  /** The PID in the record is still alive (os.kill(pid, 0)). */
  pidAlive: boolean;
  /** The password in the record authenticates successfully against the server. */
  passwordChallengePass: boolean;
  /** The protocolVersion in the record matches PROTOCOL_VERSION exactly. */
  protocolCompatible: boolean;
}

/**
 * Classify a handshake record as adoptable, stale, or foreign.
 *
 * - All four checks pass → **adoptable** (safe to reconnect).
 * - Port answers but challenge fails → **foreign** (someone else's server).
 * - Otherwise → **stale** (dead or incompatible — cold-spawn required).
 */
export function classifyGate(inputs: GateInputs): GateVerdict {
  const { healthy, pidAlive, passwordChallengePass, protocolCompatible } = inputs;

  // All pass → adoptable
  if (healthy && pidAlive && passwordChallengePass && protocolCompatible) {
    return "adoptable";
  }

  // Port answers (healthy) but password challenge fails → foreign
  if (healthy && !passwordChallengePass) {
    return "foreign";
  }

  // Everything else: dead PID, dead port, protocol mismatch → stale
  return "stale";
}

// ── Hash helpers ────────────────────────────────────────────────────────────

/** SHA-256 of a file's contents — used for the binary hash. */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/** SHA-256 of a string — used for the config content hash. */
export function hashString(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Cold-spawn password ─────────────────────────────────────────────────────

/** Mint a fresh random password for the handshake record (32 bytes, base64url).
 *  Identical algorithm to mintServerPassword in server_auth.ts — a fresh value
 *  per cold spawn, never reused across spawns. */
export function mintHandshakePassword(): string {
  return randomBytes(32).toString("base64url");
}

// ── Cold-spawn integration ──────────────────────────────────────────────────

export interface ColdSpawnHandshakeOpts {
  port: number;
  pid: number;
  password: string;
  binaryHash: string;
  configHash: string;
  /** Override the handshake file path (tests). */
  filePath?: string;
}

/** Write the handshake record after a cold spawn completes its health probe.
 *  Called from the server manager's onReady handler — NEVER before health
 *  passes. Generates startedAt and stamps PROTOCOL_VERSION automatically. */
export function writeColdSpawnHandshake(opts: ColdSpawnHandshakeOpts): void {
  writeHandshake(
    {
      port: opts.port,
      pid: opts.pid,
      startedAt: new Date().toISOString(),
      password: opts.password,
      binaryHash: opts.binaryHash,
      configHash: opts.configHash,
      protocolVersion: PROTOCOL_VERSION,
    },
    opts.filePath,
  );
}
