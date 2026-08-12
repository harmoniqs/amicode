// Fleet Launch & Stats — session launch from profile and aggregate stats
// computation. The launch creates a FleetRecord in the fleet registry dir
// (~/.amico/ops/fleet/). Stats are computed from all records.
//
// Part of #357 (Fleet Panel: session launch from profile + aggregate stats).

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { hostname } from "node:os";
import { stringify as stringifyToml } from "smol-toml";
import { FLEET_DIR } from "./fleet_fallback";
import type { FleetProfile } from "./fleet_profiles";
import type { FleetStats } from "./fleet_panel";

export const FLEET_REGISTRY_DIR = FLEET_DIR;

export interface FleetRecordForLaunch {
  schema: number;
  session_id: string;
  state: "spooling";
  current_step: string;
  started: string;
  tokens: number;
  runtime: number;
  respooled_to: string;
  pid: number;
  host: string;
  profile: {
    name: string;
    base: string;
    model: string;
    variant: string;
    task_type: string;
    skills: string[];
    gates: string[];
    permissions: Record<string, string>;
  };
}

/** Generate a unique session ID (ses_ + 12 random hex chars). */
export function generateSessionId(): string {
  return `ses_${crypto.randomBytes(6).toString("hex")}`;
}

/** Create a FleetRecord for a new session launched from a profile.
 *  The record is in `spooling` state — the harness will transition it. */
export function buildLaunchRecord(profile: FleetProfile): FleetRecordForLaunch {
  return {
    schema: 1,
    session_id: generateSessionId(),
    state: "spooling",
    current_step: "",
    started: new Date().toISOString(),
    tokens: 0,
    runtime: 0,
    respooled_to: "",
    pid: process.pid,
    host: hostname(),
    profile: {
      name: profile.name,
      base: profile.base,
      model: profile.model,
      variant: profile.variant,
      task_type: profile.task_type,
      skills: profile.skills,
      gates: profile.gates,
      permissions: profile.permissions,
    },
  };
}

/** Write a fleet record atomically (tmp + rename). */
export function writeFleetRecord(
  record: FleetRecordForLaunch,
  dir: string = FLEET_REGISTRY_DIR,
): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${record.session_id}.toml`);
  const tmp = `${filePath}.tmp-${process.pid}`;
  const toml = stringifyToml(record as unknown as Record<string, unknown>);
  fs.writeFileSync(tmp, toml);
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Launch a session from a profile: build the record, write it. */
export function launchFromProfile(
  profile: FleetProfile,
  dir: string = FLEET_REGISTRY_DIR,
): { sessionId: string; recordPath: string } {
  const record = buildLaunchRecord(profile);
  const recordPath = writeFleetRecord(record, dir);
  return { sessionId: record.session_id, recordPath };
}

// ============================================================================
// Aggregate Stats
// ============================================================================

interface SimpleRecord {
  state: string;
  tokens: number;
  started: string;
}

/** Read all fleet records (simple: state + tokens + started). */
export function readAllSimpleRecords(dir: string = FLEET_REGISTRY_DIR): SimpleRecord[] {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml") && !f.startsWith("."));
    const records: SimpleRecord[] = [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), "utf8");
        // Simple parse: extract state, tokens, started
        const stateMatch = raw.match(/^state\s*=\s*"([^"]+)"/m);
        const tokensMatch = raw.match(/^tokens\s*=\s*(\d+)/m);
        const startedMatch = raw.match(/^started\s*=\s*"([^"]+)"/m);
        if (stateMatch) {
          records.push({
            state: stateMatch[1],
            tokens: tokensMatch ? parseInt(tokensMatch[1], 10) : 0,
            started: startedMatch?.[1] ?? "",
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
    return records;
  } catch {
    return [];
  }
}

/** Compute aggregate fleet stats from all records. */
export function computeFleetStats(
  records: SimpleRecord[],
  opts: { today?: string } = {},
): FleetStats {
  const todayPrefix = opts.today ?? new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const active = records.filter((r) => r.state === "running" || r.state === "blocked" || r.state === "spooling");
  const running = records.filter((r) => r.state === "running");
  const blocked = records.filter((r) => r.state === "blocked");
  const tokensToday = records
    .filter((r) => r.started.startsWith(todayPrefix))
    .reduce((sum, r) => sum + r.tokens, 0);

  return {
    active: active.length,
    running: running.length,
    blocked: blocked.length,
    tokensToday,
  };
}

/** Compute stats from the fleet registry directory. */
export function getFleetStats(dir: string = FLEET_REGISTRY_DIR): FleetStats {
  const records = readAllSimpleRecords(dir);
  return computeFleetStats(records);
}

// ============================================================================
// Sweep — mark orphaned crashed sessions
// ============================================================================

/** Check if a process is alive by sending signal 0. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sweep: find records whose pid is not alive and mark them as crashed.
 *  Returns the session IDs that were swept. */
export function sweepCrashed(dir: string = FLEET_REGISTRY_DIR): string[] {
  const swept: string[] = [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".toml") && !f.startsWith("."));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const stateMatch = raw.match(/^state\s*=\s*"([^"]+)"/m);
        const pidMatch = raw.match(/^pid\s*=\s*(\d+)/m);
        const state = stateMatch?.[1];
        const pid = pidMatch ? parseInt(pidMatch[1], 10) : 0;

        // Only sweep running/blocked sessions with dead pids
        if ((state === "running" || state === "blocked") && pid > 0 && !isProcessAlive(pid)) {
          // Update state to crashed (atomic write)
          const updated = raw.replace(/^state\s*=\s*"[^"]+"/m, 'state = "crashed"');
          const tmp = `${filePath}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, updated);
          fs.renameSync(tmp, filePath);
          swept.push(file.replace(/\.toml$/, ""));
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist = nothing to sweep
  }
  return swept;
}
