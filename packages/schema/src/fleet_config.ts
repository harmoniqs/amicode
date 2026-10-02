// The fleet.json WRITER (amicode#1319) — the membership record's write side,
// hoisted to @amicode/schema to sit beside its READER (parseFleetTopology in
// fleet_projection.ts). ONE contract, both directions, one home.
//
// Originally the extension's fleet_fallback.ts owned this (a WRITER, never a
// parser — amicissimo's fleet authority owns the ONE parser behind `amico fleet
// status --projection`). It was hoisted so `amico fleet enroll` (in
// @amicode/amico-run, which cannot import the extension) writes the SAME
// role+canonical record. The extension re-exports FleetConfig + writeFleetConfig
// unchanged, so goStandalone / removeFleetConfig / migrateLegacyFallback and
// every existing caller/test are untouched.
//
// On-disk file: ~/.amico/ops/fleet/fleet.json
//   { "role": "standalone"|"server"|"client", "canonical": { "host": "...", "port": 4096, "sshAlias": "..." } }
//   No file = standalone (safe zero-config default).
import * as fs from "node:fs";
import * as path from "node:path";
import { fleetTopologyPath } from "./fleet_projection.js";

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

/** Write fleet config atomically (tmp + rename). Default path is the ONE
 *  topology path (`~/.amico/ops/fleet/fleet.json`) the reader resolves. */
export function writeFleetConfig(config: FleetConfig, p: string = fleetTopologyPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  fs.renameSync(tmp, p);
}
