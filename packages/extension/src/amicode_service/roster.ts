// AMICODE SERVICE (#1318, ADR 0026): the host-owned fleet roster routes —
// GET /amicode/roster (read the fleet-wide roster) + POST /amicode/roster (the
// caller self-reports its OWN row). Deliberately on the PROXIED /amicode/*
// namespace, NOT under /amicode/fleet/* (the client's local honesty surface the
// #1262 proxy refuses to carry — a roster route there would 404 on every
// client). Every OTHER /amicode/* path is proxied to the host unchanged
// (server.ts shouldProxyAmicodeToHost), so a client reaches the host's
// authoritative roster through the same proxy.
//
// The self-report write mirrors the loopback-mutation-guard routes
// (solver_mode.ts, connections.ts): it rides the AUTHENTICATED /amicode/ data
// plane (accept-both service/engine mint, #822) to a LOOPBACK-bound host and
// calls the bind_host loopback check — NOT the ADR-0005 Fleet token. Failures
// collapse into a fixed-string {ok:false, error:"code: detail"}; no caller
// bytes are ever echoed (sibling security discipline).
import { existsSync, readFileSync } from "node:fs";
import {
  ROSTER_SCHEMA_VERSION,
  emptyRoster,
  fleetRosterCachePath,
  parseRosterDocument,
  parseRosterRow,
  upsertRosterRow,
  type RosterDocument,
  type RosterRow,
} from "@amicode/schema";
import { atomicWriteFileSync } from "./credentials";
import { getBindHostname, isLoopbackHostname } from "./bind_host";

// The self-report body is one small object; anything larger is a mistake.
const MAX_BODY_BYTES = 64 * 1024;

export interface RosterDeps {
  /** Override the roster file (pure-injection for tests). Default:
   *  $AMICO_FLEET_ROSTER_FILE → the shared fleet roster cache path. */
  rosterFile?: string;
  /** Override the recorded bind hostname (the loopback mutation guard);
   *  undefined (the in-process/no-socket case) counts as loopback, exactly like
   *  the solver-mode guard. */
  bindHostname?: string;
}

/** The roster file this host reads/writes: the injected path, else the
 *  $AMICO_FLEET_ROSTER_FILE override (the test + headless seam), else the ONE
 *  shared cache path every consumer resolves (fleetRosterCachePath). */
export function rosterFilePath(deps: RosterDeps = {}): string {
  if (deps.rosterFile) return deps.rosterFile;
  const env = process.env.AMICO_FLEET_ROSTER_FILE;
  if (env && env.trim() !== "") return env;
  return fleetRosterCachePath();
}

/** Tolerant load → a lawful RosterDocument: an absent or malformed store reads
 *  as the empty roster (the read route always answers a shape, never a throw;
 *  a corrupt file is never half-trusted). */
function loadRoster(file: string): RosterDocument {
  if (!existsSync(file)) return emptyRoster();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return emptyRoster();
  }
  const doc = parseRosterDocument(parsed);
  return doc.ok ? doc.doc : emptyRoster();
}

/** GET /amicode/roster — the fleet-wide roster (host-owned). One success shape:
 *  {ok, schema_version, rows, error}. */
export function rosterReadResponse(deps: RosterDeps = {}): string {
  const doc = loadRoster(rosterFilePath(deps));
  return JSON.stringify({ ok: true, schema_version: doc.schema_version, rows: doc.rows, error: null });
}

/** Fixed-string refusal — sibling discipline, never echoes the caller's bytes. */
function refuse(code: string, detail: string): string {
  return JSON.stringify({ ok: false, machine_id: null, error: `${code}: ${detail}` });
}

/** POST /amicode/roster — the caller self-reports its OWN row. Single-writer:
 *  upsertRosterRow touches only the row whose machine_id matches, so a report
 *  can never mutate a peer's row. Loopback-guarded like the other mutations. */
export function rosterReportResponse(rawBody: string, deps: RosterDeps = {}): string {
  if (!isLoopbackHostname(deps.bindHostname ?? getBindHostname())) {
    return refuse("non_loopback", "roster self-report serves loopback binds only");
  }
  if (rawBody.length > MAX_BODY_BYTES) return refuse("bad_request", "body too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return refuse("bad_request", "body must be a JSON roster row");
  }
  const row = parseRosterRow(parsed);
  // The parse error may carry the caller's bytes — surface a FIXED detail only.
  if (!row.ok) return refuse("bad_request", "body is not a well-formed roster row");
  const file = rosterFilePath(deps);
  const next = upsertRosterRow(loadRoster(file), row.row);
  try {
    atomicWriteFileSync(file, JSON.stringify({ ...next, schema_version: ROSTER_SCHEMA_VERSION }, null, 2) + "\n");
  } catch {
    return refuse("write_failed", "the roster self-report could not be persisted");
  }
  return JSON.stringify({ ok: true, machine_id: row.row.machine_id, error: null });
}

// ── boot-time self-report (#1379, ADR 0027 §5/D8) ──────────────────────────
// An engine-armed machine (standalone or server — NOT a hosted-only client)
// advertises `serving` in its roster row's capabilities[] on boot, signalling
// that its already-running engine is placement-ready. The `device_type` is
// populated from the #1368 self-report vocabulary (ADR 0028) when the caller
// detects one. This is the COMPOSITION half; the wiring half (calling this at
// boot + POSTing the row) lives with the extension's activation sequence.

/** The inputs for a boot-time roster self-report — the machine's identity,
 *  whether it has a local engine, and the optional detected form factor.
 *  Every field mirrors the RosterRow contract, minus `capabilities` (derived
 *  from `engineArmed`), `health` (always `reachable` for the reporting
 *  machine itself), and `last_report` (stamped at call time). */
export interface BootSelfReportInput {
  machineId: string;
  name: string;
  serverMode: string;
  sshAlias: string;
  transport: string;
  /** Whether this machine has a local engine (true for standalone/server,
   *  false for a hosted-only / never-fork client). Drives the `serving` tag. */
  engineArmed: boolean;
  /** The detected device form factor from the #1368 vocabulary (ADR 0028).
   *  Absent when detection failed or was not attempted — never fabricated. */
  deviceType?: string;
}

/** Build the roster self-report row a machine writes on boot. An engine-armed
 *  machine includes `serving` in capabilities (a placement-ready fact a future
 *  scheduler reads via `placementDescriptor`); a hosted-only client does NOT.
 *  The row is valid per `parseRosterRow` by construction. */
export function buildBootSelfReportRow(input: BootSelfReportInput): RosterRow {
  const capabilities: string[] = [];
  if (input.engineArmed) {
    capabilities.push("serving");
  }
  return {
    machine_id: input.machineId,
    name: input.name,
    server_mode: input.serverMode,
    capabilities,
    sshAlias: input.sshAlias,
    transport: input.transport,
    last_report: new Date().toISOString(),
    health: "reachable",
    ...(input.deviceType !== undefined ? { device_type: input.deviceType } : {}),
  };
}
