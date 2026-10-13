// sse_fanin_driver_pump.test.ts — #1566 (Dead arm zombie: cleanup source on
// pump exit). Verifies that when an upstream SSE source ends (or throws), the
// pump() method removes it from the internal sources Map so the next
// reconcile() tick can re-open the arm — not leave a zombie that blocks
// reconnection indefinitely.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as http from "node:http";
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { SseFanInDriver, SseFrameSplitter, openHttpSseSource } from "../src/amicode_service/sse_fanin_driver";
import type { SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
import { LOCAL_NAMESPACE } from "../src/amicode_service/sse_fanin_aggregator";
import { SessionOwnerMap } from "../src/amicode_service/session_multiplexer";
import { FanInCensus, FANIN_CENSUS_INTERVAL_MS, FANIN_CLOSE_REASONS } from "../src/amicode_service/fanin_census";
import {
  fakeEngine,
  startEngineSseServer,
  writeChunks,
  largeSummaryFrame,
  sequencedEvent,
  legacyEvent,
  engineId,
  chunkBytes,
  CHUNK_64K,
  TEN_MB,
  LOCAL_EPOCH,
  PEER_EPOCH,
  replayingEngine,
  type ReplayingEngine,
} from "./fixtures/engine_stream/engine_frames";
import { parseCompositeCursor } from "../src/amicode_service/sse_composite_cursor";

// ── helpers ──────────────────────────────────────────────────────────────────

/** #1771: ENGINE-SHAPED upstream frames (test/fixtures/engine_stream) — the
 *  wire the engine's `/global/event` actually writes: a sequenced (#1776) bus
 *  event `id: <epoch>:<seq>` + one `data:` line of the serialized global event,
 *  no `event:` line. These replace the synthetic `event: message` / `id: l1`
 *  frames the suite used to feed (a wire production never sees). */
const localEvt = (seq: number, properties: Record<string, unknown>, type?: string) => sequencedEvent(LOCAL_EPOCH, seq, properties, type);
const peerEvt = (seq: number, properties: Record<string, unknown>, type?: string) => sequencedEvent(PEER_EPOCH, seq, properties, type);
const localId = (seq: number) => engineId(LOCAL_EPOCH, seq);
const peerId = (seq: number) => engineId(PEER_EPOCH, seq);

/** A controllable frame source: push frames into it, end it on demand. #1773:
 *  `end("error")` models an upstream that FAILED (the real reader's
 *  `endReason()`); a bare `end()` is a clean upstream end. */
interface Ctl {
  push(frame: string): void;
  end(why?: "end" | "error"): void;
  source: SseFrameSource;
}
function controllableSource(): Ctl {
  const queue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let ended = false;
  let reason: "end" | "error" | undefined;
  const push = (f: string): void => {
    const w = waiters.shift();
    if (w) w(f);
    else queue.push(f);
  };
  const end = (why: "end" | "error" = "end"): void => {
    if (ended) return;
    ended = true;
    reason = why;
    let w: ((v: string | null) => void) | undefined;
    while ((w = waiters.shift())) w(null);
  };
  return {
    push,
    end,
    source: {
      next(): Promise<string | null> {
        const f = queue.shift();
        if (f !== undefined) return Promise.resolve(f);
        if (ended) return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
      },
      close(): void {
        end();
      },
      endReason: () => reason,
    },
  };
}

/** A mock ServerResponse that collects writes. #1772 — also records whether the
 *  response was ENDED (an evicted listener is ended by the driver) and the
 *  status/headers/body of a non-stream answer (the beyond-cap refusal). #1773 —
 *  and whether it was DESTROYED (an error close: the listener sees a transport
 *  error, not a clean end), with the error; like a real socket teardown, a
 *  destroy fires the response's `close` listeners. */
type MockRes = http.ServerResponse & {
  text(): string;
  fireClose(): void;
  ended: boolean;
  destroyed: boolean;
  destroyError?: Error;
  status?: number;
  headerMap: Record<string, string>;
  body: string;
};
function mockRes(): MockRes {
  const chunks: string[] = [];
  const closeListeners: Array<() => void> = [];
  const res = {
    headersSent: false,
    ended: false,
    destroyed: false,
    destroyError: undefined as Error | undefined,
    status: undefined as number | undefined,
    headerMap: {} as Record<string, string>,
    body: "",
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      res.status = status;
      for (const [k, v] of Object.entries(headers ?? {})) res.headerMap[k.toLowerCase()] = String(v);
      res.headersSent = true;
      return res;
    },
    setHeader(k: string, v: string | number) {
      res.headerMap[k.toLowerCase()] = String(v);
      return res;
    },
    set statusCode(s: number) {
      res.status = s;
    },
    get statusCode(): number {
      return res.status ?? 200;
    },
    flushHeaders() {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "close") closeListeners.push(cb as () => void);
      return res;
    },
    end(chunk?: string) {
      if (typeof chunk === "string") res.body += chunk;
      res.ended = true;
    },
    destroy(err?: Error) {
      if (res.destroyed) return res;
      res.destroyed = true;
      res.destroyError = err;
      for (const cb of closeListeners) cb();
      return res;
    },
    text() {
      return chunks.join("");
    },
    fireClose() {
      for (const cb of closeListeners) cb();
    },
  };
  return res as unknown as MockRes;
}

/** #1617 — a mock ServerResponse that models REAL Node backpressure: `write()`
 *  returns `false` once `block()` has been called (a full socket buffer past the
 *  high-water mark) and stays false until `fireDrain()` — which also emits the
 *  `drain` event Node fires when the buffer clears. This drives the ACTUAL drain
 *  seam (`res.on("drain", …)`) the production `FanInConnection` must wire — the
 *  gap the shipped code left (its only `resume()` call site was a unit test that
 *  hand-called it). */
function backpressureRes(): http.ServerResponse & {
  text(): string
  fireClose(): void
  block(): void
  fireDrain(): void
} {
  const chunks: string[] = []
  const closeListeners: Array<() => void> = []
  const drainListeners: Array<() => void> = []
  let blocked = false
  return {
    headersSent: false,
    write(chunk: string) {
      chunks.push(chunk)
      return !blocked
    },
    writeHead() {
      return this
    },
    flushHeaders() {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "close") closeListeners.push(cb as () => void)
      if (event === "drain") drainListeners.push(cb as () => void)
      return this
    },
    end() {},
    text() {
      return chunks.join("")
    },
    fireClose() {
      for (const cb of closeListeners) cb()
    },
    block() {
      blocked = true
    },
    fireDrain() {
      blocked = false
      for (const cb of drainListeners) cb()
    },
  } as unknown as http.ServerResponse & {
    text(): string
    fireClose(): void
    block(): void
    fireDrain(): void
  }
}

/** #1617 — a controllable source that also records pause()/resume() so a test can
 *  assert the driver paused the upstream while the downstream was backpressured
 *  and resumed it on drain. */
interface PausableCtl extends Ctl {
  paused: boolean
  pauseCalls: number
  resumeCalls: number
}
function pausableSource(): PausableCtl {
  const base = controllableSource()
  const inner = base.source // capture BEFORE we reassign ctl.source (base === ctl)
  const ctl = base as unknown as PausableCtl
  ctl.paused = false
  ctl.pauseCalls = 0
  ctl.resumeCalls = 0
  const wrapped: SseFrameSource = {
    next: () => inner.next(),
    close: () => inner.close(),
    pause() {
      ctl.paused = true
      ctl.pauseCalls += 1
    },
    resume() {
      ctl.paused = false
      ctl.resumeCalls += 1
    },
  }
  ctl.source = wrapped
  return ctl
}

function mockReq(url = "/event"): http.IncomingMessage {
  return { url, headers: {} } as unknown as http.IncomingMessage;
}

/** Let async pump iterations drain (microtasks + one macrotask tick). */
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════
// #1566 — dead arm zombie: cleanup source on pump exit
// ══════════════════════════════════════════════════════════════════════════════
describe("#1566 — dead arm zombie: pump exit cleans up source so reconcile re-opens the arm", () => {
  it("peer source ends → pump removes it → reconcile re-opens → new frames arrive", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ]);

    const F1 = peerEvt(1, { from: "studio", n: 1 });
    const F2 = peerEvt(2, { from: "studio", n: 2 });

    // Track every openUpstream call and the controllable sources they return.
    const openCalls: string[] = [];
    const peerCtls: Ctl[] = [];
    const localCtl = controllableSource();

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999, // no automatic reconcile — we call it manually
      openUpstream: (r) => {
        openCalls.push(r.namespace);
        if (r.namespace === "local") return localCtl.source;
        const ctl = controllableSource();
        peerCtls.push(ctl);
        return ctl.source;
      },
    });

    const res = mockRes();
    driver.handle(mockReq(), res);
    await tick();

    // ── Step 1: the initial start() + reconcile() opened the peer arm ──────
    const initialPeerOpens = openCalls.filter((ns) => ns === "studio").length;
    expect(initialPeerOpens).toBe(1);

    // ── Step 2: push a frame from the peer — it arrives downstream ─────────
    peerCtls[0].push(F1);
    await tick();
    expect(res.text()).toContain('"from":"studio"');
    expect(res.text()).toContain('"n":1');

    // ── Step 3: end the peer source (upstream closure / disconnect) ─────────
    peerCtls[0].end();
    await tick(); // let the async pump() exit

    // ── Step 4: reconcile — should detect the dead arm and re-open it ──────
    driver.reconcile();
    await tick();

    const afterReconcileOpens = openCalls.filter((ns) => ns === "studio").length;
    expect(afterReconcileOpens).toBe(2); // <── the crux: arm was RE-OPENED

    // ── Step 5: the new source delivers a frame — it arrives downstream ────
    peerCtls[1].push(F2);
    await tick();
    expect(res.text()).toContain('"n":2');

    // Cleanup
    localCtl.end();
    for (const ctl of peerCtls) ctl.end();
    res.fireClose();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1580 — the fan-in must OPEN its upstream arms against `/global/event`, not the
// literal `/event`. The vendored engine + the app speak the v1 "global instance"
// protocol whose event bus is `/global/event`; opening an arm at `/event` reads a
// path the engine does not serve as the global bus, so the owner's agent output
// never reaches the aggregator and the observer's live view stays stuck. BOTH the
// ALWAYS-present local arm (§D4, opened in start()) and every peer arm (opened in
// reconcile()) go through the same openArm() upstream request, so a single path
// covers both.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1580 — fan-in opens its local AND peer arms against /global/event", () => {
  it("the injected upstream opener receives path === /global/event for both the LOCAL arm and a peer arm", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ]);

    // Record the FULL upstream request (namespace + path) for every arm opened.
    const opened: Array<{ namespace: string; path: string }> = [];
    const localCtl = controllableSource();
    const peerCtl = controllableSource();

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999, // no automatic reconcile — start()+its inline reconcile open both arms
      openUpstream: (r) => {
        opened.push({ namespace: r.namespace, path: r.path });
        return r.namespace === LOCAL_NAMESPACE ? localCtl.source : peerCtl.source;
      },
    });

    const res = mockRes();
    driver.handle(mockReq(), res);
    await tick();

    // Falsifiable: before the fix openArm() hard-coded path: "/event", so both
    // arms opened against "/event" and these assertions failed.
    const localArm = opened.find((o) => o.namespace === LOCAL_NAMESPACE);
    const peerArm = opened.find((o) => o.namespace === "studio");
    expect(localArm).toBeDefined();
    expect(peerArm).toBeDefined();
    expect(localArm!.path).toBe("/global/event");
    expect(peerArm!.path).toBe("/global/event");

    // Cleanup
    localCtl.end();
    peerCtl.end();
    res.fireClose();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1601 — dead LOCAL arm: reconcile re-opens the local arm. start() opens the
// LOCAL arm exactly once; pump() removes ANY dead source (incl. local) on
// upstream end so a future reconcile() "can re-open the arm". BUT reconcile()
// only iterated agg.activeArms() — which is peers-only by construction (it
// returns [...peerArms], never `local`) — and explicitly `continue`d past
// LOCAL on the close side, so nothing re-opened the LOCAL arm. Once the LOCAL
// upstream ended, the local view was dead until a full handle() (webview
// reload): peer frames kept the composite stream non-silent so the client
// watchdog never fired. This mirrors the #1566 peer test, but for LOCAL.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1601 — dead LOCAL arm: reconcile re-opens the local arm", () => {
  it("local source ends → pump removes it → reconcile re-opens → new local frames arrive, res never ends", async () => {
    // One owned peer keeps the composite stream alive (mirrors the real bug: the
    // peer frames mask the dead local arm from the watchdog). Not strictly
    // required for the assertions, but faithful to the failure mode.
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ]);

    const L1 = localEvt(1, { from: "macbook", n: 1 });
    const L2 = localEvt(2, { from: "macbook", n: 2 });

    // Track every openUpstream call; hand out a FRESH local source per open so we
    // can distinguish the re-opened arm from the original.
    const openCalls: string[] = [];
    const localCtls: Ctl[] = [];
    const peerCtls: Ctl[] = [];

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999, // no automatic reconcile — we call it manually
      openUpstream: (r) => {
        openCalls.push(r.namespace);
        if (r.namespace === LOCAL_NAMESPACE) {
          const ctl = controllableSource();
          localCtls.push(ctl);
          return ctl.source;
        }
        const ctl = controllableSource();
        peerCtls.push(ctl);
        return ctl.source;
      },
    });

    const res = mockRes();
    driver.handle(mockReq(), res);
    await tick();

    // ── AC1: start() opened the LOCAL arm exactly once ──────────────────────
    const initialLocalOpens = openCalls.filter((ns) => ns === LOCAL_NAMESPACE).length;
    expect(initialLocalOpens).toBe(1);

    // ── AC2: a LOCAL frame pushed before the drop reaches downstream res ────
    localCtls[0].push(L1);
    await tick();
    expect(res.text()).toContain('"from":"macbook"');
    expect(res.text()).toContain('"n":1');

    // ── end the LOCAL source (upstream closure / engine restart) ───────────
    localCtls[0].end();
    await tick(); // let the async pump() exit and delete the dead source

    // ── AC3: reconcile — should detect the dead LOCAL arm and re-open it ────
    //   (this is the assertion that FAILS before the fix)
    driver.reconcile();
    await tick();

    const afterReconcileLocalOpens = openCalls.filter((ns) => ns === LOCAL_NAMESPACE).length;
    expect(afterReconcileLocalOpens).toBe(2); // <── the crux: LOCAL arm was RE-OPENED

    // ── AC4: a frame from the NEW local source reaches downstream res ───────
    localCtls[1].push(L2);
    await tick();
    expect(res.text()).toContain('"n":2');

    // ── AC5: downstream res was NEVER ended across the drop+reopen ──────────
    //   The connection stays open beneath the arm churn. mockRes.end() is a
    //   no-op that records nothing, so we assert the surviving-flow intent:
    //   BOTH the pre-drop and post-reopen frames are present in the ONE stream
    //   (a re-ended/replaced res would have lost the earlier frame or split it).
    expect(res.text()).toContain('"n":1');
    expect(res.text()).toContain('"n":2');

    // Cleanup
    for (const ctl of localCtls) ctl.end();
    for (const ctl of peerCtls) ctl.end();
    res.fireClose();
  });

  it("AC6 fleet-of-one idempotence: healthy LOCAL arm + no peers → repeated reconcile() never re-opens or duplicates it", async () => {
    // No owners at all → fleet-of-one. The LOCAL arm is the only source; a
    // healthy one must survive any number of reconcile() ticks untouched.
    const ownerMap = new SessionOwnerMap(); // no owners

    const openCalls: string[] = [];
    const localCtls: Ctl[] = [];

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      openUpstream: (r) => {
        openCalls.push(r.namespace);
        const ctl = controllableSource();
        if (r.namespace === LOCAL_NAMESPACE) localCtls.push(ctl);
        return ctl.source;
      },
    });

    const res = mockRes();
    driver.handle(mockReq(), res);
    await tick();

    // start() opened LOCAL once.
    expect(openCalls.filter((ns) => ns === LOCAL_NAMESPACE).length).toBe(1);

    // Repeated reconciles against a HEALTHY local arm must not re-open or
    // duplicate it — the call-site guard fires ONLY when LOCAL is absent.
    for (let i = 0; i < 5; i++) {
      driver.reconcile();
      await tick();
    }
    expect(openCalls.filter((ns) => ns === LOCAL_NAMESPACE).length).toBe(1);

    // Cleanup
    for (const ctl of localCtls) ctl.end();
    res.fireClose();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1617 — the fan-in driver must re-derive the transparent proxy's backpressure
// by hand: wire the downstream `drain` edge to the aggregator's resume() so
// `flowing` re-arms and the buffers flush in order, and pause the upstream
// sources while backpressured (resume on drain) so the bounded buffers cannot
// overflow-drop. This is the EXACT gap that shipped: the aggregator's resume()
// existed but its only production caller did not — the unit suite passed only
// because it hand-called resume(). This test drives the REAL drain seam.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1617 — driver wires drain→resume + upstream pause/resume", () => {
  it("a backpressured frame + a stranded frame behind it flush IN ORDER on drain, with zero drops and no reload", async () => {
    // Composite mode: one owned peer, so the local namespace goes through the
    // shared flowing-gated path (the exact user-visible failure — a large LOCAL
    // frame strands the frames after it in composite mode).
    const ownerMap = new SessionOwnerMap()
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ])

    const F1 = localEvt(1, { from: "macbook", n: 1 })
    const F2 = localEvt(2, { from: "macbook", n: 2 }) // the stranded idle-equivalent

    const localCtl = pausableSource()
    const peerCtl = pausableSource()

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999,
      openUpstream: (r) => (r.namespace === LOCAL_NAMESPACE ? localCtl.source : peerCtl.source),
    })

    const res = backpressureRes()
    driver.handle(mockReq(), res)
    await tick()

    // The downstream socket fills: the NEXT write backpressures.
    res.block()
    localCtl.push(F1) // trip-frame: written, res.write() → false, flowing=false
    await tick()
    localCtl.push(F2) // stranded behind the trip-frame — buffered, NOT delivered
    await tick()

    // The wedge, reproduced through the REAL seam: frame 1 written, frame 2 is
    // stranded, and the upstreams were paused so nothing overflows.
    expect(res.text()).toContain('"n":1')
    expect(res.text()).not.toContain('"n":2')
    expect(localCtl.pauseCalls).toBeGreaterThan(0)
    expect(peerCtl.pauseCalls).toBeGreaterThan(0)

    // The socket drains: the driver's drain wiring calls resume() → flowing
    // re-arms, the stranded frame flushes IN ORDER, and the upstreams resume.
    res.fireDrain()
    await tick()

    expect(res.text()).toContain('"n":2')
    expect(res.text().indexOf('"n":1')).toBeLessThan(res.text().indexOf('"n":2'))
    expect(localCtl.resumeCalls).toBeGreaterThan(0)
    expect(peerCtl.resumeCalls).toBeGreaterThan(0)

    // Cleanup
    localCtl.end()
    peerCtl.end()
    res.fireClose()
  })

  it("FLEET-OF-ONE (zero peers): the verbatim path backpressures + heals on drain, byte-identical", async () => {
    // No owners at all → the aggregator's §D4 zero-peer verbatim branch. This is
    // the solo-machine wedge the composite test above does NOT exercise.
    const ownerMap = new SessionOwnerMap()

    const F1 = localEvt(7, { big: "tool-output" })
    const F2 = localEvt(8, { status: "idle" }, "session.status") // clears the rail

    const localCtl = pausableSource()

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      openUpstream: () => localCtl.source,
    })

    const res = backpressureRes()
    driver.handle(mockReq(), res)
    await tick()

    res.block()
    localCtl.push(F1) // trip-frame: written verbatim, res.write() → false
    await tick()
    localCtl.push(F2) // the idle frame — must be HELD, not fired into a full socket
    await tick()

    // The wedge, through the real seam: idle frame stranded, local upstream paused.
    expect(res.text()).toContain('"big":"tool-output"')
    expect(res.text()).not.toContain('"status":"idle"')
    expect(localCtl.pauseCalls).toBeGreaterThan(0)

    res.fireDrain()
    await tick()

    // Healed: the idle frame is delivered, in order, and BYTE-IDENTICAL — no
    // composite-id rewrite, no namespacing (the #1264 guard on the live seam).
    expect(res.text()).toContain('"status":"idle"')
    expect(res.text()).toBe(F1 + F2)
    expect(res.text()).not.toContain("local\u001f")
    expect(res.text()).not.toContain(`local=${localId(8)}`)
    expect(localCtl.resumeCalls).toBeGreaterThan(0)

    localCtl.end()
    res.fireClose()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// #1638 — a re-opened arm must resume from the LAST-DELIVERED id (the aggregator's
// live per-namespace cursor), NOT the stale connect-time id, and a NON-INITIAL
// re-open must force a client refetch via one composite-mode gap (Step 0 = the
// upstream /global/event route does NOT replay on ?lastEventID). In fleet-of-one
// no gap is emitted and the verbatim stream stays byte-identical (#1264).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1638 — re-open resumes from last-delivered id + composite-mode reconnect gap", () => {
  it("a re-opened LOCAL arm resumes from the LAST-DELIVERED id, not the connect-time id", async () => {
    // Connect with a stale local cursor of l0; deliver l1, l2; drop the arm;
    // the re-open must request lastEventID = l2 (the last DELIVERED), not l0.
    const ownerMap = new SessionOwnerMap()
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ])

    const L1 = localEvt(1, { from: "macbook", n: 1 })
    const L2 = localEvt(2, { from: "macbook", n: 2 })

    const opened: Array<{ namespace: string; lastEventId?: string }> = []
    const localCtls: Ctl[] = []
    const peerCtl = controllableSource()

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999,
      openUpstream: (r) => {
        opened.push({ namespace: r.namespace, lastEventId: r.lastEventId })
        if (r.namespace === LOCAL_NAMESPACE) {
          const ctl = controllableSource()
          localCtls.push(ctl)
          return ctl.source
        }
        return peerCtl.source
      },
    })

    const res = mockRes()
    driver.handle(mockReq(`/event?lastEventID=local=${localId(0)};studio=${peerId(0)}`), res)
    await tick()

    // initial local open used the connect cursor l0
    const initialLocalOpen = opened.find((o) => o.namespace === LOCAL_NAMESPACE)
    expect(initialLocalOpen?.lastEventId).toBe(localId(0))

    // deliver two local frames — the aggregator's live local cursor advances to l2
    localCtls[0].push(L1)
    await tick()
    localCtls[0].push(L2)
    await tick()

    // the local arm drops
    localCtls[0].end()
    await tick()

    // reconcile re-opens the local arm — it MUST resume from l2 (last delivered),
    // NOT l0 (the stale connect id). This is the crux the issue names.
    driver.reconcile()
    await tick()

    const reopenLocal = opened.filter((o) => o.namespace === LOCAL_NAMESPACE)
    expect(reopenLocal.length).toBe(2)
    expect(reopenLocal[1].lastEventId).toBe(localId(2)) // <── last-delivered, not the connect-time id

    localCtls.forEach((c) => c.end())
    peerCtl.end()
    res.fireClose()
  })

  // #1773 AC1: in BOTH engine modes — an older peer engine sends no `id:` lines,
  // and its re-open must gap all the same ("delivered" = any data frame).
  // #1777: the sequenced peer has engine ids to resume from, so its re-open
  // RESUMES from the last delivered id instead — no gap (the replay covers it).
  for (const mode of ["sequenced", "legacy"] as const)
  it(`COMPOSITE MODE (${mode} peer engine): re-opening a dropped peer arm ${mode === "legacy" ? "emits exactly one amicode.sync.gap naming it" : "resumes from its last delivered id, with no gap"}`, async () => {
    const ownerMap = new SessionOwnerMap()
    ownerMap.update([
      { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    ])

    const studio = mode === "legacy" ? fakeEngine({ legacy: true }) : fakeEngine({ epoch: PEER_EPOCH })
    const P1 = studio.event("message.part.updated", { from: "studio", n: 1 })

    const localCtl = controllableSource()
    const peerCtls: Ctl[] = []
    const peerOpens: Array<string | undefined> = []

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999,
      openUpstream: (r) => {
        if (r.namespace === LOCAL_NAMESPACE) return localCtl.source
        peerOpens.push(r.lastEventId)
        const ctl = controllableSource()
        peerCtls.push(ctl)
        return ctl.source
      },
    })

    const res = mockRes()
    driver.handle(mockReq(), res)
    await tick()

    // deliver a peer frame so the arm has DELIVERED (a re-open is now non-initial)
    peerCtls[0].push(P1)
    await tick()
    expect(res.text()).toContain('"from":"studio"')
    const beforeGap = (res.text().match(/amicode\.sync\.gap/g) ?? []).length
    expect(beforeGap).toBe(0) // initial open emitted no gap

    // drop the peer arm, then reconcile re-opens it
    peerCtls[0].end()
    await tick()
    driver.reconcile()
    await tick()

    const gapMatches = res.text().match(/event: amicode\.sync\.gap/g) ?? []
    if (mode === "sequenced") {
      expect(peerOpens).toEqual([undefined, studio.idAt(1)]) // resumed from the last delivered id
      expect(gapMatches.length).toBe(0)
    } else {
      expect(peerOpens).toEqual([undefined, undefined]) // nothing to resume from
      expect(gapMatches.length).toBe(1)
      const gapFrame = res.text().split("\n\n").find((f) => f.includes("amicode.sync.gap"))!
      const dataLine = gapFrame.split("\n").find((l) => l.startsWith("data:"))!
      const parsed = JSON.parse(dataLine.slice("data:".length).trim())
      expect(parsed.namespaces).toContain("studio")
    }

    localCtl.end()
    peerCtls.forEach((c) => c.end())
    res.fireClose()
  })

  // #1773 AC2 supersedes #1638's "the solo-mode arm re-opens silently": a silent
  // re-open loses the stretch between the arm's end and its re-subscription with
  // nothing to announce it. The #1264 guards stay: no synthetic frame, and the
  // stream is byte-identical to what the local source delivered while connected.
  // #1777: the sever is the fallback for a local engine WITHOUT ids (older than
  // #1776) — a sequenced one resumes instead (the #1777 suite) — so L1 is legacy.
  it("FLEET-OF-ONE (zero peers): a re-opened LOCAL arm emits NO gap, stays byte-identical (#1264), and severs the listener (#1773)", async () => {
    const ownerMap = new SessionOwnerMap() // no owners → fleet-of-one

    const L1 = legacyEvent({ from: "macbook", n: 1 })

    const localCtls: Ctl[] = []

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      openUpstream: () => {
        const ctl = controllableSource()
        localCtls.push(ctl)
        return ctl.source
      },
    })

    const res = mockRes()
    driver.handle(mockReq(), res)
    await tick()

    // deliver a local frame, drop the arm, re-open
    localCtls[0].push(L1)
    await tick()
    localCtls[0].end()
    await tick()
    driver.reconcile()
    await tick()

    // NO synthetic frame anywhere; the verbatim stream is exactly what was delivered.
    expect(res.text()).not.toContain("amicode.sync.gap")
    expect(res.text()).not.toContain("local\u001f")
    expect(res.text()).toBe(L1) // byte-identical
    // the loss is announced by severing: a transport error, not a clean end
    expect(res.destroyed).toBe(true)
    expect(res.destroyError).toBeInstanceOf(Error)
    expect(res.ended).toBe(false)
    expect(localCtls).toHaveLength(1) // and the severed listener opens nothing more

    localCtls.forEach((c) => c.end())
    res.fireClose()
  })

  it("fleet-of-one cursor bookkeeping: a never-delivered arm re-opens from the connect cursor; a delivered one resumes from its last-delivered id, and so does a reconnecting listener", async () => {
    const ownerMap = new SessionOwnerMap()

    const L1 = localEvt(1, { from: "macbook", n: 1 })

    const opened: Array<{ namespace: string; lastEventId?: string }> = []
    const localCtls: Ctl[] = []

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      openUpstream: (r) => {
        opened.push({ namespace: r.namespace, lastEventId: r.lastEventId })
        const ctl = controllableSource()
        localCtls.push(ctl)
        return ctl.source
      },
    })

    const res = mockRes()
    driver.handle(mockReq(`/event?lastEventID=${localId(0)}`), res)
    await tick()
    expect(opened[0].lastEventId).toBe(localId(0)) // initial: connect cursor

    // the arm fails before delivering anything: nothing was lost → a plain re-open,
    // still resumed from the connect-time cursor (the #1638 fallback)
    localCtls[0].end("error")
    await tick()
    driver.reconcile()
    await tick()
    expect(opened).toHaveLength(2)
    expect(opened[1].lastEventId).toBe(localId(0))
    expect(res.destroyed).toBe(false)

    // #1777: the re-opened arm delivers, then drops → it RESUMES from the last
    // delivered id (the engine replays the stretch) — the listener is not severed
    localCtls[1].push(L1)
    await tick()
    localCtls[1].end()
    await tick()
    driver.reconcile()
    await tick()
    expect(res.destroyed).toBe(false)
    expect(opened).toHaveLength(3)
    expect(opened[2].lastEventId).toBe(localId(1)) // last-delivered, not the stale connect id

    // the client's cursor is the last SSE id it saw on the verbatim stream …
    const lastSeen = [...res.text().matchAll(/^id: (.*)$/gm)].at(-1)?.[1]
    expect(lastSeen).toBe(localId(1))
    // … and its reconnect resumes the local arm from exactly that id
    res.fireClose()
    const again = mockRes()
    driver.handle(mockReq(`/event?lastEventID=${lastSeen}`), again)
    await tick()
    expect(opened[3].lastEventId).toBe(localId(1))

    localCtls.forEach((c) => c.end())
    again.fireClose()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// #1773 AC2 — FLEET-OF-ONE loss is signalled by SEVERING, never by a frame. A
// synthetic gap frame may not enter the solo pass-through stream (#1264), so a
// re-opened local arm (one that delivered data) ends the listener's stream with a
// transport error: the client registers the disconnect and resyncs. While
// connected, the stream stays byte-identical to the local source. Engine-shaped
// fixtures in both modes (legacy id-less, sequenced).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1773 AC2 — fleet-of-one: a re-opened local arm severs the listener with a transport error", () => {
  // #1777: the sever is the fallback for a local engine without ids (legacy); a
  // sequenced engine's arm RESUMES from its last delivered id instead — the
  // replay announces nothing because nothing was lost, and the listener lives.
  for (const mode of ["legacy", "sequenced"] as const) {
    for (const why of ["end", "error"] as const) {
      const title =
        mode === "legacy"
          ? `${mode} engine, upstream ${why}: no synthetic frame, byte-identical while connected, then an error close named ${why === "end" ? "upstream-end" : "upstream-error"}`
          : `${mode} engine, upstream ${why}: no synthetic frame, and the arm resumes from its last id — no sever`
      it(title, async () => {
        const { census, lines } = testCensus()
        const localCtls: Ctl[] = []
        const opened: Array<string | undefined> = []
        const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), {
          census,
          openUpstream: (r) => {
            opened.push(r.lastEventId)
            const ctl = controllableSource()
            localCtls.push(ctl)
            return ctl.source
          },
        })
        const engine = mode === "legacy" ? fakeEngine({ legacy: true }) : fakeEngine({ epoch: LOCAL_EPOCH })
        const res = mockRes()
        driver.handle(mockReq("/global/event"), res)
        const frames = [
          engine.connected(),
          engine.event("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
          ...engine.stored("message.part.updated", { part: { id: "prt_1", text: "ciao" } }, { aggregateID: "ses_1" }),
          engine.heartbeat(),
        ]
        for (const f of frames) localCtls[0].push(f)
        await flush()
        expect(res.text()).toBe(frames.join("")) // connected: byte-identical (#1264)

        localCtls[0].end(why) // the local upstream is lost …
        await flush()
        expect(res.destroyed).toBe(false) // … nothing is decided until the re-open
        driver.reconcile() // the re-open: resume, or sever — never re-open silently
        await flush()

        expect(res.text()).toBe(frames.join("")) // no synthetic frame was injected
        const reason = why === "end" ? "upstream-end" : "upstream-error"
        expect(lines).toContain(`[fanin] arm-closed plane=observe conn=c1 arm=local reason=${reason}`)
        if (mode === "sequenced") {
          expect(res.destroyed).toBe(false)
          expect(opened).toEqual([undefined, engine.idAt(engine.seq)])
          expect(lines.at(-1)).toBe("[fanin] arm-opened plane=observe conn=c1 arm=local opens=2")
          expect(census.snapshot()).toMatchObject({ listeners: 1, accepted: 1, closed: 0 })
          res.fireClose()
          return
        }
        expect(res.destroyed).toBe(true)
        expect(res.destroyError).toBeInstanceOf(Error)
        expect(res.ended).toBe(false) // an error close, never a clean end
        expect(localCtls).toHaveLength(1) // the severed listener re-opened nothing

        // the census names the listener's close by its cause (#1771's set)
        expect(lines).toContain(`[fanin] listener-closed plane=observe conn=c1 reason=${reason} listeners=0`)
        expect(census.snapshot()).toMatchObject({ listeners: 0, accepted: 1, closed: 1, evictions: 0 })
      })
    }
  }

  it("a local arm that never delivered a data frame re-opens normally — no sever (nothing was lost)", async () => {
    const localCtls: Ctl[] = []
    const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), {
      openUpstream: () => {
        const ctl = controllableSource()
        localCtls.push(ctl)
        return ctl.source
      },
    })
    const res = mockRes()
    driver.handle(mockReq("/global/event"), res)
    localCtls[0].push(": keep-alive\n\n") // a comment is not data
    await flush()
    localCtls[0].end("error")
    await flush()
    driver.reconcile()
    await flush()
    expect(res.destroyed).toBe(false)
    expect(localCtls).toHaveLength(2)
    const f = fakeEngine({ legacy: true }).connected()
    localCtls[1].push(f)
    await flush()
    expect(res.text()).toBe(": keep-alive\n\n" + f)
    localCtls.forEach((c) => c.end())
    res.fireClose()
  })

  it("severing one listener leaves another listener's stream untouched", async () => {
    const localCtls: Ctl[] = []
    const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), {
      openUpstream: () => {
        const ctl = controllableSource()
        localCtls.push(ctl)
        return ctl.source
      },
    })
    const engine = fakeEngine({ legacy: true })
    const resA = mockRes()
    const resB = mockRes()
    driver.handle(mockReq("/global/event"), resA) // localCtls[0]
    driver.handle(mockReq("/global/event"), resB) // localCtls[1]
    const c = engine.connected()
    localCtls[0].push(c)
    localCtls[1].push(c)
    await flush()
    localCtls[0].end() // only A's upstream is lost
    await flush()
    driver.reconcile()
    await flush()
    expect(resA.destroyed).toBe(true)
    expect(resB.destroyed).toBe(false)
    const h = engine.heartbeat()
    localCtls[1].push(h)
    await flush()
    expect(resB.text()).toBe(c + h)
    localCtls.forEach((x) => x.end())
    resB.fireClose()
  })

  it("over REAL sockets: the listener's response errors (no clean end) after exactly the frames the local engine sent", async () => {
    const engine = fakeEngine({ legacy: true }) // an old engine: id-less frames
    const sent = [engine.connected(), engine.event("session.status", { sessionID: "ses_1", status: { type: "idle" } })]
    const upstream = await startEngineSseServer((res) => {
      for (const f of sent) res.write(f)
      setImmediate(() => res.end()) // the local engine ends its stream (a restart)
    })
    const lines: string[] = []
    const w = lineWaiter(lines)
    const driver = new SseFanInDriver({
      ownerMap: new SessionOwnerMap(),
      localMachineId: "macbook",
      localEventUrl: () => upstream.url,
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      census: new FanInCensus({ plane: "observe", sink: w.sink }),
    })
    const front = http.createServer((req, res) => void driver.handle(req, res))
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r))
    const { port } = front.address() as import("node:net").AddressInfo
    try {
      let body = ""
      let haveAll: () => void = () => undefined
      const received = new Promise<void>((r) => (haveAll = r))
      const outcome = new Promise<"end" | "error">((resolve) => {
        http.get(`http://127.0.0.1:${port}/global/event`, (res) => {
          res.setEncoding("utf8")
          res.on("data", (c: string) => {
            body += c
            if (body === sent.join("")) haveAll()
          })
          res.on("end", () => resolve("end"))
          res.on("error", () => resolve("error"))
        })
      })
      await w.waitFor((l) => l.includes("arm=local reason=upstream-end"))
      await received // the listener holds every frame (production's reconcile is a later timer tick)
      driver.reconcile() // the re-open → sever
      expect(await outcome).toBe("error") // a transport error, never a clean end of stream
      expect(body).toBe(sent.join("")) // byte-identical while connected, nothing injected
      expect(await w.waitFor((l) => l.startsWith("[fanin] listener-closed"))).toContain("reason=upstream-end")
    } finally {
      front.closeAllConnections?.()
      await new Promise<void>((r) => front.close(() => r()))
      await upstream.stop()
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// #1772 — the fan-in serves EVERY listener. Each global-stream listener gets its
// own FanInConnection (aggregator + upstream arms + reconcile); a second view
// (another window, a Chat Deck pane, a split pane) no longer evicts the first.
// The harness models the upstream origins as BROADCAST buses (the engine's
// global bus delivers every event to every open subscription), so a listener
// whose arms were torn down by an eviction visibly stops receiving frames.
// ══════════════════════════════════════════════════════════════════════════════

/** A fake set of upstream origins: every `openUpstream` call is a NEW
 *  subscription on its namespace's bus; `broadcast` delivers a frame to every
 *  OPEN subscription of that namespace. Records every open and every close. */
interface FakeOrigins {
  openUpstream: (r: { namespace: string; lastEventId?: string }) => SseFrameSource;
  broadcast(namespace: string, frame: string): void;
  opens(namespace: string): number;
  closes(namespace: string): number;
  live(namespace: string): number;
}
function fakeOrigins(): FakeOrigins {
  const subs = new Map<string, Set<Ctl>>();
  const openCount = new Map<string, number>();
  const closeCount = new Map<string, number>();
  const bump = (m: Map<string, number>, ns: string) => m.set(ns, (m.get(ns) ?? 0) + 1);
  return {
    openUpstream(r) {
      const ctl = controllableSource();
      const set = subs.get(r.namespace) ?? new Set<Ctl>();
      subs.set(r.namespace, set);
      set.add(ctl);
      bump(openCount, r.namespace);
      return {
        next: () => ctl.source.next(),
        close: () => {
          if (set.delete(ctl)) bump(closeCount, r.namespace);
          ctl.end();
        },
      };
    },
    broadcast(namespace, frame) {
      for (const ctl of subs.get(namespace) ?? []) ctl.push(frame);
    },
    opens: (ns) => openCount.get(ns) ?? 0,
    closes: (ns) => closeCount.get(ns) ?? 0,
    live: (ns) => subs.get(ns)?.size ?? 0,
  };
}

const STUDIO_OWNED = [
  { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
];

function twoListenerDriver(origins: FakeOrigins, ownerMap: SessionOwnerMap, extra: Partial<ConstructorParameters<typeof SseFanInDriver>[0]> = {}): SseFanInDriver {
  return new SseFanInDriver({
    ownerMap,
    localMachineId: "macbook",
    localEventUrl: () => "http://local.invalid",
    peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
    peerToken: (id) =>
      id === "studio"
        ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
        : { ok: false as const, reason: "absent" as const },
    reconcileMs: 999_999,
    openUpstream: origins.openUpstream,
    ...extra,
  });
}

describe("#1772 AC1 — two concurrent listeners both stay connected and both receive every frame", () => {
  it("listener A and listener B each receive the local arm's AND the peer arm's frames; neither is ended", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap);

    const resA = mockRes();
    const resB = mockRes();
    expect(driver.handle(mockReq("/global/event"), resA)).toBe(true);
    await tick();
    expect(driver.handle(mockReq("/global/event"), resB)).toBe(true);
    await tick();

    origins.broadcast(LOCAL_NAMESPACE, localEvt(1, { from: "macbook", n: 1 }));
    origins.broadcast("studio", peerEvt(1, { from: "studio", n: 2 }));
    await tick();

    for (const res of [resA, resB]) {
      expect(res.ended).toBe(false); // still connected — no eviction
      expect(res.text()).toContain('"from":"macbook"');
      expect(res.text()).toContain('"from":"studio"');
    }

    resA.fireClose();
    resB.fireClose();
  });
});

describe("#1772 AC2 — closing one listener closes ONLY that listener's upstream arms", () => {
  it("A departs → exactly A's local + peer arms close; B keeps its arms and keeps streaming, uninterrupted", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap);

    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    await tick();
    driver.handle(mockReq("/global/event"), resB);
    await tick();
    // Both listeners hold their own local + peer arm.
    expect(origins.live(LOCAL_NAMESPACE)).toBe(2);
    expect(origins.live("studio")).toBe(2);

    origins.broadcast(LOCAL_NAMESPACE, localEvt(1, { n: "before" }));
    await tick();

    // Listener A departs (its socket closes).
    resA.fireClose();
    await tick();

    // Exactly A's two arms closed; B's two arms untouched.
    expect(origins.closes(LOCAL_NAMESPACE)).toBe(1);
    expect(origins.closes("studio")).toBe(1);
    expect(origins.live(LOCAL_NAMESPACE)).toBe(1);
    expect(origins.live("studio")).toBe(1);

    // B keeps streaming on the SAME arms (no re-open), from both origins.
    driver.reconcile();
    await tick();
    origins.broadcast(LOCAL_NAMESPACE, localEvt(2, { n: "after-local" }));
    origins.broadcast("studio", peerEvt(2, { n: "after-peer" }));
    await tick();
    expect(resB.ended).toBe(false);
    expect(resB.text()).toContain('"n":"before"');
    expect(resB.text()).toContain('"n":"after-local"');
    expect(resB.text()).toContain('"n":"after-peer"');
    expect(origins.opens(LOCAL_NAMESPACE)).toBe(2); // one per listener, never re-opened
    expect(origins.opens("studio")).toBe(2);
    // The departed listener receives nothing further.
    expect(resA.text()).not.toContain('"n":"after-local"');

    resB.fireClose();
    await tick();
    expect(origins.live(LOCAL_NAMESPACE)).toBe(0);
    expect(origins.live("studio")).toBe(0);
  });
});

/** Poll until `cond` holds (or time out) — for the cadence-driven tests, where
 *  each connection's own reconcile timer (not a manual call) does the work. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await tick(5);
  return cond();
}

describe("#1772 AC3 — reconcile updates EVERY live connection's membership", () => {
  it("driver.reconcile() opens a newly-owned peer's arm on BOTH listeners, and closes it on both when it goes dark", async () => {
    const ownerMap = new SessionOwnerMap(); // fleet-of-one at connect
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap);

    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await tick();
    expect(origins.opens("studio")).toBe(0);

    ownerMap.update(STUDIO_OWNED);
    driver.reconcile();
    await tick();
    expect(origins.live("studio")).toBe(2); // one peer arm per listener
    origins.broadcast("studio", peerEvt(1, { from: "studio" }));
    await tick();
    expect(resA.text()).toContain('"from":"studio"');
    expect(resB.text()).toContain('"from":"studio"');

    ownerMap.update([]);
    driver.reconcile();
    await tick();
    expect(origins.live("studio")).toBe(0); // both listeners dropped the dark peer
    expect(origins.live(LOCAL_NAMESPACE)).toBe(2); // local arms untouched (§D4)

    resA.fireClose();
    resB.fireClose();
  });

  it("on its CADENCE (no manual reconcile): both listeners pick up a new owner, then drop it", async () => {
    const ownerMap = new SessionOwnerMap();
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap, { reconcileMs: 20 });

    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await tick();

    ownerMap.update(STUDIO_OWNED);
    expect(await until(() => origins.live("studio") === 2)).toBe(true);
    origins.broadcast("studio", peerEvt(1, { from: "studio" }));
    await tick();
    expect(resA.text()).toContain('"from":"studio"');
    expect(resB.text()).toContain('"from":"studio"');

    ownerMap.update([]);
    expect(await until(() => origins.live("studio") === 0)).toBe(true);

    resA.fireClose();
    resB.fireClose();
    // A closed listener's timer is stopped: a later owner change opens nothing.
    const opensAfterClose = origins.opens("studio");
    ownerMap.update(STUDIO_OWNED);
    await tick(80);
    expect(origins.opens("studio")).toBe(opensAfterClose);
  });
});

describe("#1772 AC4 — a listener beyond the cap is refused (retryable), never by evicting one", () => {
  it("default cap 16: the 17th listener gets 503 + Retry-After, opens no arm, and all 16 keep streaming; a freed slot is reusable", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap);

    const accepted: MockRes[] = [];
    for (let i = 0; i < 16; i++) {
      const res = mockRes();
      expect(driver.handle(mockReq("/global/event"), res)).toBe(true);
      accepted.push(res);
    }
    await tick();
    expect(origins.live(LOCAL_NAMESPACE)).toBe(16);

    // The 17th is ANSWERED (handle owns the response) with a retryable refusal.
    const refused = mockRes();
    expect(driver.handle(mockReq("/global/event"), refused)).toBe(true);
    await tick();
    expect(refused.status).toBe(503);
    expect(Number(refused.headerMap["retry-after"])).toBeGreaterThan(0);
    expect(refused.ended).toBe(true);
    const body = JSON.parse(refused.body) as { ok: boolean; reason: string; max_listeners: number };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("listener-cap");
    expect(body.max_listeners).toBe(16);

    // No existing listener was closed to make room, and the refused one opened nothing.
    expect(origins.opens(LOCAL_NAMESPACE)).toBe(16);
    expect(origins.closes(LOCAL_NAMESPACE)).toBe(0);
    expect(origins.live("studio")).toBe(16);
    origins.broadcast(LOCAL_NAMESPACE, localEvt(1, { n: "after-refusal" }));
    await tick();
    for (const res of accepted) {
      expect(res.ended).toBe(false);
      expect(res.text()).toContain('"n":"after-refusal"');
    }
    expect(refused.text()).toBe("");

    // The cap bounds CONCURRENT listeners: once one departs, a retry is accepted.
    accepted[0].fireClose();
    await tick();
    const retry = mockRes();
    driver.handle(mockReq("/global/event"), retry);
    await tick();
    expect(retry.status).toBe(200);
    expect(retry.ended).toBe(false);
    expect(origins.live(LOCAL_NAMESPACE)).toBe(16);

    for (const res of [...accepted, retry]) res.fireClose();
  });
});

/** #1772 — a VIEW that behaves like the app's stream loop: when the driver ENDS
 *  its stream (an eviction is a clean end), the socket closes and the view
 *  reconnects after `delayMs` (the client's reconnect delay, shortened). Two
 *  such views against an evicting driver re-open against each other forever —
 *  the Studio's ~340-reconnects-in-15-minutes storm. */
function reconnectingView(driver: SseFanInDriver, delayMs = 5): { connects(): number; current(): MockRes; stop(): void } {
  let stopped = false;
  let connects = 0;
  let current!: MockRes;
  const connect = (): void => {
    if (stopped) return;
    connects += 1;
    const res = mockRes();
    const end = res.end.bind(res);
    res.end = ((chunk?: string) => {
      end(chunk);
      setTimeout(() => {
        res.fireClose();
        connect();
      }, delayMs);
    }) as typeof res.end;
    current = res;
    driver.handle(mockReq("/global/event"), res);
  };
  connect();
  return {
    connects: () => connects,
    current: () => current,
    stop() {
      stopped = true;
      current.fireClose();
    },
  };
}

describe("#1772 AC5 — two listeners: one local arm each, kept open — no repeating re-open pattern", () => {
  it("two reconnecting views over many live reconcile ticks: 2 local arms opened, 0 closed, 0 view reconnects", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, ownerMap, { reconcileMs: 10 });

    const viewA = reconnectingView(driver);
    await tick();
    const viewB = reconnectingView(driver);
    await tick(250); // ~25 reconcile ticks per connection

    try {
      expect(viewA.connects()).toBe(1);
      expect(viewB.connects()).toBe(1);
      expect(origins.opens(LOCAL_NAMESPACE)).toBe(2); // one local arm per listener
      expect(origins.closes(LOCAL_NAMESPACE)).toBe(0); // …and each is kept open
      expect(origins.live(LOCAL_NAMESPACE)).toBe(2);
      expect(origins.opens("studio")).toBe(2);
      expect(origins.closes("studio")).toBe(0);

      // Both views are live on those same arms.
      origins.broadcast(LOCAL_NAMESPACE, localEvt(1, { n: "steady" }));
      await tick();
      expect(viewA.current().text()).toContain('"n":"steady"');
      expect(viewB.current().text()).toContain('"n":"steady"');
    } finally {
      viewA.stop();
      viewB.stop();
    }
  });
});

describe("#1772 invariants — #1264 / #1601 / #1617 hold PER LISTENER", () => {
  it("#1264 fleet-of-one: each of two listeners receives the local stream byte-identical", async () => {
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, new SessionOwnerMap());
    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await tick();

    // #1771: the engine's real stream — an old (id-less) engine and a #1776
    // (sequenced) one — connected, an event, the plain + sync twin of a stored
    // event, a heartbeat. Every byte relays verbatim to every listener.
    for (const engine of [fakeEngine({ legacy: true }), fakeEngine({ epoch: LOCAL_EPOCH })]) {
      const frames = [
        engine.connected(),
        engine.event("session.status", { a: 1 }),
        ...engine.stored("message.updated", { b: 2 }, { aggregateID: "ses_1" }),
        engine.heartbeat(),
      ];
      const before = [resA.text(), resB.text()];
      for (const f of frames) origins.broadcast(LOCAL_NAMESPACE, f);
      await tick();
      expect(resA.text()).toBe(before[0] + frames.join(""));
      expect(resB.text()).toBe(before[1] + frames.join(""));
    }

    resA.fireClose();
    resB.fireClose();
  });

  it("#1601 per connection: one listener's dead local arm is re-opened for THAT listener only", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const localCtls: Ctl[] = [];
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, {
      openUpstream: (r) => {
        const ctl = controllableSource();
        if (r.namespace === LOCAL_NAMESPACE) localCtls.push(ctl);
        return ctl.source;
      },
    });
    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA); // localCtls[0]
    driver.handle(mockReq("/global/event"), resB); // localCtls[1]
    await tick();
    expect(localCtls.length).toBe(2);

    localCtls[0].end(); // A's local upstream drops
    await tick();
    driver.reconcile();
    await tick();
    expect(localCtls.length).toBe(3); // exactly one re-open — A's

    localCtls[2].push(localEvt(2, { to: "A" }));
    localCtls[1].push(localEvt(1, { to: "B" }));
    await tick();
    expect(resA.text()).toContain('"to":"A"');
    expect(resA.text()).not.toContain('"to":"B"');
    expect(resB.text()).toContain('"to":"B"');
    expect(resB.text()).not.toContain('"to":"A"');

    localCtls.forEach((c) => c.end());
    resA.fireClose();
    resB.fireClose();
  });

  it("#1617 per connection: a backpressured listener pauses only ITS upstreams and heals on ITS drain", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const ctls: PausableCtl[] = [];
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, {
      openUpstream: () => {
        const ctl = pausableSource();
        ctls.push(ctl);
        return ctl.source;
      },
    });
    const resA = backpressureRes();
    driver.handle(mockReq("/global/event"), resA); // ctls[0] local, ctls[1] studio
    await tick();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resB); // ctls[2] local, ctls[3] studio
    await tick();
    const [aLocal, aPeer, bLocal, bPeer] = ctls;

    resA.block();
    aLocal.push(localEvt(1, { n: 1 })); // trips A's backpressure
    await tick();
    aLocal.push(localEvt(2, { n: 2 })); // stranded behind it
    await tick();
    expect(aLocal.pauseCalls).toBeGreaterThan(0);
    expect(aPeer.pauseCalls).toBeGreaterThan(0);
    expect(bLocal.pauseCalls).toBe(0); // B is not throttled by A's slow socket
    expect(bPeer.pauseCalls).toBe(0);

    bLocal.push(localEvt(1, { to: "B" }));
    await tick();
    expect(resB.text()).toContain('"to":"B"'); // B streams on while A is backpressured
    expect(resA.text()).not.toContain('"n":2');

    resA.fireDrain();
    await tick();
    expect(resA.text()).toContain('"n":2');
    expect(aLocal.resumeCalls).toBeGreaterThan(0);

    ctls.forEach((c) => c.end());
    resA.fireClose();
    resB.fireClose();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1771 — the fan-in CENSUS. A wedged, evicted, or flapping arm used to look
// identical to a quiet one in every log: nothing recorded who subscribed, why an
// arm re-opened, or what was dropped. Every fan-in service now keeps counters per
// listener connection and per arm, logs one census line every 30 s, and one line
// immediately on each transition. The upstream frames below are ENGINE-SHAPED
// (test/fixtures/engine_stream): id-less or `<epoch>:<seq>` data frames, the
// plain + sync twin of a stored event, heartbeats.
// ══════════════════════════════════════════════════════════════════════════════

/** A census wired to a collecting sink and a hand-driven clock. */
function testCensus(plane = "observe") {
  const lines: string[] = [];
  let t = 1_000_000;
  const census = new FanInCensus({ plane, sink: (l) => lines.push(l), now: () => t });
  return {
    census,
    lines,
    advance(ms: number) {
      t += ms;
    },
    censusLines: () => lines.filter((l) => l.startsWith("[fanin] census ")),
  };
}

/** One `key=value key=value` segment → a record. */
function kv(segment: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of segment.trim().split(" ")) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return out;
}

/** A census line: its service-level head, then one segment per (connection, arm). */
function parseCensus(line: string): { head: Record<string, string>; arms: Array<Record<string, string>> } {
  const [head, ...arms] = line.split(" | ");
  return { head: kv(head), arms: arms.map(kv) };
}

/** Drain the pumps: every pending microtask runs before the immediate fires —
 *  no wall-clock sleep. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const bytesOf = (frames: string[]) => frames.reduce((n, f) => n + Buffer.byteLength(f), 0);

describe("#1771 AC1 — a fan-in service logs a census line every 30 s", () => {
  afterEach(() => vi.useRealTimers());

  it("listeners, accepted/closed since boot, evictions, and per arm: frames, bytes, largest, time since last frame, opens, closes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const { census, advance, censusLines } = testCensus();
    census.start();
    const driver = twoListenerDriver(origins, ownerMap, { census });
    const local = fakeEngine({ epoch: LOCAL_EPOCH });
    const studio = fakeEngine({ epoch: PEER_EPOCH });

    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await flush();

    const localFrames = [
      local.connected(),
      local.event("session.status", { sessionID: "ses_1", status: { type: "busy" } }),
      ...local.stored("message.part.updated", { part: { id: "prt_1", text: "bravo" } }, { aggregateID: "ses_1" }),
      local.heartbeat(),
    ];
    for (const f of localFrames) origins.broadcast(LOCAL_NAMESPACE, f);
    const studioFrame = studio.event("message.part.updated", { from: "studio" });
    origins.broadcast("studio", studioFrame);
    await flush();
    resA.fireClose(); // listener A departs; B stays
    await flush();
    advance(1500);

    expect(censusLines()).toHaveLength(0); // nothing before the first period
    vi.advanceTimersByTime(FANIN_CENSUS_INTERVAL_MS);
    expect(censusLines()).toHaveLength(1);

    const { head, arms } = parseCensus(censusLines()[0]);
    expect(head).toMatchObject({ plane: "observe", listeners: "1", accepted: "2", closed: "1", evictions: "0" });
    // Only the LIVE listener's arms are listed: B's local arm and B's peer arm.
    expect(arms.map((a) => a.arm).sort()).toEqual(["local", "studio"]);
    expect(new Set(arms.map((a) => a.conn)).size).toBe(1);
    const bLocal = arms.find((a) => a.arm === "local")!;
    expect(bLocal).toMatchObject({
      frames: "5",
      bytes: String(bytesOf(localFrames)),
      largest: String(Math.max(...localFrames.map((f) => Buffer.byteLength(f)))),
      since_last_ms: "1500",
      opens: "1",
      closes: "-",
      pending: "0",
      drops: "0",
      gaps: "0",
    });
    expect(arms.find((a) => a.arm === "studio")).toMatchObject({
      frames: "1",
      bytes: String(Buffer.byteLength(studioFrame)),
      largest: String(Buffer.byteLength(studioFrame)),
      since_last_ms: "1500",
      opens: "1",
      closes: "-",
    });

    // The cadence repeats every 30 s, and stops with the census.
    vi.advanceTimersByTime(FANIN_CENSUS_INTERVAL_MS);
    expect(censusLines()).toHaveLength(2);
    census.stop();
    vi.advanceTimersByTime(FANIN_CENSUS_INTERVAL_MS * 3);
    expect(censusLines()).toHaveLength(2);

    resB.fireClose();
  });

  it("per arm: pending depth while backpressured, overflow drops, and gaps emitted", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins(); // its sources cannot pause → frames keep arriving
    const { census, censusLines } = testCensus();
    const driver = twoListenerDriver(origins, ownerMap, { census });
    const studio = fakeEngine({ epoch: PEER_EPOCH });

    const res = backpressureRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();
    const studioArm = () => parseCensus(censusLines().at(-1)!).arms.find((a) => a.arm === "studio")!;

    res.block();
    // 1 trip-frame written, 256 buffered (the per-namespace bound), 43 dropped.
    for (let i = 0; i < 300; i++) origins.broadcast("studio", studio.event("message.part.delta", { i }));
    await flush();
    census.emit();
    expect(studioArm()).toMatchObject({ frames: "300", pending: "256", drops: "43", gaps: "0" });

    res.fireDrain(); // the buffer flushes in order, then ONE overflow gap names the arm
    await flush();
    census.emit();
    expect(studioArm()).toMatchObject({ frames: "300", pending: "0", drops: "43", gaps: "1" });

    res.fireClose();
  });
});

/** Resolve once the census sink has received a line matching `pred` —
 *  event-driven (the sink notifies), never a polling sleep. */
function lineWaiter(lines: string[]): { sink: (l: string) => void; waitFor(pred: (l: string) => boolean): Promise<string> } {
  const waiters: Array<{ pred: (l: string) => boolean; resolve: (l: string) => void }> = [];
  return {
    sink(l: string) {
      lines.push(l);
      for (const w of [...waiters]) {
        if (w.pred(l)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(l);
        }
      }
    },
    waitFor(pred) {
      const hit = lines.find(pred);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
  };
}

describe("#1771 AC2 — close reasons are an enumerated set", () => {
  it("the set is exactly: upstream end, upstream error, membership change, listener closed, evicted, shutdown", () => {
    expect([...FANIN_CLOSE_REASONS]).toEqual([
      "upstream-end",
      "upstream-error",
      "membership-change",
      "listener-closed",
      "evicted",
      "shutdown",
    ]);
  });

  it("an arm's closes are counted under their reason: upstream end, upstream error, membership change", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const { census, lines, censusLines } = testCensus();
    const localCtls: Ctl[] = [];
    const failing: Array<(err: Error) => void> = [];
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, {
      census,
      openUpstream: (r) => {
        if (r.namespace === LOCAL_NAMESPACE) {
          const ctl = controllableSource();
          localCtls.push(ctl);
          return ctl.source;
        }
        // the peer's upstream FAILS: next() rejects
        return {
          next: () => new Promise<string | null>((_, reject) => failing.push(reject)),
          close() {},
        };
      },
    });
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();

    localCtls[0].end(); // the local engine ends the stream cleanly
    failing.shift()!(new Error("ECONNRESET")); // the peer's stream errors
    await flush();
    expect(lines).toContainEqual(expect.stringMatching(/^\[fanin\] arm-closed plane=observe conn=c1 arm=local reason=upstream-end$/));
    expect(lines).toContainEqual(expect.stringMatching(/^\[fanin\] arm-closed plane=observe conn=c1 arm=studio reason=upstream-error$/));

    driver.reconcile(); // both re-open
    await flush();
    ownerMap.update([]); // the peer's sessions end → its arm leaves the membership
    driver.reconcile();
    await flush();
    expect(lines).toContainEqual(expect.stringMatching(/^\[fanin\] arm-closed plane=observe conn=c1 arm=studio reason=membership-change$/));

    census.emit();
    const arms = parseCensus(censusLines().at(-1)!).arms;
    expect(arms.find((a) => a.arm === "local")).toMatchObject({ opens: "2", closes: "upstream-end:1" });
    expect(arms.find((a) => a.arm === "studio")).toMatchObject({ opens: "2", closes: "upstream-error:1,membership-change:1" });
    expect(parseCensus(censusLines().at(-1)!).head.evictions).toBe("0"); // no eviction path exists (#1772)

    localCtls.forEach((c) => c.end());
    res.fireClose();
  });

  it("the REAL upstream reader tells a clean end (upstream-end) from a mid-stream failure (upstream-error)", async () => {
    const local = fakeEngine({ legacy: true }); // an old engine: id-less frames
    const peer = fakeEngine({ legacy: true });
    const ends = await startEngineSseServer((res) => {
      res.write(local.connected());
      res.end(); // clean end of stream
    });
    const dies = await startEngineSseServer((res) => {
      res.write(peer.connected());
      setImmediate(() => res.destroy()); // the link dies mid-stream
    });
    const lines: string[] = [];
    const w = lineWaiter(lines);
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => ends.url,
      peerBaseUrl: (id) => (id === "studio" ? dies.url : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: dies.url, token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999_999,
      census: new FanInCensus({ plane: "observe", sink: w.sink }),
      // no openUpstream → the production http reader
    });
    const res = mockRes();
    try {
      driver.handle(mockReq("/global/event"), res);
      expect(await w.waitFor((l) => l.includes("arm=local reason="))).toMatch(/reason=upstream-end$/);
      expect(await w.waitFor((l) => l.includes("arm=studio reason="))).toMatch(/reason=upstream-error$/);
    } finally {
      res.fireClose();
      await ends.stop();
      await dies.stop();
    }
  });

  // ────────────────────────────────────────────────────────────────────────────
  // #1773 AC4 — the arm reader (openHttpSseSource) reports upstream END and
  // upstream ERROR as distinct reasons. A non-200 upstream (an auth failure, an
  // overloaded peer, the beyond-cap 503) is an ERROR, not a clean end — and its
  // body is never parsed as SSE frames.
  // ────────────────────────────────────────────────────────────────────────────
  describe("#1773 AC4 — the arm reader's end-vs-error", () => {
    /** Drain a source to its end: the frames it yielded, and its endReason. */
    async function drain(source: SseFrameSource): Promise<{ frames: string[]; reason: string | undefined }> {
      const frames: string[] = [];
      for (;;) {
        const f = await source.next();
        if (f === null) break;
        frames.push(f);
      }
      return { frames, reason: source.endReason?.() };
    }
    const arm = (url: string) => openHttpSseSource({ namespace: "studio", url, path: "/global/event" });

    it("a clean upstream end reads as `end`, after every frame", async () => {
      const engine = fakeEngine({ epoch: PEER_EPOCH });
      const sent = [engine.connected(), engine.event("session.status", { s: 1 })];
      const server = await startEngineSseServer((res) => {
        for (const f of sent) res.write(f);
        res.end();
      });
      try {
        expect(await drain(arm(server.url))).toEqual({ frames: sent, reason: "end" });
      } finally {
        await server.stop();
      }
    });

    it("an upstream that dies mid-stream reads as `error`, after the frames it sent", async () => {
      const engine = fakeEngine({ legacy: true });
      const sent = [engine.connected()];
      const server = await startEngineSseServer((res) => {
        for (const f of sent) res.write(f);
        setTimeout(() => res.destroy(), 20);
      });
      try {
        expect(await drain(arm(server.url))).toEqual({ frames: sent, reason: "error" });
      } finally {
        await server.stop();
      }
    });

    for (const status of [401, 500, 503]) {
      it(`a ${status} upstream is an \`error\` — never a clean end, and its body is not read as frames`, async () => {
        const server = await startEngineSseServer(
          (res) => res.end(`{"ok":false,"error":"refused"}\n\ndata: {"not":"a frame"}\n\n`),
          { status },
        );
        try {
          expect(await drain(arm(server.url))).toEqual({ frames: [], reason: "error" });
        } finally {
          await server.stop();
        }
      });
    }

    it("a refused connection is an `error`", async () => {
      // port 1 (tcpmux) on loopback: nothing listens there, the dial is refused
      expect(await drain(arm("http://127.0.0.1:1"))).toEqual({ frames: [], reason: "error" });
    });

    it("through the driver: a peer answering 401 closes its arm as upstream-error in the census", async () => {
      const local = await startEngineSseServer((res) => res.write(fakeEngine({ legacy: true }).connected()));
      const peer = await startEngineSseServer((res) => res.end(`{"ok":false}`), { status: 401 });
      const lines: string[] = [];
      const w = lineWaiter(lines);
      const ownerMap = new SessionOwnerMap();
      ownerMap.update(STUDIO_OWNED);
      const driver = new SseFanInDriver({
        ownerMap,
        localMachineId: "macbook",
        localEventUrl: () => local.url,
        peerBaseUrl: (id) => (id === "studio" ? peer.url : undefined),
        peerToken: (id) =>
          id === "studio"
            ? { ok: true as const, credential: { baseUrl: peer.url, token: "tok-studio" } }
            : { ok: false as const, reason: "absent" as const },
        reconcileMs: 999_999,
        census: new FanInCensus({ plane: "observe", sink: w.sink }),
      });
      const res = mockRes();
      try {
        driver.handle(mockReq("/global/event"), res);
        expect(await w.waitFor((l) => l.includes("arm=studio reason="))).toMatch(/reason=upstream-error$/);
      } finally {
        res.fireClose();
        await local.stop();
        await peer.stop();
      }
    });
  });

  it("a departing listener's arms close as listener-closed; after shutdown() the teardown's closes are shutdown", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const { census, lines } = testCensus();
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, { census });
    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await flush();

    resA.fireClose(); // a view goes away
    expect(lines.filter((l) => l.includes("conn=c1") && l.includes("reason="))).toEqual([
      "[fanin] arm-closed plane=observe conn=c1 arm=local reason=listener-closed",
      "[fanin] arm-closed plane=observe conn=c1 arm=studio reason=listener-closed",
      "[fanin] listener-closed plane=observe conn=c1 reason=listener-closed listeners=1",
    ]);

    driver.shutdown(); // the service stops: its socket teardown closes the rest
    resB.fireClose();
    expect(lines.filter((l) => l.includes("conn=c2") && l.includes("reason="))).toEqual([
      "[fanin] arm-closed plane=observe conn=c2 arm=local reason=shutdown",
      "[fanin] arm-closed plane=observe conn=c2 arm=studio reason=shutdown",
      "[fanin] listener-closed plane=observe conn=c2 reason=shutdown listeners=0",
    ]);
    // shutdown() closed nothing itself — B's stream ended only with its socket.
    expect(lines.some((l) => l.includes("reason=evicted"))).toBe(false);
  });

  // #1773 AC3 — a fan-in connection never ends its listener's stream cleanly
  // except on a graceful service shutdown: every other close reason is an ERROR
  // close (the listener, or the relay in front of it, sees a transport error).
  it("#1773 AC3: a listener-closed connection is an ERROR close; a shutdown is the only clean end", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const driver = twoListenerDriver(fakeOrigins(), ownerMap);
    const resA = mockRes();
    const resB = mockRes();
    driver.handle(mockReq("/global/event"), resA);
    driver.handle(mockReq("/global/event"), resB);
    await flush();

    resA.fireClose(); // listener-closed
    expect(resA.destroyed).toBe(true);
    expect(resA.destroyError).toBeInstanceOf(Error);
    expect(resA.destroyError?.message).toContain("listener-closed");
    expect(resA.ended).toBe(false);

    driver.shutdown();
    resB.fireClose(); // shutdown
    expect(resB.ended).toBe(true);
    expect(resB.destroyed).toBe(false);
  });

  it("#1773 AC3: the severed listener's error close names its cause (upstream-error) — census and error agree", async () => {
    const { census, lines } = testCensus();
    const localCtls: Ctl[] = [];
    const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), {
      census,
      openUpstream: () => {
        const ctl = controllableSource();
        localCtls.push(ctl);
        return ctl.source;
      },
    });
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    localCtls[0].push(fakeEngine({ legacy: true }).connected()); // #1777: an id-less engine — the sever fallback
    await flush();
    localCtls[0].end("error");
    await flush();
    driver.reconcile();
    expect(res.destroyError?.message).toContain("upstream-error");
    expect(lines.at(-1)).toBe("[fanin] listener-closed plane=observe conn=c1 reason=upstream-error listeners=0");
    // the socket's own close event afterwards changes nothing (closed once, first reason wins)
    res.fireClose();
    expect(lines.filter((l) => l.includes("listener-closed")).length).toBe(1);
    expect(census.snapshot()).toMatchObject({ listeners: 0, closed: 1 });
  });
});

describe("#1771 AC3 — each transition logs one line immediately, with its connection and arm", () => {
  it("listener accepted → arm opened (local, peer) — synchronously, before any frame or timer", () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const { census, lines } = testCensus();
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, { census });
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    // no flush, no timer: the lines are already there
    expect(lines).toEqual([
      "[fanin] listener-accepted plane=observe conn=c1 listeners=1",
      "[fanin] arm-opened plane=observe conn=c1 arm=local opens=1",
      "[fanin] arm-opened plane=observe conn=c1 arm=studio opens=1",
    ]);
    res.fireClose();
  });

  // #1777: an id-less (legacy) arm's re-open logs its gap; a sequenced arm's
  // re-open RESUMES — closed → opened, and no gap line at all.
  for (const mode of ["legacy", "sequenced"] as const)
  it(`frames are never logged; ${mode === "legacy" ? "an id-less arm that drops and re-opens logs closed → gap emitted → opened" : "a sequenced arm that drops and re-opens logs closed → opened (resumed, no gap)"}`, async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const { census, lines } = testCensus();
    const peerCtls: Ctl[] = [];
    const driver = twoListenerDriver(fakeOrigins(), ownerMap, {
      census,
      openUpstream: (r) => {
        const ctl = controllableSource();
        if (r.namespace === "studio") peerCtls.push(ctl);
        return ctl.source;
      },
    });
    const studio = mode === "legacy" ? fakeEngine({ legacy: true }) : fakeEngine({ epoch: PEER_EPOCH });
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    const before = lines.length;
    for (let i = 0; i < 25; i++) peerCtls[0].push(studio.event("message.part.delta", { i }));
    peerCtls[0].push(studio.heartbeat());
    await flush();
    expect(lines.length).toBe(before); // 26 frames delivered, zero lines

    peerCtls[0].end();
    await flush();
    driver.reconcile();
    expect(lines.slice(before)).toEqual([
      "[fanin] arm-closed plane=observe conn=c1 arm=studio reason=upstream-end",
      ...(mode === "legacy" ? ["[fanin] gap-emitted plane=observe conn=c1 arm=studio cause=reopen"] : []),
      "[fanin] arm-opened plane=observe conn=c1 arm=studio opens=2",
    ]);
    peerCtls.forEach((c) => c.end());
    res.fireClose();
  });

  it("an overflow episode logs ONE overflow-drop line (not one per dropped frame), then its gap on drain", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const origins = fakeOrigins();
    const { census, lines } = testCensus();
    const driver = twoListenerDriver(origins, ownerMap, { census });
    const studio = fakeEngine({ epoch: PEER_EPOCH });
    const res = backpressureRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();
    const before = lines.length;

    res.block();
    for (let i = 0; i < 300; i++) origins.broadcast("studio", studio.event("message.part.delta", { i }));
    await flush();
    expect(lines.slice(before)).toEqual(["[fanin] overflow-drop plane=observe conn=c1 arm=studio pending=256"]);

    res.fireDrain();
    await flush();
    expect(lines.slice(before + 1)).toEqual(["[fanin] gap-emitted plane=observe conn=c1 arm=studio cause=overflow"]);
    res.fireClose();
  });

  it("a beyond-cap refusal logs one line naming the cap (and counts in the census)", () => {
    const { census, lines } = testCensus();
    const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), { census, maxListeners: 1 });
    const ok = mockRes();
    driver.handle(mockReq("/global/event"), ok);
    driver.handle(mockReq("/global/event"), mockRes());
    expect(lines.at(-1)).toBe("[fanin] listener-refused plane=observe listeners=1 cap=1");
    expect(census.snapshot()).toMatchObject({ listeners: 1, accepted: 1, refusals: 1, evictions: 0 });
    ok.fireClose();
  });
});

describe("#1771 AC5 — the census adds no frames to any stream and changes no delivery", () => {
  afterEach(() => vi.useRealTimers());

  it("FLEET-OF-ONE under a live census (cadence ticking, every transition logging): the stream is the engine's frames, byte-identical (#1264)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { census, lines } = testCensus();
    census.start();
    const localCtls: Ctl[] = [];
    const driver = twoListenerDriver(fakeOrigins(), new SessionOwnerMap(), {
      census,
      openUpstream: () => {
        const ctl = controllableSource();
        localCtls.push(ctl);
        return ctl.source;
      },
    });
    for (const engine of [fakeEngine({ legacy: true }), fakeEngine({ epoch: LOCAL_EPOCH })]) {
      localCtls.length = 0;
      const res = mockRes();
      driver.handle(mockReq("/global/event"), res);
      const first = [engine.connected(), engine.event("session.status", { status: "busy" }), ...engine.stored("message.part.updated", { text: "ciao" }, { aggregateID: "ses_1" })];
      for (const f of first) localCtls[0].push(f);
      await flush();
      vi.advanceTimersByTime(FANIN_CENSUS_INTERVAL_MS); // a census line mid-stream
      localCtls[0].end(); // the arm drops …
      await flush();
      driver.reconcile(); // … and the re-open severs the listener (#1773 — no gap frame in fleet-of-one) or, #1777, resumes it
      const second = [engine.heartbeat(), engine.event("session.status", { status: "idle" })];
      if (engine.epoch !== undefined) {
        // a sequenced engine: the arm resumed beneath the SAME listener — still
        // the engine's frames, byte for byte
        expect(res.destroyed).toBe(false);
        for (const f of second) localCtls[1].push(f);
        await flush();
        expect(res.text()).toBe(first.join("") + second.join(""));
        res.fireClose();
        continue;
      }
      expect(res.text()).toBe(first.join(""));
      expect(res.destroyed).toBe(true);
      // the client reconnects; the stream resumes on the new listener
      const again = mockRes();
      driver.handle(mockReq("/global/event"), again);
      for (const f of second) localCtls[1].push(f);
      await flush();
      expect(again.text()).toBe(second.join(""));
      again.fireClose();
    }
    expect(lines.some((l) => l.startsWith("[fanin] census "))).toBe(true);
    expect(lines.some((l) => l.includes("arm-closed"))).toBe(true);
  });

  it("COMPOSITE: the same scripted sequence (overflow, gap, membership change, re-open) is byte-identical with and without a census sink", async () => {
    async function run(sink: ((l: string) => void) | undefined): Promise<string> {
      const ownerMap = new SessionOwnerMap();
      ownerMap.update(STUDIO_OWNED);
      const origins = fakeOrigins();
      const driver = twoListenerDriver(origins, ownerMap, sink ? { census: new FanInCensus({ sink, now: () => 0 }) } : {});
      const local = fakeEngine({ legacy: true }); // an old local engine: id-less
      const studio = fakeEngine({ epoch: PEER_EPOCH });
      const res = backpressureRes();
      driver.handle(mockReq(`/global/event?lastEventID=studio=${studio.idAt(0)}`), res);
      await flush();
      for (const f of [local.connected(), ...local.stored("message.updated", { n: 1 }, { aggregateID: "ses_1" }), local.heartbeat()]) {
        origins.broadcast(LOCAL_NAMESPACE, f);
      }
      origins.broadcast("studio", studio.connected());
      await flush();
      res.block();
      for (let i = 0; i < 300; i++) origins.broadcast("studio", studio.event("message.part.delta", { i }));
      await flush();
      res.fireDrain();
      await flush();
      ownerMap.update([]);
      driver.reconcile(); // membership change closes the peer arm
      ownerMap.update(STUDIO_OWNED);
      driver.reconcile(); // … and it re-opens (a reopen gap)
      await flush();
      origins.broadcast("studio", studio.heartbeat());
      await flush();
      res.fireClose();
      return res.text();
    }
    const lines: string[] = [];
    const silent = await run(undefined);
    const logged = await run((l) => lines.push(l));
    expect(logged).toBe(silent);
    expect(lines.length).toBeGreaterThan(5); // the census did see it all …
    expect(logged).not.toContain("[fanin]"); // … and none of it reached the stream
    expect(logged).not.toContain("[owner-map]");
  });

  it("a census sink that throws never breaks delivery", async () => {
    const census = new FanInCensus({
      sink: () => {
        throw new Error("log pipe closed");
      },
    });
    census.start();
    const origins = fakeOrigins();
    const driver = twoListenerDriver(origins, new SessionOwnerMap(), { census });
    const engine = fakeEngine({ epoch: LOCAL_EPOCH });
    const res = mockRes();
    expect(() => driver.handle(mockReq("/global/event"), res)).not.toThrow();
    const f = engine.event("session.status", { status: "busy" });
    origins.broadcast(LOCAL_NAMESPACE, f);
    await flush();
    expect(() => census.emit()).not.toThrow();
    expect(res.text()).toBe(f);
    res.fireClose();
    census.stop();
  });
});

describe("#1771 AC6 — a 10 MB engine frame delivered in 64 KB chunks (the #1779 surface)", () => {
  it("the real reader reassembles it whole; the stream carries it byte-identical; the census counts its bytes and largest frame", async () => {
    const engine = fakeEngine({ epoch: LOCAL_EPOCH });
    const connected = engine.connected();
    const big = largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 1 });
    const after = engine.heartbeat();
    const chunks = chunkBytes(connected + big + after, CHUNK_64K);
    expect(Buffer.byteLength(big)).toBeGreaterThanOrEqual(TEN_MB);
    expect(chunks.length).toBeGreaterThan(160);
    const server = await startEngineSseServer(async (res) => {
      await writeChunks(res, chunks);
      res.end();
    });
    const lines: string[] = [];
    const w = lineWaiter(lines);
    const census = new FanInCensus({ plane: "observe", sink: w.sink, now: () => 0 });
    const driver = new SseFanInDriver({
      ownerMap: new SessionOwnerMap(), // fleet-of-one: the verbatim relay
      localMachineId: "macbook",
      localEventUrl: () => server.url,
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      census,
    });
    const res = mockRes();
    try {
      driver.handle(mockReq("/global/event"), res);
      await w.waitFor((l) => l.includes("arm=local reason="));
      expect(res.text()).toBe(connected + big + after); // whole, in order, byte-identical
      census.emit();
      const local = parseCensus(lines.at(-1)!).arms.find((a) => a.arm === "local")!;
      expect(local).toMatchObject({
        frames: "3",
        bytes: String(Buffer.byteLength(connected + big + after)),
        largest: String(Buffer.byteLength(big)),
      });
    } finally {
      res.fireClose();
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1779 — LINEAR-TIME FRAME SPLITTING in the relay's upstream reader. The reader
// (`openHttpSseSource`) decodes each network chunk (`res.setEncoding("utf8")`, a
// StringDecoder: a code point split across chunks is held back, never mangled)
// and hands the text to its frame splitter. `readFrames` is that data path minus
// the socket, so a test can choose the chunk boundaries exactly — the network
// cannot deliver a 10 MB frame in ONE chunk, which is the baseline AC1 compares to.
// ══════════════════════════════════════════════════════════════════════════════

/** The relay reader's data path: decode each byte chunk as `setEncoding("utf8")`
 *  does, split the text into whole frames. */
function readFrames(chunks: Buffer[]): string[] {
  const decoder = new StringDecoder("utf8");
  const splitter = new SseFrameSplitter();
  const frames: string[] = [];
  for (const chunk of chunks) {
    const text = decoder.write(chunk);
    if (text !== "") frames.push(...splitter.push(text));
  }
  return frames;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const elapsedMs = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

/** #1779 AC1's assertion, made robust: a warm-up, then INTERLEAVED trials (both
 *  deliveries see the same machine noise), the median of each, and a generous
 *  factor. A quadratic splitter misses it by an order of magnitude. `SPLIT_RATIO_LOG`
 *  (a file path) records each run's ratio for a flake report. */
function splitTimeRatio(read: (chunks: Buffer[]) => unknown, whole: Buffer[], chunked: Buffer[]): { ratio: number; wholeMs: number; chunkedMs: number } {
  for (let i = 0; i < 2; i++) {
    read(whole);
    read(chunked);
  }
  const one: number[] = [];
  const many: number[] = [];
  for (let i = 0; i < 7; i++) {
    one.push(elapsedMs(() => read(whole)));
    many.push(elapsedMs(() => read(chunked)));
  }
  const wholeMs = median(one);
  const chunkedMs = median(many);
  return { ratio: chunkedMs / wholeMs, wholeMs, chunkedMs };
}
const SPLIT_RATIO_FACTOR = 3;

describe("#1779 AC1 — the relay reader splits a 10 MB frame in 64 KB chunks within a small constant factor of one chunk", () => {
  it("chunked ÷ single-chunk split time (medians) stays ≤ 3×, and both yield the one frame byte-identical", () => {
    const big = largeSummaryFrame({ epoch: LOCAL_EPOCH, seq: 1 });
    const whole = [Buffer.from(big, "utf8")];
    const chunked = chunkBytes(big, CHUNK_64K);
    expect(Buffer.byteLength(big)).toBeGreaterThanOrEqual(TEN_MB);
    expect(chunked.length).toBeGreaterThan(160);
    for (const delivery of [whole, chunked]) {
      const frames = readFrames(delivery);
      expect(frames).toHaveLength(1);
      expect(frames[0] === big).toBe(true); // byte-identical (#1264); no 10 MB diff on failure
    }
    const { ratio, wholeMs, chunkedMs } = splitTimeRatio(readFrames, whole, chunked);
    if (process.env.SPLIT_RATIO_LOG) appendFileSync(process.env.SPLIT_RATIO_LOG, `relay ${ratio.toFixed(3)} ${wholeMs.toFixed(2)} ${chunkedMs.toFixed(2)}\n`);
    expect(ratio, `chunked ${chunkedMs.toFixed(1)} ms vs whole ${wholeMs.toFixed(1)} ms`).toBeLessThanOrEqual(SPLIT_RATIO_FACTOR);
  }, 60_000);
});

// ══════════════════════════════════════════════════════════════════════════════
// #1777 — LOSSLESS RESUME. The engine (#1776) sequences and replays its global
// stream; the fan-in now uses it. A re-opened arm resumes from its last delivered
// engine id, so the upstream REPLAYS what the listener missed — no gap, no resync.
// Only what the replay cannot serve is announced (an upstream reset → one gap;
// an old id-less engine → the #1773 gap / sever fallback). The upstream here is
// a REPLAYING engine (test/fixtures/engine_stream): it answers a cursor the way
// the #1776 route does — `server.connected` at the cursor, then the replay — or
// with the `server.cursor.unservable` reset first.
// ══════════════════════════════════════════════════════════════════════════════

/** The downstream stream as a client parses it: per frame, its `id:` and JSON data. */
function sseFrames(text: string): Array<{ id?: string; data?: Record<string, any>; type?: string }> {
  const out: Array<{ id?: string; data?: Record<string, any>; type?: string }> = [];
  for (const block of text.split("\n\n")) {
    if (block.trim() === "") continue;
    const id = /^id: (.*)$/m.exec(block)?.[1];
    const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
    const data = dataLine ? (JSON.parse(dataLine.slice(5).trim()) as Record<string, any>) : undefined;
    const type: string | undefined = data ? (data.payload?.type ?? data.type) : undefined;
    out.push({ ...(id !== undefined ? { id } : {}), ...(data ? { data } : {}), ...(type ? { type } : {}) });
  }
  return out;
}

/** A driver whose arms subscribe to in-process replaying engines. */
function replayDriver(
  engines: { local: ReplayingEngine; studio?: ReplayingEngine },
  ownerMap: SessionOwnerMap,
  extra: Partial<ConstructorParameters<typeof SseFanInDriver>[0]> = {},
): SseFanInDriver {
  return new SseFanInDriver({
    ownerMap,
    localMachineId: "macbook",
    localEventUrl: () => "http://local.invalid",
    peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
    peerToken: (id) =>
      id === "studio"
        ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
        : { ok: false as const, reason: "absent" as const },
    reconcileMs: 999_999,
    openUpstream: (r) => (r.namespace === LOCAL_NAMESPACE ? engines.local : engines.studio!).subscribe(r.lastEventId).source,
    ...extra,
  });
}

const partEvent = (n: number) => ["message.part.updated", { part: { id: `prt_${n}`, text: `line ${n}` }, n }] as const;

describe("#1777 AC1 — a peer arm that drops and re-opens within the replay window resumes: every missed frame, no gap, no resync", () => {
  for (const why of ["end", "error"] as const) {
    it(`upstream ${why}: the re-open resumes from the last delivered id and the viewer gets every frame exactly once, in order`, async () => {
      const ownerMap = new SessionOwnerMap();
      ownerMap.update(STUDIO_OWNED);
      const local = replayingEngine({ epoch: LOCAL_EPOCH });
      const studio = replayingEngine({ epoch: PEER_EPOCH });
      const { census, lines } = testCensus();
      const driver = replayDriver({ local, studio }, ownerMap, { census });
      const res = mockRes();
      driver.handle(mockReq("/global/event"), res);
      await flush();

      for (const n of [1, 2, 3]) studio.publish(...partEvent(n)); // mid-turn
      await flush();
      studio.subscriptions[0].end(why); // the peer link drops …
      await flush();
      for (const n of [4, 5, 6]) studio.publish(...partEvent(n)); // … while the turn goes on
      driver.reconcile(); // the re-open
      await flush();
      for (const n of [7, 8]) studio.publish(...partEvent(n));
      await flush();

      // the re-open asked for the last delivered id, and the engine could serve it
      expect(studio.subscriptions).toHaveLength(2);
      expect(studio.subscriptions[1].cursor).toBe(studio.idAt(3));
      expect(studio.subscriptions[1].reset).toBe(false);

      const frames = sseFrames(res.text());
      // every frame the peer published, exactly once, in order
      expect(frames.filter((f) => f.type === "message.part.updated").map((f) => f.data!.payload.properties.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      // no gap signal …
      expect(frames.some((f) => f.type === "amicode.sync.gap")).toBe(false);
      expect(lines.some((l) => l.includes("gap-emitted"))).toBe(false);
      // … and no resync cue: the resumed arm's own handshake is not an event of
      // the listener's stream (only the two initial arms' connected frames show)
      expect(frames.filter((f) => f.type === "server.connected")).toHaveLength(2);
      // the listener stays connected, and its cursor carries the peer's position
      expect(res.destroyed).toBe(false);
      expect(parseCompositeCursor(frames.at(-1)!.id).get("studio")).toBe(studio.idAt(8));
      res.fireClose();
    });
  }
});

const RESTARTED_EPOCH = "c3R1ZGlvMg"; // the peer's engine after a restart: a new process epoch

describe("#1777 AC2 — an upstream reset on any arm is exactly one gap for that namespace downstream", () => {
  const gapsOf = (text: string) => sseFrames(text).filter((f) => f.type === "amicode.sync.gap").map((f) => f.data!.namespaces);

  it("composite: a peer engine that restarted answers the resume with a reset → one gap naming it; the reset frame itself is not forwarded; the arm re-bases in the new epoch", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const local = replayingEngine({ epoch: LOCAL_EPOCH });
    const studio = replayingEngine({ epoch: PEER_EPOCH });
    const engines: { local: ReplayingEngine; studio: ReplayingEngine } = { local, studio };
    const { census, lines } = testCensus();
    const driver = replayDriver(engines, ownerMap, { census });
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();
    for (const n of [1, 2]) studio.publish(...partEvent(n));
    await flush();
    studio.subscriptions[0].end("error"); // the link drops — and the peer's engine restarts
    await flush();
    const restarted = replayingEngine({ epoch: RESTARTED_EPOCH });
    engines.studio = restarted;
    restarted.publish(...partEvent(3)); // lost with the old process's buffer: unrecoverable
    driver.reconcile();
    await flush();

    expect(restarted.subscriptions[0]).toMatchObject({ cursor: studio.idAt(2), reset: true });
    expect(gapsOf(res.text())).toEqual([["studio"]]); // exactly one gap, naming the peer
    expect(sseFrames(res.text()).some((f) => f.type === "server.cursor.unservable")).toBe(false);
    expect(lines).toContain("[fanin] gap-emitted plane=observe conn=c1 arm=studio cause=reset");
    expect(res.destroyed).toBe(false);

    // re-based: the next frames carry the new epoch, and a later drop resumes in it
    restarted.publish(...partEvent(4));
    await flush();
    expect(parseCompositeCursor(sseFrames(res.text()).at(-1)!.id).get("studio")).toBe(restarted.idAt(2));
    restarted.subscriptions[0].end();
    await flush();
    driver.reconcile();
    await flush();
    expect(restarted.subscriptions[1]).toMatchObject({ cursor: restarted.idAt(2), reset: false });
    expect(gapsOf(res.text())).toHaveLength(1); // still one
    res.fireClose();
  });

  it("composite: a drop longer than the replay window (the cursor was evicted) → one gap naming the peer", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const local = replayingEngine({ epoch: LOCAL_EPOCH });
    const studio = replayingEngine({ epoch: PEER_EPOCH });
    const driver = replayDriver({ local, studio }, ownerMap);
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();
    studio.publish(...partEvent(1));
    await flush();
    studio.subscriptions[0].end("error");
    await flush();
    for (const n of [2, 3, 4]) studio.publish(...partEvent(n));
    studio.evictThrough(3); // the window moved past the cursor (seq 1)
    driver.reconcile();
    await flush();
    expect(studio.subscriptions[1].reset).toBe(true);
    expect(gapsOf(res.text())).toEqual([["studio"]]);
    res.fireClose();
  });

  it("composite: the LOCAL arm's reset (the local engine restarted) is one gap naming `local`", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const engines: { local: ReplayingEngine; studio: ReplayingEngine } = {
      local: replayingEngine({ epoch: LOCAL_EPOCH }),
      studio: replayingEngine({ epoch: PEER_EPOCH }),
    };
    const driver = replayDriver(engines, ownerMap);
    const res = mockRes();
    driver.handle(mockReq("/global/event"), res);
    await flush();
    engines.local.publish(...partEvent(1));
    await flush();
    engines.local.subscriptions[0].end();
    await flush();
    engines.local = replayingEngine({ epoch: "bG9jYWwy" });
    driver.reconcile();
    await flush();
    expect(gapsOf(res.text())).toEqual([[LOCAL_NAMESPACE]]);
    res.fireClose();
  });

  it("composite: a listener reconnecting with a cursor its peer can no longer serve gets one gap for that peer — and a replay for the servable one", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const local = replayingEngine({ epoch: LOCAL_EPOCH });
    const studio = replayingEngine({ epoch: PEER_EPOCH });
    for (const n of [1, 2]) local.publish(...partEvent(n));
    const driver = replayDriver({ local, studio }, ownerMap);
    const res = mockRes();
    // a cursor from before the peer's restart: `studio` names a dead epoch
    driver.handle(mockReq(`/global/event?lastEventID=local=${local.idAt(1)};studio=${RESTARTED_EPOCH}:9`), res);
    await flush();
    expect(local.subscriptions[0]).toMatchObject({ cursor: local.idAt(1), reset: false });
    expect(studio.subscriptions[0]).toMatchObject({ cursor: `${RESTARTED_EPOCH}:9`, reset: true });
    expect(gapsOf(res.text())).toEqual([["studio"]]);
    // the local replay arrived: frame 2 (the one after the cursor)
    expect(sseFrames(res.text()).filter((f) => f.type === "message.part.updated").map((f) => f.data!.payload.properties.n)).toEqual([2]);
    res.fireClose();
  });

  it("fleet-of-one: the engine's reset frame passes VERBATIM (it is the engine's own signal — #1264: nothing synthetic), and the listener lives", async () => {
    const engines: { local: ReplayingEngine } = { local: replayingEngine({ epoch: LOCAL_EPOCH }) };
    const sent: string[] = [];
    const driver = replayDriver(engines as { local: ReplayingEngine }, new SessionOwnerMap(), {
      openUpstream: (r) => {
        const sub = engines.local.subscribe(r.lastEventId);
        const next = sub.source.next;
        sub.source.next = async () => {
          const f = await next();
          if (f !== null) sent.push(f);
          return f;
        };
        return sub.source;
      },
    });
    const res = mockRes();
    driver.handle(mockReq(`/global/event?lastEventID=${LOCAL_EPOCH}:4`), res); // stale: the engine is at 0
    await flush();
    engines.local.publish(...partEvent(1));
    await flush();
    engines.local.subscriptions[0].end(); // mid-stream: the local engine restarts
    await flush();
    engines.local = replayingEngine({ epoch: "bG9jYWwy" });
    driver.reconcile(); // resume → the new process resets
    await flush();
    engines.local.publish(...partEvent(2));
    await flush();

    expect(res.text()).toBe(sent.join("")); // byte-identical to what the engine sent, ids included
    const types = sseFrames(res.text()).map((f) => f.type);
    expect(types.filter((t) => t === "server.cursor.unservable")).toHaveLength(2); // the stale connect cursor, then the restart
    expect(types).not.toContain("amicode.sync.gap");
    expect(res.destroyed).toBe(false);
    res.fireClose();
  });
});

/** Serve a replaying engine's `/global/event` over a REAL socket (127.0.0.1,
 *  port 0, dialed at its own address): each request subscribes with its
 *  `?lastEventID=` and writes the subscription's frames as they come. Records
 *  every byte written per connection; `drop()` destroys the open connections
 *  (a link loss — the reader sees an error, not a clean end). */
async function serveReplayingEngine(engine: ReplayingEngine) {
  const written: string[][] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const cursor = new URL(req.url ?? "/", "http://engine").searchParams.get("lastEventID") ?? undefined;
    const sub = engine.subscribe(cursor);
    const mine: string[] = [];
    written.push(mine);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
    res.flushHeaders();
    open.add(res);
    res.on("close", () => {
      open.delete(res);
      sub.end("error");
    });
    void (async () => {
      for (;;) {
        const f = await sub.source.next();
        if (f === null) return;
        mine.push(f);
        res.write(f);
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as import("node:net").AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    written,
    drop: () => {
      for (const res of open) res.destroy();
    },
    stop: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

describe("#1777 AC3 — fleet-of-one: the listener's stream is byte-identical to the engine's, ids included", () => {
  it("over REAL sockets, across a link loss and the replayed re-open: every byte the engine wrote, and nothing else", async () => {
    const engine = replayingEngine({ epoch: LOCAL_EPOCH, now: () => 1_700_000_000_000 });
    const upstream = await serveReplayingEngine(engine);
    const lines: string[] = [];
    const w = lineWaiter(lines);
    const driver = new SseFanInDriver({
      ownerMap: new SessionOwnerMap(), // fleet-of-one: the verbatim relay
      localMachineId: "macbook",
      localEventUrl: () => upstream.url,
      peerBaseUrl: () => undefined,
      peerToken: () => ({ ok: false as const, reason: "absent" as const }),
      reconcileMs: 999_999,
      census: new FanInCensus({ plane: "observe", sink: w.sink }),
    });
    const front = http.createServer((req, res) => void driver.handle(req, res));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    const { port } = front.address() as import("node:net").AddressInfo;
    let body = "";
    let wake: () => void = () => undefined;
    // event-driven (each listener chunk wakes it); the deadline only names a regression
    const until = async (pred: () => boolean, what: string) => {
      const deadline = Date.now() + 3_000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; the listener got:\n${body}`);
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 100);
        });
      }
    };
    const listener = http.get(`http://127.0.0.1:${port}/global/event`, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
        wake();
      });
      res.on("error", () => undefined);
    });
    listener.on("error", () => undefined);
    const engineBytes = () => upstream.written.flat().join("");
    try {
      await until(() => body.includes("server.connected"), "the connected frame");
      for (const n of [1, 2]) engine.publish(...partEvent(n));
      engine.heartbeat();
      await until(() => body === engineBytes() && body.includes("server.heartbeat"), "the first connection's frames");

      upstream.drop(); // the link dies mid-stream
      await w.waitFor((l) => l.includes("arm=local reason=upstream-error"));
      for (const n of [3, 4]) engine.publish(...partEvent(n)); // missed while down
      driver.reconcile(); // resume from the last id the listener has
      await until(() => upstream.written.length === 2 && body.includes('"n":4'), "the replay");
      engine.publish(...partEvent(5));
      await until(() => body.includes('"n":5'), "the live frame after the replay");

      expect(upstream.written).toHaveLength(2);
      expect(body).toBe(engineBytes()); // byte-identical, ids included, across both connections
      const ids = [...body.matchAll(/^id: (.*)$/gm)].map((m) => m[1]);
      expect(ids.every((i) => /^bG9jYWwx:\d+$/.test(i))).toBe(true); // the engine's own bare ids — never a composite
      expect(body).not.toContain("amicode.sync.gap");
      expect(body).not.toContain("local=");
    } finally {
      listener.destroy();
      front.closeAllConnections?.();
      await new Promise<void>((r) => front.close(() => r()));
      await upstream.stop();
    }
  });
});

describe("#1777 AC4 — a reconnecting listener resumes with the SSE id it last saw (composite when fanned in)", () => {
  it("the last composite id a fanned-in listener saw resumes EVERY arm from its own engine id — each engine replays, no gap", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update(STUDIO_OWNED);
    const local = replayingEngine({ epoch: LOCAL_EPOCH });
    const studio = replayingEngine({ epoch: PEER_EPOCH });
    const driver = replayDriver({ local, studio }, ownerMap);
    const first = mockRes();
    driver.handle(mockReq("/global/event"), first);
    await flush();
    local.publish(...partEvent(1));
    studio.publish(...partEvent(2));
    local.publish(...partEvent(3));
    await flush();
    const lastSeen = sseFrames(first.text()).at(-1)!.id!; // the client's cursor
    expect(lastSeen).toBe(`local=${local.idAt(2)};studio=${studio.idAt(1)}`);
    first.fireClose(); // the view reloads / its socket drops

    studio.publish(...partEvent(4)); // both origins move on while it is away
    local.publish(...partEvent(5));
    const again = mockRes();
    driver.handle(mockReq(`/global/event?lastEventID=${encodeURIComponent(lastSeen)}`), again);
    await flush();

    expect(local.subscriptions.at(-1)).toMatchObject({ cursor: local.idAt(2), reset: false });
    expect(studio.subscriptions.at(-1)).toMatchObject({ cursor: studio.idAt(1), reset: false });
    const frames = sseFrames(again.text());
    expect(frames.filter((f) => f.type === "message.part.updated").map((f) => f.data!.payload.properties.n).sort()).toEqual([4, 5]);
    expect(frames.some((f) => f.type === "amicode.sync.gap")).toBe(false);
    // every frame's id carries both origins' positions, ending at the newest
    expect(parseCompositeCursor(frames.at(-1)!.id)).toEqual(
      new Map([
        [LOCAL_NAMESPACE, local.idAt(3)],
        ["studio", studio.idAt(2)],
      ]),
    );
    again.fireClose();
  });
});
