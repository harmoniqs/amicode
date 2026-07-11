import type { NodeState, NodeStatus } from "./calibration_graph";

// ============================================================================
// Device calibration registry — Spec A §4.2 + corrections C6/C7.
//
// On disk (rolling OPS state, NOT vault — §4.2): `state.json` (a JSON map, the
// LATEST value per node) + `history.jsonl` (the append log of every calibration
// result). Node DEFINITIONS + thresholds are durable knowledge and live in the
// vault `graph.toml` (calibration_graph.ts); latest values + their history are
// churning ops state and live here.
//
// This module is PURE + in-memory (the run_registry.ts precedent): parse/
// serialize helpers + an idempotent registry keyed by node. The FILE I/O lives
// in the poll loop / a manager (the real run_registry ↔ runs_manager split);
// per §2.4 the Amicode TS queue client — never the QILC loop — writes state.json.
// ============================================================================

/** A finished calibration job's result event → one `history.jsonl` line and the
 *  new latest `state.json` entry for its node. */
export interface CalibrationEvent {
  node: string;
  value?: Record<string, unknown>;
  ts: string; // ISO8601
  status: NodeStatus;
  job_id: string;
  config_version?: string;
}

const NODE_STATUSES: NodeStatus[] = ["calibrated", "stale", "suspect", "failed", "uncharacterized"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function toNodeState(o: Record<string, unknown>): NodeState {
  const st: NodeState = {};
  if (isRecord(o.value)) st.value = o.value;
  if (typeof o.ts === "string") st.ts = o.ts;
  if (typeof o.status === "string" && (NODE_STATUSES as string[]).includes(o.status)) st.status = o.status as NodeStatus;
  if (typeof o.job_id === "string") st.job_id = o.job_id;
  if (typeof o.config_version === "string") st.config_version = o.config_version;
  return st;
}

/** Parse a `state.json` body → { node → NodeState }. Never throws: junk, a
 *  non-object, or a missing file all degrade to {}. */
export function parseStateJson(text: string | unknown): Record<string, NodeState> {
  let parsed: unknown;
  if (typeof text === "string") {
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
  } else {
    parsed = text;
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, NodeState> = {};
  for (const [node, raw] of Object.entries(parsed)) if (isRecord(raw)) out[node] = toNodeState(raw);
  return out;
}

/** Serialize a node-state map → deterministic `state.json` text (sorted keys so
 *  a replay produces a byte-identical file — §6 crit 6). */
export function serializeStateJson(state: Record<string, NodeState>): string {
  const sorted: Record<string, NodeState> = {};
  for (const k of Object.keys(state).sort()) sorted[k] = state[k];
  return JSON.stringify(sorted, null, 2);
}

/** Serialize one calibration event → a single `history.jsonl` line. */
export function historyLine(ev: CalibrationEvent): string {
  return JSON.stringify(ev);
}

/** Parse one `history.jsonl` line → CalibrationEvent, or undefined. Never throws
 *  (a blank/torn final line heals on the next drain — the run_registry.ts rule). */
export function parseHistoryLine(line: string): CalibrationEvent | undefined {
  if (!line || !line.trim()) return undefined;
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(o)) return undefined;
  if (typeof o.node !== "string" || typeof o.job_id !== "string" || typeof o.ts !== "string") return undefined;
  const status = typeof o.status === "string" && (NODE_STATUSES as string[]).includes(o.status) ? (o.status as NodeStatus) : "calibrated";
  return {
    node: o.node,
    job_id: o.job_id,
    ts: o.ts,
    status,
    value: isRecord(o.value) ? o.value : undefined,
    config_version: typeof o.config_version === "string" ? o.config_version : undefined,
  };
}

/** In-memory calibration state, keyed by node. Idempotent by job_id (§6 crit 6):
 *  replaying a finished-job event is a no-op. */
export class DeviceRegistry {
  private readonly map = new Map<string, NodeState>();
  /** Applied job_ids — the idempotency key (§6 crit 6, "keyed on job_id"). */
  private readonly seen = new Set<string>();

  /** Hydrate from a parsed `state.json` map (poll loop reads the file, hands it
   *  here). The carried job_id primes the dedup set so a replay after reload is
   *  still a no-op. */
  constructor(initial?: Record<string, NodeState>) {
    if (!initial) return;
    for (const [node, st] of Object.entries(initial)) {
      this.map.set(node, { ...st });
      if (st.job_id) this.seen.add(st.job_id);
    }
  }

  /** Apply a finished-job event. Returns true if state changed, false if this
   *  job_id was already applied (idempotent replay). */
  record(ev: CalibrationEvent): boolean {
    if (ev.job_id && this.seen.has(ev.job_id)) return false;
    if (ev.job_id) this.seen.add(ev.job_id);
    this.map.set(ev.node, {
      value: ev.value,
      ts: ev.ts,
      status: ev.status,
      job_id: ev.job_id,
      config_version: ev.config_version,
    });
    return true;
  }

  latest(node: string): NodeState | undefined {
    const st = this.map.get(node);
    return st ? { ...st } : undefined;
  }

  /** The `Record<string, NodeState>` evaluate() consumes — a deep-ish copy so
   *  callers can't mutate registry state (the run_registry.ts all()-copies rule). */
  toStateMap(): Record<string, NodeState> {
    const out: Record<string, NodeState> = {};
    for (const [node, st] of this.map) out[node] = { ...st };
    return out;
  }

  /** Serialized `state.json` — byte-stable across replays (§6 crit 6). */
  snapshot(): string {
    return serializeStateJson(this.toStateMap());
  }
}
