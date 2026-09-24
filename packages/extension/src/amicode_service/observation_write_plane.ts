// OBSERVATION WRITE PLANE (#1542, B2b WRITE seam): the mirror of the #1537
// observation READ plane, with the GET/non-GET decision INVERTED — it routes
// NON-GET requests (prompt / archive / delete) to a PEER-OWNED session and
// IGNORES GET (the read plane owns GET). On a machine running the OBSERVATION
// path (`baseStudioActivates` mounted the fleet routes but NO premium fleet
// plane is attached, so getMode stays "engine"), a peer-owned session's WRITE
// requests fell through to the LOCAL engine — which never held the peer's
// session — or were dropped. This plane AUTHORIZES such a write through the pure
// `evaluateRemoteWriteGate` (active `control` grant + reachable transport, D2-
// corrected grant read at the wiring) and, when allowed, proxies it to the owner
// with the credential the owner accepts. A denied write is the gate's NAMED
// honest deny, NEVER executed locally (the #1382 invariant); every other request
// falls through byte-identical to local.
//
// EMPIRICAL CREDENTIAL BOUNDARY (resolved against live evidence, NOT assumed):
// the control grant is the CLIENT-SIDE authorization gate — it decides whether
// this machine may SEND the write at all. The transport credential presented to
// the owner is the PEER credential the owner accepts (today: the reader token,
// the SAME credential the read plane sources via `fleetPeers.readPeerToken`).
// The observation-only owner accepts the peer reader token for full `/session`
// CRUD — it does NOT enforce a separate control scope on proxied `/session`. A
// self-issued control-grant token the owner has never seen would 401. A distinct
// owner-enforced control token is a future tightening. So this plane presents
// `target.token` (the peer reader token) via its OWN `proxyToPeer` — NOT
// `ControlGatedResolver`/`controlGatedMultiplexAdapter`, whose adapter DROPS the
// peer credential ("a future integration slice will thread it through the
// proxy", control_gated_routing.ts).
//
// Reuse-first: the peer hop rides the battle-tested HubProxy streaming machinery
// (bodies, SSE, timeouts, client-abort, honest 502/503) — byte-identical to the
// read plane. HubProxy attaches `hubUpstreamAuthHeader(token)` ≡ `peerAuthHeader(
// token)` (both `serverAuthHeader(token)`), so a synthetic per-peer credential
// produces exactly the peer-token auth the owner expects.
import * as http from "node:http";
import { HubProxy } from "./hub_proxy";
import { HUB_MINT_NAME, type HubCredentialRead } from "./hub_credential";
import {
  ObservationWriteRouter,
  type ObservationWriteRouterOpts,
  type ObservationWritePeerTarget,
} from "./session_multiplexer";
import type { ObservationWritePlane } from "./server";

/** Build the observation-only WRITE plane: a resolver (path→owner peer, GET
 *  ignored) that AUTHORIZES through the pure write gate, plus the peer proxy
 *  presenting the credential the owner accepts (the peer reader token).
 *  `timeoutMs` bounds the headers wait (SSE bodies ride past it), mirroring the
 *  read plane / hub / attached proxies. */
export function createObservationWritePlane(
  opts: ObservationWriteRouterOpts & { timeoutMs?: number },
): ObservationWritePlane {
  const router = new ObservationWriteRouter(opts);
  return {
    resolve: (method, pathname) => router.resolve(method, pathname),
    proxyToPeer(req: http.IncomingMessage, res: http.ServerResponse, target: ObservationWritePeerTarget): boolean {
      // A synthetic per-peer hub credential → HubProxy attaches
      // serverAuthHeader(target.token) === peerAuthHeader(target.token). The
      // token is the PEER reader token the owner accepts — NOT the control-grant
      // token (see the empirical boundary in the header comment).
      const credential = (): HubCredentialRead => ({
        ok: true,
        mint: HUB_MINT_NAME,
        credential: { baseUrl: target.url, token: target.token },
      });
      const proxy = new HubProxy({
        getUrl: () => target.url,
        credential,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return proxy.handle(req, res);
    },
  };
}
