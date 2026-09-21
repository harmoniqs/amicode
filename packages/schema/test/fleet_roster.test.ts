// fleet_roster.test.ts — the fleet roster contract (amicode#1318, fleet
// capability model + host-owned roster; ADR 0026). Sibling of the fleet
// projection reader (fleet_projection.ts): a schema-versioned, host-owned
// roster whose rows each machine self-reports. The FORMAT is amicode-owned
// (unlike the projection, which mirrors amicissimo's Python contract) — this
// suite pins the row round-trip, the closed `health` enum, the open
// capability-tag set, and the single-writer upsert.
//
// Properties this suite defends (the #1318 Acceptance Criteria that live at
// the schema layer, "alongside the schema suites" per the issue's Testing
// Decisions):
//   AC1 — a full row round-trips { machine_id, name, server_mode,
//         capabilities[], sshAlias, transport, last_report, health } without
//         loss; health is the closed tri-state {reachable, degraded, down}
//         and a value outside it is rejected, never coerced.
//   AC2 — `compute` and `roaming` are the KNOWN behavior tags; an arbitrary
//         descriptive tag is accepted and preserved verbatim (open set).
import { describe, it, expect } from "vitest";
import {
  ROSTER_SCHEMA_VERSION,
  HEALTH_VOCABULARY,
  KNOWN_CAPABILITY_TAGS,
  KNOWN_DEVICE_TYPES,
  isKnownCapability,
  parseRosterRow,
  type RosterRow,
} from "../src/fleet_roster.js";

const ROW: RosterRow = {
  machine_id: "mac-studio-01",
  name: "JJ's Mac Studio",
  server_mode: "server",
  capabilities: ["compute", "roaming"],
  sshAlias: "jjs-mac-studio",
  transport: "tailscale",
  last_report: "2026-09-20T12:00:00Z",
  health: "reachable",
};

describe("the fleet roster contract (v1)", () => {
  it("is schema-versioned at v1 and carries the closed health tri-state", () => {
    expect(ROSTER_SCHEMA_VERSION).toBe(1);
    expect(HEALTH_VOCABULARY).toEqual(["reachable", "degraded", "down"]);
  });
});

describe("parseRosterRow — AC1: a full row round-trips without loss", () => {
  it("accepts a complete row and returns every field unchanged", () => {
    const r = parseRosterRow(ROW);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid row");
    expect(r.row).toEqual(ROW); // no field dropped, none invented
  });

  it("accepts each health value in the closed tri-state", () => {
    for (const health of HEALTH_VOCABULARY) {
      const r = parseRosterRow({ ...ROW, health });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a health value OUTSIDE the tri-state, never coercing it", () => {
    const r = parseRosterRow({ ...ROW, health: "flaky" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.error).toMatch(/health/i);
  });

  it("rejects a row missing its machine_id (the single-writer key)", () => {
    const { machine_id, ...noId } = ROW;
    void machine_id;
    expect(parseRosterRow(noId).ok).toBe(false);
  });

  it("rejects a non-object document, never coercing it into a row", () => {
    expect(parseRosterRow(null).ok).toBe(false);
    expect(parseRosterRow([1, 2, 3]).ok).toBe(false);
    expect(parseRosterRow("mac-studio-01").ok).toBe(false);
  });
});

describe("device_type — optional per-row form factor (fleet sidebar type pill, #1359)", () => {
  it("round-trips a device_type when the reporting machine includes one", () => {
    const r = parseRosterRow({ ...ROW, device_type: "laptop" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid row");
    expect(r.row.device_type).toBe("laptop");
  });

  it("parses a row that omits device_type entirely — absent is lawful, not invented", () => {
    const r = parseRosterRow(ROW); // ROW carries no device_type key
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid row");
    expect(r.row.device_type).toBeUndefined();
    expect("device_type" in r.row).toBe(false); // never fabricated onto the row
  });

  it("rejects a non-string device_type, never coercing it", () => {
    const r = parseRosterRow({ ...ROW, device_type: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected rejection");
    expect(r.error).toMatch(/device_type/i);
  });

  it("names the suggested form factors for the sidebar's type pill (open set, like capabilities)", () => {
    expect(KNOWN_DEVICE_TYPES).toEqual(["server", "desktop", "laptop"]);
    // an unrecognized form factor is still a valid, round-tripping value.
    const r = parseRosterRow({ ...ROW, device_type: "raspberry-pi" });
    expect(r.ok).toBe(true);
  });
});

describe("capabilities — AC2: known behavior tags + an open descriptive set", () => {
  it("`compute` and `roaming` are the recognized known tags", () => {
    expect(KNOWN_CAPABILITY_TAGS).toEqual(["compute", "roaming"]);
    expect(isKnownCapability("compute")).toBe(true);
    expect(isKnownCapability("roaming")).toBe(true);
  });

  it("an arbitrary descriptive tag is NOT known, yet is accepted (the set is open)", () => {
    expect(isKnownCapability("gpu-box-3090")).toBe(false);
    const r = parseRosterRow({ ...ROW, capabilities: ["compute", "roaming", "gpu-box-3090"] });
    expect(r.ok).toBe(true);
  });

  it("preserves capability tags VERBATIM and in order — known and arbitrary alike, none dropped", () => {
    const caps = ["compute", "the-loud-one", "roaming", "🛰️ satellite-lab"];
    const r = parseRosterRow({ ...ROW, capabilities: caps });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected a valid row");
    expect(r.row.capabilities).toEqual(caps); // arbitrary tags round-trip byte-for-byte
  });

  it("an empty capability set is valid (a machine may declare nothing)", () => {
    expect(parseRosterRow({ ...ROW, capabilities: [] }).ok).toBe(true);
  });
});
