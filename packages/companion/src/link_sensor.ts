// link_sensor.ts — the always-local companion's CLIENT-SIDE LINK SENSOR (#1275,
// ADR 0025 P2). It runs the companion's OWN client→host probe (probe.ts, #1274)
// on the standard cadence and feeds each outcome to the MERGED detector the
// fleet's data plane already uses — FleetPostureDetector
// (amicode_service/fleet_posture.ts), founding case "750 ms plane wifi". The
// companion owns only the PROBE (a `ui`-kind extension cannot read host-side
// posture state, the running instance, or the projection); the CLASSIFICATION
// is 100% the merged detector's.
//
// ── ONE DETECTOR, NO FORK (AC3) ───────────────────────────────────────────────
// This module IMPORTS the merged detector and the shared health→outcome mapping
// straight from the extension source and re-exports them, so:
//   · the companion's `FleetPostureDetector` IS the extension's (same symbol);
//   · the ok/degraded/hub-down classification (= the detector's
//     fleet/degraded/standalone states) is never re-derived here;
//   · the reachable→responded / unreachable→no-response mapping is the SHARED
//     `transportHealthToOutcome` ("this slice OWNS it… ONE mapping, so every
//     provider feeds the SAME FleetPostureDetector — never a per-provider fork").
// Both source files are PURE (no `vscode`, no node builtins — a single type-only
// import between them), so esbuild bundles them into the ui companion safely.
// The companion imports the SOURCE by relative path (the extension package
// publishes no `exports` map and its `main` is the bundled dist) — the least-
// invasive reuse (#1275 briefing option 2); the detector is NOT moved, so the
// six landed fleet slices stay untouched.
//
// The only companion-authored transform is `probeResultToTransportHealth`: a
// thin re-expression of the companion's OWN #1274 HubProbeResult into the
// transport-health vocabulary the shared mapping consumes. That is an input
// adapter for the companion's own probe type, NOT the classification.

import {
  FleetPostureDetector,
  type FleetPostureState,
  type FleetPostureSnapshot,
} from "../../extension/src/amicode_service/fleet_posture";
import {
  transportHealthToOutcome,
  type FleetTransportHealth,
} from "../../extension/src/amicode_service/fleet_transport";
import type { HubProbeResult } from "./probe";

// Re-export the merged detector + its thresholds + the shared mapping VERBATIM,
// so the companion's single source of these is provably the extension's (AC3).
export {
  FleetPostureDetector,
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
  type FleetPostureState,
  type FleetPostureSnapshot,
  type DataPlaneOutcome,
} from "../../extension/src/amicode_service/fleet_posture";
export { transportHealthToOutcome } from "../../extension/src/amicode_service/fleet_transport";

/** The standard client→host probe cadence — the main extension's fleet poll
 *  interval (checkFleet polls the tunnel every 2s; the merged detector's
 *  hysteresis is tuned against that cadence). */
export const DEFAULT_PROBE_CADENCE_MS = 2000;

/** The classified posture the sensor emits each tick. `state` is the merged
 *  detector's OWN classification, VERBATIM — fleet (ok) | degraded |
 *  standalone (hub-down): the AC's ok/degraded/hub-down names ARE these three
 *  states (fleet = ok; the standalone state carries the "hub-down" pointer).
 *  It is never re-mapped here — re-deriving that mapping is the fork AC3
 *  forbids. `snapshot` is the detector's full snapshot for the switch
 *  orchestration to consume (#1276 auto-DOWN, #1277 prompt-UP). */
export interface LinkPosture {
  /** The merged detector's classification, verbatim. */
  state: FleetPostureState;
  /** The detector's honest pointer — set on the hub-down (standalone) state. */
  pointer: string | null;
  /** Whether the probe that produced this classification reached the host. */
  reachable: boolean;
  /** The merged detector's full snapshot (transitions, refetch_epoch, window). */
  snapshot: FleetPostureSnapshot;
}

/** The timer seam so the cadence is driven without real timers in tests. The
 *  handle is opaque (a number under DOM, a Timeout under node) — kept `unknown`
 *  so neither lib's `setInterval` typing leaks into the seam. */
export interface SensorScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const DEFAULT_SCHEDULER: SensorScheduler = {
  setInterval: (cb, ms) => {
    const handle = globalThis.setInterval(cb, ms);
    // Defensively unref (node Timeout) so the cadence never by itself keeps the
    // event loop / a test worker alive; a no-op where unref is absent (DOM).
    const maybeUnref = (handle as { unref?: () => void }).unref;
    if (typeof maybeUnref === "function") maybeUnref.call(handle);
    return handle;
  },
  clearInterval: (h) => globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]),
};

/** Re-express the companion's OWN #1274 probe result in the transport-health
 *  vocabulary the SHARED `transportHealthToOutcome` mapping consumes. The
 *  minimal client probe does no hub-version handshake, so `version` is honestly
 *  null. This adapts the companion's own probe-result type — it is NOT the
 *  classification (that stays entirely in the merged detector). */
export function probeResultToTransportHealth(result: HubProbeResult): FleetTransportHealth {
  return result.reachable
    ? { reachable: true, latencyMs: result.latencyMs, version: null }
    : { reachable: false, reason: result.reason };
}

export interface LinkSensorOptions {
  /** The client→host probe — one call, one outcome. Injected so tests feed a
   *  scripted outcome stream; production passes the wired probeHubHealth. */
  probe: () => Promise<HubProbeResult>;
  /** The bundled merged detector. Default: a fresh FleetPostureDetector with the
   *  merged defaults. Injectable so a caller can supply tuning (or share one). */
  detector?: FleetPostureDetector;
  /** The probe cadence in ms. Default DEFAULT_PROBE_CADENCE_MS (the 2s poll). */
  cadenceMs?: number;
  /** Called after every tick with the freshly classified posture (the seam the
   *  switch orchestration consumes — #1276/#1277). */
  onPosture?: (posture: LinkPosture) => void;
  /** The timer seam. Default: global setInterval/clearInterval. */
  scheduler?: SensorScheduler;
}

/**
 * The client-side link sensor: probe on a cadence → feed the MERGED detector →
 * emit the classified posture. It acts on nothing (auto-DOWN / prompt-UP /
 * URI-carry are S3+); it only classifies and emits.
 */
export class LinkSensor {
  private readonly probe: () => Promise<HubProbeResult>;
  private readonly detector: FleetPostureDetector;
  private readonly cadenceMs: number;
  private readonly onPosture?: (posture: LinkPosture) => void;
  private readonly scheduler: SensorScheduler;
  private handle: unknown = undefined;

  constructor(opts: LinkSensorOptions) {
    this.probe = opts.probe;
    this.detector = opts.detector ?? new FleetPostureDetector();
    this.cadenceMs = opts.cadenceMs ?? DEFAULT_PROBE_CADENCE_MS;
    this.onPosture = opts.onPosture;
    this.scheduler = opts.scheduler ?? DEFAULT_SCHEDULER;
  }

  /** Begin probing on the cadence. Idempotent — a second start is a no-op. */
  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.scheduler.setInterval(() => {
      void this.tick();
    }, this.cadenceMs);
  }

  /** Stop probing. Idempotent. */
  stop(): void {
    if (this.handle === undefined) return;
    this.scheduler.clearInterval(this.handle);
    this.handle = undefined;
  }

  /**
   * Run ONE probe, feed its outcome to the merged detector through the shared
   * health→outcome mapping, and emit + return the classified posture. The probe
   * is awaited (it is client-timeout-bounded); the detector records
   * synchronously (it observes outcomes, never awaits — it cannot wedge).
   */
  async tick(): Promise<LinkPosture> {
    const result = await this.probe();
    this.detector.record(transportHealthToOutcome(probeResultToTransportHealth(result)));
    const snapshot = this.detector.snapshot();
    const posture: LinkPosture = {
      state: snapshot.state,
      pointer: snapshot.pointer,
      reachable: result.reachable,
      snapshot,
    };
    this.onPosture?.(posture);
    return posture;
  }
}
