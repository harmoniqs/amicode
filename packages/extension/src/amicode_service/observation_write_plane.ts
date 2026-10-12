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
import { serverAuthHeader } from "../server_auth";
import {
  ObservationWriteRouter,
  type ObservationWriteRouterOpts,
  type ObservationWritePeerTarget,
} from "./session_multiplexer";
import type { ObservationWritePlane } from "./server";

/** Does the owning peer host a project whose worktree equals `dir`? Probes the
 *  peer's `GET /project` list (the same route the fleet projection can see) with
 *  the peer reader token. Used to decide whether a remote create's directory is a
 *  REAL shared path on the peer (keep it — the session lands in that shared repo,
 *  where the peer's UI looks) or a foreign creator-only path (strip it). Any
 *  probe failure (transport, non-2xx, non-JSON, unexpected shape) resolves FALSE
 *  — the fail-safe: strip to the peer's default scope rather than pin the session
 *  to a directory the peer may not list. Never throws. */
async function peerHasProjectWorktree(peerUrl: string, token: string, dir: string): Promise<boolean> {
  try {
    const resp = await fetch(new URL("/project", peerUrl).toString(), {
      method: "GET",
      headers: { authorization: serverAuthHeader(token) },
    });
    if (!resp.ok) return false;
    const projects = (await resp.json()) as Array<{ worktree?: unknown }>;
    if (!Array.isArray(projects)) return false;
    return projects.some((p) => typeof p?.worktree === "string" && p.worktree === dir);
  } catch {
    return false;
  }
}

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
    resolveCreate: (method, pathname, headers) => router.resolveCreate(method, pathname, headers),
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
    async proxyCreateToPeer(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      target: ObservationWritePeerTarget,
    ): Promise<boolean> {
      // The path-less session-create is a small one-shot JSON request/response
      // (never SSE), so — unlike proxyToPeer's streaming HubProxy — it is proxied
      // BUFFERED, so the new session's id can be read from the response and its
      // ownership recorded IMMEDIATELY (the pull-only projection lags ~5s; the
      // app reads /session/{id} right after create). The peer is dialed with the
      // reader token it accepts (serverAuthHeader(token)); auth_token query
      // carriers are dropped (GET-only on the peer). On any transport error the
      // caller answers its own honest 503 (return false).
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const upstream = new URL(req.url ?? "/session", target.url);
        upstream.searchParams.delete("auth_token");
        // Resolve the create's PROJECT SCOPE on the owning peer (the peer-UI
        // visibility fix, match-by-path). The app issues create scoped to ITS
        // OWN open project (?directory=<creator path>); the peer's sidebar lists
        // session.list({ directory: <the peer's open project> }), so the create
        // must land in a project the PEER actually lists.
        //   - KEEP the creator's directory IFF it is a project worktree on the
        //     peer (the common shared-repo case: both machines have the same
        //     repo open) → the session lands in that shared repo, where the
        //     peer's UI looks.
        //   - Otherwise STRIP it: a foreign path would otherwise resolve to the
        //     peer's throwaway ambient temp cwd (a project nobody views), so we
        //     drop it and let the peer file the session under its OWN default
        //     scope. The follow-up read routes by session id (owner map),
        //     independent of directory, so nothing downstream needs the dir.
        const creatorDir = upstream.searchParams.get("directory");
        if (creatorDir && !(await peerHasProjectWorktree(target.url, target.token, creatorDir))) {
          upstream.searchParams.delete("directory");
        }
        const headers: Record<string, string> = {
          authorization: serverAuthHeader(target.token),
          "content-type": typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/json",
        };
        const resp = await fetch(upstream.toString(), {
          method: req.method ?? "POST",
          headers,
          body: body.length ? body : undefined,
        });
        const text = await resp.text();
        // Record the new session → owner binding so the immediate follow-up read
        // routes to the peer (superseded by the next projection; TTL-bounded).
        try {
          const parsed = JSON.parse(text) as { id?: unknown };
          if (typeof parsed?.id === "string" && parsed.id) opts.ownerMap.recordPendingOwner(parsed.id, target.machineId);
        } catch {
          /* a non-JSON body is not fatal — the response still streams back */
        }
        res.writeHead(resp.status, { "content-type": resp.headers.get("content-type") ?? "application/json" });
        res.end(text);
        return true;
      } catch {
        return false; // transport error → the caller sends the honest 503
      }
    },
  };
}
