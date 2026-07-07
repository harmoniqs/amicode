import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGraph } from "../src/calibration_graph";
import { DeviceRegistry, type CalibrationEvent } from "../src/device_registry";
import { buildDeviceStatus, nextActions } from "../src/device_status";
import { MockJobServer } from "../src/qick_job_server";
import { SchusterJobServer } from "../src/qick_client";

// Spec A §6 acceptance sweep — the whole flow END-TO-END on MockJobServer + the
// Snowbird fixture DAG, no hardware. Each `it` names the criterion it pins; the
// finer-grained unit coverage lives in the per-module tests. This is the
// integration proof that the mock substrate backs every §6 criterion.

const NOW = Date.parse("2026-07-07T00:00:00Z");
const FIXTURE = readFileSync(join(__dirname, "corpus", "snowbird-graph.toml"), "utf8");
function graph() {
  const r = loadGraph(FIXTURE);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const DRIVE_LINES = [
  { id: "ch0", target: "Q1", kind: "drive" },
  { id: "ch1", target: "Q1", kind: "flux" },
];

describe("Spec A §6 acceptance sweep (MockJobServer + Snowbird fixture)", () => {
  it("crit 3 + crit 1: an idle mock queue yields a non-empty ranked list over an honest projection", async () => {
    const g = graph();
    const js = new MockJobServer({ channels: ["ch0", "ch1"], capabilities: [] });
    const health = await js.health();
    const status = buildDeviceStatus({
      graph: g,
      state: {}, // nothing measured yet
      now: NOW,
      driveLines: DRIVE_LINES,
      qubits: ["Q1"],
      onlineChannels: health.channels,
    });
    // honesty: empty state → uncharacterized qubit, no fabricated metrics
    expect(status.qubits[0].status).toBe("uncharacterized");
    expect(Object.keys(status.metrics)).toHaveLength(0);
    expect(status.driveLines.every((d) => d.online)).toBe(true); // both channels reported

    const r = nextActions(g, {}, await js.queue(), NOW, { entitled: true });
    expect(r.idle).toBe(true);
    expect(r.ranked_actions.length).toBeGreaterThan(0);
    // roots-first: resonator_spec (the only depth-0 node) is the first action
    expect(r.ranked_actions[0].node).toBe("resonator_spec");
  });

  it("crit 3: a running job for the device flips idle=false", async () => {
    const g = graph();
    const js = new MockJobServer();
    await js.submit({ user: "amico", experiment: { adapter: "mock", payload: {} } });
    expect(nextActions(g, {}, await js.queue(), NOW, { entitled: true }).idle).toBe(false);
  });

  it("crit 6: replaying a finished-job event → zero change to state.json (through the registry)", async () => {
    const js = new MockJobServer();
    await js.submit({ user: "amico", experiment: { adapter: "mock", payload: { tool: "amplitude_rabi" } } });
    const finished = await js.runNext({ result: { pi_amp: 0.031 } });
    expect(finished?.status).toBe("completed");

    // the TS QUEUE CLIENT (never the loop, §2.4) turns the finished job into a
    // state event and records it — idempotently.
    const reg = new DeviceRegistry();
    const ev: CalibrationEvent = { node: "pi_amp", job_id: finished!.job_id, ts: "2026-07-06T21:00:00Z", status: "calibrated", value: finished!.result };
    expect(reg.record(ev)).toBe(true);
    const snap = reg.snapshot();
    expect(reg.record(ev)).toBe(false); // replay of the same finished job
    expect(reg.snapshot()).toBe(snap); // state.json byte-identical
  });

  it("crit 4: entitlement gates the qilc node — off → fallback, on → itself", () => {
    const g = graph();
    const emptyQueue = { running: undefined, pending: [] };
    const off = nextActions(g, {}, emptyQueue, NOW, { entitled: false }).ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(off.locked).toBe(true);
    expect(off.recommendedNode).toBe("cz_gate_standard");
    const on = nextActions(g, {}, emptyQueue, NOW, { entitled: true }).ranked_actions.find((a) => a.node === "cz_gate")!;
    expect(on.locked).toBe(false);
    expect(on.recommendedNode).toBe("cz_gate");
  });

  it("crit 5 + crit 7: a dead client degrades to an honest offline projection; a cyclic graph is rejected", async () => {
    // dead client — a 500 never throws; the caller treats it as empty/offline.
    const dead = new SchusterJobServer({ baseUrl: "http://dead", fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => "" }) });
    const q = await dead.queue();
    const h = await dead.health();
    expect(q.ok).toBe(false);
    expect(h.ok).toBe(false);
    const g = graph();
    const status = buildDeviceStatus({
      graph: g,
      state: {},
      now: NOW,
      driveLines: DRIVE_LINES,
      qubits: ["Q1"],
      onlineChannels: h.ok ? h.value.channels : undefined, // dead → undefined → all offline
    });
    expect(status.driveLines.every((d) => !d.online)).toBe(true);
    expect(status.qubits[0].status).toBe("uncharacterized");

    // cycle rejection at load — evaluate() is never called on a cyclic graph.
    const cyclic = loadGraph(`
[node.a]
depends_on = ["b"]
produces = ["x"]
impl = "standard"
[node.b]
depends_on = ["a"]
produces = ["y"]
impl = "standard"
`);
    expect(cyclic.ok).toBe(false);
  });
});
