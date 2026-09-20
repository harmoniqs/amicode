import { describe, it, expect } from "vitest";
import {
  FleetPollHysteresis,
  DEFAULT_DOWN_THRESHOLD,
  DEFAULT_OFFER_THRESHOLD,
  DEFAULT_OFFER_COOLDOWN_MS,
  type FleetPollDecision,
} from "../src/fleet_poll_hysteresis";

// ============================================================================
// #1202 — the fleet client poll needs hysteresis.
//
// Pre-fix reality (the 2026-09-15 live log): ONE failed probe (1.5s timeout)
// flipped fleetReady off and FIVE total checks (10s) fired the "Go Standalone?"
// popup — repeatedly, during multi-minute tunnel degradation windows. This
// module pins the hysteresis contract, mirroring server_keepalive's #1187
// pattern (DEFAULT_FAILURE_THRESHOLD + consecutive-failure counting):
//
//   AC1  a blip (1–2 failures) holds; the down-flip fires only at the
//        configured consecutive-failure threshold
//   AC2  the standalone offer fires only after a SUSTAINED outage
//        (default ≈5 min of consecutive failures), exactly ONCE per outage
//   AC3  recovery is unchanged (attach transition) and never re-offers
//        within the cooldown after a recovery
//   AC4  a successful probe clears the consecutive count; thresholds are
//        configurable through the helper's options
// ============================================================================

/** Drive n consecutive probes. */
function probeN(poll: FleetPollHysteresis, up: boolean, n: number): FleetPollDecision[] {
  return Array.from({ length: n }, () => poll.onProbe(up));
}

// ============================================================================
// AC1: a blip holds — the down-flip fires only at the threshold
// ============================================================================

describe("FleetPollHysteresis — down-flip threshold (AC1)", () => {
  it("defaults pin the issue's contract: 15 consecutive failures to flip (30s at the 2s poll), 150 to offer (~5min)", () => {
    expect(DEFAULT_DOWN_THRESHOLD).toBe(15);
    expect(DEFAULT_OFFER_THRESHOLD).toBe(150);
    expect(DEFAULT_OFFER_COOLDOWN_MS).toBeGreaterThanOrEqual(10 * 60_000); // minutes-scale
  });

  it("a single failed probe does NOT flip fleetReady off (the status bar holds)", () => {
    const poll = new FleetPollHysteresis();
    poll.onProbe(true); // tunnel up — attached
    const d = poll.onProbe(false); // one lost probe
    expect(d.transition).toBeNull(); // no detach → wiring keeps the status bar up
    expect(d.ready).toBe(true);
    expect(d.offerStandalone).toBe(false);
  });

  it("two consecutive failures still hold (a tunnel blip, not an outage)", () => {
    const poll = new FleetPollHysteresis();
    poll.onProbe(true);
    const [d1, d2] = probeN(poll, false, 2);
    expect(d1.transition).toBeNull();
    expect(d2.transition).toBeNull();
    expect(d2.ready).toBe(true);
  });

  it("the down-flip fires exactly at the 15th consecutive failure, not before", () => {
    const poll = new FleetPollHysteresis();
    poll.onProbe(true);
    const holds = probeN(poll, false, 14);
    expect(holds.every((d) => d.transition === null && d.ready === true)).toBe(true);
    const flip = poll.onProbe(false); // 15th
    expect(flip.transition).toBe("detach");
    expect(flip.ready).toBe(false);
    expect(flip.failures).toBe(15);
  });

  it("the first failed probe while up carries the failure count (the wiring logs the hold once)", () => {
    const poll = new FleetPollHysteresis();
    poll.onProbe(true);
    const d = poll.onProbe(false);
    expect(d.failures).toBe(1);
    expect(d.downThreshold).toBe(DEFAULT_DOWN_THRESHOLD);
  });
});

// ============================================================================
// AC2: the standalone offer fires only after a SUSTAINED outage — once
// ============================================================================

describe("FleetPollHysteresis — sustained-outage offer (AC2)", () => {
  it("offers standalone exactly ONCE at 150 consecutive failures — never again while the outage continues", () => {
    const poll = new FleetPollHysteresis();
    const downs = probeN(poll, false, DEFAULT_OFFER_THRESHOLD + 10);
    const offers = downs.filter((d) => d.offerStandalone);
    expect(offers).toHaveLength(1);
    expect(offers[0].failures).toBe(DEFAULT_OFFER_THRESHOLD);
    // the offer comes AFTER the down-flip (150 > 15) — fleetReady is already off
    expect(offers[0].ready).toBe(false);
  });

  it("no offer below the sustained threshold (the old 5-check popup is gone)", () => {
    const poll = new FleetPollHysteresis();
    const downs = probeN(poll, false, DEFAULT_OFFER_THRESHOLD - 1);
    expect(downs.some((d) => d.offerStandalone)).toBe(false);
  });

  it("flags the boot probe so the wiring logs 'waiting for tunnel' once, not per check", () => {
    const poll = new FleetPollHysteresis();
    expect(poll.onProbe(false).bootProbe).toBe(true);
    expect(poll.onProbe(false).bootProbe).toBe(false);
    expect(poll.onProbe(true).bootProbe).toBe(false);
  });
});

// ============================================================================
// AC3: recovery unchanged — attach fires; no re-offer within the cooldown
// ============================================================================

describe("FleetPollHysteresis — recovery + offer cooldown (AC3)", () => {
  it("recovery emits exactly one attach transition and re-arms nothing else", () => {
    const poll = new FleetPollHysteresis();
    probeN(poll, false, 20); // outage past the flip threshold
    const d = poll.onProbe(true);
    expect(d.transition).toBe("attach");
    expect(d.ready).toBe(true);
    // an up probe while already ready emits nothing (no re-attach storm)
    expect(poll.onProbe(true).transition).toBeNull();
  });

  it("after a recovery, a NEW sustained outage does not re-offer within the cooldown", () => {
    let t = 0;
    const poll = new FleetPollHysteresis({ now: () => t });
    // outage #1: offer fires at 150 consecutive failures
    probeN(poll, false, DEFAULT_OFFER_THRESHOLD);
    expect(poll.onProbe(false).offerStandalone).toBe(false); // latched — one per outage
    // recovery at t = 1_000
    t = 1_000;
    expect(poll.onProbe(true).transition).toBe("attach");
    // outage #2: another full sustained outage, but well inside the cooldown
    t = 2_000;
    const downs = probeN(poll, false, DEFAULT_OFFER_THRESHOLD);
    expect(downs.some((d) => d.offerStandalone)).toBe(false);
  });

  it("after the cooldown elapses, a sustained outage may offer again", () => {
    let t = 0;
    const poll = new FleetPollHysteresis({ now: () => t });
    probeN(poll, false, DEFAULT_OFFER_THRESHOLD); // offer #1 at t=0
    t = 1_000;
    poll.onProbe(true); // recovery
    // outage #2 reaching its sustained threshold AFTER the cooldown window
    t = DEFAULT_OFFER_COOLDOWN_MS + 5_000;
    const downs = probeN(poll, false, DEFAULT_OFFER_THRESHOLD);
    const offers = downs.filter((d) => d.offerStandalone);
    expect(offers).toHaveLength(1);
    expect(offers[0].failures).toBe(DEFAULT_OFFER_THRESHOLD);
  });
});

// ============================================================================
// AC4: counter reset on success + configurable thresholds
// ============================================================================

describe("FleetPollHysteresis — counter reset + configurability (AC4)", () => {
  it("a successful probe clears the consecutive count (14 downs + 1 up + 14 downs still holds)", () => {
    const poll = new FleetPollHysteresis();
    poll.onProbe(true);
    probeN(poll, false, DEFAULT_DOWN_THRESHOLD - 1); // 14 — one short of the flip
    expect(poll.onProbe(true).transition).toBeNull(); // ready stays ready; no re-attach
    const downs = probeN(poll, false, DEFAULT_DOWN_THRESHOLD - 1); // a fresh streak of 14
    expect(downs.every((d) => d.transition === null && d.ready === true)).toBe(true);
  });

  it("thresholds are configurable — a small config flips and offers early", () => {
    const poll = new FleetPollHysteresis({ downThreshold: 2, offerThreshold: 4, now: () => 0 });
    poll.onProbe(true);
    expect(poll.onProbe(false).transition).toBeNull(); // 1st failure holds
    expect(poll.onProbe(false).transition).toBe("detach"); // 2nd flips
    const downs = probeN(poll, false, 2); // failures 3 and 4
    expect(downs[0].offerStandalone).toBe(false);
    expect(downs[1].offerStandalone).toBe(true);
  });

  it("the offer cooldown is configurable (ms)", () => {
    let t = 0;
    const poll = new FleetPollHysteresis({ offerCooldownMs: 5_000, now: () => t });
    probeN(poll, false, 150); // offer #1
    t = 1_000;
    poll.onProbe(true); // recovery
    t = 4_000; // 3s after the recovery — inside the 5s cooldown
    probeN(poll, false, 150);
    expect(poll.onProbe(false).offerStandalone).toBe(false);
    t = 6_500; // past the cooldown from the FIRST offer
    expect(poll.onProbe(false).offerStandalone).toBe(true);
  });

  it("degenerate thresholds clamp to sane floors (0 behaves as 1 — flip on the first failure, never a NaN/never-flip config)", () => {
    const poll = new FleetPollHysteresis({ downThreshold: 0, offerThreshold: 0, offerCooldownMs: -1 });
    poll.onProbe(true);
    expect(poll.onProbe(false).downThreshold).toBe(1); // clamped, same floor as the keepalive's Math.max(1, …)
    expect(poll.onProbe(false).transition).toBeNull(); // 2nd failure: already detached, no re-detach
  });

  it("isReady exposes the CURRENT state before a probe (#777 — the wiring widens the probe budget while un-attached)", () => {
    const poll = new FleetPollHysteresis({ downThreshold: 2 });
    expect(poll.isReady).toBe(false); // pre-attach: the wide first-attach budget applies
    poll.onProbe(false); // still not ready — a failed wide-budget probe
    expect(poll.isReady).toBe(false);
    poll.onProbe(true);
    expect(poll.isReady).toBe(true); // attached: the fast steady-state budget applies
    poll.onProbe(false); // a transient failure does NOT flip ready back
    expect(poll.isReady).toBe(true);
    poll.onProbe(false); // downThreshold 2 → detach
    expect(poll.isReady).toBe(false); // un-attached again: wide budget on the next probe
  });
});
