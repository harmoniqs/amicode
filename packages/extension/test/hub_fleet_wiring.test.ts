// hub_fleet_wiring.test.ts — fix for the #1607 regression: on a role=server
// machine the app rides the launchd hub (amicode_service_runner), which called
// createAmicodeService WITHOUT fleet wiring — so /amicode/fleet/* (incl. the
// remote-create routes) 404'd on the server the app talks to. This helper is
// the pure decision: given the headless topology + a machine-id resolver, build
// the OBSERVATION-ONLY fleet the hub passes to createAmicodeService (mirroring
// amicode_service_wiring.ts:311-328), or undefined for a true standalone.
import { describe, it, expect } from "vitest";
import { buildHubFleetOption, type HubFleetDeps } from "../src/hub_fleet_wiring";

function deps(over?: Partial<HubFleetDeps>): HubFleetDeps {
  return {
    readTopology: () => ({ kind: "ok", role: "server", canonical: { host: "jjs-macbook-pro" } }),
    buildProvider: (localMachineId) => ({ __provider: true, localMachineId } as any),
    ...over,
  };
}

describe("#1607 fix — buildHubFleetOption (hub observation-only fleet)", () => {
  it("role=server with a canonical host → observation-only fleet with a provider", () => {
    const fleet = buildHubFleetOption(deps());
    expect(fleet).toBeDefined();
    expect(fleet!.observationOnly).toBe(true);
    expect(fleet!.hub.getUrl()).toBeUndefined();
    expect((fleet!.fleetPeers as any).localMachineId).toBe("jjs-macbook-pro");
  });

  it("role=standalone (no canonical host) → undefined (byte-identical base, H3 preserved)", () => {
    const fleet = buildHubFleetOption(deps({
      readTopology: () => ({ kind: "ok", role: "standalone" }),
    }));
    expect(fleet).toBeUndefined();
  });

  it("no machine id resolvable → undefined (never a fleet with an empty id)", () => {
    const fleet = buildHubFleetOption(deps({
      readTopology: () => ({ kind: "ok", role: "server", canonical: { host: "" } }),
    }));
    expect(fleet).toBeUndefined();
  });

  it("a client machine → undefined (a client relay is never a fleet hub server; baseStudioActivates would reject anyway)", () => {
    const fleet = buildHubFleetOption(deps({
      readTopology: () => ({ kind: "ok", role: "client", canonical: { host: "jjs-macbook-pro" } }),
    }));
    expect(fleet).toBeUndefined();
  });

  it("a topology read error → undefined (honest; never throws to the runner boot)", () => {
    const fleet = buildHubFleetOption(deps({
      readTopology: () => {
        throw new Error("no fleet.json");
      },
    }));
    expect(fleet).toBeUndefined();
  });

  it("builds the provider with the resolved machine id (the id flows through)", () => {
    let seen = "";
    buildHubFleetOption(deps({
      readTopology: () => ({ kind: "ok", role: "server", canonical: { host: "studio-host" } }),
      buildProvider: (id) => { seen = id; return { localMachineId: id } as any; },
    }));
    expect(seen).toBe("studio-host");
  });
});
