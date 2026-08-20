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
  readonly password: string;

  constructor(opts: { password?: string } = {}) {
    this.password = opts.password ?? mintServerPassword();
  }

  get port(): number | undefined {
    return this._port;
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
    const send = (r: AmicodeHandlerResult) => {
      res.statusCode = r.status ?? 200;
      res.setHeader("Content-Type", r.contentType ?? "application/json");
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
      if (!route) {
        send({ status: 404, body: JSON.stringify({ ok: false, error: `no route: ${req.method} ${url.pathname}` }) });
        return;
      }
      const body = await this.readBody(req);
      const result = await route.handler({ url, body });
      send(result);
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
