// HUB PROXY (amicissimo#391 — the local-shell data plane, D1): the reverse
// proxy from the amicode service's origin to the HUB over the fleet tunnel —
// the fleet routing mode's data upstream. Streaming like the engine proxy,
// with ONE deliberate difference: credential TRANSLATION at the hop.
//
// The framed app authenticates to THIS origin with the service or engine
// mint (D5's per-mode discipline — the hub mint is never a client
// credential). The hub does not know those mints: it is an opencode server
// behind the tunnel expecting ITS OWN Basic credential. So this proxy
// strips the inbound Authorization header and the ?auth_token= query
// carrier (the engine's bootstrap vehicle — garbage to the hub, which reads
// the query carrier FIRST and would 401), and attaches the hub mint's Basic
// header from the credential-store entry (hub_credential.ts).
//
// Honesty rules (D5): a missing hub credential is a NAMED outcome — the
// honest 503 `hub-credential-missing`, never a silent fallback to another
// mint, never an unauthenticated forward. A dead tunnel is the honest 502
// (the caller answers no-upstream with its own named 503).
import * as http from "node:http";
import { HubCredentialRead } from "./hub_credential";
import { hubUpstreamAuthHeader } from "./hub_credential";

export interface HubProxyOptions {
  /** The hub origin (the fleet tunnel's far end), read per request;
   *  undefined = the tunnel is down (the caller sends its named 503). */
  getUrl(): string | undefined;
  /** The hub mint's NAMED read — re-read per request so a mid-session
   *  write/clear of the credential store is honored without a reboot. */
  credential(): HubCredentialRead;
}

/** Hop-by-hop headers a proxy must not forward verbatim (RFC 7230 §6.1) —
 *  plus `authorization`, which this proxy OWNS (the hub mint translation is
 *  its whole reason to exist). */
const DROPPED_HEADERS = ["host", "connection", "authorization"] as const;

export class HubProxy {
  constructor(private readonly opts: HubProxyOptions) {}

  /**
   * Stream one request through to the hub with the hub mint attached.
   * Returns false when no upstream is bound (the caller sends the honest
   * named 503); true once handled — including the NAMED
   * `hub-credential-missing` 503 this proxy sends itself. Never throws.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const upstreamBase = this.opts.getUrl();
    if (!upstreamBase) return false;
    const cred = this.opts.credential();
    if (!cred.ok) {
      try {
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "hub-credential-missing", reason: cred.reason }));
        } else {
          res.end();
        }
      } catch {
        /* never throw into the server */
      }
      return true;
    }
    try {
      // Reconstruct the request line against the hub origin, WITHOUT the
      // ?auth_token= carrier (the engine's bootstrap vehicle — the hub reads
      // the query carrier first and would 401 a perfectly good Basic header).
      const incoming = new URL(req.url ?? "/", upstreamBase);
      incoming.searchParams.delete("auth_token");
      const target = new URL(incoming.toString());
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      for (const h of DROPPED_HEADERS) delete headers[h];
      headers["authorization"] = hubUpstreamAuthHeader(cred.credential.token);
      const upstream = http.request(target, { method: req.method, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        up.on("error", () => {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        });
      });
      upstream.on("error", (err) => {
        try {
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `hub upstream failed: ${err}` }));
          } else {
            res.end();
          }
        } catch {
          /* response already torn down — never throw into the server */
        }
      });
      req.pipe(upstream);
      return true;
    } catch {
      try {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "hub upstream unavailable" }));
        } else {
          res.end();
        }
      } catch {
        /* never throw into the server */
      }
      return true;
    }
  }
}
