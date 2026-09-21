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

/** Default FleetSectionInput with only the fields you want to override. */
function input(over: Record<string, unknown> = {}) {
  return {
    roster: [] as ReturnType<typeof row>[],
    rosterReachable: true,
    posture: null,
    manageAvailable: false,
    troubleshootAvailable: false,
    ...over,
  };
}

describe("buildFleetSectionModel — per-device rows (AC1)", () => {
  it("renders one row per roster device with name, role, health, last-seen", () => {
    const model = buildFleetSectionModel(input({
      roster: [row({ machine_id: "a", name: "Alpha" }), row({ machine_id: "b", name: "Beta" })],
    }));
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
    const model = buildFleetSectionModel(input({
      roster: [row({ capabilities: ["compute", "roaming", "gpu-rig"] })],
    }));
    const chips = model.devices[0].capabilities;
    expect(chips).toEqual([
      { tag: "compute", known: true },
      { tag: "roaming", known: true },
      { tag: "gpu-rig", known: false }, // an arbitrary descriptive tag round-trips, marked not-known
    ]);
  });

  it("resolves the type-pill label from device_type when the row reports one (#1359)", () => {
    const model = buildFleetSectionModel(input({
      roster: [row({ device_type: "laptop" })],
    }));
    expect(model.devices[0].typeLabel).toBe("laptop");
  });

  it("falls back the type-pill label to server_mode when device_type is absent (#1359)", () => {
    const model = buildFleetSectionModel(input({
      roster: [row({ server_mode: "client" })], // no device_type in this row
    }));
    expect(model.devices[0].typeLabel).toBe("client");
  });
});

describe("buildFleetSectionModel — this machine's posture badge (AC2)", () => {
  it("derives the posture badge from Server mode + link-health", () => {
    const model = buildFleetSectionModel(input({
      roster: [row()],
      posture: {
        serverMode: "server",
        hostname: "mac-studio-01",
        mode: "fleet",
        reachable: true,
        hub: { name: "hub", base_url: "http://hub:43117" },
      },
    }));
    expect(model.posture).not.toBeNull();
    expect(model.posture!.serverMode).toBe("server");
    expect(model.posture!.hostname).toBe("mac-studio-01");
    // link-health folds the attach posture: fleet+reachable → ok.
    expect(model.posture!.linkHealth).toBe("ok");
    expect(model.posture!.hub).toEqual({ name: "hub", base_url: "http://hub:43117" });
  });

  it("maps the degraded attach posture to a degraded link-health (not down)", () => {
    const model = buildFleetSectionModel(input({
      posture: { serverMode: "client", hostname: "h", mode: "degraded", reachable: true, hub: { name: null, base_url: null } },
    }));
    expect(model.posture!.linkHealth).toBe("degraded");
  });

  it("maps the standalone / unreachable posture to a down link-health", () => {
    const model = buildFleetSectionModel(input({
      posture: { serverMode: "standalone", hostname: "h", mode: "standalone", reachable: false, hub: { name: null, base_url: null } },
    }));
    expect(model.posture!.linkHealth).toBe("down");
  });

  it("carries a null posture badge when posture is unknown (never fabricated)", () => {
    const model = buildFleetSectionModel(input({ roster: [row()] }));
    expect(model.posture).toBeNull();
  });
});

describe("buildFleetSectionModel — honest empty / unreachable state (AC6)", () => {
  it("resolves an empty-but-reachable roster to the 'empty' state, no devices", () => {
    const model = buildFleetSectionModel(input());
    expect(model.state).toBe("empty");
    expect(model.devices).toEqual([]);
  });

  it("synthesizes a self-row from localDevice when the roster has none for this machine (#1359)", () => {
    const model = buildFleetSectionModel(input({
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    }));
    expect(model.state).toBe("populated");
    expect(model.devices).toHaveLength(1);
    expect(model.devices[0].machineId).toBe("this-mac");
    expect(model.devices[0].name).toBe("Mac");
    expect(model.devices[0].typeLabel).toBe("server"); // no deviceType → falls back to serveStance
    expect(model.devices[0].health).toBe("reachable"); // you can always see yourself
  });

  it("does not duplicate the self-row when the roster already carries this machine (#1359)", () => {
    const model = buildFleetSectionModel(input({
      roster: [row({ machine_id: "this-mac", name: "Real Report", health: "degraded" })],
      localDevice: { machineId: "this-mac", name: "Local Guess", serveStance: "server", deviceType: undefined },
    }));
    expect(model.devices).toHaveLength(1);
    // the roster's own report wins — it's real provenance, not a guess.
    expect(model.devices[0].name).toBe("Real Report");
    expect(model.devices[0].health).toBe("degraded");
    expect(model.devices[0].isLocal).toBe(true);
  });

  it("the local machine always renders first, even when the roster lists it after peers (#1359)", () => {
    const model = buildFleetSectionModel(input({
      roster: [
        row({ machine_id: "peer-a", name: "Alpha" }),
        row({ machine_id: "peer-b", name: "Beta" }),
        row({ machine_id: "this-mac", name: "Me" }),
      ],
      localDevice: { machineId: "this-mac", name: "Me", serveStance: "server", deviceType: undefined },
    }));
    expect(model.devices).toHaveLength(3);
    expect(model.devices[0].machineId).toBe("this-mac");
    expect(model.devices[0].isLocal).toBe(true);
    expect(model.devices[1].machineId).toBe("peer-a");
    expect(model.devices[2].machineId).toBe("peer-b");
  });
  it("resolves an unreachable roster (host down) to the 'unreachable' state", () => {
    const model = buildFleetSectionModel(input({ rosterReachable: false }));
    expect(model.state).toBe("unreachable");
    expect(model.devices).toEqual([]);
  });

  it("never fabricates a device list when unreachable — a stale roster is dropped", () => {
    const model = buildFleetSectionModel(input({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false,
    }));
    expect(model.state).toBe("unreachable");
    expect(model.devices).toEqual([]);
  });

  it("still shows the self-row when the peer roster is unreachable but local identity is known (#1359)", () => {
    const model = buildFleetSectionModel(input({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    }));
    expect(model.state).toBe("unreachable");
    expect(model.devices).toHaveLength(1);
    expect(model.devices[0].machineId).toBe("this-mac");
  });
});

describe("buildFleetSectionModel — not registered with a fleet (#1359)", () => {
  it("collapses to the 'standalone' state when this machine has no fleet.json (serveStance standalone)", () => {
    const model = buildFleetSectionModel(input({
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    }));
    expect(model.state).toBe("standalone");
    expect(model.devices).toEqual([]);
  });

  it("standalone collapse takes priority even if the (irrelevant) peer roster is unreachable", () => {
    const model = buildFleetSectionModel(input({
      roster: [row(), row({ machine_id: "b" })], rosterReachable: false,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    }));
    expect(model.state).toBe("standalone");
    expect(model.devices).toEqual([]);
  });
});

describe("buildFleetSectionModel — canonical-server synthesis on a client (#1363)", () => {
  it("synthesizes a server row from canonicalServer when the roster carries none for it", () => {
    const model = buildFleetSectionModel(input({
      roster: [],
      localDevice: { machineId: "laptop-01", name: "JJ's Laptop", serveStance: "client", deviceType: "laptop" },
      canonicalServer: { machineId: "jjs-mac-studio", name: "jjs-mac-studio" },
    }));
    expect(model.state).toBe("populated");
    const server = model.devices.find((d) => d.machineId === "jjs-mac-studio");
    expect(server).toBeDefined();
    expect(server!.role).toBe("server");        // the canonical node is the server
    expect(server!.isLocal).toBe(false);
    expect(server!.health).toBe("reachable");   // reachable roster ⇒ server reachable
  });

  it("does not duplicate the server row when the host roster already carries it", () => {
    const model = buildFleetSectionModel(input({
      roster: [row({ machine_id: "jjs-mac-studio", name: "Mac Studio", server_mode: "server" })],
      localDevice: { machineId: "laptop-01", name: "Laptop", serveStance: "client" },
      canonicalServer: { machineId: "jjs-mac-studio", name: "jjs-mac-studio" },
    }));
    const serverRows = model.devices.filter((d) => d.machineId === "jjs-mac-studio");
    expect(serverRows).toHaveLength(1);
  });

  it("does not synthesize a server row for the local machine (the server never doubles its own self-row)", () => {
    const model = buildFleetSectionModel(input({
      roster: [],
      localDevice: { machineId: "jjs-mac-studio", name: "Mac Studio", serveStance: "server" },
      canonicalServer: { machineId: "jjs-mac-studio", name: "jjs-mac-studio" },
    }));
    const serverRows = model.devices.filter((d) => d.machineId === "jjs-mac-studio");
    expect(serverRows).toHaveLength(1);
    expect(serverRows[0].isLocal).toBe(true);   // it's the self-row, not a synthesized peer
  });

  it("still shows the canonical server (as down) when the host roster is unreachable (#1359-style known fact)", () => {
    const model = buildFleetSectionModel(input({
      rosterReachable: false,
      localDevice: { machineId: "laptop-01", name: "Laptop", serveStance: "client" },
      canonicalServer: { machineId: "jjs-mac-studio", name: "jjs-mac-studio" },
    }));
    expect(model.state).toBe("unreachable");
    const server = model.devices.find((d) => d.machineId === "jjs-mac-studio");
    expect(server).toBeDefined();
    expect(server!.health).toBe("down");        // known to exist, but unreachable — never fabricated as healthy
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
    troubleshootAvailable: true,
    ...(over as any),
  });
}

describe("buildFleetSectionModel — action bar (manage + troubleshoot)", () => {
  it("enables both manage and troubleshoot when a fleet exists (populated)", () => {
    const model = buildFleetSectionModel({
      roster: [row()], rosterReachable: true, posture: null,
      manageAvailable: true, troubleshootAvailable: true,
    });
    expect(model.manage.enabled).toBe(true);
    expect(model.troubleshoot.enabled).toBe(true);
  });

  it("enables troubleshoot for empty and unreachable states (fleet exists, just no devices)", () => {
    const empty = buildFleetSectionModel({
      roster: [], rosterReachable: true, posture: null,
      manageAvailable: true, troubleshootAvailable: true,
    });
    expect(empty.troubleshoot.enabled).toBe(true);

    const unreachable = buildFleetSectionModel({
      roster: [], rosterReachable: false, posture: null,
      manageAvailable: true, troubleshootAvailable: true,
    });
    expect(unreachable.troubleshoot.enabled).toBe(true);
  });

  it("disables troubleshoot for the standalone state (no fleet to troubleshoot)", () => {
    const model = buildFleetSectionModel({
      roster: [], rosterReachable: true, posture: null,
      manageAvailable: true, troubleshootAvailable: true,
      localDevice: { machineId: "m", name: "M", serveStance: "standalone", deviceType: undefined },
    });
    expect(model.troubleshoot.enabled).toBe(false);
  });

  it("disables troubleshoot when the host says troubleshootAvailable is false", () => {
    const model = buildFleetSectionModel({
      roster: [row()], rosterReachable: true, posture: null,
      manageAvailable: true, troubleshootAvailable: false,
    });
    expect(model.troubleshoot.enabled).toBe(false);
  });
});

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
    const model = buildFleetSectionModel(input({ manageAvailable: true, troubleshootAvailable: true }));
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-empty")).not.toBeNull();
    expect(el.querySelectorAll(".fleet-device-row")).toHaveLength(0);
    // never a spinner / loading affordance.
    expect(el.querySelector(".fleet-loading, .spinner")).toBeNull();
  });

  it("unreachable roster (host down) renders an honest degraded state, no fabricated rows", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel(input({ rosterReachable: false, manageAvailable: true, troubleshootAvailable: true }));
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-unreachable")).not.toBeNull();
    expect(el.querySelectorAll(".fleet-device-row")).toHaveLength(0);
    expect(el.querySelector(".fleet-loading, .spinner")).toBeNull();
  });

  it("unreachable roster still renders the self-row when local identity is known (#1359)", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel(input({
      rosterReachable: false, manageAvailable: true, troubleshootAvailable: true,
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "server", deviceType: undefined },
    }));
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
    const model = buildFleetSectionModel(input({
      manageAvailable: true, troubleshootAvailable: true,
      posture: { serverMode: "standalone", hostname: "h", mode: "standalone", reachable: false, hub: { name: null, base_url: null } },
      localDevice: { machineId: "this-mac", name: "Mac", serveStance: "standalone", deviceType: undefined },
    }));
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
  });

  it("clicking the Troubleshoot button posts EXACTLY the troubleshoot-fleet message", () => {
    const el = document.createElement("div");
    const post = vi.fn();
    renderFleetSection(el, populatedModel(), post);
    const troubleshoot = el.querySelector(".fleet-troubleshoot") as HTMLButtonElement;
    troubleshoot.click();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ kind: "troubleshoot-fleet" });
  });

  it("honest degrade — Manage is not rendered at all when the Fleet Manager tab is absent (#1359)", () => {
    const el = document.createElement("div");
    const post = vi.fn();
    // manageAvailable:false ⇒ #1322 not present on this branch.
    const model = buildFleetSectionModel(input({
      roster: [{ machine_id: "a", name: "A", server_mode: "server", capabilities: [], last_report: "t", health: "reachable" }],
      manageAvailable: false, troubleshootAvailable: true,
    }));
    renderFleetSection(el, model, post);
    // no dead click — nothing to click at all, not merely a disabled control.
    expect(el.querySelector(".fleet-manage")).toBeNull();
    // but troubleshoot IS rendered (it has its own independent gate)
    expect(el.querySelector(".fleet-troubleshoot")).not.toBeNull();
  });

  it("the action bar renders at the top of the section, before the device list", () => {
    const el = document.createElement("div");
    renderFleetSection(el, populatedModel(), () => {});
    const children = Array.from(el.children);
    const barIdx = children.findIndex((c) => c.classList.contains("fleet-action-bar"));
    const listIdx = children.findIndex((c) => c.classList.contains("fleet-device-list"));
    expect(barIdx).toBeGreaterThanOrEqual(0);
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(barIdx).toBeLessThan(listIdx);
  });

  it("the action bar is absent entirely in standalone state", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel(input({
      manageAvailable: true, troubleshootAvailable: true,
      localDevice: { machineId: "m", name: "M", serveStance: "standalone", deviceType: undefined },
    }));
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-action-bar")).toBeNull();
  });

  it("the action bar is absent when both buttons are disabled", () => {
    const el = document.createElement("div");
    const model = buildFleetSectionModel(input({
      roster: [row()], manageAvailable: false, troubleshootAvailable: false,
    }));
    renderFleetSection(el, model, () => {});
    expect(el.querySelector(".fleet-action-bar")).toBeNull();
  });
});
