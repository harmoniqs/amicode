// amicode_service_observe_event_routing.test.ts — #1543 / #1565 (Fleet Studio
// B2b, SSE fan-in on the OBSERVATION path, ADR 0033 D1–D4 via ADR 0034 D6). A
// NEW, SEPARATELY-ARMED `/event` interception that reuses the SseFanInDriver as
// a library — it is NOT the premium `server.ts` wire (`fleetMultiplexEnabled() &&
// fleetPlane.eventFanIn`), NOT behind AMICO_FLEET_MULTIPLEX, and NOT behind the
// multiplexer (ADR 0033 Amendment 1). The driver always accepts when wired
// (#1565): fleet-of-one byte-identity is maintained by the aggregator's §D4
// relay; reconcile opens peer arms as the OwnerMapFeed discovers them.
//
// The route dispatch → the observation `/event` interception → the #1511
// aggregator → the real downstream `res` is exercised deterministically via an
// INJECTED upstream opener; the live cross-machine delivery is the opt-in E2E.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";

import { AmicodeServiceServer } from "../src/amicode_service/server";
import { createAmicodeService } from "../src/amicode_service";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import { SseFanInDriver } from "../src/amicode_service/sse_fanin_driver";
import type { SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
import { SessionOwnerMap } from "../src/amicode_service/session_multiplexer";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
import { serverAuthHeader } from "../src/server_auth";

const PW = "observe-event-1543";
const authed = { Authorization: serverAuthHeader(PW) };

// ── an SSE stub: emits a fixed frame list as text/event-stream then ends (so a
//    byte-identity read completes). Records path / ?lastEventID / auth. ────────
interface SseStub {
  url: string;
  requests: Array<{ path: string; lastEventID: string | null; auth?: string }>;
  stop(): Promise<void>;
}
function startSseStub(frames: string[]): Promise<SseStub> {
  const requests: SseStub["requests"] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    requests.push({
      path: u.pathname,
      lastEventID: u.searchParams.get("lastEventID"),
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    });
    if (u.pathname === "/session" && (req.method ?? "GET") === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify([{ id: "ses-studio", time: { created: 3, updated: 4 } }]));
    }
    if (u.pathname === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ version: "stub-1543" }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const f of frames) res.write(f);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function sseFrame(...lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

async function readSseFrames(url: string, headers: Record<string, string>, opts: { maxFrames: number; timeoutMs: number }): Promise<string[]> {
  const frames: string[] = [];
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!res.ok || res.body === null) return frames;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (frames.length < opts.maxFrames) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0 && frames.length < opts.maxFrames) {
          frames.push(buf.slice(0, idx + 2));
          buf = buf.slice(idx + 2);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  } catch {
    /* timeout / blip — return whatever whole frames we got */
  }
  return frames;
}

/** A controllable frame source (stays OPEN between pushes; a real SSE stream
 *  never ends on its own) — feeds the aggregator deterministically. */
interface Ctl {
  push(frame: string): void;
  end(): void;
  source: SseFrameSource;
}
function controllableSource(preload: string[] = []): Ctl {
  const queue: string[] = [...preload];
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

// ══════════════════════════════════════════════════════════════════════════════
// AC1 (#1565 — the fleet-of-one byte-identity guard). With the observation
// event plane ATTACHED but ZERO non-local owners, the driver ACCEPTS in
// fleet-of-one mode — the aggregator's §D4 byte-identity relay delivers local
// frames verbatim. Reconcile opens peer arms as the OwnerMapFeed discovers them.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1543 AC1 — observation /event fleet-of-one byte-identity (zero non-local owners → driver accepts in fleet-of-one mode → byte-identical)", () => {
  const F1 = sseFrame("event: message", 'data: {"a":1}', "id: 1");
  const F2 = sseFrame("event: message", 'data: {"b":2}', "id: 2");

  it("zero non-local owners → driver accepts in fleet-of-one mode → local frames arrive byte-identical", async () => {
    // The driver now ACCEPTS even with zero non-local owners (#1565). The
    // aggregator's fleet-of-one mode (§D4) writes local frames VERBATIM when no
    // peer arms are active, so the output matches the input frames byte-for-byte.
    const localCtl = controllableSource([F1, F2]);
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-local", amicode_owner: { owner_machine_id: "macbook", owner_name: "macbook", is_local: true } }]);

    const svc = new AmicodeServiceServer({ password: PW });
    svc.attachObservationEventPlane(
      new SseFanInDriver({
        ownerMap,
        localMachineId: "macbook",
        localEventUrl: () => "http://local.invalid",
        peerBaseUrl: () => undefined,
        peerToken: () => ({ ok: false, reason: "absent" }),
        reconcileMs: 999999,
        openUpstream: () => localCtl.source,
      }),
    );
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const frames = await readSseFrames(`${origin}/event`, authed, { maxFrames: 2, timeoutMs: 2500 });
      expect(frames).toEqual([F1, F2]); // byte-identical via §D4 fleet-of-one relay
    } finally {
      localCtl.end();
      await svc.stop();
    }
  });

  it("?lastEventID cursor reaches the local arm's upstream as the local namespace resume id", async () => {
    // The driver parses the composite cursor and passes the local namespace's
    // resume id to the local arm's openUpstream call. A bare scalar "42" (no
    // namespace separator) is the #1264 back-compat form → local arm's position.
    const localCtl = controllableSource([sseFrame("data: {}", "id: 9")]);
    const seenUpstream: Array<{ namespace: string; lastEventId?: string }> = [];
    const ownerMap = new SessionOwnerMap();

    const svc = new AmicodeServiceServer({ password: PW });
    svc.attachObservationEventPlane(
      new SseFanInDriver({
        ownerMap,
        localMachineId: "macbook",
        localEventUrl: () => "http://local.invalid",
        peerBaseUrl: () => undefined,
        peerToken: () => ({ ok: false, reason: "absent" }),
        reconcileMs: 999999,
        openUpstream: (r) => {
          seenUpstream.push({ namespace: r.namespace, lastEventId: r.lastEventId });
          return localCtl.source;
        },
      }),
    );
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      await readSseFrames(`${origin}/event?lastEventID=42`, authed, { maxFrames: 1, timeoutMs: 2500 });
      const localReq = seenUpstream.find((u) => u.namespace === "local");
      expect(localReq).toBeDefined();
      expect(localReq!.lastEventId).toBe("42");
    } finally {
      localCtl.end();
      await svc.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — a peer-owned session's events STREAM LIVE into this window's single
// /event (the driver takes over at ≥1 non-local owner; the peer arm's frame is
// fanned in, frame-preserved per ADR 0033 D2). Injected upstream for determinism.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1543 AC2 — a peer-owned session's events fan in live", () => {
  it("≥1 reachable non-local owner → the peer frame's data survives on the single downstream /event", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } }]);
    const peerCtl = controllableSource([sseFrame("event: message", 'data: {"from":"studio","n":7}', "id: p1")]);
    const localCtl = controllableSource(); // local arm stays open, no frames
    const seenUpstream: Array<{ namespace: string; authHeader?: string }> = [];

    const svc = new AmicodeServiceServer({ password: PW });
    // No engine proxy needed: the driver takes over the response.
    svc.attachObservationEventPlane(
      new SseFanInDriver({
        ownerMap,
        localMachineId: "macbook",
        localEventUrl: () => "http://local.invalid",
        peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
        peerToken: (id) => (id === "studio" ? { ok: true, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } } : { ok: false, reason: "absent" }),
        reconcileMs: 999999,
        openUpstream: (r) => {
          seenUpstream.push({ namespace: r.namespace, ...(r.authHeader ? { authHeader: r.authHeader } : {}) });
          return r.namespace === "studio" ? peerCtl.source : localCtl.source;
        },
      }),
    );
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const frames = await readSseFrames(`${origin}/event`, authed, { maxFrames: 6, timeoutMs: 2500 });
      const joined = frames.join("");
      expect(joined).toContain('"from":"studio"'); // the peer frame's data survived (D2 relay)
      // the peer arm authed AS ITSELF with its OWN token (decision A / D2)
      const peerArm = seenUpstream.find((u) => u.namespace === "studio");
      expect(peerArm).toBeDefined();
      expect(peerArm!.authHeader).toBe(peerAuthHeader("tok-studio"));
    } finally {
      peerCtl.end();
      localCtl.end();
      await svc.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Inert when UNATTACHED — a server with NO event plane consults nothing; /event
// streams byte-identically through the engine proxy (the `?.handle` no-op).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1543 — the observation event plane is INERT when unattached (structural byte-identity)", () => {
  it("no event plane attached → /event streams verbatim through the engine proxy", async () => {
    const F = sseFrame("event: message", 'data: {"z":1}', "id: 5");
    const engine = await startSseStub([F]);
    try {
      const server = new AmicodeServiceServer({ password: PW });
      server.attachEngineProxy(new EngineProxy({ getUrl: () => engine.url }));
      const origin = (await server.start()).toString().replace(/\/$/, "");
      const body = await (await fetch(`${origin}/event`, { headers: authed })).text();
      await server.stop();
      expect(body).toBe(F);
    } finally {
      await engine.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Production wiring — createAmicodeService on the OBSERVATION-ONLY path attaches
// the event plane wired from fleetPeers. With a serving SSE peer owned in the
// projection, GET /event TAKES OVER and opens the peer's /event upstream with
// the peer reader token (proving the real wiring, not a hand-attached driver).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1543 — production wiring (createAmicodeService observation-only path)", () => {
  let root: string;
  const savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
  let engineStub: SseStub;
  let peerStub: SseStub;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1543-wire-"));
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
    engineStub = await startSseStub([sseFrame("data: {}", "id: local-1")]);
    peerStub = await startSseStub([sseFrame("event: message", 'data: {"peer":true}', "id: p9")]);
  });
  afterAll(async () => {
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    await engineStub?.stop();
    await peerStub?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function servingPeerProvider() {
    return {
      localMachineId: "macbook",
      getServingPeers: () => [{ machineId: "studio" }],
      getBlockedPeers: () => [] as Array<{ machineId: string; reason: "identity-conflict" }>,
      readPeerToken: (id: string) =>
        id === "studio" ? ({ ok: true as const, credential: { baseUrl: peerStub.url, token: "tok-studio" } }) : ({ ok: false as const }),
      rosterLookup: (id: string) => ({ name: id }),
    };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  }

  it("observation-only boot + a serving owned peer → GET /event opens the peer's /event upstream with the peer reader token", async () => {
    const svc = createAmicodeService({
      password: PW,
      engine: { password: "engine-mint", getUrl: () => engineStub.url },
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // let the OwnerMapFeed pull the projection so the peer becomes a non-local owner
      await waitFor(() => peerStub.requests.some((r) => r.path === "/session"));
      await new Promise((r) => setTimeout(r, 250));
      const peerEventBefore = peerStub.requests.filter((r) => r.path === "/event").length;
      await readSseFrames(`${origin}/event`, { Authorization: serverAuthHeader("engine-mint") }, { maxFrames: 4, timeoutMs: 2500 });
      const peerEventReqs = peerStub.requests.filter((r) => r.path === "/event");
      expect(peerEventReqs.length).toBeGreaterThan(peerEventBefore); // the peer arm was opened (takeover)
      expect(peerEventReqs.at(-1)!.auth).toBe(peerAuthHeader("tok-studio")); // authed as the peer, its own token
    } finally {
      await svc.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1565 — late peer discovery: the driver accepts at zero owners, streams local
// frames in fleet-of-one mode, then reconcile opens peer arms when the
// OwnerMapFeed discovers them (the race-fix contract).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1565 — late peer discovery (observation-path race fix)", () => {
  it("zero-owner start → ownerMap gains a peer → reconcile opens the peer arm and its frames arrive", async () => {
    const F_local = sseFrame("event: message", 'data: {"src":"local"}', "id: L1");
    const F_peer = sseFrame("event: message", 'data: {"src":"studio"}', "id: P1");

    const localCtl = controllableSource([F_local]);
    const peerCtl = controllableSource();
    const ownerMap = new SessionOwnerMap(); // zero owners initially
    const seenUpstream: Array<{ namespace: string }> = [];

    const driver = new SseFanInDriver({
      ownerMap,
      localMachineId: "macbook",
      localEventUrl: () => "http://local.invalid",
      peerBaseUrl: (id) => (id === "studio" ? "http://studio.invalid" : undefined),
      peerToken: (id) =>
        id === "studio"
          ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
          : { ok: false as const, reason: "absent" as const },
      reconcileMs: 999999,
      openUpstream: (r) => {
        seenUpstream.push({ namespace: r.namespace });
        if (r.namespace === "studio") return peerCtl.source;
        return localCtl.source;
      },
    });

    const svc = new AmicodeServiceServer({ password: PW });
    svc.attachObservationEventPlane(driver);
    const origin = (await svc.start()).toString().replace(/\/$/, "");

    try {
      // Schedule late peer discovery: after 300ms, add a peer and push its frame.
      // The driver already accepted at zero owners and is streaming local frames.
      setTimeout(() => {
        ownerMap.update([
          { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
        ]);
        driver.reconcile();
        peerCtl.push(F_peer);
      }, 300);

      // Read frames — expect both the local frame and the late-arriving peer frame
      const frames = await readSseFrames(`${origin}/event`, authed, { maxFrames: 2, timeoutMs: 3000 });
      expect(frames.length).toBe(2);
      // First frame: local, byte-identical (fleet-of-one at the time)
      expect(frames[0]).toContain('"src":"local"');
      // Second frame: the peer's frame arrived after late reconcile
      expect(frames[1]).toContain('"src":"studio"');
      // The peer arm was opened by reconcile
      expect(seenUpstream.some((u) => u.namespace === "studio")).toBe(true);
    } finally {
      localCtl.end();
      peerCtl.end();
      await svc.stop();
    }
  });
});
