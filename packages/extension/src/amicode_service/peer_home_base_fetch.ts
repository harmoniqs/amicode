// PEER HOME-BASE FETCH (#1643 remote-create unblock, S8) — the live server-side
// peer read that resolves a peer's home-base directory by fetching its OWN
// /amicode/fleet/peer-workspace route. This is the "live peer read" the design
// chose over a roster field: the OWNING machine is the authority on its own
// working directory, and this dials it (reader-token transport) at create time.
//
// Replaces the readPeerHomeDir stub. The local /amicode/fleet/peer-home-base
// route calls this; the app's pre-flight then either arms the create (dir
// resolved) or refuses no-remote-root (undefined). Never throws — every failure
// (unknown peer, unreachable, non-200, missing field, malformed body) collapses
// to undefined, which is the honest no-remote-root outcome.

import { serverAuthHeader } from "../server_auth";

export interface PeerTransport {
  baseUrl: string;
  token: string;
}

export interface PeerFetchDeps {
  /** Resolve a peer's transport (baseUrl + reader token), or undefined. Wired to
   *  the fleetPeers provider's readPeerToken at the call site. */
  resolvePeer: (peerId: string) => PeerTransport | undefined;
  /** The fetch implementation (injectable for tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

/** Fetch the peer's home-base directory from its /amicode/fleet/peer-workspace
 *  route. undefined on any failure (→ the caller blocks with no-remote-root). */
export async function fetchPeerHomeBase(peerId: string, deps: PeerFetchDeps): Promise<string | undefined> {
  const peer = deps.resolvePeer(peerId);
  if (!peer || !peer.baseUrl) return undefined;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const url = new URL("/amicode/fleet/peer-workspace", peer.baseUrl).toString();
    const res = await fetchImpl(url, {
      headers: { Authorization: serverAuthHeader(peer.token) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: boolean; home_base?: unknown };
    if (typeof body.home_base !== "string") return undefined;
    const trimmed = body.home_base.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}
