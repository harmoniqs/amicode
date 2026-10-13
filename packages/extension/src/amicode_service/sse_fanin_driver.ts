// SSE FAN-IN DRIVER (#1519, Fleet Studio wiring W1c — ADR 0033 §D1–D4) — the
// thin async driver the #1511 aggregator's design named as the deferred hot-path
// slice: it wires the origin's global `/event` stream to the SseFanInAggregator.
//
// #1511 built the synchronous frame-routing CORE (sse_fanin_aggregator.ts) and
// unit-tested all 7 ACs against a deterministic sink. What was deliberately NOT
// wired was the driver that opens the REAL upstream SSE connections and pumps
// their frames onto the downstream `res` the app reads. This module is that
// driver. #1772: ADR 0027's single-origin assumption (the app opens exactly one
// `/event`) no longer holds — multiple windows, Chat Deck panes and split panes
// each open their own — so every listener gets its own connection (aggregator,
// arms, reconcile) up to a cap; none is ever evicted to make room for another.
//
// On the observation path (#1543/#1565), `handle()` ALWAYS accepts (returns
// true) — zero non-local owners starts in fleet-of-one mode where the
// aggregator's §D4 byte-identity relay delivers local frames verbatim, and
// reconcile opens peer arms as they appear. The premium path (behind
// AMICO_FLEET_MULTIPLEX, server.ts) also consults this driver. With ≥1 owned
// peer, peer arms fan in through the aggregator's composite-cursor `ingest` path.
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
import { FanInCensus, emptyCloses, type FanInCloseReason, type CensusConnection } from "./fanin_census";

/** The one thing dispatch needs from the driver (server.ts imports this type and
 *  exposes it on FleetPlane.eventFanIn). `handle` always returns true on the
 *  observation path (#1565): zero non-local owners starts in fleet-of-one mode
 *  (the aggregator's §D4 byte-identity relay); reconcile opens peer arms as the
 *  OwnerMapFeed discovers them. */
export interface EventFanInDriver {
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

/** One upstream-open request. Both the local arm and each peer arm read the
 *  global `/global/event` stream (the v1 global-instance event bus, #1580);
 *  `url` is the source origin (the local engine, or the peer's base URL),
 *  `lastEventId` is that namespace's D3 resume id. */
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
  /** #1772 — the cap on CONCURRENT listeners (one FanInConnection each). A
   *  listener beyond it is refused with a retryable 503 + Retry-After; no live
   *  listener is ever closed to make room. Default DEFAULT_FANIN_MAX_LISTENERS. */
  maxListeners?: number;
  /** #1771 — this service's census (counters + log lines). The caller owns its
   *  cadence (`start()`) and its sink. Absent ⇒ a silent census (counted,
   *  logged nowhere). */
  census?: FanInCensus;
}

/** #1772 — default concurrent-listener cap per fan-in service. A service rarely
 *  has more than a handful of views (windows, Chat Deck panes, split panes). */
export const DEFAULT_FANIN_MAX_LISTENERS = 16;
/** #1772 — the Retry-After hint (seconds) on a beyond-cap refusal. */
export const FANIN_LISTENER_CAP_RETRY_AFTER_S = 5;
/** #1772 — the named error on a beyond-cap refusal. */
export const FANIN_LISTENER_CAP_ERROR = "fan-in listener cap reached";

/** The relay reader's frame splitter: decoded upstream text in, WHOLE frames out
 *  (delimiter-inclusive, verbatim). #1779: LINEAR in the text received. The old
 *  reader appended every chunk to the whole partial buffer and searched it from
 *  the start, so a multi-MB frame arriving in 64 KB chunks cost quadratic time.
 *  Now only the NEW chunk is scanned; a delimiter split across two chunks is
 *  caught by looking back one character into the partial frame, which is held
 *  as pieces and joined ONCE, when it completes. */
export class SseFrameSplitter {
  /** The partial frame, as received (never re-copied while it grows). */
  private parts: string[] = [];
  /** The partial frame's last character — the lookback for a split delimiter. */
  private tail = "";

  /** Feed one decoded chunk; returns the frames it completed, in order. */
  push(chunk: string): string[] {
    const frames: string[] = [];
    if (chunk === "") return frames;
    const tail = this.tail;
    let start = 0; // where the partial frame resumes in this chunk
    let from = 0;
    let lf: number;
    while ((lf = chunk.indexOf("\n", from)) !== -1) {
      from = lf + 1;
      // the line feed ends a blank line iff the character before it — in this
      // chunk, or the partial frame's tail when it is the chunk's first — is one too
      const prev = lf > start ? chunk.charCodeAt(lf - 1) : lf === 0 ? tail.charCodeAt(0) : NaN;
      if (prev !== LF_CODE) continue;
      this.parts.push(chunk.slice(start, from));
      frames.push(this.parts.length === 1 ? this.parts[0] : this.parts.join("")); // whole frame, delimiter-inclusive
      this.parts = [];
      start = from;
    }
    if (start < chunk.length) {
      this.parts.push(start === 0 ? chunk : chunk.slice(start));
      this.tail = chunk.charAt(chunk.length - 1);
    } else {
      this.tail = ""; // a frame ended exactly at the chunk's end
    }
    return frames;
  }
}
const LF_CODE = 10;

/** The production upstream reader: a frame-preserving http SSE source. Splits the
 *  byte stream on the SSE blank-line delimiter into WHOLE frames (delimiter-
 *  inclusive) so `event:`/`data:`/`retry:`/`id:` lines survive intact for the
 *  aggregator's §D2 relay. Never throws — a connection error just ends the
 *  source (the aggregator names the gap; D3 replays it on reconnect). #1771:
 *  the source remembers WHICH ended it — a clean upstream end or an error — for
 *  the census's close reason; both still end it identically. #1773: a non-200
 *  answer (an auth failure, an overloaded peer, a beyond-cap 503) is an ERROR —
 *  a loss, not a clean end — and its body is never parsed as frames. */
export function openHttpSseSource(r: FanInUpstreamRequest): SseFrameSource {
  const queue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let ended = false;
  let reason: "end" | "error" | undefined;
  let clientReq: http.ClientRequest | undefined;
  const pushFrame = (f: string): void => {
    const w = waiters.shift();
    if (w) w(f);
    else queue.push(f);
  };
  const end = (why: "end" | "error"): void => {
    if (ended) return;
    ended = true;
    reason = why;
    let w: ((v: string | null) => void) | undefined;
    while ((w = waiters.shift())) w(null);
  };
  try {
    const u = new URL(r.path, r.url);
    if (r.lastEventId !== undefined && r.lastEventId !== "") u.searchParams.set("lastEventID", r.lastEventId);
    const headers: Record<string, string> = {};
    if (r.authHeader) headers.authorization = r.authHeader;
    clientReq = http.get(u, { headers }, (res) => {
      if (res.statusCode !== 200) {
        // #1773 — not a stream: an upstream ERROR. Discard the body (never read
        // it as SSE frames) and let the socket go.
        res.on("error", () => undefined); // a reset mid-drain must not throw
        res.resume();
        end("error");
        return;
      }
      const splitter = new SseFrameSplitter();
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (ended) return;
        for (const frame of splitter.push(chunk)) pushFrame(frame);
      });
      res.on("end", () => end("end"));
      res.on("error", () => end("error"));
    });
    clientReq.on("error", () => end("error"));
  } catch {
    end("error");
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
      end("end");
    },
    endReason: () => reason,
  };
}

/** One live `/event` fan-in connection — ONE PER LISTENER (#1772): the
 *  aggregator on this response, the open upstream sources keyed by namespace,
 *  and this connection's own reconcile timer. Closing it closes only its arms.
 *  #1771: it is also the census's view of this listener — per-arm opens and
 *  closes-by-reason live here, traffic/pending/drops/gaps in the aggregator.
 *  #1773: it never ends its listener silently — every close except a graceful
 *  service shutdown is an ERROR close (the listener sees a transport error and
 *  resyncs), and a fleet-of-one local-arm loss severs the listener that way. */
class FanInConnection implements CensusConnection {
  private readonly agg: SseFanInAggregator;
  private readonly sources = new Map<string, SseFrameSource>();
  private resume = new Map<string, string>();
  private readonly open: OpenUpstream;
  private readonly authHeader?: string;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  /** #1771 — per arm: how often it opened, and why it closed. */
  private readonly armLife = new Map<string, { opens: number; closes: Record<FanInCloseReason, number> }>();
  /** #1773 — per arm: the reason of its most recent close (a severed
   *  listener's close is named after the loss that caused it). */
  private readonly lastClose = new Map<string, FanInCloseReason>();
  /** #1771 — sources THIS connection closed (their reason is already recorded;
   *  the pump's exit must not re-count them as an upstream end). */
  private readonly closedByUs = new WeakSet<SseFrameSource>();

  constructor(
    readonly id: string,
    private readonly deps: SseFanInDriverDeps,
    private readonly census: FanInCensus,
    private readonly req: http.IncomingMessage,
    private readonly res: http.ServerResponse,
    /** Invoked exactly once, when this connection closes (for any reason). */
    private readonly onClosed: (reason: FanInCloseReason) => void,
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
      // #1617 — re-derive the transparent proxy's backpressure by hand. When the
      // shared downstream `write()` returns false, pause EVERY live upstream so
      // the bounded per-namespace buffers cannot overflow-drop (an overflow drop
      // is not replayed — the arm stays open — so it can only be announced, by
      // the overflow gap). The `drain` edge (wired in start()) resumes them and calls
      // agg.resume() to flush the buffers in order and re-arm `flowing`.
      onBackpressure: () => this.pauseUpstreams(),
      // #1771 — the census clock and its view of drops and gaps.
      now: census.now,
      observer: {
        onOverflowDrop: (ns, pending) => census.overflowDrop(this.id, ns, pending),
        onGap: (nss, cause) => census.gapEmitted(this.id, nss, cause),
      },
    });
  }

  /** #1771 — this listener's arms as the census reports them (read at census
   *  time, never pushed per frame). */
  arms(): ReturnType<CensusConnection["arms"]> {
    return [...this.armLife.entries()].map(([arm, life]) => ({
      arm,
      traffic: this.agg.traffic(arm),
      pending: this.agg.pendingDepth(arm),
      opens: life.opens,
      closes: { ...life.closes },
    }));
  }

  private lifeOf(namespace: string): { opens: number; closes: Record<FanInCloseReason, number> } {
    let life = this.armLife.get(namespace);
    if (!life) {
      life = { opens: 0, closes: emptyCloses() };
      this.armLife.set(namespace, life);
    }
    return life;
  }

  /** #1771 — record (and log) an arm's close, once. */
  private noteArmClosed(namespace: string, reason: FanInCloseReason): void {
    this.lifeOf(namespace).closes[reason] += 1;
    this.lastClose.set(namespace, reason);
    this.census.armClosed(this.id, namespace, reason);
  }

  /** Close an upstream THIS connection decided to close (membership change,
   *  listener closed, shutdown) — recorded with its reason before the source's
   *  own end reaches the pump. */
  private closeSource(namespace: string, source: SseFrameSource, reason: FanInCloseReason): void {
    this.closedByUs.add(source);
    this.noteArmClosed(namespace, reason);
    try {
      source.close();
    } catch {
      /* already gone */
    }
  }

  /** #1617 — pause every live upstream source that supports it. A source
   *  without pause()/resume() (an injected test source, or a transport that
   *  cannot pause) simply keeps flowing into the aggregator's bounded buffer. */
  private pauseUpstreams(): void {
    for (const s of this.sources.values()) {
      try {
        s.pause?.();
      } catch {
        /* a source that cannot pause degrades to buffer-and-drain */
      }
    }
  }

  /** #1617 — resume every live upstream source on the downstream `drain` edge. */
  private resumeUpstreams(): void {
    for (const s of this.sources.values()) {
      try {
        s.resume?.();
      } catch {
        /* best-effort */
      }
    }
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
    // #1617 — wire the downstream `drain` edge to the aggregator's resume(). This
    // is the flow-control the transparent proxy's stream `pipe` gave for free and
    // the hand-rolled relay silently dropped: without it, `flowing` never re-arms
    // after a single large frame trips backpressure, and every subsequent frame —
    // including the `session.status: idle` that clears the rail — is buffered
    // indefinitely (the stale-until-reload wedge). On drain we resume the live
    // upstreams (paused in onBackpressure) and flush the per-namespace buffers in
    // arrival order; resume() also emits the overflow gap signal if any dropped.
    this.res.on("drain", () => {
      if (this.closed) return;
      this.resumeUpstreams();
      this.agg.resume();
    });
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
      // #1638 — resume from the aggregator's LIVE resume position for this
      // namespace, NOT the stale connect-time id. #1777: a re-open of an arm
      // that delivered engine ids RESUMES there and the peer replays; one with
      // no ids (an older engine) gets the composite-mode gap instead
      // (reopenArm is a no-op for a never-delivered arm; a peer arm is only
      // active in composite mode, so its verdict is never `sever`).
      this.reopenAndTrack(machineId, this.deps.peerBaseUrl(machineId), this.peerAuth(machineId));
    }
    // Close the real upstream for any peer arm no longer active (dark peer, or
    // its sessions ended). The local arm is never closed here (§D4).
    for (const machineId of [...this.sources.keys()]) {
      if (machineId === LOCAL_NAMESPACE) continue;
      if (!active.has(machineId)) {
        this.closeSource(machineId, this.sources.get(machineId)!, "membership-change");
        this.sources.delete(machineId);
      }
    }
    // #1601: re-open the LOCAL arm if it is gone. `activeArms()` is peers-only by
    // construction (it returns [...peerArms], never `local`), so the loops above
    // — both the open-side over `active` and the close-side over `sources` — can
    // NEVER touch LOCAL. Yet pump() removes ANY dead source, LOCAL included, when
    // its upstream ends. Without this check the local arm, once dead, stays dead
    // until a full handle() (webview reload) while peer frames keep the composite
    // stream non-silent so the client watchdog never fires ("local sessions freeze
    // until reload"). Guard at the call site so a HEALTHY local arm is never
    // re-opened or duplicated (openArm early-returns on a present source too);
    // resume from LOCAL's live cursor for lossless replay — mirrors start().
    // #1773: in fleet-of-one a local arm that delivered is not re-opened at all —
    // reopenAndTrack severs the listener (an error close) so the client resyncs.
    if (!this.sources.has(LOCAL_NAMESPACE)) {
      this.reopenAndTrack(LOCAL_NAMESPACE, this.deps.localEventUrl(), this.authHeader);
    }
  }

  /** #1638 — re-open an arm from the aggregator's LIVE resume position (not the
   *  stale connect-time id). `agg.reopenArm` is a no-op for an arm that has
   *  never delivered (an initial open), so it is safe to call at every
   *  reconcile-time open. Falls back to the connect-time resume id when the arm
   *  has delivered nothing yet.
   *
   *  #1777 — an arm that delivered engine ids RESUMES: it re-opens from its last
   *  delivered id and the upstream replays the stretch it missed — no gap, no
   *  sever. An upstream reset is announced as the upstream answers.
   *
   *  #1773 — the fallback for an upstream without ids: in composite mode one gap;
   *  in fleet-of-one the verdict is `sever` (a synthetic gap frame may not enter
   *  the verbatim stream, #1264), so instead of re-opening silently (losing the
   *  stretch unannounced) the listener is ended with a transport error, named
   *  after the loss that caused it. */
  private reopenAndTrack(namespace: string, url: string | undefined, authHeader: string | undefined): void {
    if (this.sources.has(namespace)) return;
    if (this.agg.reopenArm(namespace) === "sever") {
      this.close(this.lastClose.get(namespace) ?? "upstream-end");
      return;
    }
    const lastEventId = this.agg.cursorFor(namespace) ?? this.resume.get(namespace);
    this.openArm(namespace, url, authHeader, lastEventId);
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
      // #1580: the vendored engine + the app speak the v1 "global instance"
      // protocol whose event bus is `/global/event` — opening the arm at the
      // literal `/event` read a path the engine does not serve as the global bus,
      // so the owner's agent output never reached the aggregator. This one path
      // covers both the always-present local arm (§D4, opened in start()) and
      // every peer arm (opened in reconcile()).
      path: "/global/event",
      ...(authHeader ? { authHeader } : {}),
      ...(lastEventId ? { lastEventId } : {}),
    });
    this.sources.set(namespace, source);
    const life = this.lifeOf(namespace);
    life.opens += 1;
    this.census.armOpened(this.id, namespace, life.opens);
    void this.pump(namespace, source);
  }

  /** Pull whole frames from one arm and fan them in through the aggregator's
   *  composite-cursor `ingest` (the seam that stamps the round-trippable `id:`
   *  the client tracks — NOT the bare `pipeToResponse` relay, which would emit
   *  the NS_SEP form the composite cursor cannot round-trip). */
  private async pump(namespace: string, source: SseFrameSource): Promise<void> {
    let threw = false;
    for (;;) {
      let frame: string | null;
      try {
        frame = await source.next();
      } catch {
        threw = true;
        break;
      }
      if (frame === null || this.closed) break;
      // #1777 — a fleet-of-one arm resumed from its cursor whose upstream
      // answered without ids (an engine that cannot replay) lost the stretch
      // since the drop; the verbatim stream may carry no gap frame, so the
      // listener is severed under the loss that caused the re-open (#1773).
      if (this.agg.ingest(namespace, frame) === "sever") {
        this.close(this.lastClose.get(namespace) ?? "upstream-end");
        return;
      }
    }
    // #1771 — the upstream's OWN end (not one this connection caused): name it.
    if (!this.closed && !this.closedByUs.has(source)) {
      this.noteArmClosed(namespace, threw || source.endReason?.() === "error" ? "upstream-error" : "upstream-end");
    }
    // The upstream ended or errored — remove the dead source so the next
    // reconcile() tick can re-open the arm (#1566).
    this.sources.delete(namespace);
  }

  /** Close this listener's connection: stop its reconcile, close its arms, and
   *  end its response. #1773 — only a graceful service SHUTDOWN ends the stream
   *  cleanly; every other reason ERRORS it (`res.destroy(err)`), so the listener
   *  — or the relay in front of it — sees a transport error, never a clean end
   *  that reads as "nothing was lost". Idempotent: the first reason wins. */
  close(reason: FanInCloseReason = "listener-closed"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const [namespace, s] of this.sources) this.closeSource(namespace, s, reason);
    this.sources.clear();
    try {
      if (reason === "shutdown") this.res.end();
      else this.res.destroy(new Error(`amicode fan-in: listener stream closed (${reason}); resync required`));
    } catch {
      /* already torn down */
    }
    this.onClosed(reason);
  }
}

/** #1772 — the explicit, retryable beyond-cap refusal: 503 + Retry-After and a
 *  named JSON body (the `{ ok: false, error, reason }` shape of the service's
 *  other 503s). The app's stream loop treats any non-200 as a disconnect and
 *  retries; nothing about this response is an eviction of anyone else. */
function refuseBeyondCap(res: http.ServerResponse, cap: number): void {
  try {
    res.writeHead(503, {
      "content-type": "application/json",
      "cache-control": "no-cache",
      "retry-after": String(FANIN_LISTENER_CAP_RETRY_AFTER_S),
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: FANIN_LISTENER_CAP_ERROR,
        reason: "listener-cap",
        max_listeners: cap,
        retry_after_s: FANIN_LISTENER_CAP_RETRY_AFTER_S,
      }),
    );
  } catch {
    /* the refused socket is already gone — nothing to answer */
  }
}

/** The `/event` fan-in driver (ADR 0033 §D1). #1772 — ONE FanInConnection PER
 *  LISTENER: the single-origin assumption (ADR 0027: the app opens exactly one
 *  `/event`) no longer holds with multiple windows, Chat Deck panes and split
 *  panes onto the same hub. Evicting the prior listener made two views re-open
 *  against each other once per second, indefinitely, silently dropping whatever
 *  the evicted view would have received. Each listener now owns its aggregator,
 *  upstream arms and reconcile timer; the driver only tracks the live set,
 *  bounded by `maxListeners` (refusal beyond it, never an eviction). */
export class SseFanInDriver implements EventFanInDriver {
  private readonly connections = new Set<FanInConnection>();
  /** #1771 — this service's census (a silent one when none was injected). */
  readonly census: FanInCensus;
  private nextConnection = 0;
  private shuttingDown = false;

  constructor(private readonly deps: SseFanInDriverDeps) {
    this.census = deps.census ?? new FanInCensus();
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // #1772: beyond the cap the listener is REFUSED — answered here (so dispatch
    // never falls through to an un-fanned engine stream) with a retryable 503
    // and a Retry-After hint. No existing listener is closed to make room.
    const cap = this.deps.maxListeners ?? DEFAULT_FANIN_MAX_LISTENERS;
    if (this.connections.size >= cap) {
      refuseBeyondCap(res, cap);
      this.census.listenerRefused(cap);
      return true;
    }
    // #1565: always accept on the observation path. Zero non-local owners starts
    // in fleet-of-one mode (the aggregator's §D4 byte-identity relay); reconcile
    // opens peer arms as the OwnerMapFeed discovers them. #1773: a connection
    // can also close ITSELF (a fleet-of-one local-arm loss severs the listener);
    // either way it leaves the live set and the census once, under its reason.
    const conn: FanInConnection = new FanInConnection(`c${++this.nextConnection}`, this.deps, this.census, req, res, (reason) => {
      this.connections.delete(conn);
      this.census.listenerClosed(conn.id, reason);
    });
    this.connections.add(conn);
    this.census.listenerAccepted(conn);
    conn.start();
    // A departing listener closes ONLY its own connection (and so only its own
    // upstream arms); every other listener keeps streaming. #1771: a close the
    // service's own teardown caused is attributed to `shutdown`.
    res.on("close", () => conn.close(this.shuttingDown ? "shutdown" : "listener-closed"));
    return true;
  }

  /** Reconcile EVERY live connection's membership NOW (each connection's own
   *  timer is the cadence; also called directly by the arm-lifecycle tests for
   *  determinism). */
  reconcile(): void {
    for (const conn of this.connections) conn.reconcile();
  }

  /** #1771 — the service is stopping: the listener and arm closes its socket
   *  teardown triggers next are attributed `shutdown` (not `listener-closed`),
   *  and the census cadence stops. Closes nothing itself — delivery unchanged. */
  shutdown(): void {
    this.shuttingDown = true;
    this.census.stop();
  }
}
