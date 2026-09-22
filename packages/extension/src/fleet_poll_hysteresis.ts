// ============================================================================
// Fleet poll hysteresis — the fleet client's tunnel-probe state machine
// (#1202).
//
// The fleet client polls the tunnel every 2s (checkFleet in extension.ts).
// Before #1202, ONE failed probe (1.5s timeout) flipped fleetReady off and
// FIVE total checks (10s) fired the "Go Standalone?" popup — so a tunnel in a
// multi-minute degradation window (the macbook↔hub reality: direct tailscale,
// ~160ms avg) flapped the status bar and re-offered standalone throughout
// active use (the 2026-09-15 live log: 37→46→75→89→119 consecutive failed
// checks).
//
// Hysteresis, mirroring server_keepalive's #1187 pattern
// (DEFAULT_FAILURE_THRESHOLD + consecutive-failure counting):
//   - the down-flip (fleetReady=false) requires DEFAULT_DOWN_THRESHOLD
//     consecutive failures (default 15 ≈ 30s at the 2s poll);
//   - the standalone offer requires a SUSTAINED outage
//     (DEFAULT_OFFER_THRESHOLD consecutive failures ≈ 5 min), once per
//     outage, and never re-offers within DEFAULT_OFFER_COOLDOWN_MS of the
//     previous offer (the cooldown survives a recovery — flapping tunnels
//     cannot extract repeated popups);
//   - a successful probe clears the consecutive count (the up-transition
//     side effects — SSE re-attach, panel reveal, provider signal — live in
//     extension.ts and are UNCHANGED; they fire on the "attach" transition).
//
// This module is pure infrastructure — no VS Code API, no fetch, no timers.
// Every threshold is injectable config (the amicode.fleet* settings follow
// the D6 tuning precedent: 0 = the default). extension.ts's wiring stays thin.
// ============================================================================

/** #1202: consecutive failed probes required before the tunnel is considered
 *  down (fleetReady=false + the status bar). 15 × 2s poll ≈ 30s. A single
 *  transient blip must never flip the status bar. */
export const DEFAULT_DOWN_THRESHOLD = 15;

/** #1202: consecutive failed probes required before the standalone offer.
 *  150 × 2s ≈ 5 minutes — a SUSTAINED outage, not a 10s hiccup. */
export const DEFAULT_OFFER_THRESHOLD = 150;

/** #1202: after an offer, no new offer within this window — across recoveries.
 *  One offer per outage, and a flapping tunnel cannot extract another popup
 *  until this cooldown from the LAST offer has elapsed. 15 minutes. */
export const DEFAULT_OFFER_COOLDOWN_MS = 15 * 60_000;

export interface FleetPollOptions {
  /** Consecutive failures before the down-flip. Default DEFAULT_DOWN_THRESHOLD. */
  downThreshold?: number;
  /** Consecutive failures before the standalone offer. Default DEFAULT_OFFER_THRESHOLD. */
  offerThreshold?: number;
  /** No re-offer within this window after the last offer (survives recovery).
   *  Default DEFAULT_OFFER_COOLDOWN_MS. */
  offerCooldownMs?: number;
  /** Injectable clock for the cooldown (prod = Date.now). */
  now?: () => number;
}

/** The up/down transition the wiring must act on:
 *  - "attach" — the tunnel came UP (re-attach SSE, reveal the panel, the
 *    provider signal — the pre-#1202 up-transition behavior, unchanged);
 *  - "detach" — the tunnel went DOWN at the threshold (status bar off);
 *  - null — no transition (holds, holds-with-failures, steady states). */
export type FleetPollTransition = "attach" | "detach" | null;

export interface FleetPollDecision {
  transition: FleetPollTransition;
  /** Offer the "Go Standalone?" popup this probe (fires once per outage,
   *  cooldown-gated). */
  offerStandalone: boolean;
  /** Consecutive failure count (0 on a successful probe). */
  failures: number;
  /** The effective down-flip threshold (for the wiring's hold log). */
  downThreshold: number;
  /** True on the very first probe overall — the wiring's one-time
   *  "waiting for tunnel" boot log. */
  bootProbe: boolean;
  /** The resulting fleetReady state. */
  ready: boolean;
}

/**
 * Pure consecutive-failure state machine for the fleet tunnel poll.
 * Feed it one probe outcome per poll tick; act on the returned decision.
 */
export class FleetPollHysteresis {
  private ready = false;
  private consecutiveFailures = 0;
  private totalChecks = 0;
  /** Latch: an offer already fired for the current outage (reset on recovery). */
  private offered = false;
  /** Timestamp of the last offer — persists ACROSS recoveries (the cooldown). */
  private lastOfferMs: number | undefined;
  private readonly downThreshold: number;
  private readonly offerThreshold: number;
  private readonly offerCooldownMs: number;
  private readonly now: () => number;

  constructor(opts: FleetPollOptions = {}) {
    this.downThreshold = Math.max(1, opts.downThreshold ?? DEFAULT_DOWN_THRESHOLD);
    // The offer threshold can never be below the down-flip threshold — the
    // offer only makes sense once the tunnel is already considered down.
    this.offerThreshold = Math.max(this.downThreshold, opts.offerThreshold ?? DEFAULT_OFFER_THRESHOLD);
    this.offerCooldownMs = Math.max(0, opts.offerCooldownMs ?? DEFAULT_OFFER_COOLDOWN_MS);
    this.now = opts.now ?? Date.now;
  }

  /** #777: the CURRENT ready state, read BEFORE a probe — the wiring uses this
   *  to widen the probe budget while un-attached (see checkFleet). A public
   *  getter only; mutations still flow through onProbe. */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Record one probe outcome and return the decision the wiring must act on.
   * A successful probe clears the consecutive-failure count.
   */
  onProbe(up: boolean): FleetPollDecision {
    this.totalChecks++;
    const bootProbe = this.totalChecks === 1;
    let transition: FleetPollTransition = null;

    if (up) {
      this.consecutiveFailures = 0;
      if (!this.ready) {
        this.ready = true;
        // One offer per outage: the latch re-arms on recovery. The cooldown
        // (lastOfferMs) deliberately does NOT reset here.
        this.offered = false;
        transition = "attach";
      }
    } else {
      this.consecutiveFailures++;
      if (this.ready && this.consecutiveFailures >= this.downThreshold) {
        this.ready = false;
        transition = "detach";
      }
    }

    let offerStandalone = false;
    if (!this.ready && !this.offered && this.consecutiveFailures >= this.offerThreshold) {
      const t = this.now();
      if (this.lastOfferMs === undefined || t - this.lastOfferMs >= this.offerCooldownMs) {
        offerStandalone = true;
        this.offered = true;
        this.lastOfferMs = t;
      }
    }

    return {
      transition,
      offerStandalone,
      failures: this.consecutiveFailures,
      downThreshold: this.downThreshold,
      bootProbe,
      ready: this.ready,
    };
  }
}
