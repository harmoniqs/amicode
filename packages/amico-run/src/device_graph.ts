// The device CALIBRATION GRAPH — the pure core behind the `amico device` verb
// (issue #113, slice B3), the dispatcher successor (spec-20260708-112732 §3.1 /
// W-2; spec-20260706-221348 §4). A directed ACYCLIC graph after Kelly et al.
// "Physical qubit calibration on a directed acyclic graph" (arXiv:1803.03226,
// "Optimus"): nodes = calibrations, directed edges = dependencies.
//
// This is the SAME pure machinery the extension's calibration_graph.ts /
// device_status.ts / device_registry.ts carry, ported here into the shared CLI
// spine (the doctrine's "repeated + deterministically formulable = code"). It is
// PURE + TOTAL and free of any server/queue transport — the LLM traversal AGENT
// is retired; the ranked-action machinery is deterministic and lives here.
// Loaders never throw: a missing/corrupt graph or state degrades to an empty view,
// exactly like repertoire.ts's loaders degrade to an empty repertoire.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

/** The single status enum — node state, evaluate() verdict, and the per-qubit
 *  rollup all use it (no divergent vocabularies). */
export type NodeStatus = "calibrated" | "stale" | "suspect" | "failed" | "uncharacterized";

/** `check` = the cheap check_data action; `calibrate` = a full recalibration.
 *  `redesign` is emitted by the premium/entitlement path (never by evaluate()). */
export type RecommendedAction = "none" | "check" | "calibrate" | "redesign";

/** Per-adapter OPAQUE experiment blob — the queue verbs stay uniform; only the
 *  payload shape is adapter-specific. Carried verbatim; never interpreted here. */
export interface ExperimentBlob {
  adapter: string;
  payload: unknown;
}

/** DISPLAY severity precedence: failed > suspect > stale > uncharacterized >
 *  calibrated. Used for "worst status wins" combination + the qubit rollup. */
const SEVERITY: Record<NodeStatus, number> = {
  calibrated: 0,
  uncharacterized: 1,
  stale: 2,
  suspect: 3,
  failed: 4,
};

export function worseStatus(a: NodeStatus, b: NodeStatus): NodeStatus {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export interface Threshold {
  metric: string;
  max?: number;
  min?: number;
}

export interface GraphNode {
  name: string;
  depends_on: string[];
  experiment?: ExperimentBlob;
  produces: string[];
  ttl_seconds?: number;
  impl: "standard" | "qilc";
  /** A qilc node names a standard fallback whose `produces` overlaps. */
  fallback?: string;
  /** Optional qubit association → the per-qubit rollup. */
  qubit?: string;
  thresholds?: { check?: Threshold; calibrate?: Threshold };
}

export interface CalibrationGraph {
  nodes: Map<string, GraphNode>;
  /** Topological order: every dependency precedes its dependents. */
  topoOrder: string[];
  /** Longest path from any root (roots = depth 0) — the ranking key. */
  depth(name: string): number;
  /** Direct dependents of `name`. */
  children(name: string): string[];
}

/** Rolling ops state per node (the `state.json` map). */
export interface NodeState {
  value?: Record<string, unknown>;
  ts?: string; // ISO8601
  status?: NodeStatus; // last recorded own status (e.g. an experiment reported "failed")
  job_id?: string;
  config_version?: string;
}

export interface NodeVerdict {
  node: string;
  status: NodeStatus;
  recommended_action: RecommendedAction;
  reason: string;
  /** Seconds since last result; +Infinity if uncharacterized (sorts first). */
  ageSeconds: number;
  depth: number;
  impl: "standard" | "qilc";
  fallback?: string;
  qubit?: string;
}

// ── loadGraph — parse TOML, build nodes, validate acyclicity ──────────────────

type LoadResult = { ok: true; graph: CalibrationGraph } | { ok: false; error: string };

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseThreshold(v: unknown): Threshold | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.metric !== "string") return undefined;
  const t: Threshold = { metric: o.metric };
  if (typeof o.max === "number") t.max = o.max;
  if (typeof o.min === "number") t.min = o.min;
  return t;
}

function parseExperiment(v: unknown): ExperimentBlob | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.adapter !== "string") return undefined;
  return { adapter: o.adapter, payload: o.payload ?? {} };
}

/** Kahn topological sort. Returns undefined if a cycle remains (a back-edge).
 *  Deterministic: ready nodes are processed in sorted name order. */
function topoSort(nodes: Map<string, GraphNode>): string[] | undefined {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → dependents
  for (const name of nodes.keys()) {
    indeg.set(name, 0);
    adj.set(name, []);
  }
  for (const node of nodes.values()) {
    for (const dep of node.depends_on) {
      if (!nodes.has(dep)) continue; // unknown dep — dropped from the edge set (defensive)
      adj.get(dep)!.push(node.name);
      indeg.set(node.name, (indeg.get(node.name) ?? 0) + 1);
    }
  }
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const child of adj.get(n)!.slice().sort()) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) {
        const idx = ready.findIndex((x) => x > child);
        if (idx === -1) ready.push(child);
        else ready.splice(idx, 0, child);
      }
    }
  }
  return order.length === nodes.size ? order : undefined;
}

export function loadGraph(tomlText: string): LoadResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(tomlText) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, error: `parse_error: ${(e as Error).message}` };
  }
  const nodeTable = parsed.node;
  if (!nodeTable || typeof nodeTable !== "object") {
    return { ok: false, error: "no_nodes: graph has no [node.*] tables" };
  }
  const nodes = new Map<string, GraphNode>();
  for (const [name, raw] of Object.entries(nodeTable as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const thr = o.thresholds as Record<string, unknown> | undefined;
    nodes.set(name, {
      name,
      depends_on: asStringArray(o.depends_on),
      experiment: parseExperiment(o.experiment),
      produces: asStringArray(o.produces),
      ttl_seconds: typeof o.ttl_seconds === "number" ? o.ttl_seconds : undefined,
      impl: o.impl === "qilc" ? "qilc" : "standard",
      fallback: typeof o.fallback === "string" ? o.fallback : undefined,
      qubit: typeof o.qubit === "string" ? o.qubit : undefined,
      thresholds: thr ? { check: parseThreshold(thr.check), calibrate: parseThreshold(thr.calibrate) } : undefined,
    });
  }
  if (nodes.size === 0) return { ok: false, error: "no_nodes: graph has no [node.*] tables" };

  const order = topoSort(nodes);
  if (order === undefined) return { ok: false, error: "cycle: the calibration graph has a dependency cycle" };

  // depth = longest path from a root; computed over the topo order.
  const depthMap = new Map<string, number>();
  for (const name of order) {
    const node = nodes.get(name)!;
    const deps = node.depends_on.filter((d) => nodes.has(d));
    depthMap.set(name, deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => depthMap.get(d) ?? 0)));
  }
  const childMap = new Map<string, string[]>();
  for (const name of nodes.keys()) childMap.set(name, []);
  for (const node of nodes.values())
    for (const dep of node.depends_on) if (nodes.has(dep)) childMap.get(dep)!.push(node.name);

  return {
    ok: true,
    graph: {
      nodes,
      topoOrder: order,
      depth: (name) => depthMap.get(name) ?? 0,
      children: (name) => (childMap.get(name) ?? []).slice(),
    },
  };
}

// ── evaluate — pure + total (precondition: the graph loaded acyclically) ──────

const ACTION_FOR: Record<NodeStatus, RecommendedAction> = {
  calibrated: "none",
  stale: "check",
  suspect: "check",
  uncharacterized: "calibrate",
  failed: "calibrate",
};

/** Own status from a node's own state alone (no propagation). */
function ownStatus(
  node: GraphNode,
  st: NodeState | undefined,
  nowMs: number,
): { status: NodeStatus; ageSeconds: number } {
  if (!st || !st.ts) return { status: "uncharacterized", ageSeconds: Infinity };
  const tsMs = Date.parse(st.ts);
  if (Number.isNaN(tsMs)) return { status: "uncharacterized", ageSeconds: Infinity };
  const ageSeconds = (nowMs - tsMs) / 1000;
  // an experiment that reported failure is authoritative
  if (st.status === "failed") return { status: "failed", ageSeconds };
  // threshold breach (only when the metric is actually present in the value)
  const check = node.thresholds?.check;
  if (check && st.value && typeof st.value[check.metric] === "number") {
    const m = st.value[check.metric] as number;
    if ((check.max !== undefined && m > check.max) || (check.min !== undefined && m < check.min))
      return { status: "failed", ageSeconds };
  }
  // stale by ttl
  if (node.ttl_seconds !== undefined && ageSeconds > node.ttl_seconds) return { status: "stale", ageSeconds };
  return { status: "calibrated", ageSeconds };
}

export function evaluate(graph: CalibrationGraph, state: Record<string, NodeState>, nowMs: number): NodeVerdict[] {
  // Pass 1 — own status.
  const own = new Map<string, { status: NodeStatus; ageSeconds: number }>();
  for (const [name, node] of graph.nodes) own.set(name, ownStatus(node, state[name], nowMs));

  // Pass 2 — suspect propagation over the topo order. A node whose OWN status is
  // calibrated but which has any non-calibrated dependency becomes suspect (a
  // parent moved out from under it). suspect only ever replaces calibrated — a
  // node with its own problem keeps its own (more actionable) status/action.
  const finalStatus = new Map<string, NodeStatus>();
  for (const name of graph.topoOrder) {
    const node = graph.nodes.get(name)!;
    const os = own.get(name)!.status;
    if (os !== "calibrated") {
      finalStatus.set(name, os);
      continue;
    }
    const anyDepDirty = node.depends_on
      .filter((d) => graph.nodes.has(d))
      .some((d) => finalStatus.get(d) !== "calibrated");
    finalStatus.set(name, anyDepDirty ? "suspect" : "calibrated");
  }

  // Pass 3 — verdicts + rank.
  const verdicts: NodeVerdict[] = [];
  for (const [name, node] of graph.nodes) {
    const status = finalStatus.get(name)!;
    const { ageSeconds } = own.get(name)!;
    verdicts.push({
      node: name,
      status,
      recommended_action: ACTION_FOR[status],
      reason: reasonFor(status, node),
      ageSeconds,
      depth: graph.depth(name),
      impl: node.impl,
      fallback: node.fallback,
      qubit: node.qubit,
    });
  }
  // rank: topological depth asc (roots first), then age desc (+∞ first), then name.
  verdicts.sort(
    (a, b) =>
      a.depth - b.depth ||
      cmpAgeDesc(a.ageSeconds, b.ageSeconds) ||
      (a.node < b.node ? -1 : a.node > b.node ? 1 : 0),
  );
  return verdicts;
}

function cmpAgeDesc(a: number, b: number): number {
  if (a === b) return 0;
  if (a === Infinity) return -1;
  if (b === Infinity) return 1;
  return b - a;
}

function reasonFor(status: NodeStatus, node: GraphNode): string {
  switch (status) {
    case "calibrated":
      return "fresh; all dependencies calibrated";
    case "stale":
      return `last result older than ttl (${node.ttl_seconds ?? "∞"}s)`;
    case "suspect":
      return "a dependency moved since this node last ran";
    case "failed":
      return "last check breached its threshold or the experiment failed";
    case "uncharacterized":
      return "no recorded result";
  }
}

// ── device-status projection (the honesty rule: uncharacterized/stale) ────────

export interface QubitRollup {
  qubit: string;
  /** Worst-status-wins over that qubit's nodes. uncharacterized if none (honest gap). */
  status: NodeStatus;
  nodeCount: number;
}

export interface MetricReading {
  value: number;
  ts?: string;
  ageSeconds: number;
  status: NodeStatus;
  node: string;
}

/** The projection the `device status` verb renders. Metrics are present ONLY for
 *  MEASURED nodes — never a fabricated number (the honesty rule). */
export interface DeviceStatus {
  qubits: QubitRollup[];
  metrics: Record<string, MetricReading>;
  /** Latest produced params (T1/T2/fidelity/…), measured-only. */
  calibrationParams: Record<string, unknown>;
  /** The full ranked verdict set. */
  nodes: NodeVerdict[];
}

export function buildDeviceStatus(
  graph: CalibrationGraph,
  state: Record<string, NodeState>,
  now: number,
  qubitsArg?: string[],
): DeviceStatus {
  const verdicts = evaluate(graph, state, now);
  const byNode = new Map(verdicts.map((v) => [v.node, v]));

  const qubitSet =
    qubitsArg ??
    [...new Set([...graph.nodes.values()].map((n) => n.qubit).filter((q): q is string => !!q))].sort();
  const qubits: QubitRollup[] = qubitSet.map((qubit) => {
    const nodeVerdicts = verdicts.filter((v) => v.qubit === qubit);
    let status: NodeStatus = "uncharacterized"; // no nodes → honest gap
    if (nodeVerdicts.length > 0)
      status = nodeVerdicts.reduce<NodeStatus>((acc, v) => worseStatus(acc, v.status), "calibrated");
    return { qubit, status, nodeCount: nodeVerdicts.length };
  });

  const metrics: Record<string, MetricReading> = {};
  const calibrationParams: Record<string, unknown> = {};
  for (const [name, node] of graph.nodes) {
    const st = state[name];
    if (!st || !st.value) continue;
    const v = byNode.get(name)!;
    for (const key of node.produces) {
      const val = st.value[key];
      if (val === undefined) continue;
      calibrationParams[key] = val;
      if (typeof val === "number" && Number.isFinite(val))
        metrics[key] = { value: val, ts: st.ts, ageSeconds: v.ageSeconds, status: v.status, node: name };
    }
  }
  return { qubits, metrics, calibrationParams, nodes: verdicts };
}

// ── next-actions + the premium (Intonatissimo) funnel ─────────────────────────

export interface NextAction {
  node: string;
  /** The node to actually run — the fallback when a qilc node is locked. */
  recommendedNode: string;
  status: NodeStatus;
  action: RecommendedAction;
  impl: "standard" | "qilc";
  /** Premium + unentitled → locked, and carries the funnel (below). Never
   *  auto-runs the premium action; shows the upsell rather than a dead grey-out. */
  locked: boolean;
  /** The funnel on a locked premium node: name the product + capability + invite.
   *  NEVER the private method acronym. Absent on unlocked nodes. */
  premium?: { package: string; capability: string; invite: string };
  reason: string;
}

export interface NextActionsResult {
  idle: boolean;
  ranked_actions: NextAction[];
}

export function nextActions(
  graph: CalibrationGraph,
  state: Record<string, NodeState>,
  now: number,
  opts: { entitled: boolean; idle: boolean },
): NextActionsResult {
  const verdicts = evaluate(graph, state, now);
  const ranked: NextAction[] = [];
  for (const v of verdicts) {
    if (v.recommended_action === "none") continue; // calibrated nodes need no action
    const base: NextAction = {
      node: v.node,
      recommendedNode: v.node,
      status: v.status,
      action: v.recommended_action,
      impl: v.impl,
      locked: false,
      reason: v.reason,
    };
    if (v.impl === "qilc" && !opts.entitled) {
      base.locked = true; // access control — but a FUNNEL, not a dead grey-out
      base.premium = {
        package: "Intonatissimo",
        capability: "closed-loop calibration",
        invite:
          "Closed-loop calibration here is handled by Intonatissimo — contact Harmoniqs to enable it on this device.",
      };
      if (v.fallback) {
        base.recommendedNode = v.fallback; // deterministic path falls back to the standard node...
        base.action = "calibrate";
        base.reason = `Closed-loop calibration via Intonatissimo (premium) — falling back to '${v.fallback}' until enabled`;
      } else {
        base.action = "redesign";
        base.reason =
          "Closed-loop calibration via Intonatissimo (premium) not enabled, no fallback → redesign the pulse";
      }
    }
    ranked.push(base);
  }
  return { idle: opts.idle, ranked_actions: ranked };
}

// ── state.json loader ─────────────────────────────────────────────────────────

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
export function parseStateJson(text: string): Record<string, NodeState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, NodeState> = {};
  for (const [node, raw] of Object.entries(parsed)) if (isRecord(raw)) out[node] = toNodeState(raw);
  return out;
}

// ── the benchmark-exclusivity lock (W-2) ──────────────────────────────────────
// A device under a `benchmark` allocation accepts NO concurrent submission, and
// the harness suspends leaf fan-out for its duration (the no-parallel-benchmark
// rule). The lock is durable ops state (a `lock.json` alongside state.json); the
// DECISION logic is pure and lives here, the file I/O in device_verb.ts.

/** The exclusive allocation modes — a held lock in one of these blocks submission. */
export const EXCLUSIVE_MODES = ["benchmark"] as const;

export interface DeviceLock {
  mode: string;
  owner: string;
  acquired_at: string; // ISO8601
}

export function parseLock(text: string): DeviceLock | undefined {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(o)) return undefined;
  if (typeof o.mode !== "string" || typeof o.owner !== "string" || typeof o.acquired_at !== "string") return undefined;
  return { mode: o.mode, owner: o.owner, acquired_at: o.acquired_at };
}

export function isExclusive(mode: string): boolean {
  return (EXCLUSIVE_MODES as readonly string[]).includes(mode);
}

/** A device accepts a concurrent submission iff it is NOT under an exclusive
 *  (benchmark) allocation. */
export function acceptsSubmission(lock: DeviceLock | undefined): boolean {
  return !(lock && isExclusive(lock.mode));
}

export type AcquireDecision =
  | { ok: true; lock: DeviceLock; reentrant: boolean }
  | { ok: false; reason: string; held: DeviceLock };

/** Acquire an exclusive allocation. Free → granted. Held by the SAME owner →
 *  re-entrant (idempotent). Held by ANOTHER owner → refused (the exclusivity). */
export function acquireDecision(
  current: DeviceLock | undefined,
  mode: string,
  owner: string,
  now: string,
): AcquireDecision {
  if (current && current.owner !== owner) {
    return {
      ok: false,
      reason: `device is held by "${current.owner}" (mode ${current.mode}) — benchmark exclusivity refuses a concurrent allocation`,
      held: current,
    };
  }
  if (current && current.owner === owner && current.mode === mode) {
    return { ok: true, lock: current, reentrant: true }; // idempotent re-acquire keeps acquired_at
  }
  return { ok: true, lock: { mode, owner, acquired_at: now }, reentrant: false };
}

export type ReleaseDecision =
  | { ok: true; released: boolean; had?: DeviceLock }
  | { ok: false; reason: string; held: DeviceLock };

/** Release an allocation. No lock → no-op. Held by the owner (or --force) →
 *  released. Held by another owner without --force → refused. */
export function releaseDecision(
  current: DeviceLock | undefined,
  owner: string | undefined,
  force: boolean,
): ReleaseDecision {
  if (!current) return { ok: true, released: false };
  if (force || (owner !== undefined && current.owner === owner)) return { ok: true, released: true, had: current };
  return {
    ok: false,
    reason: `device is held by "${current.owner}" — pass --owner ${current.owner} or --force to release it`,
    held: current,
  };
}

// ── on-disk device layout ─────────────────────────────────────────────────────
// Ops state, NOT vault (churning): <deviceRoot>/<device>/{graph.toml,state.json,lock.json}.
// $AMICO_DEVICE_DIR overrides the root (tests point it at a temp dir); default is
// the local ops mount.

export function deviceRoot(): string {
  const env = process.env.AMICO_DEVICE_DIR;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "devices");
}

export interface DeviceLoad {
  dir: string;
  graph?: CalibrationGraph;
  graphError?: string;
  state: Record<string, NodeState>;
  lock?: DeviceLock;
}

/** Read a device's graph.toml + state.json + lock.json. Never throws: a missing
 *  graph leaves `graph` undefined with a `graphError`; a missing state/lock
 *  degrades to {}/undefined. */
export function loadDevice(root: string, device: string): DeviceLoad {
  const dir = join(root, device);
  const load: DeviceLoad = { dir, state: {} };

  const graphFile = join(dir, "graph.toml");
  if (existsSync(graphFile)) {
    try {
      const res = loadGraph(readFileSync(graphFile, "utf8"));
      if (res.ok) load.graph = res.graph;
      else load.graphError = res.error;
    } catch (e) {
      load.graphError = `read_error: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    load.graphError = `no_graph: ${graphFile} not found`;
  }

  const stateFile = join(dir, "state.json");
  if (existsSync(stateFile)) {
    try {
      load.state = parseStateJson(readFileSync(stateFile, "utf8"));
    } catch {
      load.state = {};
    }
  }

  const lockFile = join(dir, "lock.json");
  if (existsSync(lockFile)) {
    try {
      load.lock = parseLock(readFileSync(lockFile, "utf8"));
    } catch {
      load.lock = undefined;
    }
  }
  return load;
}
