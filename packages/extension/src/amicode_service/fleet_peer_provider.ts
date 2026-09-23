// THE PRODUCTION FLEET-PEER PROVIDER (#1446, W0 — root of the Fleet Studio
// wiring DAG). The three fleet-session features (the N-peer projection route,
// index.ts:474; the W1 session multiplexer; W2's production flip) all consume
// ONE peer set, in two shapes. Nothing in production assembled it: the roster
// (serving∧reachable rows), the reader peer-store (per-peer tokens), and the
// roster name/device_type lookup existed as separate readers but were never
// composed. This module IS that composition — the missing DAG root.
//
// Two projections of ONE peer set (the coupling the wiring deliberation
// surfaced): the 4-method provider object (getServingPeers/readPeerToken/
// rosterLookup + localMachineId), from which the fleet-sessions route derives
// its FleetPeerSource[] (index.ts:475); and the Record<string, PeerTransport>
// map the W1 multiplexer needs (session_multiplexer.ts:102). Both list the
// SAME machine_ids — they are two views of the same serving-peer set.
//
// W0 CONSTRUCTS this provider but does NOT assign it into opts.fleet.fleetPeers
// — that one-line production flip is W2's (#1447). `fleetPeers`-present is
// itself the gate (no feature flag), so leaving it unset keeps the legacy
// 2-source projection serving and production byte-identical.
//
// Reads are LATE per the fleet discipline: getServingPeers/rosterLookup read
// the roster afresh through the injected getter, and readPeerToken hits the
// reader peer-store each call, so a mid-session roster refresh or credential
// rotation is picked up — never a boot-time snapshot. A machine with no
// configured fleet (empty roster) yields no peers.
import type { RosterRow } from "@amicode/schema";
import { readPeerToken as readPeerTokenFromStore, type PeerTokenRead } from "./fleet_peer_store";
import { servingReachablePeers } from "./fleet_accept_set";
import { readRosterRows } from "./roster";
import type { PeerTransport } from "./session_multiplexer";
import type { RosterEntry } from "./merged_projection";

/** The 4-method provider object the fleet-sessions route (index.ts:474) and
 *  the W1 multiplexer both consume. A provider WITH METHODS — never a
 *  FleetPeerSource[] array (the seam shape the wiring deliberation fixed). */
export interface FleetPeerProvider {
  /** This machine's own stable id — the local source in the N-peer fan-out. */
  localMachineId: string;
  /** The serving∧reachable peers (roster-derived), MINUS self. */
  getServingPeers(): Array<{ machineId: string }>;
  /** The reader peer-store credential this machine holds for a target peer. */
  readPeerToken(machineId: string): PeerTokenRead;
  /** Roster name/device_type enrichment for the owner tag. */
  rosterLookup(machineId: string): RosterEntry | undefined;
}

export interface FleetPeerProviderDeps {
  /** This machine's own stable id (excluded from the serving-peer set). */
  localMachineId: string;
  /** The roster rows source. Default: the host's real roster reader
   *  (readRosterRows) — NO test stub in the production path. Injectable for
   *  unit tests. */
  rosterRows?: () => RosterRow[];
  /** The per-peer token reader. Default: the real reader peer-store
   *  (fleet_peer_store.readPeerToken). Injectable for unit tests. */
  readPeerToken?: (machineId: string) => PeerTokenRead;
  /** Override the roster file the DEFAULT reader loads (test/headless seam). */
  rosterFile?: string;
  /** Override the reader peer-store file the DEFAULT reader loads. */
  peerStoreFile?: string;
}

/** Compose the production fleet-peer provider from the roster + reader
 *  peer-store. Defaults read the machine's REAL stores (no stubs in the
 *  production path); tests inject `rosterRows`/`readPeerToken` or point the
 *  defaults at fixture files via `rosterFile`/`peerStoreFile`. */
export function buildFleetPeerProvider(deps: FleetPeerProviderDeps): FleetPeerProvider {
  const rosterRows =
    deps.rosterRows ?? (() => readRosterRows(deps.rosterFile !== undefined ? { rosterFile: deps.rosterFile } : {}));
  const readToken =
    deps.readPeerToken ??
    ((machineId: string) =>
      readPeerTokenFromStore(machineId, deps.peerStoreFile !== undefined ? { storeFile: deps.peerStoreFile } : {}));
  return {
    localMachineId: deps.localMachineId,
    getServingPeers() {
      return servingReachablePeers(rosterRows())
        .filter((p) => p.machineId !== "" && p.machineId !== deps.localMachineId)
        .map((p) => ({ machineId: p.machineId }));
    },
    readPeerToken(machineId) {
      return readToken(machineId);
    },
    rosterLookup(machineId) {
      const row = rosterRows().find((r) => r.machine_id === machineId);
      if (row === undefined) return undefined;
      return { name: row.name, ...(row.device_type !== undefined ? { device_type: row.device_type } : {}) };
    },
  };
}

/** Project the SAME serving-peer set into the Record<string, PeerTransport>
 *  shape the W1 multiplexer (session_multiplexer.ts:102) consumes — machine-id
 *  keyed. Each transport reads its token ONCE here (mirroring the route's
 *  FleetPeerSource construction, index.ts:475-482); a missing/absent token
 *  yields an undefined URL (the honest degraded peer), never a fabricated one.
 *  The key set is exactly `getServingPeers()` — the two projections list the
 *  same machine_ids by construction. */
export function fleetPeerTransports(provider: FleetPeerProvider): Record<string, PeerTransport> {
  const out: Record<string, PeerTransport> = {};
  for (const { machineId } of provider.getServingPeers()) {
    const read = provider.readPeerToken(machineId);
    out[machineId] = {
      getUrl: () => (read.ok ? read.credential.baseUrl : undefined),
      token: read.ok ? read.credential.token : undefined,
    };
  }
  return out;
}
