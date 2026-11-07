// Fleet configuration — the WRITER for the raw fleet.json (#1106, fleet
// rearchitect P3b-2, spec spec-20260913-114814 row 1).
//
// On-disk file: ~/.amico/ops/fleet/fleet.json
//   { "role": "standalone"|"server"|"client", "canonical": { "host": "...", "port": 4096, "sshAlias": "..." } }
//   No file = standalone (safe zero-config default).
//
// As of #1106 this module is a WRITER, never a parser: amicissimo's fleet
// authority owns the ONE parser for this file (behind the `amico fleet` CLI),
// and every amicode-side READ goes through the verb-refreshed projection cache
// (~/.amico/ops/fleet/projection.json) via fleet_topology.ts + @amicode/
// schema's reader. The write side stays exactly where it was because the mode
// flows (Go Standalone, legacy migration) mutate the machine-local membership
// record the ONE parser reads — the on-disk shape below is the parser's
// contract and must round-trip byte-for-parseable.
//
// "Go Standalone" (CONTEXT.md): the user-invoked mode switch from client to
// standalone. The machine leaves the fleet and serves itself permanently. Not
// an escape hatch — a first-class choice. Re-enrollment (joining a fleet) is a
// separate flow. Every writer here is followed at the CALL-SITE by a
// projection-cache refresh through the verb (`amico fleet status
// --projection`), so the consumers' cache stays coherent with the raw file.
//
// Legacy: the old fallback.json marker is migrated to fleet.json on activation
// (harmoniqs/amicode#338).

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { writeFleetConfig, type FleetConfig } from "@amicode/schema";

// The FleetConfig shape + the atomic writeFleetConfig writer were HOISTED to
// @amicode/schema (amicode#1319) so `amico fleet enroll` (in @amicode/amico-run,
// which cannot import this extension) writes the SAME role+canonical record.
// Re-exported here so every existing caller/test (goStandalone, migration, the
// fleet_fallback suite) is byte-for-byte unchanged.
export { writeFleetConfig, type FleetConfig } from "@amicode/schema";

export const FLEET_DIR = path.join(homedir(), ".amico", "ops", "fleet");
export const FLEET_CONFIG_PATH = path.join(FLEET_DIR, "fleet.json");
// Legacy path — migrated to fleet.json on read
const LEGACY_FALLBACK_PATH = path.join(FLEET_DIR, "fallback.json");

/** Go Standalone: write role=standalone to fleet.json. Preserves previous settings for
 *  potential re-enrollment. Removes legacy fallback.json if present. Paths
 *  injectable for tests. */
export function goStandalone(opts: { previousBinary?: string; previousPort?: number; path?: string; legacyPath?: string } = {}): FleetConfig {
  const p = opts.path ?? FLEET_CONFIG_PATH;
  const config: FleetConfig = {
    role: "standalone",
    previousBinary: opts.previousBinary,
    previousPort: opts.previousPort,
  };
  writeFleetConfig(config, p);
  // Remove legacy fallback.json if present
  try { fs.unlinkSync(opts.legacyPath ?? LEGACY_FALLBACK_PATH); } catch {}
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

// ── Legacy compatibility ────────────────────────────────────────────────────
// The old fallback.json marker is treated as role=standalone for the guard.
// Extension code that formerly called isFallbackActive now reads the
// projection topology via fleet_topology.ts; this section is only the
// one-time marker migration (an existence probe + a write — never a parse).

/** Migrate legacy fallback.json → fleet.json if fallback.json exists but fleet.json doesn't.
 *  Called once at extension activation. Paths injectable for tests. */
export function migrateLegacyFallback(opts: { legacyPath?: string; configPath?: string } = {}): void {
  const legacyPath = opts.legacyPath ?? LEGACY_FALLBACK_PATH;
  const configPath = opts.configPath ?? FLEET_CONFIG_PATH;
  if (fs.existsSync(legacyPath) && !fs.existsSync(configPath)) {
    // Legacy fallback was active = the machine was in standalone mode
    goStandalone({ path: configPath, legacyPath });
  }
}
