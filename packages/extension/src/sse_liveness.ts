// Liveness state machine (L1, #638): evidence-backed states for the event
// stream, so "thinking" is never rendered without a live connection behind it.
//
// The truth hierarchy: frames are the primary signal (ANY SSE block — event
// or comment-only ping; opencode sends pings the old client discarded). No
// frames for stalenessMs → STALE. The STALE branch probes the server to split
// "alive but stream quiet" (a half-open TCP connection — tear it down and
// reconnect; never wait for TCP to notice) from "server gone" (DEAD). Every
// transition fires onStateChange with the evidence logged — the UI gets the
// truth, the output channel gets the why.
//
// Pure by injection: the probe, the clock, and the state-change sink are
// dependencies. The production caller is sse_client; T4a's serve-daemon tests
// reuse the same semantics. Tests use fake timers — zero real sleeps.

export type SseState = "connecting" | "live" | "stale" | "dead";

export const DEFAULT_STALENESS_MS = 30_000;
export const DEFAULT_TICK_MS = 5_000;

export interface SseLivenessOptions {
  /** ms without a frame before the stream is STALE (default 30s). */
  stalenessMs?: number;
  /** tick cadence for staleness checks (default 5s). */
  tickMs?: number;
  /** Probe the server: resolve true = alive. Injected so the STALE branch
   *  can split stale-from-dead without this module owning fetch. */
  probe: () => Promise<boolean>;
  /** Fired on every state TRANSITION (never twice for the same state). */
  onStateChange?: (from: SseState, to: SseState) => void;
  /** Fired once when the server proves alive but the stream stayed quiet —
   *  the half-open signal: the owner tears the connection down and
   *  reconnects rather than waiting for TCP to notice. */
  onReconnectNeeded?: () => void;
  /** Diagnostics sink (the output channel); liveness never crashes the host. */
  log?: (line: string) => void;
  /** Clock — injected; tests pass a controllable one, production wall clock. */
  now?: () => number;
}

export class SseLivenessTracker {
  private state: SseState = "connecting";
  private lastFrameAt: number | undefined;
  private connectedAt: number | undefined;
  private readonly stalenessMs: number;
  private readonly tickMs: number;
  private readonly probeFn: () => Promise<boolean>;
  private readonly onStateChange?: (from: SseState, to: SseState) => void;
  private readonly onReconnectNeeded?: () => void;
  private readonly log?: (line: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private probing = false;

  constructor(opts: SseLivenessOptions) {
    this.stalenessMs = opts.stalenessMs ?? DEFAULT_STALENESS_MS;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.probeFn = opts.probe;
    this.onStateChange = opts.onStateChange;
    this.onReconnectNeeded = opts.onReconnectNeeded;
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
  }

  /** Start ticking. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getState(): SseState {
    return this.state;
  }

  /** The stream connected (2xx on the event request). */
  noteConnected(): void {
    this.connectedAt = this.now();
    this.transition("live");
  }

  /** The stream ended/errored — a reconnect is in flight. */
  noteDisconnected(): void {
    this.transition("connecting");
  }

  /** ANY block arrived — event or comment-only ping. The discarded-ping fix:
   *  this is the liveness signal. Frames recover STALE back to LIVE. */
  noteFrame(): void {
    this.lastFrameAt = this.now();
    if (this.state === "stale") {
      this.log?.("[liveness] frames returned — stream live again");
    }
    // a speaking stream is live in every state — believe the frames
    this.transition("live");
  }

  private transition(to: SseState): void {
    if (this.state === to) return;
    const from = this.state;
    this.state = to;
    this.log?.(`[liveness] ${from} → ${to}`);
    this.onStateChange?.(from, to);
  }

  private async tick(): Promise<void> {
    if (this.state !== "live" && this.state !== "stale") return;
    const now = this.now();
    const last = this.lastFrameAt ?? this.connectedAt ?? now;
    if (now - last < this.stalenessMs) return;
    if (this.state === "live") {
      this.transition("stale");
    }
    if (this.probing) return;
    this.probing = true;
    let alive = false;
    try {
      alive = await this.probeFn();
    } catch {
      alive = false; /* a throwing probe is a dead probe, never a crash */
    } finally {
      this.probing = false;
    }
    // state may have moved on while the probe was in flight (frames returned)
    if (this.state !== "stale") return;
    if (!alive) {
      this.transition("dead");
      return;
    }
    this.log?.("[liveness] server alive but stream quiet — half-open; reconnect");
    this.onReconnectNeeded?.();
  }
}
