import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SseLivenessTracker, type SseState } from "../src/sse_liveness";

// The state machine's law (L1, #638): frames are truth; a quiet stream is
// STALE, not "thinking"; the probe splits dead from half-open; transitions
// fire exactly once. Fake timers — zero real sleeps.

describe("SseLivenessTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function rig(opts: {
    probe?: () => Promise<boolean>;
    onReconnectNeeded?: () => void;
  } = {}) {
    const transitions: [SseState, SseState][] = [];
    const probe = opts.probe ?? vi.fn().mockResolvedValue(true);
    const onReconnectNeeded = opts.onReconnectNeeded ?? vi.fn();
    const tracker = new SseLivenessTracker({
      stalenessMs: 30_000,
      tickMs: 5_000,
      probe,
      onReconnectNeeded,
      onStateChange: (from, to) => transitions.push([from, to]),
      log: () => {},
    });
    tracker.start();
    return { tracker, transitions, probe, onReconnectNeeded };
  }

  it("starts connecting; a connection makes it live", () => {
    const { tracker } = rig();
    expect(tracker.getState()).toBe("connecting");
    tracker.noteConnected();
    expect(tracker.getState()).toBe("live");
  });

  it("frames keep it live — the discarded-ping fix (comment-only blocks count)", () => {
    const { tracker } = rig();
    tracker.noteConnected();
    // frames arriving every <staleness: pings or events, both are liveness
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      tracker.noteFrame();
    }
    expect(tracker.getState()).toBe("live");
  });

  it("goes stale when no frames arrive for the threshold", () => {
    const { tracker, transitions } = rig();
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    expect(tracker.getState()).toBe("stale");
    expect(transitions).toContainEqual(["live", "stale"]);
  });

  it("stale + dead probe → dead", async () => {
    const { tracker } = rig({ probe: vi.fn().mockResolvedValue(false) });
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    expect(tracker.getState()).toBe("stale");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracker.getState()).toBe("dead");
  });

  it("stale + live server (half-open) → reconnect requested, once per tick", async () => {
    const onReconnectNeeded = vi.fn();
    const { tracker } = rig({ onReconnectNeeded });
    tracker.noteConnected();
    // the staleness threshold lands on the 30s tick, which goes stale AND
    // probes in the same pass (the faster dead/alive split by design)
    vi.advanceTimersByTime(30_000);
    expect(tracker.getState()).toBe("stale");
    // flush: probe #1 (the stale tick's own) + probe #2 (the next tick)
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReconnectNeeded).toHaveBeenCalledTimes(2);
    // still stale, still quiet, still alive: asks again on the next tick
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onReconnectNeeded).toHaveBeenCalledTimes(3);
  });

  it("frames while stale recover to live (and it says so)", async () => {
    const { tracker, transitions } = rig();
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    expect(tracker.getState()).toBe("stale");
    tracker.noteFrame();
    expect(tracker.getState()).toBe("live");
    expect(transitions).toContainEqual(["stale", "live"]);
  });

  it("a throwing probe is a dead probe, never a crash", async () => {
    const { tracker } = rig({ probe: vi.fn().mockRejectedValue(new Error("probe blew up")) });
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracker.getState()).toBe("dead");
  });

  it("disconnect makes it connecting; a reconnect returns it to live", () => {
    const { tracker } = rig();
    tracker.noteConnected();
    tracker.noteDisconnected();
    expect(tracker.getState()).toBe("connecting");
    tracker.noteConnected();
    expect(tracker.getState()).toBe("live");
  });

  it("transitions never double-fire for the same state", () => {
    const { tracker, transitions } = rig();
    tracker.noteConnected();
    tracker.noteConnected();
    tracker.noteFrame();
    expect(transitions.filter(([f, t]) => t === "live").length).toBe(1);
  });

  it("dead recovers through a reconnect: connecting → live", async () => {
    const { tracker } = rig({ probe: vi.fn().mockResolvedValue(false) });
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracker.getState()).toBe("dead");
    // the reconnect loop eventually succeeds
    tracker.noteDisconnected();
    tracker.noteConnected();
    expect(tracker.getState()).toBe("live");
  });

  it("frames arriving while the probe is in flight win over the probe", async () => {
    let resolveProbe!: (v: boolean) => void;
    const { tracker } = rig({
      probe: () => new Promise<boolean>((res) => (resolveProbe = res)),
    });
    tracker.noteConnected();
    vi.advanceTimersByTime(35_000);
    expect(tracker.getState()).toBe("stale");
    const tickDone = vi.advanceTimersByTimeAsync(5_000);
    // frames return mid-probe — the stream recovered; the probe result is moot
    tracker.noteFrame();
    expect(tracker.getState()).toBe("live");
    resolveProbe(false);
    await tickDone;
    expect(tracker.getState()).toBe("live");
  });

  it("dispose stops the ticks", () => {
    const { tracker } = rig({ probe: vi.fn().mockResolvedValue(false) });
    tracker.noteConnected();
    tracker.dispose();
    vi.advanceTimersByTime(60_000);
    expect(tracker.getState()).toBe("live"); // no ticks: no stale transition
  });
});
