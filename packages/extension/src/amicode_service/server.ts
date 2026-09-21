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
import { HubProxy } from "./hub_proxy";
import type { UpstreamMode } from "./merged_projection";
import { isPublicUiPath } from "./public_ui";
import { resolveAttachmentPointer } from "./attachment_pointer";
import { resolveKeeperPointer } from "./keeper_pointer";
import { resolveAmicodeTarget, type MultiplexTarget } from "./attachment_pointer";

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

/** #391 (the local-shell data plane, D1): the fleet plane the staged path
 *  arms. Mode selection is DATA-DRIVEN (read per request, like every
 *  late-bound upstream here); "degraded" is Slice B's steady state of the
 *  SAME fleet mode — this plane carries only the engine | fleet decision. */
export interface FleetPlane {
  getMode(): UpstreamMode;
  hub: HubProxy;
  /** #392 (D3): the write pipeline — non-GET data-plane requests resolve
   *  through the write-failure contract (delivered | failed | ambiguous),
   *  never through the raw proxy. */
  writes?: { handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> };
  /** #392 (D6): invoked when the hub proxy reports no upstream (the
   *  tunnel getter yielded nothing) — feeds the posture detector, so a
   *  tunnel-down window counts toward the named hub-down condition. */
  onNoUpstream?: () => void;
  /** #1261 (AC6): this relay is a fleet CLIENT (never-fork, NO local engine).
   *  When true, a hub-down window is the relay's OWN honest hub-down 503 —
   *  never "engine upstream not available" (there is no engine to be
   *  unavailable) and never a silent standalone→engine fall-through. */
  client?: boolean;
  /** #1261 (AC6): the live hub-down pointer for the client's honest 503 (the
   *  posture snapshot's pointer when standalone; a default otherwise). */
  hubDownPointer?: () => string | null;
  /** #1378 (D3 resolver wiring): the ATTACHED server's upstream — the D6
   *  switch-control pointer's transport. Present only on engine-armed (non-
   *  client) peers that have peer capabilities; absent on client relays and
   *  standalone machines. When present, `dispatch()` calls the D3 resolver
   *  to route requests through this proxy or the keeper below. */
  attached?: HubProxy;
  /** #1378 (D3 resolver wiring): the KEEPER's upstream — the directory
   *  registry's transport. /amicode/roster resolves here regardless of
   *  which server is attached. */
  keeper?: HubProxy;
  /** #1382 (peer-unreachable posture): the live pointer for the peer's
   *  honest 503 — the posture snapshot's pointer when attached; a default
   *  otherwise. Absent → the FLEET_PEER_UNREACHABLE_POINTER default. */
  peerUnreachablePointer?: () => string | null;
}

/** #1261 (AC6): a client's own named hub-down state — distinct from the base
 *  "hub upstream not available" and never the engine's message. */
export const FLEET_HUB_DOWN_ERROR = "fleet-hub-down";
export const FLEET_HUB_DOWN_POINTER =
  "the fleet host is unreachable — a client holds no local engine (never-fork); " +
  "check the tunnel / host service, or Go Standalone to work locally";

/** #1382 (peer-unreachable posture): the NAMED error and default pointer for
 *  the attached-server-unreachable 503 — the peer branch's own honest posture,
 *  distinct from the client's hub-down (same shape, different condition). */
export const FLEET_PEER_UNREACHABLE_ERROR = "attached server unreachable";
export const FLEET_PEER_UNREACHABLE_POINTER =
  "the attached server is unreachable — check the peer's tunnel / service, " +
  "or detach to work locally";

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
  /** #391 (D1): the fleet plane — armed ONLY through the entitlement-staged
   *  path (fleet_staging.ts); absent on every base boot, which is what makes
   *  the no-entitlement byte identity structural. */
  private fleetPlane?: FleetPlane;
  readonly password: string;
  /** #955 (the hub cutover): the auth mode. "credential" (the default) is the
   *  per-boot-mint posture — every non-public-UI request 401s without a
   *  valid mint. "open" matches the fork hub's DEPLOYED posture on the
   *  tunnel/LAN boundary (the canonical /session answers 200 anonymous; the
   *  SSH mesh is the security boundary, and the fleet clients ride tunnels
   *  without credentials): authorized() accepts every request. A PRESENT
   *  mint keeps working — the framed app's engine credential is accepted
   *  exactly as before; open only stops REQUIRING one. */
  readonly authMode: "open" | "credential";
  /** #822: the spawned engine's per-boot mint, accepted ALONGSIDE the
   *  service's own — the framed app bootstraps with the ENGINE credential
   *  (its auth machinery is the one that works against the engine today),
   *  so every surface on this origin must take it with zero app-side
   *  change. undefined = no engine bound (the proxy-less boots stay
   *  single-mint, byte-compatible with the pre-#822 contract). */
  private readonly enginePassword?: string;

  constructor(opts: { password?: string; enginePassword?: string; authMode?: "open" | "credential" } = {}) {
    this.password = opts.password ?? mintServerPassword();
    this.enginePassword = opts.enginePassword;
    this.authMode = opts.authMode ?? "credential";
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

  /** #391 (D1): arm the fleet plane — the late-bound routing mode plus the
   *  hub proxy. Called ONLY by the staged path in index.ts; a boot without
   *  it never carries a fleet surface. */
  attachFleetPlane(plane: FleetPlane): this {
    this.fleetPlane = plane;
    return this;
  }

  /** The current routing mode (D1's data-driven selection): the fleet
   *  plane's late-bound getter when armed, the base engine mode otherwise. */
  get routingMode(): UpstreamMode {
    return this.fleetPlane?.getMode() ?? "engine";
  }

  /** #823 (the M3 cutover bootstrap seam): the credential source for one
   *  request, mirroring the ENGINE's own middleware precedence — the
   *  `?auth_token=` query carrier FIRST, the Basic header as the fallback.
   *  The carrier is the iframe bootstrap's only vehicle (a document GET
   *  cannot carry headers) and the engine reads it the same way, so the
   *  service must too or the framed document 401s at the shelf while the
   *  engine would have accepted it. GET-ONLY for the query form (the design
   *  note's framed-path scope: document/SPA/pane GETs; the app's post-load
   *  calls all carry the Basic header via its SDK). A present-but-garbage
   *  carrier fails closed — it does NOT fall back to a header, exactly like
   *  the engine (a request the service accepted but the engine would 401
   *  must never happen). */
  private credential(req: http.IncomingMessage, url: URL): Buffer | undefined {
    const token = url.searchParams.get("auth_token");
    if (token !== null) {
      if ((req.method ?? "GET") !== "GET") return undefined; // GET-only seam
      return Buffer.from(token, "base64");
    }
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Basic ")) return undefined;
    return Buffer.from(header.slice(6).trim(), "base64");
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    // #955: the open-boundary mode accepts every request — the fork hub's
    // deployed tunnel/LAN posture (anonymous 200 on the canonical /session;
    // the SSH mesh is the boundary, not HTTP auth). Present mints keep
    // working: everything a credential-mode boot would accept, this accepts.
    if (this.authMode === "open") return true;
    // The anonymous sub-resource surface (fork public-ui parity): GET-only
    // static UI paths a browser cannot credential — exempt BEFORE anything
    // else, exactly like the engine's middleware does for them.
    if (isPublicUiPath(req.method ?? "GET", url.pathname)) return true;
    const given = this.credential(req, url);
    if (given === undefined) return false;
    // #822: accept BOTH mints — the service's own AND the engine's (the
    // framed app bootstraps with the engine credential; the proxy forwards
    // it unchanged, and the /amicode/* routes take it too so one credential
    // works everywhere on this origin). Length checks before the constant-
    // time compare, per credential, so a wrong-mint probe learns nothing.
    for (const mint of [this.password, this.enginePassword]) {
      if (mint === undefined) continue;
      const want = Buffer.from(`opencode:${mint}`, "utf8");
      if (given.length === want.length && timingSafeEqual(given, want)) return true;
    }
    return false;
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

  /** #1262: does this request belong to the HOST's authoritative /amicode/*
   *  surface — i.e. should a fleet CLIENT proxy it to the host instead of
   *  serving it from the local exact-match table / catch-all? True ONLY for a
   *  fleet client, in fleet routing mode, on an /amicode/* path that is NOT the
   *  client's OWN /amicode/fleet/* honesty surface (posture/mode/staging —
   *  those stay local). Standalone and the engine-armed base machine → false
   *  (they own a local store and serve /amicode/* locally, byte-identically). */
  private shouldProxyAmicodeToHost(url: URL): boolean {
    if (!this.fleetPlane?.client) return false;
    if (this.routingMode !== "fleet") return false;
    const p = url.pathname;
    if (p !== "/amicode" && !p.startsWith("/amicode/")) return false;
    // The client's own fleet-plane surface stays LOCAL — never proxied (a
    // proxied posture/status would report the HOST's, defeating the honesty
    // surface #1261 AC6 relies on).
    if (p === "/amicode/fleet" || p.startsWith("/amicode/fleet/")) return false;
    return true;
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (r: AmicodeHandlerResult | AppShelfResult) => {
      res.statusCode = r.status ?? 200;
      res.setHeader("Content-Type", r.contentType ?? "application/json");
      for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
      res.end(r.body);
    };
    try {
      const host = req.headers.host ?? "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (!this.authorized(req, url)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="amicode-service"');
        send(unauthorized());
        return;
      }
      // #1262: in fleet CLIENT mode the HOST owns all /amicode/* state. Bypass
      // the ENTIRE local /amicode/* dispatch (the exact-match route table AND
      // the catch-all 404 below) so a REGISTERED route (GET /amicode/problems,
      // POST /amicode/connections) no longer shadows the proxy — the request
      // falls through to the fleet branch and routes to the host's
      // authoritative amicode_service (reads → hub proxy, non-GET → the
      // write-failure contract). EXCEPTION: /amicode/fleet/* is the CLIENT'S
      // OWN honesty surface (its live posture/mode/staging receipt) and stays
      // LOCAL. Gated on the client role so standalone AND the engine-armed base
      // machine are byte-identical — both still serve /amicode/* locally.
      const proxyAmicodeToHost = this.shouldProxyAmicodeToHost(url);
      // #1378 (D3 resolver wiring): the peer branch's routing decision for
      // engine-armed (!client) fleet machines with an attached upstream. Called
      // EARLY: a non-"local" result bypasses the local /amicode/* dispatch (the
      // route table + 404 catch-all) so registered routes like /amicode/roster
      // and /amicode/vaults no longer shadow the upstream — they fall through to
      // the fleet branch and route to the resolver's target (keeper or attached).
      // A "local" result keeps the route table's normal behavior, which is D3's
      // fail-safe default (empty/corrupt pointer → local engine).
      let peerTarget: MultiplexTarget | undefined;
      if (
        !proxyAmicodeToHost &&
        this.routingMode === "fleet" &&
        this.fleetPlane &&
        !this.fleetPlane.client &&
        this.fleetPlane.attached
      ) {
        const attachedResult = resolveAttachmentPointer();
        const keeperResult = resolveKeeperPointer();
        const { target } = resolveAmicodeTarget(url.pathname, { attached: attachedResult, keeper: keeperResult });
        if (target !== "local") {
          peerTarget = target;
        }
      }
      if (!proxyAmicodeToHost && !peerTarget) {
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
      }
      // #391 (D1): the upstream is chosen by the CURRENT routing mode —
      // fleet routes data + SSE to the hub over the tunnel (the shelf above
      // already served the UI locally: zero assets cross the WAN); the
      // engine mode keeps the base behavior. No silent fallback: a fleet
      // boot with the tunnel down answers its OWN named 503, never the
      // engine's.
      const mode = this.routingMode;
      if (mode === "fleet" && this.fleetPlane) {
        // #1378: peer branch — the resolver already decided the target above.
        // Routes to the named upstream; if unreachable, answers the peer's OWN
        // named 503 — NEVER falls through to the local engine (the sessions
        // are on a different DB; serving local sessions dressed as the peer's
        // would be dishonest — #1382).
        if (peerTarget && !this.fleetPlane.client) {
          if (peerTarget === "keeper" && this.fleetPlane.keeper) {
            if (this.fleetPlane.keeper.handle(req, res)) return;
          } else if (peerTarget === "attached" && this.fleetPlane.attached) {
            if (this.fleetPlane.attached.handle(req, res)) return;
          }
          // #1382: upstream unreachable → named 503, hold, no silent local.
          // Same shape as the client's hub-down 503 (consumers handle both
          // cases uniformly) with the peer-unreachable reason.
          const pointer = this.fleetPlane.peerUnreachablePointer?.() ?? FLEET_PEER_UNREACHABLE_POINTER;
          send({
            status: 503,
            body: JSON.stringify({ ok: false, error: FLEET_PEER_UNREACHABLE_ERROR, reason: "peer-unreachable", pointer }),
          });
          return;
        } else {
        // ── BYTE-UNCHANGED: the client→hub path (incl. #1261 hub-down 503) ──
        // #392 (D3): writes resolve through the write-failure contract —
        // every outcome enumerated, never silently ambiguous. Reads
        // (GET/HEAD — SSE included) stream through the proxy.
        const method = req.method ?? "GET";
        if (this.fleetPlane.writes && method !== "GET" && method !== "HEAD") {
          if (await this.fleetPlane.writes.handle(req, res)) return;
        } else {
          if (this.fleetPlane.hub.handle(req, res)) return;
          // no upstream bound: this IS a data-plane no-response — feed the
          // posture detector so a tunnel-down window reaches the named
          // hub-down condition.
          this.fleetPlane.onNoUpstream?.();
        }
        // #1261 (AC6): a CLIENT (never-fork, no local engine) answers with its
        // OWN honest hub-down state — never "engine upstream not available"
        // (there is no engine), never a silent local fall-through. The base
        // (engine-armed) machine keeps its "hub upstream not available" 503.
        if (this.fleetPlane.client) {
          const pointer = this.fleetPlane.hubDownPointer?.() ?? FLEET_HUB_DOWN_POINTER;
          send({
            status: 503,
            body: JSON.stringify({ ok: false, error: FLEET_HUB_DOWN_ERROR, reason: "hub-unreachable", pointer }),
          });
          return;
        }
        send({ status: 503, body: JSON.stringify({ ok: false, error: "hub upstream not available" }) });
        return;
        }
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

  async start(port?: number): Promise<URL> {
    if (this.server) throw new Error("amicode service already running");
    const server = http.createServer((req, res) => {
      void this.dispatch(req, res);
    });
    // #1263 (Slice 3): the WebSocket/PTY upgrade path. The dispatch table and
    // both body-pipe proxies are request-only, so WS upgrades (the integrated
    // terminal's GET /pty/:id/connect) had nowhere to go on a thin client. This
    // extends the SAME fleet branch dispatch keys on (fleetPlane.client &&
    // routingMode === "fleet") — a fleet CLIENT tunnels the upgrade to the host
    // engine, forwarding the engine's OWN 101 verbatim, with hub-credential
    // translation on the request. Every OTHER posture (engine-armed base
    // machine, standalone, no fleet plane) keeps the prior no-listener
    // behavior — the socket is destroyed — so loopback/never-fork is unchanged.
    server.on("upgrade", (req, socket, head) => {
      try {
        if (this.fleetPlane?.client && this.routingMode === "fleet") {
          this.fleetPlane.hub.handleUpgrade(req, socket, head);
          return;
        }
        // #1378: peer branch — the D3 resolver routes SSE/WebSocket upgrades
        // to the same target as dispatch() (attached or keeper). The client
        // path above is byte-unchanged; "local" falls through to socket.destroy
        // (the engine handles its own upgrades on its native port).
        if (!this.fleetPlane?.client && this.routingMode === "fleet" && this.fleetPlane?.attached) {
          const upgradeUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
          const attachedResult = resolveAttachmentPointer();
          const keeperResult = resolveKeeperPointer();
          const { target } = resolveAmicodeTarget(upgradeUrl.pathname, { attached: attachedResult, keeper: keeperResult });
          if (target === "attached") {
            this.fleetPlane.attached.handleUpgrade(req, socket, head);
            return;
          }
          if (target === "keeper" && this.fleetPlane.keeper) {
            this.fleetPlane.keeper.handleUpgrade(req, socket, head);
            return;
          }
          // "local" → fall through to socket.destroy (engine's native port)
        }
        socket.destroy();
      } catch {
        try {
          socket.destroy();
        } catch {
          /* already gone — never throw out of the upgrade handler */
        }
      }
    });
    this.server = server;
    const listenPort = port ?? 0;
    await new Promise<void>((resolve, reject) => {
      server.on("error", (err) => {
        // #955: a listen failure (e.g. the fixed port busy) must leave NO
        // instance state behind — this.server set-before-listen otherwise
        // wedges the instance, so the caller's own retry (the wiring's and
        // the runner's busy-port fallback) dies on "already running".
        this.server = undefined;
        reject(err);
      });
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // #1263 (Slice 3): server.close() waits for existing connections to end,
      // but an UPGRADED WS/PTY tunnel (the relay's proxied terminal) is a
      // hijacked socket that server.close() never ends on its own — so a live
      // terminal at shutdown would wedge stop() indefinitely. Force-close every
      // connection so teardown is prompt and leak-free (idle keep-alives too);
      // guarded because it is Node ≥18.2.
      server.closeAllConnections?.();
    });
  }
}
