import { parse as parseToml } from "smol-toml";
import type { ExperimentBlob } from "./qick_job_server";

// ============================================================================
// The calibration graph — Spec A §4. A directed ACYCLIC graph after Kelly et
// al. "Physical qubit calibration on a directed acyclic graph" (arXiv:1803.03226,
// "Optimus"): nodes = calibrations, directed edges = dependencies. This is the
// doctrine's "repeated + deterministically formulable = code": the traversal
// AGENT (§7) is deferred, but the ranked-action machinery is deterministic and
// lives here.
//
// Pure + vscode-free (the run_registry.ts precedent) so vitest runs it headless.
// evaluate() is PURE + TOTAL: acyclicity is validated at load, so a topological
// order always exists and the suspect sweep is well-defined.
// ============================================================================

/** The single status enum — node state, evaluate() verdict, and the §3.2 qubit
 *  rollup all use it (no divergent vocabularies). */
export type NodeStatus = "calibrated" | "stale" | "suspect" | "failed" | "uncharacterized";

/** `check` = the cheap check_data action (§4.1); `check_state` is internal to
 *  propagation and never surfaces as a recommendation. `redesign` is emitted by
 *  the entitlement path (device_status.ts §5.2), never by evaluate(). */
export type RecommendedAction = "none" | "check" | "calibrate" | "redesign";

/** DISPLAY severity precedence (§3.2): failed > suspect > stale > uncharacterized
 *  > calibrated. Used for the "worst status wins" combination + the qubit rollup. */
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
  /** A qilc node names a standard fallback whose `produces` overlaps (§5.2). */
  fallback?: string;
  /** Optional qubit association → the §3.2 per-qubit rollup. */
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

/** Rolling ops state per node (§4.2, `state.json`). */
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

// --------------------------------------------------------------------------
// loadGraph — parse TOML (smol-toml), build nodes, validate acyclicity.
// --------------------------------------------------------------------------

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

/** Kahn topological sort. Returns undefined if a cycle remains (a back-edge). */
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
  // Deterministic: process ready nodes in sorted name order.
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([n]) => n).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const child of adj.get(n)!.slice().sort()) {
      const d = (indeg.get(child) ?? 0) - 1;
      indeg.set(child, d);
      if (d === 0) {
        // keep `ready` sorted for determinism
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
      thresholds: thr
        ? { check: parseThreshold(thr.check), calibrate: parseThreshold(thr.calibrate) }
        : undefined,
    });
  }
  if (nodes.size === 0) return { ok: false, error: "no_nodes: graph has no [node.*] tables" };

  const order = topoSort(nodes);
  if (order === undefined) {
    return { ok: false, error: "cycle: the calibration graph has a dependency cycle" };
  }

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

  const graph: CalibrationGraph = {
    nodes,
    topoOrder: order,
    depth: (name) => depthMap.get(name) ?? 0,
    children: (name) => (childMap.get(name) ?? []).slice(),
  };
  return { ok: true, graph };
}

// --------------------------------------------------------------------------
// evaluate — pure + total. Precondition: the graph loaded acyclically.
// --------------------------------------------------------------------------

const ACTION_FOR: Record<NodeStatus, RecommendedAction> = {
  calibrated: "none",
  stale: "check",
  suspect: "check",
  uncharacterized: "calibrate",
  failed: "calibrate",
};

/** Own status from a node's own state alone (no propagation). */
function ownStatus(node: GraphNode, st: NodeState | undefined, nowMs: number): { status: NodeStatus; ageSeconds: number } {
  if (!st || !st.ts) return { status: "uncharacterized", ageSeconds: Infinity };
  const tsMs = Date.parse(st.ts);
  const ageSeconds = Number.isNaN(tsMs) ? Infinity : (nowMs - tsMs) / 1000;
  if (Number.isNaN(tsMs)) return { status: "uncharacterized", ageSeconds: Infinity };
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
  // parent moved out from under it). suspect only ever replaces calibrated —
  // a node with its own problem keeps its own (more actionable) status/action.
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
