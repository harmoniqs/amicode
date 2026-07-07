import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraph, type CalibrationGraph, type NodeState } from "../src/calibration_graph";
import { buildDeviceStatus, nextActions, capabilityHint } from "../src/device_status";
import { MockJobServer, type QueueView } from "../src/qick_job_server";

// Spec A §3 (device projection) + §5 (queue-awareness + entitlement). All pure —
// the tests assert the PROJECTION OBJECT, never a rendered view (the Kobalte-SSR
// untestability lesson, §6 crit 1). Covers §6 crit 1, 3, 4.

const NOW = Date.parse("2026-07-07T00:00:00Z");
const FIXTURE = readFileSync(join(__dirname, "corpus", "snowbird-graph.toml"), "utf8");
function loadOk(): CalibrationGraph {
  const r = loadGraph(FIXTURE);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const fresh = new Date(NOW - 60_000).toISOString();
const seed = (value: Record<string, unknown>, job: string): NodeState => ({ value, ts: fresh, status: "calibrated", job_id: job });

const DRIVE_LINES = [
  { id: "ch0", target: "Q1", kind: "drive" },
  { id: "ch1", target: "Q1", kind: "flux" },
  { id: "ch2", target: "Q2", kind: "drive" },
];

describe("buildDeviceStatus — live projection (§6 crit 1)", () => {
  it("carries drive-lines-online, per-qubit rollup, latest metrics with ages, and honest gaps", () => {
    const g = loadOk();
    // Seed the chain measured+fresh, but pi_amp is STALE (past its ttl) so its
    // measured descendants roll up SUSPECT; leave the cz nodes UNMEASURED so
    // their metric stays an honest gap.
    const stale = new Date(NOW - 100 * 3600_000).toISOString();
    const state: Record<string, NodeState> = {
      resonator_spec: seed({ resonator_freq: 7.1e9 }, "J1"),
      qubit_spec: seed({ qubit_freq: 5.1e9 }, "J2"),
      pi_amp: { value: { pi_amp: 0.031 }, ts: stale, status: "calibrated", job_id: "J3" },
      pi_len: seed({ pi_len: 40 }, "J4"),
      T1: seed({ T1: 55.2 }, "J5"),
      T2_ramsey: seed({ T2_ramsey: 31.0 }, "J6"),
      T2_echo: seed({ T2_echo: 48.0 }, "J7"),
      readout: seed({ readout_fidelity: 0.97 }, "J8"),
      chevron: seed({ chevron_map: 1 }, "J9"),
    };
    const status = buildDeviceStatus({
      graph: g,
      state,
      now: NOW,
      driveLines: DRIVE_LINES,
      qubits: ["Q1", "Q2"],
      onlineChannels: ["ch0", "ch1"], // ch2 offline (not reported)
      mainConfig: { version_id: "CFG-1", type: "hw", payload: { qubit_freq: 5.1e9, readout_freq: 7.05e9 } },
    });

    // drive lines online (from health channels)
    expect(status.driveLines.find((d) => d.id === "ch0")?.online).toBe(true);
    expect(status.driveLines.find((d) => d.id === "ch2")?.online).toBe(false);

    // per-qubit rollup (worst-status wins): pi_amp stale → its measured
    // descendants are SUSPECT, so Q1 rolls up suspect; Q2 has NO nodes →
    // uncharacterized (honest gap, not a guess).
    const q1 = status.qubits.find((q) => q.qubit === "Q1")!;
    const q2 = status.qubits.find((q) => q.qubit === "Q2")!;
    expect(q1.status).toBe("suspect");
    expect(q2.status).toBe("uncharacterized");

    // latest metrics with ages — only for MEASURED nodes; NEVER fabricated.
    expect(status.metrics.T1).toMatchObject({ value: 55.2, status: "suspect" });
    expect(status.metrics.T1.ageSeconds).toBeCloseTo(60, 0);
    expect(status.metrics.T2_ramsey.value).toBe(31.0);
    expect(status.metrics.readout_fidelity.value).toBe(0.97);
    expect(status.metrics.cz_fidelity).toBeUndefined(); // cz unmeasured → absent, not a guess

    // calibration params = main_config payload ∪ produced params
    expect(status.calibrationParams.readout_freq).toBe(7.05e9); // from main_config
    expect(status.calibrationParams.pi_amp).toBe(0.031); // from a produced node value
  });

  it("a dead server (no online channels) → every drive line offline (§6 crit 5 projection side)", () => {
    const g = loadOk();
    const status = buildDeviceStatus({ graph: g, state: {}, now: NOW, driveLines: DRIVE_LINES, qubits: ["Q1"] });
    expect(status.driveLines.every((d) => !d.online)).toBe(true);
    expect(status.qubits[0].status).toBe("uncharacterized"); // empty state → honest
  });
});

describe("nextActions — queue-awareness (§6 crit 3)", () => {
  it("empty queue → idle=true + a non-empty ranked action list", async () => {
    const g = loadOk();
    const js = new MockJobServer();
    const q = await js.queue();
    const r = nextActions(g, {}, q, NOW, { entitled: true });
    expect(r.idle).toBe(true);
    expect(r.ranked_actions.length).toBeGreaterThan(0);
  });
  it("a running/pending job for the device → idle=false", async () => {
    const g = loadOk();
    const js = new MockJobServer();
    await js.submit({ user: "u", experiment: { adapter: "mock", payload: {} } });
    const q: QueueView = await js.queue();
    expect(nextActions(g, {}, q, NOW, { entitled: true }).idle).toBe(false);
  });
});

describe("nextActions — entitlement seam (§6 crit 4)", () => {
  const g = loadOk();
  const emptyQueue: QueueView = { running: undefined, pending: [] };

  it("unentitled → qilc node LOCKED, action redirected to its fallback node", () => {
    const r = nextActions(g, {}, emptyQueue, NOW, { entitled: false });
    const cz = r.ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(cz.locked).toBe(true);
    expect(cz.recommendedNode).toBe("cz_gate_standard"); // fallback, not the qilc node
    // it NEVER recommends the qilc action itself
    expect(cz.action).not.toBe("redesign"); // has a fallback → calibrate the fallback
  });

  it("unentitled qilc node WITHOUT a fallback → redesign kick", () => {
    const cyclicFree = `
[node.solo]
depends_on = []
produces = ["f"]
impl = "qilc"
`;
    const g2 = loadGraph(cyclicFree);
    if (!g2.ok) throw new Error(g2.error);
    const r = nextActions(g2.graph, {}, emptyQueue, NOW, { entitled: false });
    const solo = r.ranked_actions.find((a) => a.node === "solo")!;
    expect(solo.locked).toBe(true);
    expect(solo.action).toBe("redesign");
  });

  it("entitled → qilc node ranks normally, unlocked, recommends itself", () => {
    const r = nextActions(g, {}, emptyQueue, NOW, { entitled: true });
    const cz = r.ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(cz.locked).toBe(false);
    expect(cz.recommendedNode).toBe("cz_gate");
  });

  it("capabilityHint is advisory only (health flag), not the authority", () => {
    expect(capabilityHint("qilc", ["qilc"])).toBe(true);
    expect(capabilityHint("qilc", [])).toBe(false);
    expect(capabilityHint("qilc", undefined)).toBe(false);
  });
});
