// SSE FAN-IN DRIVER (#1519, Fleet Studio wiring W1c — ADR 0033 §D1–D4) — the
// thin async driver the #1511 aggregator's design named as the deferred hot-path
// slice: it wires the origin's global `/event` stream to the SseFanInAggregator.
//
// #1511 built the synchronous frame-routing CORE (sse_fanin_aggregator.ts) and
// unit-tested all 7 ACs against a deterministic sink. What was deliberately NOT
// wired was the driver that opens the REAL upstream SSE connections and pumps
// their frames onto the ONE downstream `res` the app reads (ADR 0027 single-
// origin). This module is that driver.
//
// It is consulted ONLY behind AMICO_FLEET_MULTIPLEX (server.ts gates the call).
// `handle()` DECLINES (returns false) when zero owner-peers are owned, so a
// flag-OFF / fleet-of-one `/event` falls through BYTE-IDENTICALLY to the engine
// proxy — the #1264 regression guard (AC1). With ≥1 owned peer it takes over the
// response: local arm + one authed upstream per owner-peer, fanned in through the
// aggregator's composite-cursor `ingest` path.
//
// Split (per the ADR): the aggregator CORE is driven deterministically by the
// route-level tests via an INJECTED upstream opener; the real-http opener below
// is the production transport, exercised live by the opt-in two-peer E2E.
import * as http from "node:http";
import {
  SseFanInAggregator,
  deriveMembership,
  resolveUpstreamAuth,
  LOCAL_NAMESPACE,
  type SseSink,
  type SseFrameSource,
  type FocusSnapshot,
} from "./sse_fanin_aggregator";
import type { SessionOwnerMap } from "./session_multiplexer";
import type { PeerTokenRead } from "./fleet_peer_store";

/** The one thing dispatch needs from the driver (server.ts imports this type and
 *  exposes it on FleetPlane.eventFanIn). `handle` returns true when it TOOK OVER
 *  the response (≥1 non-local owner-peer owned → the fan-in path); false when
 *  there are zero owned peers (fleet-of-one) — the caller then falls through to
 *  the existing byte-identical `/event` path (#1264, AC1). */
export interface EventFanInDriver {
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

/** One upstream-open request. Both the local arm and each peer arm read the
 *  global `/event` stream; `url` is the source origin (the local engine, or the
 *  peer's base URL), `lastEventId` is that namespace's D3 resume id. */
export interface FanInUpstreamRequest {
  namespace: string;
  url: string;
  path: string;
  authHeader?: string;
  lastEventId?: string;
}

/** Open one upstream SSE source. Production default = the real-http reader
 *  below; the route-level tests inject a deterministic fake so the REAL route
 *  (dispatch → interception → aggregator → downstream res) is exercised without
 *  a live peer. */
export type OpenUpstream = (r: FanInUpstreamRequest) => SseFrameSource;

export interface SseFanInDriverDeps {
  ownerMap: SessionOwnerMap;
  localMachineId: string;
  /** The local engine origin (§D4 local arm), read LATE (per connection). */
  localEventUrl: () => string | undefined;
  /** A peer's base URL, read LATE. undefined → the peer is unreachable. */
  peerBaseUrl: (machineId: string) => string | undefined;
  /** A peer's OWN token (decision A). Never the hub credential. */
  peerToken: (machineId: string) => PeerTokenRead;
  /** Transport reachability. Default: peerBaseUrl(id) resolves. */
  reachable?: (machineId: string) => boolean;
  /** The upstream opener. Default: the real-http reader. Injected in tests. */
  openUpstream?: OpenUpstream;
  /** Focus/picker snapshot (decision A). Optional; the aggregator emits a named
   *  empty snapshot when absent. */
  focusSnapshot?: () => FocusSnapshot | undefined;
  /** The live reconcile cadence per connection (ms). Default 1000. Tests set a
   *  large value and call `reconcile()` directly for determinism. */
  reconcileMs?: number;
}

/** The production upstream reader: a frame-preserving http SSE source. Splits the
 *  byte stream on the SSE blank-line delimiter into WHOLE frames (delimiter-
 *  inclusive) so `event:`/`data:`/`retry:`/`id:` lines survive intact for the
 *  aggregator's §D2 relay. Never throws — a connection error just ends the
 *  source (the aggregator names the gap; D3 replays it on reconnect). */
export function openHttpSseSource(r: FanInUpstreamRequest): SseFrameSource {
  const queue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let ended = false;
  let clientReq: http.ClientRequest | undefined;
  const pushFrame = (f: string): void => {
    const w = waiters.shift();
    if (w) w(f);
    else queue.push(f);
  };
  const end = (): void => {
    if (ended) return;
    ended = true;
    let w: ((v: string | null) => void) | undefined;
    while ((w = waiters.shift())) w(null);
  };
  try {
    const u = new URL(r.path, r.url);
    if (r.lastEventId !== undefined && r.lastEventId !== "") u.searchParams.set("lastEventID", r.lastEventId);
    const headers: Record<string, string> = {};
    if (r.authHeader) headers.authorization = r.authHeader;
    clientReq = http.get(u, { headers }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (ended) return;
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          pushFrame(buf.slice(0, idx + 2)); // whole frame, delimiter-inclusive
          buf = buf.slice(idx + 2);
        }
      });
      res.on("end", () => end());
      res.on("error", () => end());
    });
    clientReq.on("error", () => end());
  } catch {
    end();
  }
  return {
    next(): Promise<string | null> {
      const f = queue.shift();
      if (f !== undefined) return Promise.resolve(f);
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close(): void {
      clientReq?.destroy();
      end();
    },
  };
}

/** One live `/event` fan-in connection: the aggregator on this response, the
 *  open upstream sources keyed by namespace, and the reconcile timer. */
class FanInConnection {
  private readonly agg: SseFanInAggregator;
  private readonly sources = new Map<string, SseFrameSource>();
  private resume = new Map<string, string>();
  private readonly open: OpenUpstream;
  private readonly authHeader?: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly deps: SseFanInDriverDeps,
    private readonly req: http.IncomingMessage,
    private readonly res: http.ServerResponse,
  ) {
    this.open = deps.openUpstream ?? openHttpSseSource;
    const a = req.headers.authorization;
    this.authHeader = typeof a === "string" ? a : undefined;
    const sink: SseSink = {
      write: (chunk: string) => res.write(chunk),
      flush: () => (res as unknown as { flush?: () => void }).flush?.(),
    };
    this.agg = new SseFanInAggregator({
      sink,
      localMachineId: deps.localMachineId,
      ...(deps.focusSnapshot ? { focusSnapshot: deps.focusSnapshot } : {}),
    });
  }

  start(): void {
    // The fan-in path OWNS the response (the byte-identical path never reaches
    // here). Set the SSE headers the app expects on the global stream, and
    // FLUSH them immediately: an SSE client must see the stream open before the
    // first event, and Node otherwise holds headers until the first body write —
    // which, with no peer frame yet, would strand a just-connected reader.
    if (!this.res.headersSent) {
      this.res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      this.res.flushHeaders?.();
    }
    // Parse the opaque composite cursor (#1264 / §D3) and seed the aggregator
    // (this also emits the focus snapshot as the first `local` frame — decision A).
    const url = new URL(this.req.url ?? "/", "http://origin");
    this.resume = this.agg.connect(url.searchParams.get("lastEventID") ?? undefined);
    // §D4: the local arm is ALWAYS present, resumed from `local`'s id, authed
    // with the app's incoming credential (the engine accepts it — never a peer
    // token, never the hub credential leaked outward).
    this.openArm(LOCAL_NAMESPACE, this.deps.localEventUrl(), this.authHeader, this.resume.get(LOCAL_NAMESPACE));
    // Membership + peer arms, then keep them reconciled with the owner-map.
    this.reconcile();
    const ms = this.deps.reconcileMs ?? 1000;
    this.timer = setInterval(() => this.reconcile(), ms);
    this.timer.unref?.();
  }

  /** Reconcile the fan-in membership from the live SessionOwnerMap (§D1 / AC3):
   *  open arms for newly-owned reachable peers, close arms for peers no longer
   *  active (an unreachable owner also gets the aggregator's honest comment
   *  frame). NEVER ends the downstream `res` — arms open/close beneath it. */
  reconcile(): void {
    if (this.closed) return;
    const reachable = this.deps.reachable ?? ((id: string) => this.deps.peerBaseUrl(id) !== undefined);
    const members = deriveMembership({
      ownerMachineIds: this.deps.ownerMap.ownerMachineIds(),
      localMachineId: this.deps.localMachineId,
      reachable,
      peerToken: this.deps.peerToken,
    });
    // The aggregator opens/closes its logical arms and emits the honest comment
    // for a lost/unreachable owner (once, on transition).
    this.agg.setMembership(members);
    const active = new Set(this.agg.activeArms());
    // Open a real upstream for each newly-active peer arm.
    for (const machineId of active) {
      if (this.sources.has(machineId)) continue;
      this.openArm(machineId, this.deps.peerBaseUrl(machineId), this.peerAuth(machineId), this.resume.get(machineId));
    }
    // Close the real upstream for any peer arm no longer active (dark peer, or
    // its sessions ended). The local arm is never closed here (§D4).
    for (const machineId of [...this.sources.keys()]) {
      if (machineId === LOCAL_NAMESPACE) continue;
      if (!active.has(machineId)) {
        try {
          this.sources.get(machineId)?.close();
        } catch {
          /* already gone */
        }
        this.sources.delete(machineId);
      }
    }
  }

  /** Resolve a peer's upstream Authorization from its OWN token (decision A).
   *  The hub credential is never an input, so it cannot leak to a peer. */
  private peerAuth(machineId: string): string | undefined {
    const auth = resolveUpstreamAuth(machineId, this.deps.peerToken(machineId));
    return auth.ok ? auth.authHeader : undefined;
  }

  private openArm(namespace: string, url: string | undefined, authHeader: string | undefined, lastEventId: string | undefined): void {
    if (this.sources.has(namespace)) return;
    if (url === undefined) return; // no transport → nothing to open
    const source = this.open({
      namespace,
      url,
      path: "/event",
      ...(authHeader ? { authHeader } : {}),
      ...(lastEventId ? { lastEventId } : {}),
    });
    this.sources.set(namespace, source);
    void this.pump(namespace, source);
  }

  /** Pull whole frames from one arm and fan them in through the aggregator's
   *  composite-cursor `ingest` (the seam that stamps the round-trippable `id:`
   *  the client tracks — NOT the bare `pipeToResponse` relay, which would emit
   *  the NS_SEP form the composite cursor cannot round-trip). */
  private async pump(namespace: string, source: SseFrameSource): Promise<void> {
    for (;;) {
      let frame: string | null;
      try {
        frame = await source.next();
      } catch {
        break;
      }
      if (frame === null || this.closed) break;
      this.agg.ingest(namespace, frame);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const s of this.sources.values()) {
      try {
        s.close();
      } catch {
        /* already gone */
      }
    }
    this.sources.clear();
    try {
      this.res.end();
    } catch {
      /* already torn down */
    }
  }
}

/** The `/event` fan-in driver (ADR 0033 §D1). One live connection at a time
 *  (ADR 0027 single-origin: the app opens exactly one `/event`); a second
 *  `handle` tears the prior connection down first. */
export class SseFanInDriver implements EventFanInDriver {
  private active?: FanInConnection;

  constructor(private readonly deps: SseFanInDriverDeps) {}

  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // The gate: ≥1 non-local owner-peer owned (from the live SessionOwnerMap).
    // Zero → decline, so `/event` falls through byte-identically (#1264, AC1).
    const owners = this.deps.ownerMap
      .ownerMachineIds()
      .filter((id) => id !== "" && id !== this.deps.localMachineId);
    if (owners.length === 0) return false;
    this.active?.close();
    const conn = new FanInConnection(this.deps, req, res);
    this.active = conn;
    conn.start();
    res.on("close", () => {
      if (this.active === conn) this.active = undefined;
      conn.close();
    });
    return true;
  }

  /** Reconcile the live connection's membership NOW (the per-connection timer
   *  target; also called directly by the arm-lifecycle tests for determinism). */
  reconcile(): void {
    this.active?.reconcile();
  }
}
