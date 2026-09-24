// #780 — the machine-posture state file (the extension is the SOLE WRITER).
//
// During the 2026-09-03 outage a fleet client fell back to standalone and
// every session started afterward inherited a STALE role line with no
// posture — the researcher had to hand-explain "I'm on my MacBook, hub is
// down" to every agent. This module is the live-truth the context plugin
// reads: the extension's attach loop persists each attach-state TRANSITION
// (attach, degrade, hub-lost, hub-regained) to a small JSON file beside the
// fleet config; the plugin renders an honest posture block from it.
//
// The writer is a pure, dependency-light unit (node: builtins only) — the
// peer of fleet_poll_hysteresis.ts, wired into the same extension.ts attach
// loop. These tests pin: the issue-named schema, the TRANSITION-ONLY write
// discipline (AC3 — a poll tick that changes nothing writes nothing), the
// atomic on-disk write at the ops-fleet path, and the never-throw contract.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLEET_POSTURE_STATE_VERSION,
  fleetPostureStateFile,
  buildPostureRecord,
  FleetPostureStateWriter,
  type PostureFacts,
  type FleetPostureStateFile,
} from "../src/fleet_posture_state";

const FIXED_NOW = "2026-09-18T23:40:00.000Z";
const now = () => FIXED_NOW;

const fleetFacts = (over: Partial<PostureFacts> = {}): PostureFacts => ({
  hostname: "macbook",
  mode: "fleet",
  hub: { name: "amicissimo-hub", base_url: "http://127.0.0.1:4096" },
  reachable: true,
  last_ok: FIXED_NOW,
  last_rtt_ms: 12,
  ...over,
});

// ── the schema: every issue-named field, honestly ───────────────────────────

describe("buildPostureRecord — the issue's Key Decision schema", () => {
  it("a fleet-attach fact produces a record with hostname, mode, hub name/url, reachable, last-ok, last RTT, updated-at", () => {
    const rec = buildPostureRecord(fleetFacts(), now);
    expect(rec.schema_version).toBe(FLEET_POSTURE_STATE_VERSION);
    expect(rec.hostname).toBe("macbook");
    expect(rec.mode).toBe("fleet");
    expect(rec.hub).toEqual({ name: "amicissimo-hub", base_url: "http://127.0.0.1:4096" });
    expect(rec.reachable).toBe(true);
    expect(rec.last_ok).toBe(FIXED_NOW);
    expect(rec.last_rtt_ms).toBe(12);
    expect(rec.updated_at).toBe(FIXED_NOW);
  });

  it("absent liveness (last_ok / last_rtt_ms) is explicitly null, never undefined or a guessed value", () => {
    const rec = buildPostureRecord(
      { hostname: "mini", mode: "standalone", hub: { name: null, base_url: null }, reachable: false },
      now,
    );
    expect(rec.last_ok).toBeNull();
    expect(rec.last_rtt_ms).toBeNull();
    expect(rec.hub).toEqual({ name: null, base_url: null });
    expect(rec.reachable).toBe(false);
  });
});

// ── AC3: writes happen only on transitions, never per poll tick ──────────────

describe("FleetPostureStateWriter — transition-only write discipline (AC3)", () => {
  function spyWriter(): { writer: FleetPostureStateWriter; writes: FleetPostureStateFile[] } {
    const writes: FleetPostureStateFile[] = [];
    const writer = new FleetPostureStateWriter({
      now,
      writeFile: (_file, text) => writes.push(JSON.parse(text) as FleetPostureStateFile),
    });
    return { writer, writes };
  }

  it("the first record is a write (the attach transition)", () => {
    const { writer, writes } = spyWriter();
    const r = writer.record(fleetFacts());
    expect(r.wrote).toBe(true);
    expect(writes.length).toBe(1);
    expect(writes[0].mode).toBe("fleet");
  });

  it("identical poll ticks after a transition write NOTHING (not on every poll tick)", () => {
    const { writer, writes } = spyWriter();
    writer.record(fleetFacts());
    for (let i = 0; i < 20; i++) expect(writer.record(fleetFacts()).wrote).toBe(false);
    expect(writes.length).toBe(1); // the attach only
  });

  it("each of the four transitions is a distinct write: attach → hub-lost → hub-regained → degrade", () => {
    const { writer, writes } = spyWriter();
    writer.record(fleetFacts()); // attach
    writer.record(fleetFacts({ mode: "standalone", reachable: false })); // hub-lost
    writer.record(fleetFacts()); // hub-regained
    writer.record(fleetFacts({ mode: "degraded" })); // degrade (hub up but slow)
    expect(writes.map((w) => w.mode)).toEqual(["fleet", "standalone", "fleet", "degraded"]);
  });

  it("a changed hub identity is a transition even when mode/reachable are unchanged (rejoined a different hub)", () => {
    const { writer, writes } = spyWriter();
    writer.record(fleetFacts());
    const r = writer.record(fleetFacts({ hub: { name: "other-hub", base_url: "http://127.0.0.1:5000" } }));
    expect(r.wrote).toBe(true);
    expect(writes.length).toBe(2);
  });

  it("a changed RTT alone (same mode/reachable/hub) is NOT a transition — liveness churn must not rewrite", () => {
    const { writer, writes } = spyWriter();
    writer.record(fleetFacts({ last_rtt_ms: 10 }));
    expect(writer.record(fleetFacts({ last_rtt_ms: 900 })).wrote).toBe(false);
    expect(writes.length).toBe(1);
  });
});

// ── the on-disk write: atomic, at the ops-fleet path, never throws ───────────

describe("FleetPostureStateWriter — persistence at the ops-fleet path", () => {
  it("fleetPostureStateFile defaults beside the fleet config and honors the env override", () => {
    expect(fleetPostureStateFile({} as NodeJS.ProcessEnv)).toMatch(/\.amico\/ops\/fleet\/posture-state\.json$/);
    expect(fleetPostureStateFile({ AMICO_FLEET_POSTURE_STATE: "/tmp/x.json" } as NodeJS.ProcessEnv)).toBe("/tmp/x.json");
  });

  it("a transition write lands parseable JSON on disk (mkdir -p, atomic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "posture-state-"));
    const file = join(dir, "nested", "posture-state.json");
    try {
      const writer = new FleetPostureStateWriter({ file, now });
      const r = writer.record(fleetFacts());
      expect(r.wrote).toBe(true);
      expect(existsSync(file)).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf8")) as FleetPostureStateFile;
      expect(onDisk.hostname).toBe("macbook");
      expect(onDisk.mode).toBe("fleet");
      expect(onDisk.hub.base_url).toBe("http://127.0.0.1:4096");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a write failure is swallowed (never throws) — a dead disk must not crash the attach loop", () => {
    const writer = new FleetPostureStateWriter({
      now,
      writeFile: () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    expect(() => writer.record(fleetFacts())).not.toThrow();
    expect(writer.record(fleetFacts()).wrote).toBe(false);
  });
});
