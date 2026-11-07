// OBSERVATION READ PLANE (#1537, B2b read seam): the observation-only,
// GET-only, per-session owner-routing seam. On a machine that runs the
// OBSERVATION path (`baseStudioActivates` mounted the fleet READ routes but NO
// premium fleet plane is attached, so getMode stays "engine"), a peer-owned
// session's READ requests fell through to the LOCAL engine — which never held
// the peer's session — rendering "This session cannot be found". This plane
// resolves such a read to its owner peer and proxies it there with that peer's
// OWN reader token; every other request falls through byte-identical to local.
//
// Reuse-first: the peer hop rides the battle-tested HubProxy streaming machinery
// (bodies, SSE, timeouts, client-abort, honest 502/503). HubProxy attaches
// `hubUpstreamAuthHeader(token)` which is byte-identical to
// `peerAuthHeader(token)` (both `serverAuthHeader(token)` — Basic
// base64("opencode:<token>")), so a synthetic per-peer credential produces
// exactly the peer-token auth the owner expects. A per-request HubProxy carries
// no state, so constructing one per proxied read is cheap and correct.
import * as http from "node:http";
import { HubProxy } from "./hub_proxy";
import { HUB_MINT_NAME, type HubCredentialRead } from "./hub_credential";
import {
  ObservationReadRouter,
  type ObservationReadRouterOpts,
  type ObservationReadPeerTarget,
} from "./session_multiplexer";
import { probeLocalSession } from "./local_session_probe";
import type { ObservationReadPlane } from "./server";

/** Build the observation-only read plane: a resolver (path→owner peer) plus the
 *  peer-token proxy. `timeoutMs` bounds the headers wait (SSE bodies ride past
 *  it), mirroring the hub/attached proxies. #1774: `localEngineUrl` (the local
 *  engine origin, read per request) arms the local-first probe for an
 *  unknown-owner read; absent → no verdict, the read falls through local. */
export function createObservationReadPlane(
  opts: ObservationReadRouterOpts & { timeoutMs?: number; localEngineUrl?: () => string | undefined },
): ObservationReadPlane {
  const router = new ObservationReadRouter(opts);
  const localEngineUrl = opts.localEngineUrl;
  return {
    resolve: (method, pathname) => router.resolve(method, pathname),
    ...(localEngineUrl
      ? { probeLocal: (req: http.IncomingMessage, sessionId: string) => probeLocalSession({ localUrl: localEngineUrl(), sessionId, req }) }
      : {}),
    proxyToPeer(req: http.IncomingMessage, res: http.ServerResponse, target: ObservationReadPeerTarget): boolean {
      // A synthetic per-peer hub credential → HubProxy attaches
      // serverAuthHeader(target.token) === peerAuthHeader(target.token).
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
