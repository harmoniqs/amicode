// #1265 (Fleet thin client — Slice 5: honest degraded posture) — the
// RELAY→WRITER seam #780 left unwired. #780's debrief named it verbatim:
// "The hub-up-but-slow 'degrade' write is the natural seam for the
// service-side FleetPostureDetector (which computes latency degrade) to feed
// the SAME writer; I left that unwired."
//
// The relay's FleetPostureDetector (amicode_service/fleet_posture.ts) computes
// fleet | degraded | standalone from the data-plane outcome stream with
// latency hysteresis — including the hub-up-but-slow DEGRADED state the
// extension's own up/down probe cannot see. This module maps that detector
// state onto #780's PostureFacts and drives the SAME FleetPostureStateWriter.
//
// These tests pin the DELTA over #780: the relay-driven states (esp. degraded)
// map correctly, and the feed goes through #780's SINGLE writer, transition-
// only — NO second writer path (AC2).
import { describe, it, expect } from "vitest";
import { FleetPostureStateWriter, type FleetPostureStateFile } from "../src/fleet_posture_state";
import {
  postureFactsFromState,
  reachableForState,
  recordPostureState,
  recordDetectorSnapshot,
  type PostureContext,
  type RelayPostureState,
} from "../src/fleet_posture_feed";

const FIXED_NOW = "2026-09-18T23:40:00.000Z";
const ctx = (over: Partial<PostureContext> = {}): PostureContext => ({
  hostname: "macbook",
  hub: { name: "amicissimo-hub", base_url: "http://127.0.0.1:4096" },
  now: () => FIXED_NOW,
  ...over,
});

/** A #780 writer whose atomic disk write is replaced by a capture sink — the
 *  ONLY persistence path. If anything is written NOT through this writer, the
 *  capture stays empty (the "no second writer" proof). */
function spyWriter(): { writer: FleetPostureStateWriter; writes: FleetPostureStateFile[] } {
  const writes: FleetPostureStateFile[] = [];
  const writer = new FleetPostureStateWriter({
    now: () => FIXED_NOW,
    writeFile: (_file, text) => writes.push(JSON.parse(text) as FleetPostureStateFile),
  });
  return { writer, writes };
}

// ── the vocabulary map: relay state → #780 PostureFacts ──────────────────────

describe("postureFactsFromState — relay posture vocabulary → #780 schema", () => {
  it("fleet is hub-UP: reachable, last_ok stamped, RTT carried", () => {
    const f = postureFactsFromState("fleet", ctx({ rttMs: 30 }));
    expect(f.mode).toBe("fleet");
    expect(f.reachable).toBe(true);
    expect(f.last_ok).toBe(FIXED_NOW);
    expect(f.last_rtt_ms).toBe(30);
    expect(f.hub).toEqual({ name: "amicissimo-hub", base_url: "http://127.0.0.1:4096" });
    expect(f.hostname).toBe("macbook");
  });

  it("degraded is hub-UP-BUT-SLOW: still REACHABLE (never rendered as fell-back), RTT carried", () => {
    // The relay-distinctive state — the extension's up/down probe cannot
    // produce it. Degraded must map to reachable=true so the render says
    // "reachable but slow", never "unreachable / fell back".
    const f = postureFactsFromState("degraded", ctx({ rttMs: 2500 }));
    expect(f.mode).toBe("degraded");
    expect(f.reachable).toBe(true);
    expect(f.last_rtt_ms).toBe(2500);
    expect(f.last_ok).toBe(FIXED_NOW);
  });

  it("standalone is hub-DOWN: not reachable, no RTT, no last_ok guessed (explicit null)", () => {
    const f = postureFactsFromState("standalone", ctx());
    expect(f.mode).toBe("standalone");
    expect(f.reachable).toBe(false);
    expect(f.last_rtt_ms).toBeNull();
    expect(f.last_ok).toBeNull();
  });

  it("reachableForState: degraded is reachable, standalone is not", () => {
    expect(reachableForState("fleet")).toBe(true);
    expect(reachableForState("degraded")).toBe(true);
    expect(reachableForState("standalone")).toBe(false);
  });
});

// ── AC2: the feed goes through #780's SINGLE writer, transition-only ─────────

describe("recordPostureState — through #780's single writer, transition-only (AC2)", () => {
  it("each relay transition is one write through the SAME writer: fleet → degraded → fleet → standalone", () => {
    const { writer, writes } = spyWriter();
    recordPostureState("fleet", ctx(), writer);
    recordPostureState("degraded", ctx(), writer);
    recordPostureState("fleet", ctx(), writer);
    recordPostureState("standalone", ctx(), writer);
    expect(writes.map((w) => w.mode)).toEqual(["fleet", "degraded", "fleet", "standalone"]);
  });

  it("repeated identical states write NOTHING after the first (transition-only — the writer's discipline)", () => {
    const { writer, writes } = spyWriter();
    expect(recordPostureState("degraded", ctx(), writer).wrote).toBe(true);
    for (let i = 0; i < 20; i++) expect(recordPostureState("degraded", ctx(), writer).wrote).toBe(false);
    expect(writes.length).toBe(1);
  });

  it("a changed RTT alone on the same state is liveness churn — NOT a transition (no rewrite)", () => {
    const { writer, writes } = spyWriter();
    recordPostureState("degraded", ctx({ rttMs: 2100 }), writer);
    expect(recordPostureState("degraded", ctx({ rttMs: 8000 }), writer).wrote).toBe(false);
    expect(writes.length).toBe(1);
  });

  it("NO second writer: all persistence flows through the injected writer's sink and nowhere else", () => {
    // The feed owns no fs write of its own. If it wrote by any path other than
    // the passed FleetPostureStateWriter, this capture would miss it.
    const { writer, writes } = spyWriter();
    recordPostureState("fleet", ctx(), writer);
    recordPostureState("standalone", ctx(), writer);
    expect(writes.length).toBe(2);
    expect(writes.every((w) => w.schema_version === 1)).toBe(true); // #780's schema, unchanged
  });
});

// ── feeding the detector's own snapshot shape ────────────────────────────────

describe("recordDetectorSnapshot — the FleetPostureDetector.snapshot() feed", () => {
  it("a degraded snapshot records mode degraded + reachable, RTT from the last latency sample", () => {
    const { writer, writes } = spyWriter();
    const r = recordDetectorSnapshot({ state: "degraded", latency_window: [1900, 2200, 2600] }, ctx(), writer);
    expect(r.wrote).toBe(true);
    expect(writes[0].mode).toBe("degraded");
    expect(writes[0].reachable).toBe(true);
    expect(writes[0].last_rtt_ms).toBe(2600); // the most recent sample
  });

  it("a standalone snapshot records the honest hub-down posture (never as-if-attached)", () => {
    const { writer, writes } = spyWriter();
    recordDetectorSnapshot({ state: "standalone", latency_window: [] }, ctx(), writer);
    expect(writes[0].mode).toBe("standalone");
    expect(writes[0].reachable).toBe(false);
  });

  it("a malformed snapshot (unknown state) writes NOTHING — never a bogus/false posture from bad data", () => {
    const { writer, writes } = spyWriter();
    expect(recordDetectorSnapshot({ state: "??", latency_window: [1] }, ctx(), writer).wrote).toBe(false);
    expect(recordDetectorSnapshot({}, ctx(), writer).wrote).toBe(false);
    expect(writes.length).toBe(0);
  });
});
