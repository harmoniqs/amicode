// Fleet configuration — the single source of truth for fleet role and topology.
// Config file: ~/.amico/ops/fleet/fleet.json
//   { "role": "standalone"|"server"|"client", "canonical": { "host": "...", "port": 4096, "sshAlias": "..." } }
// No file = standalone (safe zero-config default).
//
// "Go Standalone" (CONTEXT.md): the user-invoked mode switch from client to standalone.
// The machine leaves the fleet and serves itself permanently. Not an escape hatch —
// a first-class choice. Re-enrollment (joining a fleet) is a separate flow.
//
// Legacy: the old fallback.json marker is migrated to fleet.json on first read.
// (harmoniqs/amicode#338)

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export const FLEET_DIR = path.join(homedir(), ".amico", "ops", "fleet");
export const FLEET_CONFIG_PATH = path.join(FLEET_DIR, "fleet.json");
// Legacy path — migrated to fleet.json on read
const LEGACY_FALLBACK_PATH = path.join(FLEET_DIR, "fallback.json");

export interface FleetConfig {
  role: "standalone" | "server" | "client";
  canonical?: {
    host?: string;
    port?: number;
    sshAlias?: string;
  };
  /** Previous settings (for re-enrollment if the user wants to rejoin later). */
  previousBinary?: string;
  previousPort?: number;
}

/** Read fleet config from disk. No file = null (treated as standalone by callers). */
export function readFleetConfig(
  p: string = FLEET_CONFIG_PATH,
  read: (path: string) => string = (pp) => fs.readFileSync(pp, "utf8"),
): FleetConfig | null {
  try {
    const raw = read(p);
    const j = JSON.parse(raw) as FleetConfig;
    if (j && typeof j.role === "string") return j;
    return null;
  } catch {
    return null;
  }
}

/** Get the effective fleet role. No config = standalone. */
export function getFleetRole(p: string = FLEET_CONFIG_PATH, read?: (path: string) => string): "standalone" | "server" | "client" {
  const cfg = readFleetConfig(p, read);
  return cfg?.role ?? "standalone";
}

/** Is this machine a fleet client? (role = "client" in fleet.json) */
export function isFleetClient(p: string = FLEET_CONFIG_PATH, read?: (path: string) => string): boolean {
  return getFleetRole(p, read) === "client";
}

/** Write fleet config atomically (tmp + rename). */
export function writeFleetConfig(config: FleetConfig, p: string = FLEET_CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

/** Go Standalone: write role=standalone to fleet.json. Preserves previous settings for
 *  potential re-enrollment. Removes legacy fallback.json if present. */
export function goStandalone(opts: { previousBinary?: string; previousPort?: number; path?: string } = {}): FleetConfig {
  const p = opts.path ?? FLEET_CONFIG_PATH;
  const existing = readFleetConfig(p);
  const config: FleetConfig = {
    ...existing,
    role: "standalone",
    previousBinary: opts.previousBinary,
    previousPort: opts.previousPort,
  };
  writeFleetConfig(config, p);
  // Remove legacy fallback.json if present
  try { fs.unlinkSync(LEGACY_FALLBACK_PATH); } catch {}
  return config;
}

/** Remove fleet config entirely (equivalent to standalone — no file = standalone). */
export function removeFleetConfig(p: string = FLEET_CONFIG_PATH): void {
  try { fs.unlinkSync(p); } catch {}
  // Remove legacy fallback.json too
  try { fs.unlinkSync(LEGACY_FALLBACK_PATH); } catch {}
  // Clean empty dir (best-effort)
  try {
    if (fs.existsSync(FLEET_DIR) && fs.readdirSync(FLEET_DIR).length === 0) fs.rmdirSync(FLEET_DIR);
  } catch {}
}

/** Get the canonical server port from fleet config (default 4096). */
export function getCanonicalPort(p: string = FLEET_CONFIG_PATH, read?: (path: string) => string): number {
  const cfg = readFleetConfig(p, read);
  return cfg?.canonical?.port ?? 4096;
}

// ── Legacy compatibility ────────────────────────────────────────────────────
// The old fallback.json marker is treated as role=standalone for the guard.
// Extension code that formerly called isFallbackActive now calls isFleetClient
// (inverted logic: old fallback=active meant "allow spawn"; new client=true
// means "refuse spawn"). This section provides the migration bridge.

/** Migrate legacy fallback.json → fleet.json if fallback.json exists but fleet.json doesn't.
 *  Called once at extension activation. */
export function migrateLegacyFallback(): void {
  if (fs.existsSync(LEGACY_FALLBACK_PATH) && !fs.existsSync(FLEET_CONFIG_PATH)) {
    // Legacy fallback was active = the machine was in standalone mode
    goStandalone();
  }
}

// Re-export the config path for fleet_health.ts and other consumers
export { FLEET_CONFIG_PATH as FALLBACK_PATH }; // backward compat for any remaining import
