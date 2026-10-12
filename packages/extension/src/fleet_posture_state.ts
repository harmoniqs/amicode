// #780 — the machine-posture state file. The extension is the SOLE WRITER
// (single-writer discipline; the context plugin is read-only). This module is
// the pure, dependency-light writer wired into extension.ts's fleet attach
// loop — the peer of fleet_poll_hysteresis.ts, driven by the same probe.
//
// WHY IT EXISTS: a fleet client's agent context never stated which machine it
// was on or whether the hub was reachable. On the 2026-09-03 outage a client
// fell back to standalone and every session inherited a stale role line with
// no posture. The attach loop already computes probe result / base URL /
// reachability; it persists each attach-state TRANSITION here as live truth.
//
// The file lives BESIDE the fleet config under the ops fleet directory
// (~/.amico/ops/fleet/), next to fleet.json / projection.json / fallback.json.
// fleet.json stays the ROLE config; this file is the LIVE posture truth.
//
// Node builtins only — this is imported by the extension host, but the plugin
// reads the same file shape-tolerantly (never this module) to stay dep-free.
import { homedir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

/** The state-file schema version. Bumped only on a breaking field change. */
export const FLEET_POSTURE_STATE_VERSION = 1;

/** The posture the machine is in, in the issue's own vocabulary:
 *  - "fleet"      — attached to a reachable hub;
 *  - "standalone" — no hub, or fell back after the hub was lost;
 *  - "degraded"   — hub reachable but slow (hub-up-but-slow steady state). */
export type FleetPostureMode = "fleet" | "standalone" | "degraded";

/** The persisted record. Every field the issue's Key Decision names. Every
 *  liveness claim is a TIMESTAMP or explicit null — never a bare "healthy". */
export interface FleetPostureStateFile {
  schema_version: number;
  /** This machine's hostname (os.hostname()). */
  hostname: string;
  mode: FleetPostureMode;
  /** The canonical hub's identity, or nulls when there is no hub. */
  hub: { name: string | null; base_url: string | null };
  /** Whether the hub answered at the last transition. */
  reachable: boolean;
  /** ISO instant the hub was last known reachable (null if never / unknown). */
  last_ok: string | null;
  /** Last measured round-trip time to the hub, ms (null if unknown). */
  last_rtt_ms: number | null;
  /** ISO instant THIS record was written (i.e. the transition instant). */
  updated_at: string;
}

/** What the attach loop computes each transition. last_ok / last_rtt_ms are
 *  optional: absent → recorded as explicit null (never a guess). */
export interface PostureFacts {
  hostname: string;
  mode: FleetPostureMode;
  hub: { name: string | null; base_url: string | null };
  reachable: boolean;
  last_ok?: string | null;
  last_rtt_ms?: number | null;
}

/** The state-file path: the env override (tests / relocation) then the
 *  ops-fleet default beside fleet.json. Mirrors the plugin's projection /
 *  status seams (AMICO_FLEET_PROJECTION / AMICO_FLEET_STATUS). */
export function fleetPostureStateFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_FLEET_POSTURE_STATE;
  if (v && v.trim() !== "") return v.trim();
  return path.join(homedir(), ".amico", "ops", "fleet", "posture-state.json");
}

/** Build the record from the loop's facts. Pure — the clock is injectable. */
export function buildPostureRecord(
  facts: PostureFacts,
  now: () => string = () => new Date().toISOString(),
): FleetPostureStateFile {
  return {
    schema_version: FLEET_POSTURE_STATE_VERSION,
    hostname: facts.hostname,
    mode: facts.mode,
    hub: { name: facts.hub.name ?? null, base_url: facts.hub.base_url ?? null },
    reachable: facts.reachable,
    last_ok: facts.last_ok ?? null,
    last_rtt_ms: facts.last_rtt_ms ?? null,
    updated_at: now(),
  };
}

export interface FleetPostureStateWriterOptions {
  /** Target file; default fleetPostureStateFile(). */
  file?: string;
  /** Injectable clock. */
  now?: () => string;
  /** Injectable sink (tests / alt transports); default = atomic fs write. */
  writeFile?: (file: string, text: string) => void;
  /** Optional log sink for a swallowed write failure. */
  log?: (msg: string) => void;
}

/** The posture-defining signature: the fields whose change IS a transition.
 *  RTT / last_ok / updated_at are liveness churn, deliberately excluded — a
 *  faster probe on the same posture must not rewrite the file (AC3). */
function signatureOf(facts: PostureFacts): string {
  return [facts.mode, facts.reachable ? "1" : "0", facts.hub.name ?? "", facts.hub.base_url ?? ""].join("\u0000");
}

/** Atomic default write: mkdir -p, write a temp, rename over the target. */
function atomicWriteFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/**
 * The SOLE writer of the posture state file. TRANSITION-ONLY by construction:
 * `record(facts)` writes iff the posture-defining signature changed since the
 * last successful write. Wired to be called each poll tick, it still writes
 * only on a genuine transition (attach, degrade, hub-lost, hub-regained). It
 * NEVER throws — a dead disk must not crash the attach loop.
 */
export class FleetPostureStateWriter {
  private lastSignature: string | null = null;
  private readonly file: string;
  private readonly now: () => string;
  private readonly writeImpl: (file: string, text: string) => void;
  private readonly log?: (msg: string) => void;

  constructor(opts: FleetPostureStateWriterOptions = {}) {
    this.file = opts.file ?? fleetPostureStateFile();
    this.now = opts.now ?? (() => new Date().toISOString());
    this.writeImpl = opts.writeFile ?? atomicWriteFile;
    this.log = opts.log;
  }

  /** Record a posture observation. Returns whether it wrote and the record. */
  record(facts: PostureFacts): { wrote: boolean; record: FleetPostureStateFile | null } {
    const sig = signatureOf(facts);
    if (sig === this.lastSignature) return { wrote: false, record: null };
    const record = buildPostureRecord(facts, this.now);
    try {
      this.writeImpl(this.file, JSON.stringify(record, null, 2) + "\n");
    } catch (e) {
      this.log?.(`[fleet] posture-state write failed: ${e instanceof Error ? e.message : String(e)}`);
      return { wrote: false, record: null }; // swallow — never crash the loop; retry next transition
    }
    this.lastSignature = sig;
    return { wrote: true, record };
  }
}
