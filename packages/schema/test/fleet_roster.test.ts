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
  placementDescriptor,
  classifyMacModel,
  classifyLinuxChassis,
  normalizeDeviceName,
  isWslKernel,
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
  it("`compute`, `roaming`, and `serving` are the recognized known tags", () => {
    expect(KNOWN_CAPABILITY_TAGS).toEqual(["compute", "roaming", "serving"]);
    expect(isKnownCapability("compute")).toBe(true);
    expect(isKnownCapability("roaming")).toBe(true);
    expect(isKnownCapability("serving")).toBe(true);
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

// #1341 (ADR 0027 §5, D8) — the `serving` advertisement + the placement-ready
// descriptor. `serving` rides the SAME open capabilities[] axis as `compute`
// and `roaming` (no new row field); reach coordinates (sshAlias/transport)
// and reachability (health) already exist on every row. placementDescriptor
// is the small helper a future scheduler reads: reachable? serving? — never
// a display-only chip, and deliberately WITHOUT `headroom` (Horizon-2 only).
describe("placementDescriptor — AC1/AC2 (#1341): a placement-ready fact, not a display chip", () => {
  it("a row advertising `serving` with health=reachable reads back serving:true, reachable:true", () => {
    const advertising: RosterRow = { ...ROW, capabilities: ["serving"], health: "reachable" };
    const d = placementDescriptor(advertising);
    expect(d.serving).toBe(true);
    expect(d.reachable).toBe(true);
  });

  it("a row WITHOUT `serving` in capabilities reads back serving:false, regardless of health", () => {
    const notAdvertising: RosterRow = { ...ROW, capabilities: ["compute"], health: "reachable" };
    expect(placementDescriptor(notAdvertising).serving).toBe(false);
  });

  it("reachable derives from health OUTSIDE the reachable state — degraded and down both read reachable:false", () => {
    expect(placementDescriptor({ ...ROW, capabilities: ["serving"], health: "degraded" }).reachable).toBe(false);
    expect(placementDescriptor({ ...ROW, capabilities: ["serving"], health: "down" }).reachable).toBe(false);
  });

  it("carries the row's existing reach coordinates (sshAlias, transport, machine_id) through unchanged", () => {
    const row: RosterRow = { ...ROW, capabilities: ["serving"], sshAlias: "keeper-host", transport: "ssh" };
    const d = placementDescriptor(row);
    expect(d.machine_id).toBe(row.machine_id);
    expect(d.sshAlias).toBe("keeper-host");
    expect(d.transport).toBe("ssh");
  });

  it("NEVER carries a `headroom` field — Horizon-2 only, not asserted in H1 (D8)", () => {
    const d = placementDescriptor({ ...ROW, capabilities: ["serving"] });
    expect(Object.prototype.hasOwnProperty.call(d, "headroom")).toBe(false);
    expect(Object.keys(d).sort()).toEqual(["machine_id", "reachable", "serving", "sshAlias", "transport"]);
  });

  it("is a pure read off the row — two calls on an unmodified row produce equal descriptors", () => {
    const row: RosterRow = { ...ROW, capabilities: ["serving", "compute"] };
    expect(placementDescriptor(row)).toEqual(placementDescriptor(row));
  });
});

// ── the shared device-identity classifiers (#1371 / #1368, ADR 0028) ─────────
// The PURE core of a machine's self-report: mapping the OS's raw name/form-factor
// strings to the `device_type` vocabulary + a friendly display name. Rehomed
// here so the enroll producer (amico-run) and the extension host self-row share
// ONE derivation and cannot drift. Every function is string-in/value-out — no
// child_process, no fs — so it is unit-testable on any OS.
describe("classifyMacModel — the rehomed macOS Model-Name classifier (#1371 AC1)", () => {
  it("maps every MacBook Model Name to `laptop`", () => {
    for (const model of ["MacBook Pro", "MacBook Air", "MacBook"]) {
      expect(classifyMacModel(model)).toBe("laptop");
    }
  });

  it("maps the desktop-form Macs (iMac, Mac mini, Mac Studio, Mac Pro) to `desktop`", () => {
    for (const model of ["iMac", "Mac mini", "Mac Studio", "Mac Pro"]) {
      expect(classifyMacModel(model)).toBe("desktop");
    }
  });

  it("is case- and whitespace-tolerant (the value comes off a `system_profiler` line)", () => {
    expect(classifyMacModel("  macbook pro  ")).toBe("laptop");
    expect(classifyMacModel("MAC STUDIO")).toBe("desktop");
  });

  it("abstains (undefined) on an unrecognized or empty Model Name — never a guess", () => {
    for (const model of ["Some Future Device", "", "   ", "Xserve"]) {
      expect(classifyMacModel(model)).toBeUndefined();
    }
  });

  it("only returns values in the KNOWN_DEVICE_TYPES vocabulary (or undefined)", () => {
    const out = ["MacBook Pro", "Mac Studio", "nonsense"].map(classifyMacModel);
    for (const v of out) {
      expect(v === undefined || (KNOWN_DEVICE_TYPES as readonly string[]).includes(v)).toBe(true);
    }
  });
});

describe("classifyLinuxChassis — the hostnamectl/DMI chassis classifier (#1371 AC2)", () => {
  const table: [string, string | undefined][] = [
    ["laptop", "laptop"],
    ["notebook", "laptop"],
    ["portable", "laptop"],
    ["desktop", "desktop"],
    ["tower", "desktop"],
    ["server", "server"],
    ["rack", "server"],
    ["convertible", undefined],
    ["handset", undefined],
    ["vm", undefined],
    ["", undefined],
  ];
  for (const [chassis, expected] of table) {
    it(`maps chassis "${chassis}" → ${expected ?? "undefined"}`, () => {
      expect(classifyLinuxChassis(chassis)).toBe(expected);
    });
  }

  it("is case-insensitive", () => {
    expect(classifyLinuxChassis("Laptop")).toBe("laptop");
    expect(classifyLinuxChassis("SERVER")).toBe("server");
  });
});

describe("normalizeDeviceName — the friendly-name prettifier (#1371 AC3)", () => {
  const table: [string, string][] = [
    ["Mac.mynetworksettings.com", "Mac"],
    ["host.local", "host"],
    ["JJ's Mac Studio", "JJ's Mac Studio"],
    ["", ""],
    ["workbench", "workbench"],
    ["JVs-MacBook-Pro.local", "JVs-MacBook-Pro"],
  ];
  for (const [raw, expected] of table) {
    it(`normalizes ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeDeviceName(raw)).toBe(expected);
    });
  }

  it("leaves a space-bearing name intact even if it carries a dot (a human display name, not a hostname)", () => {
    expect(normalizeDeviceName("JJ's Mac Studio")).toBe("JJ's Mac Studio");
    expect(normalizeDeviceName("Conf Room 3.5")).toBe("Conf Room 3.5");
  });
});

describe("isWslKernel — the pure /proc/version WSL detector (#1371 AC4)", () => {
  it("is true for a Microsoft/WSL marker in the kernel string", () => {
    expect(isWslKernel("Linux version 5.15.90.1-microsoft-standard-WSL2")).toBe(true);
    expect(isWslKernel("... Microsoft ...")).toBe(true);
    expect(isWslKernel("something WSL2 something")).toBe(true);
  });

  it("is false for a native Linux kernel or empty input", () => {
    expect(isWslKernel("Linux version 6.8.0-generic (buildd@lcy02) ...")).toBe(false);
    expect(isWslKernel("")).toBe(false);
  });
});
