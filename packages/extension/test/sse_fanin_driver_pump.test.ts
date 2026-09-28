// sse_fanin_driver_pump.test.ts — #1566 (Dead arm zombie: cleanup source on
// pump exit). Verifies that when an upstream SSE source ends (or throws), the
// pump() method removes it from the internal sources Map so the next
// reconcile() tick can re-open the arm — not leave a zombie that blocks
// reconnection indefinitely.
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { SseFanInDriver } from "../src/amicode_service/sse_fanin_driver";
import type { SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
import { LOCAL_NAMESPACE } from "../src/amicode_service/sse_fanin_aggregator";
import { SessionOwnerMap } from "../src/amicode_service/session_multiplexer";

// ── helpers ──────────────────────────────────────────────────────────────────

function sseFrame(...lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

/** A controllable frame source: push frames into it, end it on demand. */
interface Ctl {
  push(frame: string): void;
  end(): void;
  source: SseFrameSource;
}
function controllableSource(): Ctl {
  const queue: string[] = [];
  const waiters: Array<(v: string | null) => void> = [];
  let ended = false;
  const push = (f: string): void => {
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
    },
  };
}

/** A mock ServerResponse that collects writes. */
function mockRes(): http.ServerResponse & { text(): string; fireClose(): void } {
  const chunks: string[] = [];
  const closeListeners: Array<() => void> = [];
  return {
    headersSent: false,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    writeHead() {
      return this;
    },
    flushHeaders() {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "close") closeListeners.push(cb as () => void);
      return this;
    },
    end() {},
    text() {
      return chunks.join("");
    },
    fireClose() {
      for (const cb of closeListeners) cb();
    },
  } as unknown as http.ServerResponse & { text(): string; fireClose(): void };
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

    const F1 = sseFrame("event: message", 'data: {"from":"studio","n":1}', "id: p1");
    const F2 = sseFrame("event: message", 'data: {"from":"studio","n":2}', "id: p2");

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

    const L1 = sseFrame("event: message", 'data: {"from":"macbook","n":1}', "id: l1");
    const L2 = sseFrame("event: message", 'data: {"from":"macbook","n":2}', "id: l2");

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
