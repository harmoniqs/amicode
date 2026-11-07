// HUB FLEET WIRING (fix for the #1607 regression) — the pure decision that lets
// the launchd hub (amicode_service_runner) serve fleet routes.
//
// THE REGRESSION: #1607 Slice 1 (+ the #1576–#1581 "hub owns the engine"
// cutover) switched role=server machines to ride the launchd hub as the app's
// server. But the hub runner called createAmicodeService WITHOUT any fleet
// wiring ("byte-identical unarmed base service"), so /amicode/fleet/* — the
// N-peer sessions projection, the grant surface, AND the remote-create routes
// (#1643: creation-target / peer-home-base / peer-workspace) — all 404'd on the
// exact server the app talks to. Fleet features silently regressed on servers.
//
// THE FIX: the hub builds the SAME observation-only fleet the extension-host
// wiring builds (amicode_service_wiring.ts:311-328) and passes it to
// createAmicodeService, which mounts the fleet routes via baseStudioActivates
// (≥1 serving peer). observationOnly:true → NO hub proxy / multiplex / premium
// plane is attached; the hub only gains the local fleet READ + gate routes it
// must serve as the app's origin.
//
// GUARD (H3 preserved for true standalones): wire fleet ONLY when a machine id
// resolves from a server/standalone-with-canonical topology. A client relay,
// a standalone with no canonical host, or an unreadable topology → undefined →
// the hub stays the byte-identical unarmed base service.

import type { FleetTopologyState } from "./fleet_topology";
import type { FleetPeerProvider } from "./amicode_service/fleet_peer_provider";

/** The observation-only fleet option the hub passes to createAmicodeService. */
export interface HubFleetOption {
  fleetPeers: FleetPeerProvider;
  hub: { getUrl: () => string | undefined };
  observationOnly: true;
}

export interface HubFleetDeps {
  /** Read the fleet topology headlessly (readFleetTopology — reads fleet.json). */
  readTopology: () => FleetTopologyState;
  /** Build the fleet-peer provider for a resolved machine id
   *  (buildFleetPeerProvider — headless, reads roster + reader-token store). */
  buildProvider: (localMachineId: string) => FleetPeerProvider;
}

/** Resolve the hub's local machine id from the topology, headlessly. Mirrors
 *  extension.ts resolveLocalMachineId's server/standalone rule: canonical.host.
 *  A client relay is never a fleet server here (baseStudioActivates rejects it
 *  too); a missing/empty host is unresolvable. */
function resolveHubMachineId(state: FleetTopologyState): string | undefined {
  if (state.kind !== "ok") return undefined;
  if (state.role === "client") return undefined; // a relay is not a fleet hub server
  const host = state.canonical?.host;
  return typeof host === "string" && host.trim() !== "" ? host.trim() : undefined;
}

/** Build the hub's observation-only fleet option, or undefined to stay the
 *  byte-identical unarmed base service (true standalone / client / no id /
 *  unreadable topology). Never throws. */
export function buildHubFleetOption(deps: HubFleetDeps): HubFleetOption | undefined {
  let machineId: string | undefined;
  try {
    machineId = resolveHubMachineId(deps.readTopology());
  } catch {
    return undefined;
  }
  if (machineId === undefined) return undefined;
  return {
    fleetPeers: deps.buildProvider(machineId),
    hub: { getUrl: () => undefined },
    observationOnly: true,
  };
}
