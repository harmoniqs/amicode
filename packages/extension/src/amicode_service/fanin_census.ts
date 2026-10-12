// FAN-IN CENSUS (#1771, part of #1770) — every fan-in service's counters and
// its log lines. A wedged, evicted, or flapping event arm used to look exactly
// like a quiet one in every log: nothing recorded who subscribed, why an arm
// re-opened, or what was dropped (the Oct 12 eviction storm was found only by
// reverse-engineering engine connect timestamps). The census makes that visible
// without a probe run:
//
//   - one CENSUS line every 30 s (FANIN_CENSUS_INTERVAL_MS): active listeners,
//     listeners accepted / closed since boot, evictions, refusals, and per arm
//     (local and each peer, per listener connection) frames, bytes, largest
//     frame, time since the last frame, opens, closes by reason, pending depth,
//     overflow drops, and gaps emitted;
//   - one TRANSITION line immediately on each listener accepted / closed /
//     refused, arm opened / closed, gap emitted, overflow drop — never per frame.
//
// Observation only: the census writes to its SINK (the hub runner's log, the
// window's Amicode output channel), never to a stream. It adds no frame and
// changes no delivery decision. The clock and the sink are injected so tests
// drive it deterministically.
import type { ArmTraffic, GapCause } from "./sse_fanin_aggregator";

/** Why a listener or an upstream arm closed — an ENUMERATED set, so later
 *  slices and the verification slice can assert on it. `evicted` is kept even
 *  though #1772 removed the eviction path: it must read 0, and a regression
 *  that brings eviction back must have a name to show up under. */
export const FANIN_CLOSE_REASONS = [
  "upstream-end",
  "upstream-error",
  "membership-change",
  "listener-closed",
  "evicted",
  "shutdown",
] as const;
export type FanInCloseReason = (typeof FANIN_CLOSE_REASONS)[number];

/** The steady-state census cadence. */
export const FANIN_CENSUS_INTERVAL_MS = 30_000;

/** One arm of one live listener connection, as the census reports it. */
export interface ArmCensus {
  /** The listener connection (`c1`, `c2`, … in accept order). */
  conn: string;
  /** The arm's namespace: `local` or the peer's machine id. */
  arm: string;
  frames: number;
  bytes: number;
  largestFrame: number;
  /** ms since the arm's last frame; null when it has delivered none. */
  sinceLastFrameMs: number | null;
  opens: number;
  closes: Record<FanInCloseReason, number>;
  /** Frames waiting in the aggregator's pending stream for this arm. */
  pending: number;
  /** Frames dropped on overflow, since the connection opened. */
  drops: number;
  /** Gap frames emitted naming this arm. */
  gaps: number;
}

export interface FanInCensusSnapshot {
  plane: string;
  listeners: number;
  accepted: number;
  closed: number;
  evictions: number;
  refusals: number;
  arms: ArmCensus[];
}

/** What a live listener connection exposes to the census: its id and its
 *  arms' current counters (read at census time — nothing is pushed per frame). */
export interface CensusConnection {
  readonly id: string;
  arms(): Array<{
    arm: string;
    traffic: ArmTraffic;
    pending: number;
    opens: number;
    closes: Partial<Record<FanInCloseReason, number>>;
  }>;
}

export interface FanInCensusOptions {
  /** Which fan-in this is (`observe` — the observation path; `premium` — the
   *  flag-gated fleet plane). Rides every line. */
  plane?: string;
  /** Where the lines go. Default: nowhere (a census nobody wired is silent). */
  sink?: (line: string) => void;
  /** The clock (ms). Default Date.now. */
  now?: () => number;
  /** The census cadence. Default FANIN_CENSUS_INTERVAL_MS. */
  intervalMs?: number;
}

export function emptyCloses(): Record<FanInCloseReason, number> {
  const out = {} as Record<FanInCloseReason, number>;
  for (const r of FANIN_CLOSE_REASONS) out[r] = 0;
  return out;
}

function closesToken(closes: Record<FanInCloseReason, number>): string {
  const parts = FANIN_CLOSE_REASONS.filter((r) => closes[r] > 0).map((r) => `${r}:${closes[r]}`);
  return parts.length === 0 ? "-" : parts.join(",");
}

export class FanInCensus {
  readonly plane: string;
  readonly now: () => number;
  private readonly sink: (line: string) => void;
  private readonly intervalMs: number;
  private readonly live = new Map<string, CensusConnection>();
  private accepted = 0;
  private closed = 0;
  private evictions = 0;
  private refusals = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: FanInCensusOptions = {}) {
    this.plane = opts.plane ?? "fanin";
    this.sink = opts.sink ?? (() => undefined);
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? FANIN_CENSUS_INTERVAL_MS;
  }

  /** Start the steady-state cadence (idempotent; the timer never keeps the
   *  process alive on its own). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.emit(), this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the cadence (idempotent). Transition lines still log. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // ── transitions (each logs ONE line, immediately) ─────────────────────────

  listenerAccepted(conn: CensusConnection): void {
    this.accepted += 1;
    this.live.set(conn.id, conn);
    this.log("listener-accepted", `conn=${conn.id} listeners=${this.live.size}`);
  }

  listenerClosed(connId: string, reason: FanInCloseReason): void {
    if (!this.live.delete(connId)) return;
    this.closed += 1;
    if (reason === "evicted") this.evictions += 1;
    this.log("listener-closed", `conn=${connId} reason=${reason} listeners=${this.live.size}`);
  }

  listenerRefused(cap: number): void {
    this.refusals += 1;
    this.log("listener-refused", `listeners=${this.live.size} cap=${cap}`);
  }

  armOpened(connId: string, arm: string, opens: number): void {
    this.log("arm-opened", `conn=${connId} arm=${arm} opens=${opens}`);
  }

  armClosed(connId: string, arm: string, reason: FanInCloseReason): void {
    this.log("arm-closed", `conn=${connId} arm=${arm} reason=${reason}`);
  }

  gapEmitted(connId: string, arms: string[], cause: GapCause): void {
    this.log("gap-emitted", `conn=${connId} arm=${arms.join(",")} cause=${cause}`);
  }

  /** The FIRST drop of an overflow episode (the census counts every drop; the
   *  line is per episode — a drop storm never becomes a per-frame log). */
  overflowDrop(connId: string, arm: string, pending: number): void {
    this.log("overflow-drop", `conn=${connId} arm=${arm} pending=${pending}`);
  }

  // ── the census ────────────────────────────────────────────────────────────

  snapshot(): FanInCensusSnapshot {
    const now = this.now();
    const arms: ArmCensus[] = [];
    for (const conn of this.live.values()) {
      for (const a of conn.arms()) {
        arms.push({
          conn: conn.id,
          arm: a.arm,
          frames: a.traffic.frames,
          bytes: a.traffic.bytes,
          largestFrame: a.traffic.largestFrame,
          sinceLastFrameMs: a.traffic.lastFrameAt === undefined ? null : Math.max(0, now - a.traffic.lastFrameAt),
          opens: a.opens,
          closes: { ...emptyCloses(), ...a.closes },
          pending: a.pending,
          drops: a.traffic.drops,
          gaps: a.traffic.gaps,
        });
      }
    }
    return {
      plane: this.plane,
      listeners: this.live.size,
      accepted: this.accepted,
      closed: this.closed,
      evictions: this.evictions,
      refusals: this.refusals,
      arms,
    };
  }

  /** The census line: the service-level head, then ` | `-separated per-arm
   *  segments (`key=value` tokens throughout). */
  line(): string {
    const s = this.snapshot();
    const head = `[fanin] census plane=${s.plane} listeners=${s.listeners} accepted=${s.accepted} closed=${s.closed} evictions=${s.evictions} refusals=${s.refusals} arms=${s.arms.length}`;
    const segs = s.arms.map(
      (a) =>
        `conn=${a.conn} arm=${a.arm} frames=${a.frames} bytes=${a.bytes} largest=${a.largestFrame} since_last_ms=${a.sinceLastFrameMs ?? "-"} opens=${a.opens} closes=${closesToken(a.closes)} pending=${a.pending} drops=${a.drops} gaps=${a.gaps}`,
    );
    return [head, ...segs].join(" | ");
  }

  /** Write the census line to the sink now (the cadence calls this). */
  emit(): void {
    this.write(this.line());
  }

  /** One transition line: `[fanin] <kind> plane=<plane> <fields>`. */
  private log(kind: string, fields: string): void {
    this.write(`[fanin] ${kind} plane=${this.plane} ${fields}`);
  }

  private write(line: string): void {
    try {
      this.sink(line);
    } catch {
      /* a broken sink must never break the fan-in */
    }
  }
}
