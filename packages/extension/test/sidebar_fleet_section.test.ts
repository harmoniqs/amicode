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
});
