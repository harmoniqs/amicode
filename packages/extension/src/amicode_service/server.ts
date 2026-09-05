// AMICODE SERVICE (M1 port slice 1 — #451): the extension-host HTTP server that
// replaces the fork server's /amicode/* routes at cutover (canonical opencode
// ships no custom routes — M0 gate (a) — so the Amicode surface moves here).
//
// Deliberately framework-free: node:http on 127.0.0.1 with an ephemeral port,
// a per-boot Basic password minted exactly like the opencode server spawn
// (server_auth.ts — same mint, same header shape, so consumers reuse one
// auth idiom), and an exact-match route table mirroring the fork's
// router.add() mounts. Handlers return JSON strings, never throw — the fork's
// every-route-never-rejects discipline (each module collapses failures into
// its one success shape), so a handler bug degrades to an error payload, not
// a dead widget.
//
// vscode-free on purpose: the service boots in-process under vitest for the
// contract tests; the extension wiring (activation, lifecycle, output channel)
// lives with the extension and arrives with the consumer slice that needs it.
import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { mintServerPassword, serverAuthHeader } from "../server_auth";
import { setBindHostname } from "./bind_host";
import { AppShelf, type AppShelfResult } from "./app_shelf";
import { EngineProxy } from "./engine_proxy";

export interface AmicodeRequestCtx {
  /** Fully-parsed request URL (query params included — POST /amicode/profile
   *  rides query params by contract, not a JSON body). */
  url: URL;
  /** Raw request body ("" when none). Capped at 1 MiB. */
  body: string;
}

export interface AmicodeHandlerResult {
  status?: number;
  body: string;
  contentType?: string;
  /** Extra response headers (e.g. the widget frame's CSP — served, not srcdoc,
   *  precisely so it can carry its own policy). */
  headers?: Record<string, string>;
}

export type AmicodeHandler = (ctx: AmicodeRequestCtx) => AmicodeHandlerResult | Promise<AmicodeHandlerResult>;

interface RouteEntry {
  method: "GET" | "POST";
  path: string;
  handler: AmicodeHandler;
}

const MAX_BODY_BYTES = 1024 * 1024;

function unauthorized(): AmicodeHandlerResult {
  // The fork's auth middleware 401s anonymous requests with a Basic challenge;
  // consumers (widgets, app) attach the per-boot credential on every call, so
  // the body shape is ours to define — keep it in the never-reject JSON style.
  return { status: 401, body: JSON.stringify({ ok: false, error: "unauthorized" }), contentType: "application/json" };
}

export class AmicodeServiceServer {
  private readonly routes = new Map<string, RouteEntry>();
  private server?: http.Server;
  private _port?: number;
  private shelf?: AppShelf;
  private engineProxy?: EngineProxy;
  readonly password: string;

  constructor(opts: { password?: string } = {}) {
    this.password = opts.password ?? mintServerPassword();
  }

  get port(): number | undefined {
    return this._port;
  }
  /** Registered route count — the wiring log's inventory line reads this, so
   *  it can never drift stale the way a hard-coded count does. */
  get routeCount(): number {
    return this.routes.size;
  }
  get url(): URL | undefined {
    return this._port ? new URL(`http://127.0.0.1:${this._port}`) : undefined;
  }
  /** The header a consumer needs for every call (tests + future wiring). */
  get authHeader(): string {
    return serverAuthHeader(this.password);
  }

  add(method: "GET" | "POST", path: string, handler: AmicodeHandler): this {
    this.routes.set(`${method} ${path}`, { method, path, handler });
    return this;
  }

  /** Mount the app shelf (#822): static serving of the built app dist,
   *  consulted AFTER the exact route table and BEFORE the engine proxy. */
  attachAppShelf(shelf: AppShelf): this {
    this.shelf = shelf;
    return this;
  }

  /** Mount the engine reverse proxy (#822): the fallback for non-amicode,
   *  non-static requests, streaming to/from the spawned engine. */
  attachEngineProxy(proxy: EngineProxy): this {
    this.engineProxy = proxy;
    return this;
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return false;
    // Decode the base64 credentials before comparing — the wire form is
    // base64("opencode:<password>"), the comparison form is the raw pair.
    const given = Buffer.from(header.slice(6).trim(), "base64");
    const want = Buffer.from(`opencode:${this.password}`, "utf8");
    if (given.length !== want.length) return false;
    return timingSafeEqual(given, want);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (r: AmicodeHandlerResult | AppShelfResult) => {
      res.statusCode = r.status ?? 200;
      res.setHeader("Content-Type", r.contentType ?? "application/json");
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
      res.end(r.body);
    };
    try {
      if (!this.authorized(req)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="amicode-service"');
        send(unauthorized());
        return;
      }
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const route = this.routes.get(`${req.method} ${url.pathname}`);
      if (route) {
        const body = await this.readBody(req);
        const result = await route.handler({ url, body });
        send(result);
        return;
      }
      // #822 precedence, after the exact route table: the /amicode/*
      // namespace is OWNED by this service (unmatched paths 404 here — the
      // fork-parity discipline; stock canonical serves no /amicode/* so
      // proxying them would just launder our 404) → the app shelf → the
      // engine proxy.
      if (url.pathname === "/amicode" || url.pathname.startsWith("/amicode/")) {
        send({ status: 404, body: JSON.stringify({ ok: false, error: `no route: ${req.method} ${url.pathname}` }) });
        return;
      }
      const shelfHit = this.shelf?.handle(req.method ?? "GET", url.pathname, String(req.headers.accept ?? ""));
      if (shelfHit) {
        send(shelfHit);
        return;
      }
      if (this.engineProxy) {
        // Streams method/headers/body through to the engine (SSE included);
        // false = no upstream bound yet → the honest 503 below.
        if (this.engineProxy.handle(req, res)) return;
      }
      send({ status: 503, body: JSON.stringify({ ok: false, error: "engine upstream not available" }) });
    } catch (err) {
      // Never crash the service on one bad request; mirror the fork's
      // collapse-into-one-shape discipline at the transport layer.
      send({ status: 500, body: JSON.stringify({ ok: false, error: String(err) }) });
    }
  }

  async start(): Promise<URL> {
    if (this.server) throw new Error("amicode service already running");
    const server = http.createServer((req, res) => {
      void this.dispatch(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("amicode service: no port");
    this._port = addr.port;
    // Stamp the bind hostname for the loopback gates (vault browser, future
    // credentials surface) — the service binds 127.0.0.1 by construction.
    setBindHostname("127.0.0.1");
    return this.url!;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    this._port = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
