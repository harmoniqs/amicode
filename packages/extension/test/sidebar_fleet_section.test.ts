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
import {
  buildFleetSectionModel,
  renderFleetSection,
  effectiveHealth,
  formatAge,
  displayRole,
  DEGRADED_AGE_MS,
  DOWN_AGE_MS,
} from "../src/sidebar_fleet_section";
import type { FleetSectionModel, RosterHealth } from "../src/sidebar_fleet_section";

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

/** Default FleetSectionInput with only the fields you want to override.
 *  `now` is pinned to the test row's `last_report` so effectiveHealth sees
 *  0 age and existing assertions pass unchanged (#1375). */
function input(over: Record<string, unknown> = {}) {
  return {
    roster: [] as ReturnType<typeof row>[],
    rosterReachable: true,
    posture: null,
    manageAvailable: false,
    troubleshootAvailable: false,
    now: Date.parse("2026-09-20T12:00:00.000Z"),
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
    // server_mode is surfaced under the "role" label — a non-hub server
    // displays as "peer" (#1394, ADR 0029).
    expect(alpha.role).toBe("peer");
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
    now: Date.parse("2026-09-20T12:00:00.000Z"),
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

    // right: the type pill (device_type when set, else displayRole — here
    // unset device_type + non-hub server → "peer", #1394).
    const pill = r.querySelector(".fleet-type-pill")!;
    expect(pill.textContent).toBe("peer");

    // role / capabilities / last-seen move to the row's tooltip, not inline text.
    expect(r.querySelector(".fleet-device-role")).toBeNull();
    expect(r.querySelector(".fleet-cap-chip")).toBeNull();
    expect(r.querySelector(".fleet-last-seen")).toBeNull();
    const title = r.getAttribute("title") ?? "";
    expect(title).toContain("role: peer");
    // #1375: tooltip shows relative age ("just now") via formatAge, not raw ISO.
    expect(title).toContain("just now");
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

// ── #1372 (ADR 0028) — both views render the server exactly ONCE ──────────────
describe("buildFleetSectionModel — server self-registration collapses to one row (#1372)", () => {
  it("AC3: a CLIENT renders exactly one server row after the server self-registers (keyed canonical.host)", () => {
    // The server now self-registers a real roster row keyed by canonical.host;
    // the client's synthesized canonical-server node (same key) must collapse —
    // ZERO client-side change, just the producer keying its row correctly.
    const model = buildFleetSectionModel(input({
      roster: [row({ machine_id: "Mac.mynetworksettings.com", name: "JJ's Mac Studio", server_mode: "server", device_type: "desktop" })],
      localDevice: { machineId: "jvs-macbook.local", name: "JV's MacBook", serveStance: "client", deviceType: "laptop" },
      canonicalServer: { machineId: "Mac.mynetworksettings.com", name: "Mac.mynetworksettings.com" },
    }));
    const serverRows = model.devices.filter((d) => d.machineId === "Mac.mynetworksettings.com");
    expect(serverRows).toHaveLength(1);
    // it's the REAL roster row (friendly name + type), not the raw synthesized node
    expect(serverRows[0].name).toBe("JJ's Mac Studio");
    expect(serverRows[0].typeLabel).toBe("desktop");
    expect(serverRows[0].isLocal).toBe(false); // the server is a peer to this client
  });

  it("AC4: the SERVER renders exactly one self-row when canonical.host ≠ hostname()", () => {
    // The server's posted row is keyed canonical.host; its self-row identity is
    // reconciled to the SAME key (readLocalDevice on a server → canonical.host),
    // so the roster row is marked isLocal and no second self-row is synthesized.
    const model = buildFleetSectionModel(input({
      roster: [row({ machine_id: "Mac.mynetworksettings.com", name: "JJ's Mac Studio", server_mode: "server", device_type: "desktop" })],
      localDevice: { machineId: "Mac.mynetworksettings.com", name: "JJ's Mac Studio", serveStance: "server", deviceType: "desktop" },
      canonicalServer: null, // a server has no canonical to synthesize — it IS the server
    }));
    const serverRows = model.devices.filter((d) => d.machineId === "Mac.mynetworksettings.com");
    expect(serverRows).toHaveLength(1);
    expect(serverRows[0].isLocal).toBe(true); // the roster row IS the self-row (collapsed)
  });
});

// ── #1375: staleness-derived display health ──────────────────────────────────

describe("effectiveHealth — staleness-derived display health (#1375)", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("reachable + fresh (< DEGRADED_AGE_MS) → reachable", () => {
    const fresh = new Date(NOW - 30_000).toISOString(); // 30s ago
    expect(effectiveHealth("reachable", fresh, NOW)).toBe("reachable");
  });

  it("reachable + stale (>= DEGRADED_AGE_MS, < DOWN_AGE_MS) → degraded", () => {
    const stale = new Date(NOW - 200_000).toISOString(); // 200s (~3.3min)
    expect(effectiveHealth("reachable", stale, NOW)).toBe("degraded");
  });

  it("reachable + very stale (>= DOWN_AGE_MS) → down", () => {
    const old = new Date(NOW - 400_000).toISOString(); // 400s (~6.7min)
    expect(effectiveHealth("reachable", old, NOW)).toBe("down");
  });

  it("degraded from enrollment + any age → degraded (unchanged)", () => {
    const old = new Date(NOW - 999_999).toISOString();
    expect(effectiveHealth("degraded", old, NOW)).toBe("degraded");
  });

  it("down from enrollment + any age → down (unchanged)", () => {
    const fresh = new Date(NOW - 1_000).toISOString();
    expect(effectiveHealth("down", fresh, NOW)).toBe("down");
  });

  it("reachable + unparseable lastSeen → reachable (trust raw)", () => {
    expect(effectiveHealth("reachable", "not-a-date", NOW)).toBe("reachable");
  });

  it("reachable + future timestamp → reachable (trust raw)", () => {
    const future = new Date(NOW + 60_000).toISOString();
    expect(effectiveHealth("reachable", future, NOW)).toBe("reachable");
  });

  it("reachable + exactly at DEGRADED_AGE_MS boundary → degraded", () => {
    const exact = new Date(NOW - DEGRADED_AGE_MS).toISOString();
    expect(effectiveHealth("reachable", exact, NOW)).toBe("degraded");
  });

  it("reachable + exactly at DOWN_AGE_MS boundary → down", () => {
    const exact = new Date(NOW - DOWN_AGE_MS).toISOString();
    expect(effectiveHealth("reachable", exact, NOW)).toBe("down");
  });
});

describe("formatAge", () => {
  it("<5s → 'just now'", () => {
    expect(formatAge(3_000)).toBe("just now");
  });

  it("30s → '30s ago'", () => {
    expect(formatAge(30_000)).toBe("30s ago");
  });

  it("90s → '1m ago'", () => {
    expect(formatAge(90_000)).toBe("1m ago");
  });

  it("300s → '5m ago'", () => {
    expect(formatAge(300_000)).toBe("5m ago");
  });

  it("negative → 'just now'", () => {
    expect(formatAge(-1000)).toBe("just now");
  });
});

describe("buildFleetSectionModel — staleness integration (#1375)", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("maps a roster row through effectiveHealth (fresh → reachable)", () => {
    const freshReport = new Date(NOW - 10_000).toISOString();
    const model = buildFleetSectionModel(input({
      roster: [row({ last_report: freshReport, health: "reachable" })],
      now: NOW,
    }));
    expect(model.devices[0].health).toBe("reachable");
  });

  it("maps a roster row through effectiveHealth (stale → degraded)", () => {
    const staleReport = new Date(NOW - 200_000).toISOString();
    const model = buildFleetSectionModel(input({
      roster: [row({ last_report: staleReport, health: "reachable" })],
      now: NOW,
    }));
    expect(model.devices[0].health).toBe("degraded");
    // rosterHealth carries the raw enrollment health
    expect(model.devices[0].rosterHealth).toBe("reachable");
  });

  it("carries `now` through to the model", () => {
    const model = buildFleetSectionModel(input({ now: NOW }));
    expect(model.now).toBe(NOW);
  });

  it("self-row is EXEMPT from staleness (always reachable)", () => {
    const model = buildFleetSectionModel(input({
      localDevice: { machineId: "me", name: "Me", serveStance: "server", deviceType: undefined },
      now: NOW,
    }));
    expect(model.devices[0].health).toBe("reachable");
  });

  it("synthesized canonical-server row is EXEMPT from staleness", () => {
    const model = buildFleetSectionModel(input({
      roster: [],
      localDevice: { machineId: "laptop", name: "Laptop", serveStance: "client", deviceType: "laptop" },
      canonicalServer: { machineId: "server-01", name: "Server" },
      now: NOW,
    }));
    const server = model.devices.find((d) => d.machineId === "server-01");
    expect(server!.health).toBe("reachable"); // from reachable roster, not staleness-derived
  });
});

describe("renderFleetSection — enhanced tooltip with staleness (#1375)", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");

  it("tooltip shows relative age via formatAge when now is available", () => {
    const report = new Date(NOW - 90_000).toISOString(); // 1.5 min ago
    const model = buildFleetSectionModel({
      roster: [{ machine_id: "a", name: "A", server_mode: "server", capabilities: [], last_report: report, health: "reachable" }],
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
      troubleshootAvailable: false,
      now: NOW,
    });
    const el = document.createElement("div");
    renderFleetSection(el, model, () => {});
    const row = el.querySelector(".fleet-device-row") as HTMLElement;
    expect(row.title).toContain("1m ago");
  });

  it("tooltip annotates staleness-degraded health: 'degraded (no heartbeat)'", () => {
    const stale = new Date(NOW - 200_000).toISOString(); // > 3min → degraded
    const model = buildFleetSectionModel({
      roster: [{ machine_id: "a", name: "A", server_mode: "server", capabilities: [], last_report: stale, health: "reachable" }],
      rosterReachable: true,
      posture: null,
      manageAvailable: false,
      troubleshootAvailable: false,
      now: NOW,
    });
    const el = document.createElement("div");
    renderFleetSection(el, model, () => {});
    const row = el.querySelector(".fleet-device-row") as HTMLElement;
    expect(row.title).toContain("degraded (no heartbeat)");
  });
});

describe("displayRole — peer label for non-hub servers (#1394, ADR 0029)", () => {
  it("maps server to peer when not the canonical hub", () => {
    expect(displayRole("server", false)).toBe("peer");
  });
  it("keeps server for the canonical hub", () => {
    expect(displayRole("server", true)).toBe("server");
  });
  it("passes client through unchanged", () => {
    expect(displayRole("client", false)).toBe("client");
  });
  it("passes standalone through unchanged", () => {
    expect(displayRole("standalone", false)).toBe("standalone");
  });
});
