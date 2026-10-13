// ENGINE PROXY (#822, the fork-cutover proxy slice): the transparent reverse
// proxy from the amicode service's origin to the spawned engine (the vendored
// opencode server). Every non-amicode, non-static request streams through:
// method, headers, and body preserved — deliberately NO header rewriting (the
// framed app bootstraps with the ENGINE credential, so its Authorization is
// already exactly what the engine wants; the app's own auth machinery is the
// same one that works against the engine today). SSE rides the same pipe:
// response chunks are piped as they arrive, never buffered.
//
// vscode-free on purpose (the service's founding discipline); the upstream is
// LATE-BOUND by a getter because the engine's URL is only known once its
// ServerManager reports ready (ephemeral port) and CHANGES across restarts
// (solver-mode switches, config re-preps) — the getter is read per request.
import * as http from "node:http";

export interface EngineProxyOptions {
  /** The engine origin (e.g. http://127.0.0.1:43117), read per request;
   *  undefined = the engine is not bound yet (boot gap, restart gap). */
  getUrl(): string | undefined;
}

/** Hop-by-hop headers a proxy must not forward verbatim (RFC 7230 §6.1):
 *  `host` names the service origin, not the engine — node recomputes it for
 *  the upstream; `connection` negotiates THIS hop's options. Everything else
 *  (Authorization included) rides unchanged. */
const HOP_BY_HOP = ["host", "connection"] as const;

/** #1773 — an upstream lost AFTER the response headers went out: ERROR-close
 *  the downstream (destroy it with the error) so the listener — or the next
 *  relay — sees a transport error. A clean `end()` here read as "the stream
 *  ended normally, nothing was lost" and the client reconnected without a
 *  resync. Never throws. */
function errorClose(res: http.ServerResponse, err: unknown): void {
  try {
    res.destroy(err instanceof Error ? err : new Error(`engine upstream failed: ${String(err)}`));
  } catch {
    /* already gone */
  }
}

export class EngineProxy {
  constructor(private readonly opts: EngineProxyOptions) {}

  /**
   * Stream one request through to the engine. Returns false when no upstream
   * is bound yet (the caller sends the honest 503); true once the request is
   * in flight — the caller must not touch `res` afterwards. Never throws:
   * upstream failures collapse into the honest 502 JSON shape.
   */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const upstreamBase = this.opts.getUrl();
    if (!upstreamBase) return false;
    try {
      // req.url is the raw path+query as received — reconstruct against the
      // engine origin so the full request line (query included) is preserved.
      const target = new URL(req.url ?? "/", upstreamBase);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers };
      for (const h of HOP_BY_HOP) delete headers[h];
      const upstream = http.request(target, { method: req.method, headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        // #1773: the engine's stream died mid-body — an error close, not an end.
        up.on("error", (err) => errorClose(res, err));
      });
      // #1261 (AC5): exactly-once reattach — a client disconnect (a reloaded
      // window closing its stream) tears down the engine upstream so a reload
      // re-joins ONCE, never accumulating upstreams. Normal completion
      // (writableFinished) already ended it.
      res.on("close", () => {
        if (res.writableFinished) return;
        upstream.destroy();
      });
      upstream.on("error", (err) => {
        // The engine went away mid-flight (restart gap, crash): honest 502
        // JSON when headers aren't sent yet, else (#1773) an error close.
        if (res.headersSent) {
          errorClose(res, err);
          return;
        }
        try {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: `engine upstream failed: ${err}` }));
        } catch {
          /* response already torn down — never throw into the server */
        }
      });
      // The request body rides as a stream — never buffered, so large POSTs
      // (file uploads) pass through with no service-side memory cost.
      req.pipe(upstream);
      return true;
    } catch (err) {
      if (res.headersSent) {
        errorClose(res, err);
        return true;
      }
      try {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "engine upstream unavailable" }));
      } catch {
        /* never throw into the server */
      }
      return true;
    }
  }
}
