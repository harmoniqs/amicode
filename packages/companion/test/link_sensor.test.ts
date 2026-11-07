// Tests for issue #1275 — "Client-side link sensor in the companion (bundles +
// reuses the detector)" (ADR 0025 P2, part of #1269).
//
// The companion owns the CLIENT-SIDE probe (probe.ts, #1274) — a ui-kind
// extension cannot read host-side posture state. This slice feeds that probe's
// outcomes, on the standard cadence, into the MERGED detector the fleet already
// uses (FleetPostureDetector, amicode_service/fleet_posture.ts — founding case
// "750 ms plane wifi") and emits the classified posture. There is NO second /
// forked detector: the companion imports the merged one and reuses the shared
// health→outcome mapping.
//
// AC1: the companion runs the probe on the standard cadence and feeds outcomes
//   to the bundled detector.
// AC2: the posture classification MATCHES the merged detector's definitions
//   (ok / degraded / hub-down = fleet / degraded / standalone) for the same
//   outcome stream — asserted against the detector's OWN cases
//   (packages/extension/test/amicode_service_fleet_posture.test.ts, the D6 block).
// AC3: no forked detector — the bundled one IS the merged detector (asserted
//   structurally: the companion's detector class + thresholds + health→outcome
//   mapping are the extension's exact symbols, never a copy).

import { describe, it, expect } from "vitest";
import {
  LinkSensor,
  DEFAULT_PROBE_CADENCE_MS,
  probeResultToTransportHealth,
  type LinkPosture,
  type SensorScheduler,
} from "../src/link_sensor";
import * as sensorMod from "../src/link_sensor";
import type { HubProbeResult } from "../src/probe";
// The MERGED detector + shared mapping, imported here from the extension source
// exactly as the companion imports them — so an identity check proves no fork.
import * as extPosture from "../../extension/src/amicode_service/fleet_posture";
import * as extTransport from "../../extension/src/amicode_service/fleet_transport";

// ── probe-result builders (the companion's OWN #1274 HubProbeResult shape) ────
const reachable = (latencyMs: number): HubProbeResult => ({ reachable: true, status: 200, latencyMs });
const unreachable = (reason = "ECONNREFUSED"): HubProbeResult => ({ reachable: false, reason });

/** A probe that yields each scripted result in order, then repeats the last —
 *  the injected outcome stream that replaces real network + real timers. */
function scriptedProbe(results: HubProbeResult[]): () => Promise<HubProbeResult> {
  let i = 0;
  return () => {
    const r = results[Math.min(i, results.length - 1)];
    i++;
    return Promise.resolve(r);
  };
}

/** A timer seam that CAPTURES the scheduled callback + cadence instead of using
 *  real timers, so start()/stop() are asserted deterministically. */
function fakeScheduler() {
  const scheduled: Array<{ cb: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  const scheduler: SensorScheduler = {
    setInterval: (cb, ms) => {
      scheduled.push({ cb, ms });
      return scheduled.length - 1;
    },
    clearInterval: (h) => {
      cleared.push(h);
    },
  };
  return { scheduler, scheduled, cleared };
}

/** Flush the microtasks one awaited probe + its .then chain needs (no real
 *  timers): a handful of turns is plenty for a single `await probe()`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — the probe runs on the standard cadence and feeds the bundled detector
// ══════════════════════════════════════════════════════════════════════════════

describe("LinkSensor — cadence + feeding the bundled detector (AC1)", () => {
  it("the standard cadence is the fleet poll's 2s interval", () => {
    expect(DEFAULT_PROBE_CADENCE_MS).toBe(2000);
  });

  it("start() schedules the probe on the standard cadence; stop() clears it", () => {
    const { scheduler, scheduled, cleared } = fakeScheduler();
    const sensor = new LinkSensor({ probe: scriptedProbe([reachable(5)]), scheduler });
    sensor.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(DEFAULT_PROBE_CADENCE_MS);
    sensor.stop();
    expect(cleared).toHaveLength(1);
  });

  it("start() is idempotent — a second start schedules nothing new", () => {
    const { scheduler, scheduled } = fakeScheduler();
    const sensor = new LinkSensor({ probe: scriptedProbe([reachable(5)]), scheduler });
    sensor.start();
    sensor.start();
    expect(scheduled).toHaveLength(1);
  });

  it("a configurable cadence overrides the default", () => {
    const { scheduler, scheduled } = fakeScheduler();
    const sensor = new LinkSensor({ probe: scriptedProbe([reachable(5)]), scheduler, cadenceMs: 500 });
    sensor.start();
    expect(scheduled[0].ms).toBe(500);
  });

  it("tick() runs the probe once and feeds the outcome to the detector (a reachable probe advances the healthy streak)", async () => {
    const sensor = new LinkSensor({ probe: scriptedProbe([reachable(7)]) });
    const posture = await sensor.tick();
    expect(posture.reachable).toBe(true);
    expect(posture.state).toBe("fleet"); // ok
    expect(posture.snapshot.healthy_streak).toBe(1);
    expect(posture.snapshot.latency_window).toEqual([7]); // the probe's latency reached the detector
  });

  it("the scheduled cadence callback drives a probe→detector tick (start actually feeds the detector)", async () => {
    const { scheduler, scheduled } = fakeScheduler();
    const seen: LinkPosture[] = [];
    const sensor = new LinkSensor({
      probe: scriptedProbe([unreachable()]),
      scheduler,
      onPosture: (p) => seen.push(p),
    });
    sensor.start();
    scheduled[0].cb(); // fire one cadence tick
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].reachable).toBe(false);
    expect(seen[0].snapshot.no_response_streak).toBe(1);
  });

  it("onPosture is emitted every tick with the freshly classified posture", async () => {
    const seen: LinkPosture[] = [];
    const sensor = new LinkSensor({
      probe: scriptedProbe([unreachable(), unreachable(), unreachable()]),
      onPosture: (p) => seen.push(p),
    });
    await sensor.tick();
    await sensor.tick();
    await sensor.tick();
    expect(seen.map((p) => p.state)).toEqual(["fleet", "fleet", "standalone"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — parity with the merged detector's OWN cases (the no-fork proof)
//
// Each case below reproduces a scenario from the detector's own suite
// (packages/extension/test/amicode_service_fleet_posture.test.ts, D6 block),
// but driven through the companion's probe → shared mapping → bundled detector,
// and asserts the IDENTICAL classification.
// ══════════════════════════════════════════════════════════════════════════════

describe("LinkSensor — parity with the merged detector's definitions (AC2)", () => {
  it("N=3 consecutive unreachable probes enter hub-down (standalone); fewer hold (D6: 'N consecutive no-responses')", async () => {
    const sensor = new LinkSensor({ probe: scriptedProbe([unreachable(), unreachable(), unreachable()]) });
    expect((await sensor.tick()).state).toBe("fleet");
    expect((await sensor.tick()).state).toBe("fleet"); // 2 < N — flapping must not flap
    const third = await sensor.tick();
    expect(third.state).toBe("standalone");
    expect(third.pointer).toContain("hub-down");
  });

  it("hysteresis: one reachable probe after hub-down does NOT re-enter fleet before the recovery streak (D6)", async () => {
    const sensor = new LinkSensor({
      probe: scriptedProbe([unreachable(), unreachable(), unreachable(), reachable(5), reachable(5), reachable(5)]),
    });
    await sensor.tick();
    await sensor.tick();
    expect((await sensor.tick()).state).toBe("standalone");
    expect((await sensor.tick()).state).toBe("standalone"); // 1 healthy — not yet
    expect((await sensor.tick()).state).toBe("standalone"); // 2 healthy — not yet
    expect((await sensor.tick()).state).toBe("fleet"); // 3 healthy — recovered
  });

  it("the latency window drives DEGRADED entry (p95 over the window) with its own exit hysteresis (D6)", async () => {
    // The SAME tuning the detector's own D6 latency case uses, on an injected
    // detector — the companion feeds the identical latency samples through the
    // shared mapping.
    const detector = new extPosture.FleetPostureDetector({
      tuning: { degradedLatencyP95Ms: 100, degradedWindowSamples: 3, recoveryConsecutiveHealthy: 2 },
    });
    const sensor = new LinkSensor({
      detector,
      probe: scriptedProbe([reachable(10), reachable(200), reachable(300), reachable(5), reachable(5), reachable(5)]),
    });
    expect((await sensor.tick()).state).toBe("fleet"); // below threshold + window not full
    expect((await sensor.tick()).state).toBe("fleet"); // one slow sample, window not full
    expect((await sensor.tick()).state).toBe("degraded"); // p95 of a full window >= threshold
    expect((await sensor.tick()).state).toBe("degraded"); // recovery streak not yet satisfied
    await sensor.tick();
    expect((await sensor.tick()).state).toBe("fleet"); // latency genuinely back under threshold
  });

  it("a HANG is not degradation: consecutive unreachable probes from degraded go to hub-down, never welded (D6)", async () => {
    const detector = new extPosture.FleetPostureDetector({
      tuning: { degradedLatencyP95Ms: 100, degradedWindowSamples: 3 },
    });
    const sensor = new LinkSensor({
      detector,
      probe: scriptedProbe([
        reachable(200),
        reachable(200),
        reachable(200),
        unreachable("client-enforced timeout"),
        unreachable("client-enforced timeout"),
        unreachable("client-enforced timeout"),
      ]),
    });
    await sensor.tick();
    await sensor.tick();
    expect((await sensor.tick()).state).toBe("degraded");
    await sensor.tick();
    await sensor.tick();
    const s = await sensor.tick();
    expect(s.state).toBe("standalone"); // degraded is never welded to a wedged tunnel
    expect(s.pointer).toContain("hub-down");
  });

  it("no fork by construction: an identical stream classifies IDENTICALLY through the sensor and through a raw merged detector, at every step", async () => {
    const stream: HubProbeResult[] = [
      reachable(10),
      reachable(10),
      unreachable(),
      unreachable(),
      unreachable(), // → standalone (hub-down)
      reachable(5),
      reachable(5),
      reachable(5), // → fleet (recovery streak)
    ];
    // The merged detector, fed the mapped outcomes directly (its own contract).
    const raw = new extPosture.FleetPostureDetector();
    const sensor = new LinkSensor({ probe: scriptedProbe(stream) });
    for (const r of stream) {
      raw.record(extTransport.transportHealthToOutcome(probeResultToTransportHealth(r)));
      const posture = await sensor.tick();
      expect(posture.state).toBe(raw.snapshot().state);
    }
  });

  it("the probe→outcome mapping is faithful: reachable→responded(latency), unreachable→no-response(reason)", () => {
    expect(probeResultToTransportHealth(reachable(42))).toEqual({ reachable: true, latencyMs: 42, version: null });
    expect(probeResultToTransportHealth(unreachable("timeout"))).toEqual({ reachable: false, reason: "timeout" });
    // …and through the SHARED mapping it becomes the detector's outcome vocabulary
    expect(extTransport.transportHealthToOutcome(probeResultToTransportHealth(reachable(42)))).toEqual({
      kind: "responded",
      latencyMs: 42,
    });
    expect(extTransport.transportHealthToOutcome(probeResultToTransportHealth(unreachable("boom")))).toEqual({
      kind: "no-response",
      detail: "boom",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — no second/forked detector: the bundled one IS the merged detector
// ══════════════════════════════════════════════════════════════════════════════

describe("LinkSensor — no forked detector (AC3)", () => {
  it("the companion's detector class IS the extension's FleetPostureDetector (same symbol, not a copy)", () => {
    expect(sensorMod.FleetPostureDetector).toBe(extPosture.FleetPostureDetector);
  });

  it("the companion reuses the merged detector's thresholds verbatim (imported, never redeclared)", () => {
    expect(sensorMod.DEGRADED_LATENCY_P95_MS).toBe(extPosture.DEGRADED_LATENCY_P95_MS);
    expect(sensorMod.DEGRADED_WINDOW_SAMPLES).toBe(extPosture.DEGRADED_WINDOW_SAMPLES);
    expect(sensorMod.HUB_DOWN_CONSECUTIVE_NO_RESPONSES).toBe(extPosture.HUB_DOWN_CONSECUTIVE_NO_RESPONSES);
    expect(sensorMod.RECOVERY_CONSECUTIVE_HEALTHY).toBe(extPosture.RECOVERY_CONSECUTIVE_HEALTHY);
  });

  it("the companion reuses the SHARED health→outcome mapping, not a companion fork", () => {
    expect(sensorMod.transportHealthToOutcome).toBe(extTransport.transportHealthToOutcome);
  });

  it("the sensor's internal classification comes from a FleetPostureDetector instance (the bundled merged detector)", async () => {
    const sensor = new LinkSensor({ probe: scriptedProbe([reachable(5)]) });
    const posture = await sensor.tick();
    // The emitted posture is a FleetPostureSnapshot produced by the merged
    // detector — it carries the detector's own contract fields.
    expect(posture.snapshot).toHaveProperty("refetch_epoch");
    expect(posture.snapshot).toHaveProperty("transitions");
    expect(posture.snapshot).toHaveProperty("latency_window");
  });
});
