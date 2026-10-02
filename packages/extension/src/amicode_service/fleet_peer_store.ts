// READER PEER-TOKEN STORE (#1438, ADR 0032 §D1) — the reader side of the
// peer-trust credential.
//
// Each machine stores, PER TARGET peer, the token that peer minted granting
// THIS machine access to it (plus the peer's base_url). This is the DEDICATED
// store ADR 0032 §D1 requires — deliberately NOT attachment_credential.ts,
// whose own header (:17-19) disclaims the peer-trust identity. Overloading one
// store with two credential kinds of different lifecycle risks a revoke
// clearing the wrong entry, so the stores stay distinct.
//
// The shape { store_version, peers: { <machine_id>: { base_url, token } } } is
// byte-identical to attachment_credential.ts:119, so this rides the SHARED
// keyed-0600-store primitive (keyed_store.ts) rather than forking a third copy.
import { homedir } from "node:os";
import { join } from "node:path";
import { readKeyedCollection, upsertKeyedEntry, deleteKeyedEntry, clearKeyedStoreFile } from "./keyed_store";

export const PEER_TOKEN_STORE_VERSION = 1;

const COLLECTION = "peers";

export interface PeerToken {
  baseUrl: string;
  token: string;
}

export interface PeerStoreDeps {
  /** Override the store file (pure-injection for tests). Default:
   *  $AMICO_FLEET_PEER_TOKEN_FILE → ~/.amico/fleet-peer-tokens-reader.json.
   *  Dedicated file, distinct from the minter's issued-token registry
   *  (fleet_issued_tokens.ts) and from attachment_credential's store. */
  storeFile?: string;
}

export type PeerTokenReadReason = "absent" | "malformed" | "incomplete";
export type PeerTokenRead = { ok: true; credential: PeerToken } | { ok: false; reason: PeerTokenReadReason };

export function peerTokenStorePath(deps: PeerStoreDeps = {}): string {
  if (deps.storeFile) return deps.storeFile;
  const env = process.env.AMICO_FLEET_PEER_TOKEN_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "fleet-peer-tokens-reader.json");
}

/** Look up the peer credential this machine holds for ONE target machine_id. */
export function readPeerToken(machineId: string, deps: PeerStoreDeps = {}): PeerTokenRead {
  const peers = readKeyedCollection(peerTokenStorePath(deps), COLLECTION);
  const entry = peers[machineId];
  if (entry === undefined) return { ok: false, reason: "absent" };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "malformed" };
  const e = entry as Record<string, unknown>;
  const baseUrl = typeof e.base_url === "string" ? e.base_url.trim() : "";
  const token = typeof e.token === "string" ? e.token.trim() : "";
  if (baseUrl === "" || token === "") return { ok: false, reason: "incomplete" };
  return { ok: true, credential: { baseUrl, token } };
}

/** Store the peer credential for ONE target machine_id (an upsert; every other
 *  target is preserved). */
export function writePeerToken(machineId: string, value: PeerToken, deps: PeerStoreDeps = {}): void {
  upsertKeyedEntry(
    peerTokenStorePath(deps),
    COLLECTION,
    machineId,
    { base_url: value.baseUrl.trim(), token: value.token.trim() },
    PEER_TOKEN_STORE_VERSION,
  );
}

/** Remove ONE target's peer credential; absent is a no-op. */
export function clearPeerToken(machineId: string, deps: PeerStoreDeps = {}): void {
  deleteKeyedEntry(peerTokenStorePath(deps), COLLECTION, machineId, PEER_TOKEN_STORE_VERSION);
}

/** Whether this machine holds a peer credential for a target (the readiness
 *  gate's reader-side predicate). */
export function hasPeerToken(machineId: string, deps: PeerStoreDeps = {}): boolean {
  return readPeerToken(machineId, deps).ok;
}

/** Remove the entire reader peer-store file; absent is a no-op. */
export function clearAllPeerTokens(deps: PeerStoreDeps = {}): void {
  clearKeyedStoreFile(peerTokenStorePath(deps));
}
