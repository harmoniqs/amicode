import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraph, evaluate, type CalibrationGraph, type NodeState } from "../src/calibration_graph";

// Spec A §4 — the deterministic calibration graph (Kelly et al. "Optimus" DAG).
// Cycle rejection at load (§4.1); pure + total evaluate() (§4.3): own-status,
// suspect-propagation over the topo order, verdict + ranked action list. All
// exercised on the Snowbird fixture DAG (§4.4). Fixed NOW → no wall-clock.

const NOW = Date.parse("2026-07-07T00:00:00Z"); // fixed epoch ms — deterministic
const FIXTURE = readFileSync(join(__dirname, "corpus", "snowbird-graph.toml"), "utf8");

function loadOk(): CalibrationGraph {
  const r = loadGraph(FIXTURE);
  if (!r.ok) throw new Error(`fixture failed to load: ${r.error}`);
  return r.graph;
}

/** Seed every node with a fresh (recent) result → all calibrated. */
function freshState(g: CalibrationGraph): Record<string, NodeState> {
  const fresh = new Date(NOW - 60_000).toISOString(); // 1 min ago
  const state: Record<string, NodeState> = {};
  for (const name of g.nodes.keys()) state[name] = { value: {}, ts: fresh, status: "calibrated", job_id: `JOB-${name}` };
  return state;
}

describe("calibration graph — loadGraph (acyclic)", () => {
  it("loads the Snowbird fixture and orders dependencies before dependents", () => {
    const g = loadOk();
    expect(g.nodes.has("cz_gate")).toBe(true);
    expect(g.nodes.get("cz_gate")?.impl).toBe("qilc");
    expect(g.nodes.get("cz_gate")?.fallback).toBe("cz_gate_standard");
    // topo order: every dependency precedes the node that depends on it.
    const pos = new Map(g.topoOrder.map((n, i) => [n, i]));
    for (const node of g.nodes.values())
      for (const dep of node.depends_on) expect(pos.get(dep)!).toBeLessThan(pos.get(node.name)!);
    // roots have depth 0; a leaf is deeper than its parents.
    expect(g.depth("resonator_spec")).toBe(0);
    expect(g.depth("qubit_spec")).toBe(1);
    expect(g.depth("chevron")).toBeGreaterThan(g.depth("readout"));
  });

  it("rejects a graph with a dependency cycle with a typed error (§6 crit 7)", () => {
    const cyclic = `
[node.a]
depends_on = ["c"]
produces = ["x"]
impl = "standard"
[node.b]
depends_on = ["a"]
produces = ["y"]
impl = "standard"
[node.c]
depends_on = ["b"]
produces = ["z"]
impl = "standard"
`;
    const r = loadGraph(cyclic);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain("cycle");
  });
});

describe("calibration graph — evaluate() (pure + total)", () => {
  it("all-fresh state → every node calibrated / action none", () => {
    const g = loadOk();
    const verdicts = evaluate(g, freshState(g), NOW);
    expect(verdicts.every((v) => v.status === "calibrated")).toBe(true);
    expect(verdicts.every((v) => v.recommended_action === "none")).toBe(true);
    expect(verdicts.find((v) => v.node === "pi_amp")?.status).toBe("calibrated");
  });

  it("a stale parent marks its full descendant closure suspect; the parent ranks first (§6 crit 2)", () => {
    const g = loadOk();
    const state = freshState(g);
    // qubit_spec measured well before its 12h ttl → stale.
    state.qubit_spec = { value: {}, ts: new Date(NOW - 100 * 3600_000).toISOString(), status: "calibrated", job_id: "JOB-old" };
    const verdicts = evaluate(g, state, NOW);
    const byNode = new Map(verdicts.map((v) => [v.node, v]));

    expect(byNode.get("qubit_spec")?.status).toBe("stale");
    expect(byNode.get("qubit_spec")?.recommended_action).toBe("check");
    // full descendant closure is suspect (§4.3 step 4)
    for (const desc of ["pi_amp", "pi_len", "T1", "T2_ramsey", "T2_echo", "readout", "chevron", "cz_gate", "cz_gate_standard"])
      expect(byNode.get(desc)?.status, `${desc} should be suspect`).toBe("suspect");
    // the ancestor above the stale node is untouched
    expect(byNode.get("resonator_spec")?.status).toBe("calibrated");

    // ranked action list: qubit_spec (the moved parent) ranks before its children
    const actionable = verdicts.filter((v) => v.recommended_action !== "none").map((v) => v.node);
    expect(actionable.indexOf("qubit_spec")).toBeLessThan(actionable.indexOf("pi_amp"));
    expect(actionable.indexOf("qubit_spec")).toBeLessThan(actionable.indexOf("chevron"));
  });

  it("empty state → uncharacterized / +∞ age / calibrate; ranked roots-first, name tie-broken (§6 crit 2)", () => {
    const g = loadOk();
    const verdicts = evaluate(g, {}, NOW);
    expect(verdicts.every((v) => v.status === "uncharacterized")).toBe(true);
    expect(verdicts.every((v) => v.recommended_action === "calibrate")).toBe(true);
    expect(verdicts.every((v) => v.ageSeconds === Infinity)).toBe(true);

    // roots-first: resonator_spec (depth 0) is the single most-urgent root.
    expect(verdicts[0].node).toBe("resonator_spec");
    // deterministic name tie-break among equal (depth, +∞ age): pi_amp before pi_len.
    const order = verdicts.map((v) => v.node);
    expect(order.indexOf("pi_amp")).toBeLessThan(order.indexOf("pi_len"));
    // a leaf never precedes its parent.
    expect(order.indexOf("readout")).toBeLessThan(order.indexOf("chevron"));
  });

  it("an explicit failed status → failed / calibrate, and evaluate stays total on unknown nodes in state", () => {
    const g = loadOk();
    const state = freshState(g);
    state.readout = { value: { readout_fidelity: 0.5 }, ts: new Date(NOW - 60_000).toISOString(), status: "failed", job_id: "JOB-x" };
    state["ghost_node_not_in_graph"] = { value: {}, ts: new Date(NOW).toISOString(), status: "calibrated" };
    const verdicts = evaluate(g, state, NOW);
    const byNode = new Map(verdicts.map((v) => [v.node, v]));
    expect(byNode.get("readout")?.status).toBe("failed");
    expect(byNode.get("readout")?.recommended_action).toBe("calibrate");
    // chevron descends from readout → suspect; a stray state key is ignored (no throw, no verdict)
    expect(byNode.get("chevron")?.status).toBe("suspect");
    expect(byNode.has("ghost_node_not_in_graph")).toBe(false);
  });
});
