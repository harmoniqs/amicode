// @vitest-environment happy-dom
//
// #1321 — the slimmed, READ-ONLY sidebar fleet section. Two pure units under
// test, both browser-safe (node-import-free, like sidebar_bridge.ts):
//   - buildFleetSectionModel(): roster + posture → the view-model the webview
//     renders (role/last-seen labels, tri-state health, capability chips,
//     posture badge, honest empty/unreachable state, manage-enabled).
//   - renderFleetSection(): the view-model → DOM (rows, posture badge, the
//     single Manage affordance), and the read-only click contract.
import { describe, it, expect, vi } from "vitest";
import { buildFleetSectionModel } from "../src/sidebar_fleet_section";

// A lawful roster row (the #1318 / @amicode/schema RosterRow shape).
function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    machine_id: "mac-studio-01",
    name: "Mac Studio",
    server_mode: "server",
    capabilities: ["compute", "roaming"],
    sshAlias: "mac-studio",
    transport: "ssh",
    last_report: "2026-09-20T12:00:00.000Z",
    health: "reachable",
    ...over,
  };
}

describe("buildFleetSectionModel — per-device rows (AC1)", () => {
  it("renders one row per roster device with name, role, health, last-seen", () => {
    const model = buildFleetSectionModel({
      roster: [row({ machine_id: "a", name: "Alpha" }), row({ machine_id: "b", name: "Beta" })],
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
    });
    expect(model.state).toBe("populated");
    expect(model.devices).toHaveLength(2);
    const alpha = model.devices[0];
    expect(alpha.name).toBe("Alpha");
    // server_mode is surfaced under the "role" label — the value round-trips.
    expect(alpha.role).toBe("server");
    // last_report is surfaced under the "last-seen" label — the value round-trips.
    expect(alpha.lastSeen).toBe("2026-09-20T12:00:00.000Z");
    // the per-device reachability tri-state is carried verbatim.
    expect(alpha.health).toBe("reachable");
  });

  it("splits capability tags into known-behavior vs descriptive chips (AC1)", () => {
    const model = buildFleetSectionModel({
      roster: [row({ capabilities: ["compute", "roaming", "gpu-rig"] })],
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
    });
    const chips = model.devices[0].capabilities;
    expect(chips).toEqual([
      { tag: "compute", known: true },
      { tag: "roaming", known: true },
      { tag: "gpu-rig", known: false }, // an arbitrary descriptive tag round-trips, marked not-known
    ]);
  });
});

describe("buildFleetSectionModel — this machine's posture badge (AC2)", () => {
  it("derives the posture badge from Server mode + link-health", () => {
    const model = buildFleetSectionModel({
      roster: [row()],
      rosterReachable: true,
      posture: {
        serverMode: "server",
        hostname: "mac-studio-01",
        mode: "fleet",
        reachable: true,
        hub: { name: "hub", base_url: "http://hub:43117" },
      },
      manageAvailable: false,
    });
    expect(model.posture).not.toBeNull();
    expect(model.posture!.serverMode).toBe("server");
    expect(model.posture!.hostname).toBe("mac-studio-01");
    // link-health folds the attach posture: fleet+reachable → ok.
    expect(model.posture!.linkHealth).toBe("ok");
    expect(model.posture!.hub).toEqual({ name: "hub", base_url: "http://hub:43117" });
  });

  it("maps the degraded attach posture to a degraded link-health (not down)", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, manageAvailable: false,
      posture: { serverMode: "client", hostname: "h", mode: "degraded", reachable: true, hub: { name: null, base_url: null } },
    });
    expect(model.posture!.linkHealth).toBe("degraded");
  });

  it("maps the standalone / unreachable posture to a down link-health", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, manageAvailable: false,
      posture: { serverMode: "standalone", hostname: "h", mode: "standalone", reachable: false, hub: { name: null, base_url: null } },
    });
    expect(model.posture!.linkHealth).toBe("down");
  });

  it("carries a null posture badge when posture is unknown (never fabricated)", () => {
    const model = buildFleetSectionModel({
      roster: [row()], rosterReachable: true, posture: null, manageAvailable: false,
    });
    expect(model.posture).toBeNull();
  });
});

describe("buildFleetSectionModel — honest empty / unreachable state (AC6)", () => {
  it("resolves an empty-but-reachable roster to the 'empty' state, no devices", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, posture: null, manageAvailable: false,
    });
    expect(model.state).toBe("empty");
    expect(model.devices).toEqual([]);
  });

  it("resolves an unreachable roster (host down) to the 'unreachable' state", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: false, posture: null, manageAvailable: false,
    });
    expect(model.state).toBe("unreachable");
    expect(model.devices).toEqual([]);
  });

  it("never fabricates a device list when unreachable — a stale roster is dropped", () => {
    // Host down: even if a stale roster array is handed in, an unreachable read
    // must not render it as if live (no fabricated/stale list).
    const model = buildFleetSectionModel({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false, posture: null, manageAvailable: false,
    });
    expect(model.state).toBe("unreachable");
    expect(model.devices).toEqual([]);
  });
});
