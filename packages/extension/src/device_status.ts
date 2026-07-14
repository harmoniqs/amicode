import {
  evaluate,
  worseStatus,
  type CalibrationGraph,
  type NodeState,
  type NodeStatus,
  type NodeVerdict,
  type RecommendedAction,
} from "./calibration_graph";
import type { ConfigVersion, QueueView } from "./qick_job_server";

// ============================================================================
// Device-status projection (Spec A §3.2) + queue-aware next-actions + the
// entitlement seam (§5). All PURE — no vscode, no fetch. The device view renders
// these objects; the §6 tests assert the objects directly (the Kobalte-SSR
// untestability lesson). Entitlement here is a RESOLVED boolean passed in —
// the authoritative package-resolution predicate lives in qick_client.ts
// (isQilcEntitled), reconciled per correction C10 so there is no duplicate.
// ============================================================================

export interface DriveLine {
  id: string;
  target?: string;
  kind?: string;
}

export interface DriveLineStatus extends DriveLine {
  online: boolean;
}

export interface QubitRollup {
  qubit: string;
  /** Worst-status-wins over that qubit's nodes (§3.2). uncharacterized if none. */
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

/** The object the device view renders (§3.2) — derived on demand, never git-churned. */
export interface DeviceStatus {
  driveLines: DriveLineStatus[];
  qubits: QubitRollup[];
  /** Latest numeric produced params (T1/T2/fidelity/…) with age + status. Only
   *  present for MEASURED nodes — never a fabricated number (§3.2 honesty rule). */
  metrics: Record<string, MetricReading>;
  /** main_config values ∪ per-node produced params. */
  calibrationParams: Record<string, unknown>;
  /** The full ranked verdict set (§4.3) — feeds the view's node list. */
  nodes: NodeVerdict[];
}

export interface BuildDeviceStatusArgs {
  graph: CalibrationGraph;
  state: Record<string, NodeState>;
  now: number;
  driveLines: DriveLine[];
  /** Device qubits (from the card) — a qubit with no graph node rolls up
   *  uncharacterized (honesty). Defaults to the qubits named on graph nodes. */
  qubits?: string[];
  /** Channels the server's health() reports online. Absent/empty → all offline
   *  (a dead server degrades honestly, §6 crit 5 projection side). */
  onlineChannels?: string[];
  mainConfig?: ConfigVersion;
}

export function buildDeviceStatus(args: BuildDeviceStatusArgs): DeviceStatus {
  const { graph, state, now, driveLines, onlineChannels, mainConfig } = args;
  const verdicts = evaluate(graph, state, now);
  const byNode = new Map(verdicts.map((v) => [v.node, v]));

  // drive lines online
  const online = new Set(onlineChannels ?? []);
  const driveLineStatus: DriveLineStatus[] = driveLines.map((d) => ({ ...d, online: online.has(d.id) }));

  // per-qubit rollup (worst status wins)
  const qubitSet = args.qubits ?? [...new Set([...graph.nodes.values()].map((n) => n.qubit).filter((q): q is string => !!q))];
  const qubits: QubitRollup[] = qubitSet.map((qubit) => {
    const nodeVerdicts = verdicts.filter((v) => v.qubit === qubit);
    let status: NodeStatus = "uncharacterized"; // no nodes → honest gap
    if (nodeVerdicts.length > 0) {
      status = nodeVerdicts.reduce<NodeStatus>((acc, v) => worseStatus(acc, v.status), "calibrated");
    }
    return { qubit, status, nodeCount: nodeVerdicts.length };
  });

  // latest metrics + produced params (only for measured nodes)
  const metrics: Record<string, MetricReading> = {};
  const producedParams: Record<string, unknown> = {};
  for (const [name, node] of graph.nodes) {
    const st = state[name];
    if (!st || !st.value) continue;
    const v = byNode.get(name)!;
    for (const key of node.produces) {
      const val = st.value[key];
      if (val === undefined) continue;
      producedParams[key] = val;
      if (typeof val === "number" && Number.isFinite(val)) {
        metrics[key] = { value: val, ts: st.ts, ageSeconds: v.ageSeconds, status: v.status, node: name };
      }
    }
  }

  const mainPayload = mainConfig && mainConfig.payload && typeof mainConfig.payload === "object" ? (mainConfig.payload as Record<string, unknown>) : {};
  const calibrationParams: Record<string, unknown> = { ...mainPayload, ...producedParams };

  return { driveLines: driveLineStatus, qubits, metrics, calibrationParams, nodes: verdicts };
}

// --------------------------------------------------------------------------
// Queue-awareness + entitlement (§5).
// --------------------------------------------------------------------------

export interface NextAction {
  /** The graph node this action pertains to. */
  node: string;
  /** The node to actually run — the fallback when a qilc node is locked (§5.2). */
  recommendedNode: string;
  status: NodeStatus;
  action: RecommendedAction;
  impl: "standard" | "qilc";
  /** Premium + unentitled → locked, and carries the funnel (below). Never auto-runs
   *  the premium action; the view shows the upsell rather than a dead grey-out. */
  locked: boolean;
  /** The funnel shown on a locked premium node (Aaron 2026-07-07): name the product
   *  + capability + invite. User-facing copy names "Intonatissimo" / "closed-loop
   *  calibration" — NEVER the private method acronym. Absent on unlocked nodes. */
  premium?: { package: string; capability: string; invite: string };
  reason: string;
}

export interface NextActionsResult {
  /** Idle ⟺ no running job AND no pending job for this device (§5.1). */
  idle: boolean;
  ranked_actions: NextAction[];
}

export function nextActions(
  graph: CalibrationGraph,
  state: Record<string, NodeState>,
  queue: QueueView,
  now: number,
  opts: { entitled: boolean },
): NextActionsResult {
  const verdicts = evaluate(graph, state, now);
  const idle = queue.running === undefined && queue.pending.length === 0;

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
      base.locked = true; // §5.2 access control — but a FUNNEL, not a dead grey-out
      base.premium = {
        package: "Intonatissimo",
        capability: "closed-loop calibration",
        invite: "Closed-loop calibration here is handled by Intonatissimo — contact Harmoniqs to enable it on this device.",
      };
      if (v.fallback) {
        // deterministic path still falls back to the standard node...
        base.recommendedNode = v.fallback;
        base.action = "calibrate";
        // ...while the user-facing copy advertises the premium package (funnel).
        base.reason = `Closed-loop calibration via Intonatissimo (premium) — falling back to '${v.fallback}' until enabled`;
      } else {
        base.action = "redesign";
        base.reason = "Closed-loop calibration via Intonatissimo (premium) not enabled, no fallback → redesign the pulse";
      }
    }
    ranked.push(base);
  }
  return { idle, ranked_actions: ranked };
}

/** Advisory-only capability hint from the job server's health() flags (§5.2).
 *  This is NOT the entitlement authority — the run-time truth is whether the
 *  private package resolves (qick_client.isQilcEntitled). */
export function capabilityHint(feature: string, capabilities: string[] | undefined): boolean {
  return capabilities?.includes(feature) ?? false;
}
