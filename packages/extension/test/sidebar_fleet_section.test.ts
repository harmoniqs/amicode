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
import { buildFleetSectionModel, renderFleetSection } from "../src/sidebar_fleet_section";
import type { FleetSectionModel } from "../src/sidebar_fleet_section";

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

  it("resolves the type-pill label from device_type when the row reports one (#1359)", () => {
    const model = buildFleetSectionModel({
      roster: [row({ device_type: "laptop" })],
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
    });
    expect(model.devices[0].typeLabel).toBe("laptop");
  });

  it("falls back the type-pill label to server_mode when device_type is absent (#1359)", () => {
    const model = buildFleetSectionModel({
      roster: [row({ server_mode: "client" })], // no device_type in this row
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
    });
    expect(model.devices[0].typeLabel).toBe("client");
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

  it("synthesizes a self-row from localDevice when the roster has none for this machine (#1359)", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    });
    expect(model.state).toBe("populated");
    expect(model.devices).toHaveLength(1);
    expect(model.devices[0].machineId).toBe("this-mac");
    expect(model.devices[0].name).toBe("Mac");
    expect(model.devices[0].typeLabel).toBe("server"); // no deviceType → falls back to serveStance
    expect(model.devices[0].health).toBe("reachable"); // you can always see yourself
  });

  it("does not duplicate the self-row when the roster already carries this machine (#1359)", () => {
    const model = buildFleetSectionModel({
      roster: [row({ machine_id: "this-mac", name: "Real Report", health: "degraded" })],
      rosterReachable: true, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Local Guess", serveStance: "server", deviceType: undefined },
    });
    expect(model.devices).toHaveLength(1);
    // the roster's own report wins — it's real provenance, not a guess.
    expect(model.devices[0].name).toBe("Real Report");
    expect(model.devices[0].health).toBe("degraded");
    expect(model.devices[0].isLocal).toBe(true);
  });

  it("the local machine always renders first, even when the roster lists it after peers (#1359)", () => {
    const model = buildFleetSectionModel({
      roster: [
        row({ machine_id: "peer-a", name: "Alpha" }),
        row({ machine_id: "peer-b", name: "Beta" }),
        row({ machine_id: "this-mac", name: "Me" }),
      ],
      rosterReachable: true, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Me", serveStance: "server", deviceType: undefined },
    });
    expect(model.devices).toHaveLength(3);
    expect(model.devices[0].machineId).toBe("this-mac");
    expect(model.devices[0].isLocal).toBe(true);
    expect(model.devices[1].machineId).toBe("peer-a");
    expect(model.devices[2].machineId).toBe("peer-b");
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

  it("still shows the self-row when the peer roster is unreachable but local identity is known (#1359)", () => {
    // The peer roster being down says nothing about local truth — this
    // machine's own identity comes from fleet.json/config, not that read.
    const model = buildFleetSectionModel({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    });
    expect(model.state).toBe("unreachable"); // the peer read genuinely failed — still say so
    expect(model.devices).toHaveLength(1); // but you still see yourself
    expect(model.devices[0].machineId).toBe("this-mac");
  });
});

describe("buildFleetSectionModel — not registered with a fleet (#1359)", () => {
  it("collapses to the 'standalone' state when this machine has no fleet.json (serveStance standalone)", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    });
    expect(model.state).toBe("standalone");
    expect(model.devices).toEqual([]);
  });

  it("standalone collapse takes priority even if the (irrelevant) peer roster is unreachable", () => {
    const model = buildFleetSectionModel({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false, posture: null, manageAvailable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    });
    expect(model.state).toBe("standalone");
    expect(model.devices).toEqual([]);
  });
});

// ── renderFleetSection (DOM) ─────────────────────────────────────────────────

function populatedModel(over: Partial<FleetSectionModel> = {}): FleetSectionModel {
  return buildFleetSectionModel({
    roster: [{
      machine_id: "mac-studio-01", name: "Mac Studio", server_mode: "server",
      capabilities: ["compute", "gpu-rig"], last_report: "2026-09-20T12:00:00.000Z", health: "degraded",
    }],
    rosterReachable: true,
    posture: { serverMode: "server", hostname: "mac-studio-01", mode: "fleet", reachable: true, hub: { name: "hub", base_url: "u" } },
    manageAvailable: true,
    ...(over as any),
  });
}

describe("renderFleetSection — per-device rows + posture badge (AC1, AC2)", () => {
  it("renders one row per device: a status dot, the name, and a type pill (#1359)", () => {
    const el = document.createElement("div");
    renderFleetSection(el, populatedModel(), () => {});

    const rows = el.querySelectorAll(".fleet-device-row");
    expect(rows).toHaveLength(1);
    const r = rows[0] as HTMLElement;
    expect(r.getAttribute("data-machine-id")).toBe("mac-studio-01");
    expect(r.querySelector(".fleet-device-name")!.textContent).toContain("Mac Studio");

    // left: a status dot, keyed on data-health (color is never the only
    // signal — an aria-label carries the same tri-state for a11y).
    const dot = r.querySelector(".fleet-status-dot")!;
    expect(dot.getAttribute("data-health")).toBe("degraded");
    expect(dot.getAttribute("aria-label")).toBe("degraded");

    // right: the type pill (device_type when set, else server_mode — here unset).
    const pill = r.querySelector(".fleet-type-pill")!;
    expect(pill.textContent).toBe("server");

    // role / capabilities / last-seen move to the row's tooltip, not inline text.
    expect(r.querySelector(".fleet-device-role")).toBeNull();
    expect(r.querySelector(".fleet-cap-chip")).toBeNull();
    expect(r.querySelector(".fleet-last-seen")).toBeNull();
    const title = r.getAttribute("title") ?? "";
    expect(title).toContain("server");
    expect(title).toContain("2026-09-20T12:00:00.000Z");
    expect(title).toContain("compute");
    expect(title).toContain("gpu-rig");
  });

  it("the posture badge is retired — no longer rendered in the sidebar (#1359)", () => {
    const el = document.createElement("div");
    renderFleetSection(el, populatedModel(), () => {});
    expect(el.querySelector(".fleet-posture-badge")).toBeNull();
  });
});

describe("renderFleetSection — honest empty / unreachable DOM (AC6)", () => {
  it("empty roster renders an honest empty state, no device rows", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel({ roster: [], rosterReachable: true, posture: null, manageAvailable: true });
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-empty")).not.toBeNull();
    expect(el.querySelectorAll(".fleet-device-row")).toHaveLength(0);
    // never a spinner / loading affordance.
    expect(el.querySelector(".fleet-loading, .spinner")).toBeNull();
  });

  it("unreachable roster (host down) renders an honest degraded state, no fabricated rows", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel({ roster: [], rosterReachable: false, posture: null, manageAvailable: true });
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-unreachable")).not.toBeNull();
    expect(el.querySelectorAll(".fleet-device-row")).toHaveLength(0);
    expect(el.querySelector(".fleet-loading, .spinner")).toBeNull();
  });

  it("unreachable roster still renders the self-row when local identity is known (#1359)", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: false, posture: null, manageAvailable: true,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    });
    renderFleetSection(el, model, () => {});
    // the honest notice stays — the PEER roster really is unreachable.
    expect(el.querySelector(".fleet-unreachable")).not.toBeNull();
    // but you still see yourself, right there in the list.
    const rows = el.querySelectorAll(".fleet-device-row");
    expect(rows).toHaveLength(1);
    expect((rows[0] as HTMLElement).getAttribute("data-machine-id")).toBe("this-mac");
  });

  it("no fleet.json (standalone) renders the single honest line, no device rows (#1359)", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, manageAvailable: true,
      posture: { serverMode: "standalone", hostname: "h", mode: "standalone", reachable: false, hub: { name: null, base_url: null } },
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    });
    renderFleetSection(el, model, () => {});
    expect(el.querySelectorAll(".fleet-device-row")).toHaveLength(0);
    const notice = el.querySelector(".fleet-standalone");
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toBe("Current device not registered with a fleet.");
  });
});

describe("renderFleetSection — read-only navigation contract (AC3, AC4)", () => {
  it("clicking an enabled Manage posts EXACTLY the open-fleet-manager navigation and nothing else", () => {
    const el = document.createElement("div");
    const post = vi.fn();
    renderFleetSection(el, populatedModel({ manage: { enabled: true } } as any), post);
    const manage = el.querySelector(".fleet-manage") as HTMLButtonElement;
    manage.click();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ kind: "open-fleet-manager" });
    // read-only: no other message kind is ever emitted by the section.
    for (const call of post.mock.calls) {
      expect((call[0] as { kind: string }).kind).toBe("open-fleet-manager");
    }
  });

  it("honest degrade — Manage is not rendered at all when the Fleet Manager tab is absent (#1359)", () => {
    const el = document.createElement("div");
    const post = vi.fn();
    // manageAvailable:false ⇒ #1322 not present on this branch.
    const model = buildFleetSectionModel({
      roster: [{ machine_id: "a", name: "A", server_mode: "server", capabilities: [], last_report: "t", health: "reachable" }],
      rosterReachable: true, posture: null, manageAvailable: false,
    });
    renderFleetSection(el, model, post);
    // no dead click — nothing to click at all, not merely a disabled control.
    expect(el.querySelector(".fleet-manage")).toBeNull();
  });
});
