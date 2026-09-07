// FLEET POSTURE (amicissimo#392 — the local-shell data plane, Slice B, D6):
// degradation is a STEADY STATE with a named entry condition, not an error
// path. The rule, verbatim from the sub-spec:
//
//   every data-plane request carries a client-enforced timeout (the client
//   always resolves or times out — the detector cannot wedge on a wedged
//   tunnel: it observes OUTCOMES, it does not await them). Posture derives
//   from the outcome stream with hysteresis: a latency threshold crossed
//   over a measurement window (p95 above X for Y samples) → degraded
//   (hub-up-but-slow: usable, honest, surfaced); N consecutive
//   no-responses → the hub-down posture (base standalone + a surfaced
//   pointer); recovery re-enters fleet mode via the D2 transition rule
//   (refetch-before-first-render).
//
// The vocabulary is D6's attach-state one — fleet | standalone | degraded —
// written into the base-owned schema with bidirectional preserve-on-rewrite
// (the attach-state store itself is Slice A's F4-stamped discipline).
//
// The detector is a pure synchronous state machine: `record()` never
// awaits, never throws, and cannot wedge — the timeout enforcement lives
// with the transport (hub_proxy / fleet_writes), which feeds outcomes here.
export type FleetPostureState = "fleet" | "degraded" | "standalone";

/** One data-plane outcome, as observed by the transport's client-enforced
 *  timeout: either the upstream answered (any HTTP status — a 5xx is still
 *  an ANSWER) or it did not (timeout enforced client-side, transport
 *  error, or no upstream bound). */
export type DataPlaneOutcome =
  | { kind: "responded"; latencyMs: number }
  | { kind: "no-response"; detail?: string };

export interface FleetPostureTransition {
  from: FleetPostureState;
  to: FleetPostureState;
  at: string;
  reason: string;
  /** D2's transition rule: ANY posture transition triggers
   *  refetch-before-first-render — the client refetches against the new
   *  posture before first render, keyed on refetch_epoch. */
  refetch_required: true;
}

export interface FleetPostureSnapshot {
  state: FleetPostureState;
  /** The honest UI-consumable pointer (set for standalone — the hub-down
   *  posture: base standalone running, fleet data honestly unavailable). */
  pointer: string | null;
  since: string;
  no_response_streak: number;
  healthy_streak: number;
  latency_window: number[];
  /** Monotonic; bumps on EVERY transition — the refetch-before-first-render
   *  key (a token derived over one posture is never compared against
   *  another). */
  refetch_epoch: number;
  transitions: FleetPostureTransition[];
  last_transition: FleetPostureTransition | null;
  /** D7's parity surface: the hub build version re-asserted by the data
   *  plane, the previous one named, and whether it changed mid-session. */
  parity: { version: string | null; previous_version: string | null; changed: boolean };
}

export interface FleetPostureTuning {
  /** X of D6's rule: the p95 latency threshold (ms) for degraded entry. */
  degradedLatencyP95Ms: number;
  /** Y of D6's rule: the measurement window (samples). */
  degradedWindowSamples: number;
  /** N of D6's rule: consecutive no-responses that enter hub-down. */
  hubDownConsecutiveNoResponses: number;
  /** Hysteresis: consecutive healthy outcomes required to re-enter fleet. */
  recoveryConsecutiveHealthy: number;
}

/** The named defaults of the rule. X = 2 s p95 (the founding case was
 *  750 ms plane wifi — 2 s is honest unusability, not a hiccup); Y = 5
 *  samples; N = 3 consecutive no-responses; recovery = 3 consecutive
 *  healthy outcomes. Production wiring (the fleet option's hub getter) is a
 *  later slice; these are the named conditions the fixture asserts. */
export const DEGRADED_LATENCY_P95_MS = 2000;
export const DEGRADED_WINDOW_SAMPLES = 5;
export const HUB_DOWN_CONSECUTIVE_NO_RESPONSES = 3;
export const RECOVERY_CONSECUTIVE_HEALTHY = 3;

const MAX_TRANSITIONS_KEPT = 10;

const DEFAULT_TUNING: FleetPostureTuning = {
  degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
  degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
  hubDownConsecutiveNoResponses: HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
};

/** Nearest-rank p95 over the window (the window is tiny — sort is fine). */
function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return sorted[idx];
}

export class FleetPostureDetector {
  private state: FleetPostureState = "fleet";
  private since: string;
  private noResponseStreak = 0;
  private healthyStreak = 0;
  private window: number[] = [];
  private epoch = 0;
  private transitions: FleetPostureTransition[] = [];
  private parityVersion: string | null = null;
  private parityPrevious: string | null = null;
  private readonly tuning: FleetPostureTuning;
  private readonly now: () => string;

  constructor(opts: { tuning?: Partial<FleetPostureTuning>; now?: () => string } = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...(opts.tuning ?? {}) };
    this.now = opts.now ?? (() => new Date().toISOString());
    this.since = this.now();
  }

  /** Feed one outcome. Synchronous by contract — the detector observes
   *  outcomes the transport already resolved (or enforced a timeout on);
   *  it never awaits, so it cannot wedge. */
  record(outcome: DataPlaneOutcome): void {
    if (outcome.kind === "responded") {
      this.healthyStreak++;
      this.noResponseStreak = 0;
      this.window.push(outcome.latencyMs);
      if (this.window.length > this.tuning.degradedWindowSamples) this.window.shift();
      const p95 = percentile95(this.window);
      if (
        this.state === "fleet" &&
        this.window.length >= this.tuning.degradedWindowSamples &&
        p95 >= this.tuning.degradedLatencyP95Ms
      ) {
        this.transition(
          "degraded",
          `latency-window: p95 of the last ${this.tuning.degradedWindowSamples} data-plane responses >= ${this.tuning.degradedLatencyP95Ms}ms (hub-up-but-slow)`,
        );
        return;
      }
      if (
        this.state === "degraded" &&
        this.healthyStreak >= this.tuning.recoveryConsecutiveHealthy &&
        p95 < this.tuning.degradedLatencyP95Ms
      ) {
        this.transition("fleet", "recovered: latency back under threshold across the recovery streak");
        return;
      }
      if (this.state === "standalone" && this.healthyStreak >= this.tuning.recoveryConsecutiveHealthy) {
        this.transition("fleet", "recovered: the hub answering again across the recovery streak");
      }
      return;
    }
    // no-response: the client-enforced timeout fired, or the transport
    // failed with no status seen
    this.noResponseStreak++;
    this.healthyStreak = 0;
    if (
      this.state !== "standalone" &&
      this.noResponseStreak >= this.tuning.hubDownConsecutiveNoResponses
    ) {
      this.transition(
        "standalone",
        `hub-down: ${this.noResponseStreak} consecutive data-plane requests resolved by the client-enforced timeout or a transport error`,
      );
    }
  }

  /** D7's parity re-assertion: the hub build version seen by the data
   *  plane. A null (the stamp failed open) never overwrites a named one. */
  noteHubVersion(version: string | null): void {
    if (version === null) return;
    if (this.parityVersion === null) {
      this.parityVersion = version;
      return;
    }
    if (version !== this.parityVersion) {
      this.parityPrevious = this.parityVersion;
      this.parityVersion = version;
    }
  }

  snapshot(): FleetPostureSnapshot {
    return {
      state: this.state,
      pointer:
        this.state === "standalone"
          ? "hub-down: the hub is unreachable — the base standalone posture is running; fleet data is honestly unavailable and recoverable"
          : null,
      since: this.since,
      no_response_streak: this.noResponseStreak,
      healthy_streak: this.healthyStreak,
      latency_window: [...this.window],
      refetch_epoch: this.epoch,
      transitions: [...this.transitions],
      last_transition: this.transitions.length > 0 ? this.transitions[this.transitions.length - 1] : null,
      parity: {
        version: this.parityVersion,
        previous_version: this.parityPrevious,
        changed:
          this.parityVersion !== null && this.parityPrevious !== null && this.parityVersion !== this.parityPrevious,
      },
    };
  }

  private transition(to: FleetPostureState, reason: string): void {
    const t: FleetPostureTransition = { from: this.state, to, at: this.now(), reason, refetch_required: true };
    this.state = to;
    this.since = t.at;
    this.epoch++;
    this.transitions.push(t);
    if (this.transitions.length > MAX_TRANSITIONS_KEPT) this.transitions.shift();
    // streak bookkeeping so the just-entered state starts clean: a fresh
    // state must not immediately re-trigger off the entering streak
    if (to === "standalone") {
      this.window = [];
    }
  }
}
