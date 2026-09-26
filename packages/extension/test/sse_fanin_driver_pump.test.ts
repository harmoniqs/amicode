// sse_fanin_driver_pump.test.ts — #1566 (Dead arm zombie: cleanup source on
// pump exit). Verifies that when an upstream SSE source ends (or throws), the
// pump() method removes it from the internal sources Map so the next
// reconcile() tick can re-open the arm — not leave a zombie that blocks
// reconnection indefinitely.
import { describe, it, expect } from "vitest";
import * as http from "node:http";
import { SseFanInDriver } from "../src/amicode_service/sse_fanin_driver";
import type { SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
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
