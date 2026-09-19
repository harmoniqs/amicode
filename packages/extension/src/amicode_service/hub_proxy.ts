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
import type { Duplex } from "node:stream";
import { HubCredentialRead } from "./hub_credential";
import { hubUpstreamAuthHeader } from "./hub_credential";
import type { DataPlaneOutcome } from "./fleet_posture";
import type { SessionEventResume } from "./session_event_resume";

export interface HubProxyOptions {
  /** The hub origin (the fleet tunnel's far end), read per request;
   *  undefined = the tunnel is down (the caller sends its named 503). */
  getUrl(): string | undefined;
  /** The hub mint's NAMED read — re-read per request so a mid-session
   *  write/clear of the credential store is honored without a reboot. */
  credential(): HubCredentialRead;
  /** #392 (D6): the CLIENT-ENFORCED timeout on receiving the upstream's
   *  response headers — the detector observes outcomes, it does not await
   *  a wedged tunnel. Once headers arrive the body streams freely (SSE
   *  rides past this bound). Default 10s. */
  timeoutMs?: number;
  /** #392 (D6): the posture detector's diet — one outcome per proxied
   *  request, fed exactly once (headers arrived, or the attempt died). */
  onOutcome?: (o: DataPlaneOutcome) => void;
  /** #392 (D7): the tunnel generation stamp, read per response so a
   *  mid-session rejoin changes what the client sees on the next stream. */
  responseStamp?: () => Record<string, string> | undefined;
  /** #1264 (Slice 4): the per-session SSE cursor store. When present, a proxied
   *  per-session event stream (`/api/session/{id}/event`) is made lossless
   *  across tunnel blips — the relay resumes via `?after=<last seq>` and dedupes
   *  the boundary. Absent → every stream pipes through byte-for-byte (the
   *  pre-#1264 behavior); the non-resumable `/event` and `/global/event` streams
   *  are untouched even when present (they are not per-session paths). */
  sessionResume?: SessionEventResume;
}

/** Hop-by-hop headers a proxy must not forward verbatim (RFC 7230 §6.1) —
 *  plus `authorization`, which this proxy OWNS (the hub mint translation is
 *  its whole reason to exist). */
const DROPPED_HEADERS = ["host", "connection", "authorization"] as const;

/** #1263 (Slice 3): the upgrade path's dropped headers. Unlike the body-pipe
 *  set, `connection` and `upgrade` MUST survive — they are what makes the host
 *  engine's upgrade handler fire and emit its own 101. Only `host` (node
 *  recomputes it for the upstream) and `authorization` (this proxy TRANSLATES
 *  it to the hub mint) are dropped; `sec-websocket-*`, `origin`, and the
 *  `?ticket=`/`?cursor=` query all ride through verbatim. */
const UPGRADE_DROPPED_HEADERS = ["host", "authorization"] as const;

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
      // #1264 (Slice 4): per-session SSE resume. For `/api/session/{id}/event`
      // the relay carries the last delivered aggregate seq across reconnects —
      // injecting `?after=<seq>` here so a blip REPLAYS the gap, and deduping
      // the boundary on the response below. `plan` is undefined for every other
      // path (incl. the non-resumable `/event` / `/global/event`), so they are
      // left exactly as-is. `incoming` still carries `after` (auth_token delete
      // does not touch it), so an explicit caller cursor is honored / deferred.
      const resumePlan = this.opts.sessionResume?.plan(incoming);
      if (resumePlan?.afterToInject !== undefined) target.searchParams.set("after", resumePlan.afterToInject);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      for (const h of DROPPED_HEADERS) delete headers[h];
      headers["authorization"] = hubUpstreamAuthHeader(cred.credential.token);
      // D6: the client-enforced headers timeout — the client always
      // resolves or times out; the body (an SSE stream included) is
      // unbounded once headers arrive.
      const timeoutMs = this.opts.timeoutMs ?? 10_000;
      const started = Date.now();
      let counted = false;
      // #1261 (AC5): a client-initiated close (a window reload dropping its
      // stream) tears the upstream down — but it is NOT a hub failure, so it
      // must never record a no-response outcome (that would falsely drive the
      // hub-down posture).
      let clientAborted = false;
      const timeout = setTimeout(() => {
        if (counted || clientAborted) return;
        counted = true;
        // the client-enforced timeout IS the outcome — record it, then tear
        // the attempt down (the detector observes outcomes, it does not
        // await a wedged tunnel)
        this.opts.onOutcome?.({ kind: "no-response", detail: `client-enforced timeout (${timeoutMs}ms)` });
        upstream.destroy(new Error(`client-enforced data-plane timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      const upstream = http.request(target, { method: req.method, headers }, (up) => {
        if (!counted) {
          counted = true;
          clearTimeout(timeout);
          this.opts.onOutcome?.({ kind: "responded", latencyMs: Date.now() - started });
        }
        const stamp = this.opts.responseStamp?.() ?? undefined;
        res.writeHead(up.statusCode ?? 502, { ...up.headers, ...(stamp ?? {}) });
        // #1264 (Slice 4): a per-session event stream (matched by `plan`) whose
        // response is actually SSE rides through the dedupe/track filter — each
        // event's `id:` seq advances the session cursor, and a replayed seq at
        // or below the resume point is dropped (idempotent resume). Every other
        // response (non-session path → no plan; a non-SSE error body → not an
        // event-stream) keeps the verbatim byte pipe, so behavior is unchanged.
        const isSSE = String(up.headers["content-type"] ?? "").includes("text/event-stream");
        if (resumePlan && isSSE) {
          const filter = resumePlan.filter;
          // Flush SSE headers NOW: a resume can legitimately forward zero bytes
          // (the client is already caught up to the live tail, or the whole
          // replay was deduped). Node sends headers lazily — without this flush
          // the client's stream never opens until the first forwarded byte,
          // which may be far in the future (or never). SSE must open on connect.
          res.flushHeaders?.();
          up.on("data", (chunk: Buffer) => {
            try {
              const out = filter.push(chunk);
              if (out.length) res.write(out);
            } catch {
              /* never throw into the stream */
            }
          });
          up.on("end", () => {
            try {
              const tail = filter.flush();
              if (tail.length) res.write(tail);
              res.end();
            } catch {
              /* already gone */
            }
          });
        } else {
          up.pipe(res);
        }
        up.on("error", () => {
          try {
            res.end();
          } catch {
            /* already gone */
          }
        });
      });
      // #1261 (AC5): exactly-once reattach. When the CLIENT disconnects (a
      // reloaded window closing its stream), tear down the host upstream so a
      // reload re-joins the host ONCE — never accumulating upstreams into the
      // #792-Amendment-B connection storm. A normal completion (writableFinished)
      // already ended the upstream, so skip it there.
      res.on("close", () => {
        if (res.writableFinished) return;
        clientAborted = true;
        clearTimeout(timeout);
        upstream.destroy();
      });
      upstream.on("error", (err) => {
        if (!counted && !clientAborted) {
          counted = true;
          clearTimeout(timeout);
          this.opts.onOutcome?.({
            kind: "no-response",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
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

  /**
   * #1263 (Slice 3): tunnel a WebSocket upgrade (the PTY terminal's
   * `GET /pty/:id/connect`) through to the host engine and back. Owns the raw
   * client socket for its whole lifetime — always tears it down cleanly, never
   * leaks it, never throws into the server.
   *
   * The body-pipe `handle` cannot be reused: an upgrade has no `res`, its 101
   * response must be forwarded VERBATIM (the engine computes
   * `Sec-WebSocket-Accept` — the relay must never synthesize a 101), and
   * `connection`/`upgrade` must SURVIVE (the body-pipe drops `connection`). So
   * the credential translation is re-implemented here for the 101 path:
   *   - strip the inbound Authorization + the `?auth_token=` carrier;
   *   - attach the hub mint's Basic header;
   *   - preserve `?ticket=`/`?cursor=`/`Origin` and the `sec-websocket-*` set.
   * The host's PTY route authorizes by ticket OR Basic — the attached hub mint
   * satisfies the Basic arm; the preserved `?ticket=` satisfies the other.
   */
  handleUpgrade(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    // A pre-upgrade failure: answer the raw socket honestly, then destroy it
    // (a WS client reads a non-101 status line as a failed handshake).
    const fail = (code: number, reason: string): void => {
      try {
        if ((clientSocket as { writable?: boolean }).writable) {
          clientSocket.write(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\n\r\n`);
        }
      } catch {
        /* socket already gone */
      }
      try {
        clientSocket.destroy();
      } catch {
        /* already gone */
      }
    };

    const upstreamBase = this.opts.getUrl();
    if (!upstreamBase) {
      // tunnel down — a client holds no local engine (never-fork); the socket
      // is torn down cleanly (no leak). The honest hub-down surface for the
      // data plane stays the request path's named 503.
      fail(502, "Bad Gateway");
      return;
    }
    const cred = this.opts.credential();
    if (!cred.ok) {
      fail(503, "Service Unavailable");
      return;
    }

    let target: URL;
    try {
      // preserve the full request line (?ticket=/?cursor= ride through) MINUS
      // the engine's ?auth_token= carrier (the hub reads it first and would 401)
      const incoming = new URL(req.url ?? "/", upstreamBase);
      incoming.searchParams.delete("auth_token");
      target = new URL(incoming.toString());
    } catch {
      fail(502, "Bad Gateway");
      return;
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    for (const h of UPGRADE_DROPPED_HEADERS) delete headers[h];
    headers["authorization"] = hubUpstreamAuthHeader(cred.credential.token);

    let upgraded = false;
    let upstreamReq: http.ClientRequest;
    try {
      upstreamReq = http.request(target, { method: req.method ?? "GET", headers });
    } catch {
      fail(502, "Bad Gateway");
      return;
    }

    // The client dropped BEFORE the upstream upgraded → abort the pending
    // upstream request so nothing is left half-open.
    const onEarlyClientClose = (): void => {
      if (!upgraded) {
        try {
          upstreamReq.destroy();
        } catch {
          /* already gone */
        }
      }
    };
    clientSocket.on("close", onEarlyClientClose);

    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      upgraded = true;
      // clean teardown: ANY end/close/error on EITHER side destroys BOTH
      // sockets. This is the leak guard (AC3) — a half-close (a dropped client
      // FINs its side) must not leave the counterpart's writable half open
      // (which would keep the relay's own socket alive and wedge server.close),
      // so we DESTROY both rather than rely on pipe's half-close semantics.
      let torn = false;
      const teardown = (): void => {
        if (torn) return;
        torn = true;
        try {
          upstreamSocket.destroy();
        } catch {
          /* already gone */
        }
        try {
          clientSocket.destroy();
        } catch {
          /* already gone */
        }
      };
      try {
        // Forward the engine's OWN 101 VERBATIM — status line + every header as
        // the upstream sent it (rawHeaders preserves the exact
        // Sec-WebSocket-Accept the engine computed). NEVER a synthesized 101.
        clientSocket.write(serializeStatusHead(upstreamRes));
        if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead);
        // relay any bytes the client sent past its handshake (usually none)
        if (head && head.length) upstreamSocket.write(head);
      } catch {
        teardown();
        return;
      }
      // bidirectional raw pipe — the relay is opcode-agnostic past the 101.
      // `end: false`: piped-src EOF must NOT half-close the dest; teardown owns
      // lifecycle (both sockets die together), so neither side is left half-open.
      upstreamSocket.pipe(clientSocket, { end: false });
      clientSocket.pipe(upstreamSocket, { end: false });
      for (const ev of ["end", "close", "error"] as const) {
        clientSocket.on(ev, teardown);
        upstreamSocket.on(ev, teardown);
      }
    });

    // The host answered a NORMAL response (401/404/…) instead of upgrading —
    // relay it verbatim so the client sees the real refusal, then close (no
    // hang, no leak).
    upstreamReq.on("response", (upstreamRes) => {
      if (upgraded) return;
      try {
        clientSocket.write(serializeStatusHead(upstreamRes));
        upstreamRes.on("data", (c: Buffer) => {
          try {
            clientSocket.write(c);
          } catch {
            /* gone */
          }
        });
        upstreamRes.on("end", () => {
          try {
            clientSocket.end();
          } catch {
            /* gone */
          }
        });
        upstreamRes.on("error", () => {
          try {
            clientSocket.destroy();
          } catch {
            /* gone */
          }
        });
      } catch {
        try {
          clientSocket.destroy();
        } catch {
          /* gone */
        }
      }
    });

    upstreamReq.on("error", () => {
      if (!upgraded) fail(502, "Bad Gateway");
    });

    try {
      upstreamReq.end();
    } catch {
      fail(502, "Bad Gateway");
    }
  }
}

/** Serialize an IncomingMessage's status line + headers back to the wire form,
 *  VERBATIM (rawHeaders preserves the upstream's exact header names/values,
 *  including the engine-computed Sec-WebSocket-Accept). */
function serializeStatusHead(res: http.IncomingMessage): string {
  const raw = res.rawHeaders;
  let block = "";
  for (let i = 0; i + 1 < raw.length; i += 2) block += `${raw[i]}: ${raw[i + 1]}\r\n`;
  return `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n${block}\r\n`;
}
