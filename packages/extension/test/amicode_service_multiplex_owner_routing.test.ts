// amicode_service_multiplex_owner_routing.test.ts — #1449 (Fleet Studio wiring
// W1b): retire the single attachment pointer, feed the owner-map from the
// N-peer projection, and route the ATTACHED arm per-session.
//
// Pins the three ACs (Testing Decisions: extend the session-relay integration
// suite; assert per-verb routing, the 503-not-local degrade, and the
// attached-arm-only retirement — cross-machine routing proven against STUBBED
// peers, not a real fleet):
//   AC1 — SessionOwnerMap.update() is fed by a live loop (a timer calls
//         buildFleetProjection on an interval and ownerMap.update(sessions));
//         routing does NOT depend on the sidebar being polled.
//   AC2 — two SESSION-PATHED requests owned by different reachable peers route
//         to their respective owners; an owned-but-UNREACHABLE session yields
//         FLEET_PEER_UNREACHABLE 503 (never local); a keyless request → local.
//   AC3 — the single global attachment pointer is removed from the attached arm
//         on BOTH the request and upgrade paths; the keeper (/amicode/roster) +
//         /amicode/fleet/* arms are preserved; non-fleet still resolves local.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  OwnerMapFeed,
  SessionOwnerMap,
  SessionMultiplexProxy,
  PENDING_OWNER_TTL_MS,
  OWNER_RETENTION_MS,
  OWNER_MAP_REFRESH_MS,
  fanInReachable,
  type SessionEntry,
} from "../src/amicode_service/session_multiplexer";
import { createAmicodeService } from "../src/amicode_service";
import { SseFanInDriver, type FanInUpstreamRequest } from "../src/amicode_service/sse_fanin_driver";
import { honestSourceComment, type SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
import {
  AmicodeServiceServer,
  fleetMultiplexEnabled,
  FLEET_MULTIPLEX_FLAG,
  FLEET_PEER_UNREACHABLE_ERROR,
  type FleetPlane,
} from "../src/amicode_service/server";
import { HubProxy } from "../src/amicode_service/hub_proxy";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import { writeAttachmentPointerFile } from "../src/amicode_service/attachment_pointer";
import { writeKeeperPointerFile } from "../src/amicode_service/keeper_pointer";
import { writeHubCredential, readHubCredential } from "../src/amicode_service/hub_credential";
import { buildOwnerRoutingProjection, type OwnerRefreshPeer } from "../src/amicode_service/merged_projection";
import { serverAuthHeader } from "../src/server_auth";

// ── a marker stub: returns a distinct marker for every request; records paths ──
interface Stub {
  url: string;
  marker: string;
  requests: string[];
  stop(): Promise<void>;
}
function startStub(marker: string): Promise<Stub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        marker,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — the owner-map is fed by a live loop over the N-peer projection
// ══════════════════════════════════════════════════════════════════════════════
describe("#1449 AC1 — SessionOwnerMap fed by a live projection loop (not a test stub)", () => {
  function projectionOf(sessions: SessionEntry[]): { sessions: SessionEntry[] } {
    return { sessions };
  }

  it("refreshOnce(): the projection's session→owner overlay lands in the owner-map", async () => {
    const ownerMap = new SessionOwnerMap();
    let current: SessionEntry[] = [
      { id: "ses-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
      { id: "ses-B", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } },
    ];
    const feed = new OwnerMapFeed({ ownerMap, buildProjection: async () => projectionOf(current) });

    expect(ownerMap.size).toBe(0); // nothing until the loop runs
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-A")).toBe("machine-a");
    expect(ownerMap.resolveOwner("ses-B")).toBe("machine-b");
    expect(ownerMap.resolveOwner("ses-unknown")).toBeUndefined();
  });

  it("a later projection re-populates the map (a session that moved owner is reflected)", async () => {
    const ownerMap = new SessionOwnerMap();
    let current: SessionEntry[] = [
      { id: "ses-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
    ];
    const feed = new OwnerMapFeed({ ownerMap, buildProjection: async () => projectionOf(current) });
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-A")).toBe("machine-a");
    // the projection now reports ses-A owned by a DIFFERENT machine
    current = [{ id: "ses-A", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } }];
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-A")).toBe("machine-b");
  });

  it("a projection BUILD error leaves the last-good map intact (never throws, never clears)", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } }]);
    let errors = 0;
    const feed = new OwnerMapFeed({
      ownerMap,
      buildProjection: async () => {
        throw new Error("peer fan-out failed");
      },
      onError: () => { errors++; },
    });
    await expect(feed.refreshOnce()).resolves.toBeUndefined(); // never throws
    expect(errors).toBe(1);
    expect(ownerMap.resolveOwner("ses-A")).toBe("machine-a"); // last-good intact
  });

  it("start() fires an immediate refresh and then re-refreshes on the interval; stop() halts it", async () => {
    vi.useFakeTimers();
    try {
      const ownerMap = new SessionOwnerMap();
      let calls = 0;
      const feed = new OwnerMapFeed({
        ownerMap,
        intervalMs: 50,
        buildProjection: async () => {
          calls++;
          return { sessions: [] };
        },
      });
      feed.start();
      expect(calls).toBe(1); // immediate refresh on start
      await vi.advanceTimersByTimeAsync(120); // two more intervals
      expect(calls).toBe(3);
      feed.stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(calls).toBe(3); // no further refreshes after stop
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1771 — every ownership refresh logs, PER PEER, its outcome (ok / timeout /
// error / unauthorized), duration and entry count. The projection builder never
// throws and the feed never throws, so before this a peer whose refresh failed
// was silently missing from the map (its event arm closed, its sessions routed
// local) with nothing in any log.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1771 — each ownership refresh logs a per-peer outcome record", () => {
  it("one line per peer: outcome, duration, entries — a failed peer refresh is visible though nothing throws", async () => {
    const ownerMap = new SessionOwnerMap();
    const lines: string[] = [];
    const feed = new OwnerMapFeed({
      ownerMap,
      log: (l) => lines.push(l),
      buildProjection: async () => ({
        sessions: [{ id: "ses-A", amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false } }],
        peers: [
          { machineId: "studio", outcome: "ok", durationMs: 120, entries: 1 },
          { machineId: "mini", outcome: "timeout", durationMs: 10_004, entries: 0, reason: "fetch-failed", detail: "The operation was aborted due to timeout" },
        ],
      }),
    });
    await expect(feed.refreshOnce()).resolves.toBeUndefined();
    expect(ownerMap.resolveOwner("ses-A")).toBe("studio");
    expect(lines).toEqual([
      "[owner-map] refresh peer=studio outcome=ok duration_ms=120 entries=1",
      '[owner-map] refresh peer=mini outcome=timeout duration_ms=10004 entries=0 reason=fetch-failed detail="The operation was aborted due to timeout"',
    ]);
  });

  it("through the REAL routing projection: an unauthorized peer is a named outcome; the healthy peer still lands", async () => {
    const ownerMap = new SessionOwnerMap();
    const lines: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://peer-b")) return new Response("no", { status: 401 });
      if (url.endsWith("/global/health")) return new Response(JSON.stringify({ version: "t" }), { status: 200 });
      if (url.startsWith("http://peer-a")) return new Response(JSON.stringify([{ id: "ses-a1" }, { id: "ses-a2" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 }); // local
    }) as unknown as typeof fetch;
    const feed = new OwnerMapFeed({
      ownerMap,
      log: (l) => lines.push(l),
      buildProjection: async () => {
        const p = await buildOwnerRoutingProjection({
          localMachineId: "macbook",
          local: { getUrl: () => "http://local" },
          peers: [
            { machineId: "peer-a", getUrl: () => "http://peer-a", token: "tok-a" },
            { machineId: "peer-b", getUrl: () => "http://peer-b", token: "tok-b" },
          ],
          rosterLookup: () => undefined,
          fetchImpl,
        });
        return { sessions: p.sessions as SessionEntry[], peers: p.peers };
      },
    });
    await expect(feed.refreshOnce()).resolves.toBeUndefined(); // never throws
    expect(ownerMap.resolveOwner("ses-a1")).toBe("peer-a");
    const a = lines.find((l) => l.includes("peer=peer-a "))!;
    const b = lines.find((l) => l.includes("peer=peer-b "))!;
    expect(a).toMatch(/^\[owner-map\] refresh peer=peer-a outcome=ok duration_ms=\d+ entries=2$/);
    expect(b).toMatch(/^\[owner-map\] refresh peer=peer-b outcome=unauthorized duration_ms=\d+ entries=0 reason=unauthorized$/);
    expect(lines).toHaveLength(2); // per PEER — the local engine is not a peer
  });

  it("a projection BUILD failure is logged too (and still never throws)", async () => {
    const lines: string[] = [];
    const feed = new OwnerMapFeed({
      ownerMap: new SessionOwnerMap(),
      log: (l) => lines.push(l),
      buildProjection: async () => {
        throw new Error("peer fan-out failed");
      },
    });
    await expect(feed.refreshOnce()).resolves.toBeUndefined();
    expect(lines).toEqual(['[owner-map] refresh failed error="peer fan-out failed"']);
  });

  it("#1774: a failed peer's line says what the map did with its entries — retained, expired, dropped, still unavailable", async () => {
    let t = 0;
    const ownerMap = new SessionOwnerMap({ now: () => t });
    const lines: string[] = [];
    let next: { sessions: SessionEntry[]; peers: OwnerRefreshPeer[] } = {
      sessions: [
        { id: "ses-s1", amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false } },
        { id: "ses-s2", amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false } },
        { id: "ses-m1", amicode_owner: { owner_machine_id: "mini", owner_name: "Mini", is_local: false } },
      ],
      peers: [
        { machineId: "studio", outcome: "ok", durationMs: 40, entries: 2 },
        { machineId: "mini", outcome: "ok", durationMs: 30, entries: 1 },
      ],
    };
    const feed = new OwnerMapFeed({ ownerMap, log: (l) => lines.push(l), buildProjection: async () => next });
    await feed.refreshOnce();
    expect(lines.splice(0)).toEqual([
      "[owner-map] refresh peer=studio outcome=ok duration_ms=40 entries=2",
      "[owner-map] refresh peer=mini outcome=ok duration_ms=30 entries=1",
    ]);

    t = 15_000;
    next = {
      sessions: [],
      peers: [
        { machineId: "studio", outcome: "timeout", durationMs: 10_004, entries: 0, reason: "fetch-failed", detail: "The operation was aborted due to timeout" },
        { machineId: "mini", outcome: "unauthorized", durationMs: 9, entries: 0, reason: "unauthorized" },
      ],
    };
    await feed.refreshOnce();
    expect(lines.splice(0)).toEqual([
      '[owner-map] refresh peer=studio outcome=timeout duration_ms=10004 entries=0 reason=fetch-failed detail="The operation was aborted due to timeout" retention=retained held=2 age_ms=15000',
      "[owner-map] refresh peer=mini outcome=unauthorized duration_ms=9 entries=0 reason=unauthorized retention=dropped dropped=1",
    ]);

    t = OWNER_RETENTION_MS + 1;
    next = { sessions: [], peers: [{ machineId: "studio", outcome: "error", durationMs: 12, entries: 0, reason: "fetch-failed", detail: "HTTP 502" }] };
    await feed.refreshOnce();
    expect(lines.splice(0)).toEqual([
      '[owner-map] refresh peer=studio outcome=error duration_ms=12 entries=0 reason=fetch-failed detail="HTTP 502" retention=expired dropped=2',
    ]);

    t += 5_000;
    await feed.refreshOnce();
    expect(lines.splice(0)).toEqual([
      '[owner-map] refresh peer=studio outcome=error duration_ms=12 entries=0 reason=fetch-failed detail="HTTP 502" retention=unavailable',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1774 — the ownership map keeps a peer's sessions across a failed refresh. A
// failed peer fetch is an EMPTY slice in the projection (the builder never
// throws), so before this the peer's sessions vanished from the map on one blip:
// its event arm closed without notice and its sessions routed local (404/empty).
// Retention is decided PER PEER from #1771's refresh outcome — timeouts, network
// errors and 5xx retain; an unauthorized answer does not (a credential problem).
// ══════════════════════════════════════════════════════════════════════════════
const ownedBy = (id: string, owner: string, directory?: string): SessionEntry => ({
  id,
  ...(directory !== undefined ? { directory } : {}),
  amicode_owner: { owner_machine_id: owner, owner_name: owner, is_local: false },
});
const peerOk = (machineId: string, entries = 1): OwnerRefreshPeer => ({ machineId, outcome: "ok", durationMs: 40, entries });
const peerTimeout = (machineId: string): OwnerRefreshPeer => ({
  machineId,
  outcome: "timeout",
  durationMs: 10_004,
  entries: 0,
  reason: "fetch-failed",
  detail: "The operation was aborted due to timeout",
});
const peer5xx = (machineId: string): OwnerRefreshPeer => ({ machineId, outcome: "error", durationMs: 12, entries: 0, reason: "fetch-failed", detail: "HTTP 502" });
const peerNetErr = (machineId: string): OwnerRefreshPeer => ({ machineId, outcome: "error", durationMs: 3, entries: 0, reason: "fetch-failed", detail: "fetch failed" });
const peerUnauthorized = (machineId: string): OwnerRefreshPeer => ({ machineId, outcome: "unauthorized", durationMs: 9, entries: 0, reason: "unauthorized" });

describe("#1774 AC1 — a refresh in which one peer times out or errors keeps that peer's previous owner entries", () => {
  for (const [label, failed] of [
    ["a timeout", peerTimeout("studio")],
    ["a 5xx answer", peer5xx("studio")],
    ["a network error", peerNetErr("studio")],
  ] as const) {
    it(`${label}: the peer's sessions still resolve to it (owner + directory); the healthy peer is replaced as usual`, async () => {
      const ownerMap = new SessionOwnerMap();
      let next: { sessions: SessionEntry[]; peers: OwnerRefreshPeer[] } = {
        sessions: [ownedBy("ses-s1", "studio", "/srv/a"), ownedBy("ses-s2", "studio"), ownedBy("ses-m1", "mini")],
        peers: [peerOk("studio", 2), peerOk("mini")],
      };
      const feed = new OwnerMapFeed({ ownerMap, buildProjection: async () => next });
      await feed.refreshOnce();
      // studio's fetch fails: its slice is EMPTY in this projection; mini answers.
      next = { sessions: [ownedBy("ses-m2", "mini")], peers: [failed, peerOk("mini")] };
      await feed.refreshOnce();
      expect(ownerMap.resolveOwner("ses-s1")).toBe("studio");
      expect(ownerMap.resolveOwner("ses-s2")).toBe("studio");
      expect(ownerMap.resolveDirectory("ses-s1")).toBe("/srv/a");
      expect(ownerMap.ownerMachineIds().sort()).toEqual(["mini", "studio"]);
      // the healthy peer's refresh is still authoritative
      expect(ownerMap.resolveOwner("ses-m1")).toBeUndefined();
      expect(ownerMap.resolveOwner("ses-m2")).toBe("mini");
    });
  }

  it("through the REAL routing projection: a peer whose session list answers 502 keeps its owner entries", async () => {
    let studioDown = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://studio") && studioDown) return new Response("bad gateway", { status: 502 });
      if (url.endsWith("/global/health")) return new Response(JSON.stringify({ version: "t" }), { status: 200 });
      if (url.startsWith("http://studio")) return new Response(JSON.stringify(/archived=true/.test(url) ? [] : [{ id: "ses-s1" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 }); // local
    }) as unknown as typeof fetch;
    const ownerMap = new SessionOwnerMap();
    const feed = new OwnerMapFeed({
      ownerMap,
      buildProjection: async () => {
        const p = await buildOwnerRoutingProjection({
          localMachineId: "macbook",
          local: { getUrl: () => "http://local" },
          peers: [{ machineId: "studio", getUrl: () => "http://studio", token: "tok" }],
          rosterLookup: () => undefined,
          fetchImpl,
        });
        return { sessions: p.sessions as SessionEntry[], peers: p.peers };
      },
    });
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-s1")).toBe("studio");
    studioDown = true;
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-s1")).toBe("studio"); // retained, not dropped to local
  });

  it("its event arm stays OPEN across the failed refresh — no close, no unavailable comment", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    const origins = armOrigins();
    const driver = retentionDriver(origins, ownerMap);
    const res = sseRes();
    driver.handle(sseReq(), res);
    await settle();
    expect(origins.opens("studio")).toBe(1);

    ownerMap.update([], [peerTimeout("studio")]); // studio's slice is empty this refresh
    driver.reconcile();
    await settle();
    expect(origins.closes("studio")).toBe(0);
    expect(origins.opens("studio")).toBe(1); // the same arm, never re-opened
    expect(res.text()).not.toContain("unavailable");
    res.fireClose();
  });
});

describe("#1774 AC2 — past the retention window the entries expire, the arm closes, and listeners get the named unavailable comment", () => {
  it(`the default window is ${OWNER_RETENTION_MS} ms since the peer's last GOOD refresh: retained through it, expired past it`, () => {
    let t = 1_000_000;
    const m = new SessionOwnerMap({ now: () => t });
    m.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    t += 30_000;
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-s1")).toBe("studio");
    t += 30_000; // exactly the window since the last good refresh
    m.update([], [peer5xx("studio")]);
    expect(m.resolveOwner("ses-s1")).toBe("studio");
    t += 1; // past it
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-s1")).toBeUndefined();
    expect(m.size).toBe(0);
    expect(m.isUnavailable("studio")).toBe(true);
    // still a NAMED owner of the fan-in membership (so the stream says so) …
    expect(m.ownerMachineIds()).toEqual(["studio"]);
    // … and never an active arm, whatever its transport says
    expect(fanInReachable(m, () => true)("studio")).toBe(false);
  });

  it("the window is configurable per map (retentionMs)", () => {
    let t = 0;
    const m = new SessionOwnerMap({ now: () => t, retentionMs: 5_000 });
    m.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    t = 5_000;
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-s1")).toBe("studio");
    t = 5_001;
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-s1")).toBeUndefined();
  });

  it("expiry closes the peer's arm and the listener receives the named unavailable comment — not silence", async () => {
    let t = 0;
    const ownerMap = new SessionOwnerMap({ now: () => t });
    ownerMap.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    const origins = armOrigins();
    const driver = retentionDriver(origins, ownerMap);
    const res = sseRes();
    driver.handle(sseReq(), res);
    await settle();
    expect(origins.opens("studio")).toBe(1);

    t = OWNER_RETENTION_MS + 1;
    ownerMap.update([], [peerTimeout("studio")]);
    driver.reconcile();
    await settle();
    expect(origins.closes("studio")).toBe(1);
    expect(res.text()).toContain(honestSourceComment("studio", "peer-unreachable"));
    // announced once, not on every reconcile
    driver.reconcile();
    await settle();
    expect(res.text().split("source studio unavailable").length - 1).toBe(1);
    res.fireClose();
  });

  it("an UNAUTHORIZED refresh does not retain: the entries drop at once and the peer is named unavailable (Key Decision)", async () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    const origins = armOrigins();
    const driver = retentionDriver(origins, ownerMap);
    const res = sseRes();
    driver.handle(sseReq(), res);
    await settle();

    ownerMap.update([], [peerUnauthorized("studio")]); // well inside the window
    expect(ownerMap.resolveOwner("ses-s1")).toBeUndefined();
    driver.reconcile();
    await settle();
    expect(origins.closes("studio")).toBe(1);
    expect(res.text()).toContain(honestSourceComment("studio", "peer-unreachable"));
    res.fireClose();
  });

  it("a trust or credential problem drops like unauthorized; a transport-down peer retains like a timeout", () => {
    const m = new SessionOwnerMap();
    for (const reason of ["untrusted", "credential-missing", "identity-conflict"] as const) {
      m.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
      m.update([], [{ machineId: "studio", outcome: "error", reason }]);
      expect(m.resolveOwner("ses-s1")).toBeUndefined();
    }
    m.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    m.update([], [{ machineId: "studio", outcome: "error", reason: "no-upstream" }]);
    expect(m.resolveOwner("ses-s1")).toBe("studio");
  });

  it("a peer that LEAVES the refreshed set is gone, not retained and not named unavailable", () => {
    const m = new SessionOwnerMap();
    m.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    m.update([], []); // studio is no longer a serving peer
    expect(m.resolveOwner("ses-s1")).toBeUndefined();
    expect(m.isUnavailable("studio")).toBe(false);
    expect(m.ownerMachineIds()).toEqual([]);
  });

  it("production wiring (observation boot): a peer whose refresh turns unauthorized is announced unavailable on the live /event", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the feed + reconcile cadences; HTTP stays real
    let studioDenies = false;
    const local = await startFleetStub(() => false, []);
    const studio = await startFleetStub(() => studioDenies, [{ id: "ses-s1" }]);
    const root = mkdtempSync(join(tmpdir(), "amicode-1774-wire-"));
    const savedHub = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
    const svc = createAmicodeService({
      password: "svc-1774",
      engine: { password: "engine-1774", getUrl: () => local.url },
      fleet: {
        hub: { getUrl: () => undefined },
        observationOnly: true,
        fleetPeers: {
          localMachineId: "macbook",
          getServingPeers: () => [{ machineId: "studio" }],
          readPeerToken: (id) => (id === "studio" ? { ok: true, credential: { baseUrl: studio.url, token: "tok-studio" } } : { ok: false }),
          rosterLookup: (id) => ({ name: id }),
        },
      },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const stream = new AbortController();
    try {
      expect(await until(() => studio.listReads() >= 2)).toBe(true); // the boot refresh (active + archived)
      await settle();
      const res = await fetch(`${origin}/event`, { headers: { Authorization: serverAuthHeader("engine-1774") }, signal: stream.signal });
      const text = streamText(res);
      expect(await until(() => studio.eventOpens() === 1)).toBe(true); // the peer arm is open

      studioDenies = true;
      const reads = studio.listReads();
      await vi.advanceTimersByTimeAsync(OWNER_MAP_REFRESH_MS); // the next owner-map refresh
      expect(await until(() => studio.listReads() >= reads + 2)).toBe(true);
      await settle();
      await vi.advanceTimersByTimeAsync(1_000); // the listener's reconcile tick
      expect(await until(() => text().includes(honestSourceComment("studio", "peer-unreachable")))).toBe(true);
    } finally {
      stream.abort();
      await svc.stop();
      vi.useRealTimers();
      await Promise.all([local.stop(), studio.stop()]);
      if (savedHub === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
      else process.env.AMICO_FLEET_HUB_FILE = savedHub;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#1774 AC3 — a successful refresh replaces the peer's entries authoritatively", () => {
  it("after a retained failure, the next good refresh drops the sessions that ended and adds the new ones", () => {
    let t = 0;
    const m = new SessionOwnerMap({ now: () => t });
    m.update([ownedBy("ses-ended", "studio"), ownedBy("ses-kept", "studio", "/old")], [peerOk("studio", 2)]);
    t = 10_000;
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-ended")).toBe("studio"); // retained through the blip
    t = 20_000;
    m.update([ownedBy("ses-kept", "studio", "/new"), ownedBy("ses-born", "studio")], [peerOk("studio", 2)]);
    expect(m.resolveOwner("ses-ended")).toBeUndefined(); // it ended — gone
    expect(m.resolveOwner("ses-kept")).toBe("studio");
    expect(m.resolveDirectory("ses-kept")).toBe("/new");
    expect(m.resolveOwner("ses-born")).toBe("studio");
    expect(m.size).toBe(2);
    // and the good refresh restarts the window: a failure 59 s later still retains
    t = 20_000 + OWNER_RETENTION_MS - 1_000;
    m.update([], [peerTimeout("studio")]);
    expect(m.resolveOwner("ses-born")).toBe("studio");
    expect(m.resolveOwner("ses-ended")).toBeUndefined(); // never resurrected from the stale snapshot
  });

  it("a good refresh after expiry ends the unavailability: the peer is an ordinary owner again and its arm re-opens", async () => {
    let t = 0;
    const ownerMap = new SessionOwnerMap({ now: () => t });
    ownerMap.update([ownedBy("ses-s1", "studio")], [peerOk("studio")]);
    const origins = armOrigins();
    const driver = retentionDriver(origins, ownerMap);
    const res = sseRes();
    driver.handle(sseReq(), res);
    await settle();
    t = OWNER_RETENTION_MS + 1;
    ownerMap.update([], [peerTimeout("studio")]);
    driver.reconcile();
    await settle();
    expect(origins.closes("studio")).toBe(1);

    t += 5_000;
    ownerMap.update([ownedBy("ses-s2", "studio")], [peerOk("studio")]);
    expect(ownerMap.isUnavailable("studio")).toBe(false);
    expect(ownerMap.resolveOwner("ses-s2")).toBe("studio");
    expect(ownerMap.resolveOwner("ses-s1")).toBeUndefined();
    driver.reconcile();
    await settle();
    expect(origins.opens("studio")).toBe(2); // the arm is back
    res.fireClose();
  });
});

/** A fleet engine stub: its cross-project session list (401 while `denies()`),
 *  its health, and a /global/event stream that stays open. */
async function startFleetStub(denies: () => boolean, sessions: Array<Record<string, unknown>>) {
  let listReads = 0;
  let eventOpens = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    if (u.pathname === "/experimental/session") {
      listReads++;
      if (denies()) return void res.writeHead(401).end("no");
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify(u.searchParams.get("archived") === "true" ? [] : sessions));
    }
    if (u.pathname === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ version: "stub-1774" }));
    }
    if (u.pathname === "/global/event") {
      eventOpens++;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      return void res.write(": open\n\n");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    listReads: () => listReads,
    eventOpens: () => eventOpens,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Accumulate a streaming response's text in the background. */
function streamText(res: Response): () => string {
  let text = "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      /* aborted at teardown */
    }
  })();
  return () => text;
}

/** Poll (real timers) until `cond` holds or the deadline passes. */
async function until(cond: () => boolean, timeoutMs = 4_000): Promise<boolean> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 10));
  return cond();
}

// ── a deterministic fan-in harness (the driver + aggregator are used as-is) ───
interface SseRes extends http.ServerResponse {
  text(): string;
  fireClose(): void;
}
function sseRes(): SseRes {
  const chunks: string[] = [];
  const closers: Array<() => void> = [];
  const res = {
    headersSent: false,
    write(c: string) {
      chunks.push(c);
      return true;
    },
    writeHead() {
      res.headersSent = true;
      return res;
    },
    flushHeaders() {},
    on(event: string, cb: () => void) {
      if (event === "close") closers.push(cb);
      return res;
    },
    end() {},
    text: () => chunks.join(""),
    fireClose: () => closers.forEach((cb) => cb()),
  };
  return res as unknown as SseRes;
}
const sseReq = (): http.IncomingMessage => ({ url: "/global/event", headers: {} }) as unknown as http.IncomingMessage;
/** Let the arm pumps drain (microtasks + one macrotask tick). */
const settle = () => new Promise<void>((r) => setTimeout(r, 20));

/** Upstream arms that stay open until closed, counted per namespace. */
function armOrigins() {
  const opens = new Map<string, number>();
  const closes = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const openUpstream = (r: FanInUpstreamRequest): SseFrameSource => {
    bump(opens, r.namespace);
    const waiters: Array<(v: string | null) => void> = [];
    let ended = false;
    return {
      next: () => (ended ? Promise.resolve(null) : new Promise((resolve) => waiters.push(resolve))),
      close: () => {
        if (ended) return;
        ended = true;
        bump(closes, r.namespace);
        waiters.splice(0).forEach((w) => w(null));
      },
    };
  };
  return { openUpstream, opens: (ns: string) => opens.get(ns) ?? 0, closes: (ns: string) => closes.get(ns) ?? 0 };
}

/** The fan-in driver as index.ts wires it: reachability composed over the owner
 *  map (`fanInReachable`), so a peer the map names unavailable is never an arm. */
function retentionDriver(origins: ReturnType<typeof armOrigins>, ownerMap: SessionOwnerMap): SseFanInDriver {
  const peerBaseUrl = (id: string) => (id === "studio" ? "http://studio.invalid" : undefined);
  return new SseFanInDriver({
    ownerMap,
    localMachineId: "macbook",
    localEventUrl: () => "http://local.invalid",
    peerBaseUrl,
    peerToken: (id) =>
      id === "studio"
        ? { ok: true as const, credential: { baseUrl: "http://studio.invalid", token: "tok-studio" } }
        : { ok: false as const, reason: "absent" as const },
    reachable: fanInReachable(ownerMap, (id) => peerBaseUrl(id) !== undefined),
    reconcileMs: 999_999,
    openUpstream: origins.openUpstream,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// FREE-TIER REMOTE CREATE (feature/free-tier-fleet) — pending create-time owner
// bindings. A session just created on a peer is not yet in the pull-only fleet
// projection (refreshed every ~5s), so the immediate follow-up read would
// resolve LOCAL and render "This session cannot be found". recordPendingOwner
// binds the new id → owner at create time; the binding survives projection
// refreshes that don't yet include it, is SUPERSEDED once the projection does,
// and EXPIRES after a TTL so a dead id never routes to a peer forever.
// ══════════════════════════════════════════════════════════════════════════════
describe("free-tier remote create — pending create-time owner bindings", () => {
  const owned = (id: string, owner: string): SessionEntry => ({
    id,
    amicode_owner: { owner_machine_id: owner, owner_name: owner, is_local: false },
  });

  it("recordPendingOwner makes the session resolvable IMMEDIATELY (before any projection)", () => {
    const m = new SessionOwnerMap();
    expect(m.resolveOwner("ses-new")).toBeUndefined();
    m.recordPendingOwner("ses-new", "studio");
    expect(m.resolveOwner("ses-new")).toBe("studio");
  });

  it("the pending binding SURVIVES a projection refresh that does not yet include it", () => {
    const m = new SessionOwnerMap();
    m.recordPendingOwner("ses-new", "studio");
    m.update([owned("ses-other", "studio")]); // projection lags — no ses-new yet
    expect(m.resolveOwner("ses-new")).toBe("studio"); // still routed to the peer
    expect(m.resolveOwner("ses-other")).toBe("studio");
  });

  it("the projection SUPERSEDES the pending binding once it includes the session", () => {
    const m = new SessionOwnerMap();
    m.recordPendingOwner("ses-new", "studio");
    m.update([owned("ses-new", "studio")]); // now authoritative
    expect(m.resolveOwner("ses-new")).toBe("studio");
    // and a later projection that drops it is authoritative (session deleted)
    m.update([]);
    expect(m.resolveOwner("ses-new")).toBeUndefined();
  });

  it("a pending binding EXPIRES after the TTL (a dead id never routes to a peer forever)", () => {
    let t = 1_000_000;
    const m = new SessionOwnerMap({ now: () => t });
    m.recordPendingOwner("ses-new", "studio");
    expect(m.resolveOwner("ses-new")).toBe("studio");
    t += PENDING_OWNER_TTL_MS + 1;
    expect(m.resolveOwner("ses-new")).toBeUndefined(); // expired
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1766 checkpoint 1 — the owner map ALSO records each session's working
// directory, from the SAME owner-tagged projection entry it reads the owner from
// (the entry's own `directory` field — the session record's value, carried
// verbatim; the owner tag's `directory` is the same value). The fleet
// session-status read resolves (owner, directory) from here and never invents a
// directory, so a directory is recorded byte-for-byte and only for owned entries.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1766 — SessionOwnerMap records each session's directory from the projection entry", () => {
  const entry = (id: string, owner: string, directory?: unknown, tagDirectory?: string): SessionEntry => ({
    id,
    ...(directory !== undefined ? { directory } : {}),
    amicode_owner: {
      owner_machine_id: owner,
      owner_name: owner,
      ...(tagDirectory !== undefined ? { directory: tagDirectory } : {}),
      is_local: false,
    },
  });

  it("update() records the entry's own `directory`, verbatim (no normalization), alongside the owner", () => {
    const m = new SessionOwnerMap();
    m.update([
      entry("ses-A", "studio", "/Users/jj/harmoniqs/amicode/"), // trailing slash kept byte-for-byte
      entry("ses-B", "laptop", "/tmp/dir with spaces/ü"),
    ]);
    expect(m.resolveOwner("ses-A")).toBe("studio");
    expect(m.resolveDirectory("ses-A")).toBe("/Users/jj/harmoniqs/amicode/");
    expect(m.resolveDirectory("ses-B")).toBe("/tmp/dir with spaces/ü");
  });

  it("falls back to the owner tag's `directory` when the entry carries no top-level directory", () => {
    const m = new SessionOwnerMap();
    m.update([entry("ses-T", "studio", undefined, "/srv/project")]);
    expect(m.resolveDirectory("ses-T")).toBe("/srv/project");
  });

  it("an entry with no usable directory (absent, empty, non-string) resolves NO directory — but keeps its owner", () => {
    const m = new SessionOwnerMap();
    m.update([entry("ses-none", "studio"), entry("ses-empty", "studio", ""), entry("ses-num", "studio", 42)]);
    for (const id of ["ses-none", "ses-empty", "ses-num"]) {
      expect(m.resolveOwner(id)).toBe("studio");
      expect(m.resolveDirectory(id)).toBeUndefined();
    }
  });

  it("an unowned entry records no directory; an unknown id resolves none", () => {
    const m = new SessionOwnerMap();
    m.update([{ id: "ses-unowned", directory: "/x" }]);
    expect(m.resolveOwner("ses-unowned")).toBeUndefined();
    expect(m.resolveDirectory("ses-unowned")).toBeUndefined();
    expect(m.resolveDirectory("ses-never-seen")).toBeUndefined();
  });

  it("the projection is authoritative for directories too: a later update re-records (moved) or drops (gone)", () => {
    const m = new SessionOwnerMap();
    m.update([entry("ses-A", "studio", "/old")]);
    m.update([entry("ses-A", "studio", "/new")]);
    expect(m.resolveDirectory("ses-A")).toBe("/new");
    m.update([]);
    expect(m.resolveDirectory("ses-A")).toBeUndefined();
  });

  it("a pending create-time binding has an owner but no directory (it never invents one)", () => {
    const m = new SessionOwnerMap();
    m.recordPendingOwner("ses-new", "studio");
    expect(m.resolveOwner("ses-new")).toBe("studio");
    expect(m.resolveDirectory("ses-new")).toBeUndefined();
  });

  it("the existing owner-map surface is unchanged (size counts owned entries; ownerMachineIds is the distinct owner set)", () => {
    const m = new SessionOwnerMap();
    m.update([entry("a", "studio", "/d1"), entry("b", "studio", "/d2"), entry("c", "laptop")]);
    expect(m.size).toBe(3);
    expect(m.ownerMachineIds().sort()).toEqual(["laptop", "studio"]);
  });
});


describe("#1449 AC2/AC3 — per-session request routing retires the single attachment pointer", () => {
  const PW = "multiplex-owner-1449";
  let root: string;
  let attachmentFile: string;
  let keeperFile: string;
  let hubFile: string;
  let peerA: Stub;
  let peerB: Stub;
  let attachedStub: Stub; // the SINGLE attachment pointer's proxy target — must NOT be dialed
  let keeperStub: Stub;
  let engineStub: Stub; // the LOCAL engine (keyless / local resolutions land here)
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1449-owner-"));
    attachmentFile = join(root, "attachment.json");
    keeperFile = join(root, "keeper.json");
    hubFile = join(root, "fleet-hub.json");
    for (const k of ["AMICO_FLEET_ATTACHMENT_FILE", "AMICO_FLEET_KEEPER_FILE", "AMICO_FLEET_HUB_FILE", FLEET_MULTIPLEX_FLAG]) {
      savedEnv[k] = process.env[k];
    }
    process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;
    process.env.AMICO_FLEET_KEEPER_FILE = keeperFile;
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    process.env[FLEET_MULTIPLEX_FLAG] = "0";

    peerA = await startStub("PEER-A");
    peerB = await startStub("PEER-B");
    attachedStub = await startStub("ATTACHED-POINTER");
    keeperStub = await startStub("KEEPER");
    engineStub = await startStub("LOCAL-ENGINE");

    // A set attachment pointer → resolveAmicodeTarget returns "attached" for the
    // non-roster / non-honesty paths; the keeper pointer for /amicode/roster.
    writeAttachmentPointerFile({ sshAlias: "u@127.0.0.1", transport: "ssh", machine_id: "peer-a" }, { attachmentFile });
    writeKeeperPointerFile({ sshAlias: "keeper", transport: "ssh" }, { keeperFile });
    writeHubCredential({ baseUrl: attachedStub.url, token: "hub-tok-1449" }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
  });

  afterEach(() => {
    process.env[FLEET_MULTIPLEX_FLAG] = "0";
  });

  afterAll(async () => {
    await Promise.all([peerA?.stop(), peerB?.stop(), attachedStub?.stop(), keeperStub?.stop(), engineStub?.stop()]);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** A populated multiplexer: ses-A→peer-a (reachable), ses-B→peer-b (reachable),
   *  ses-down→peer-down (owner KNOWN, transport url undefined → unreachable). */
  function populatedMultiplex(): SessionMultiplexProxy {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([
      { id: "ses-A", amicode_owner: { owner_machine_id: "peer-a", owner_name: "A", is_local: false } },
      { id: "ses-B", amicode_owner: { owner_machine_id: "peer-b", owner_name: "B", is_local: false } },
      { id: "ses-down", amicode_owner: { owner_machine_id: "peer-down", owner_name: "Down", is_local: false } },
    ]);
    return new SessionMultiplexProxy({
      ownerMap,
      peers: {
        "peer-a": { getUrl: () => peerA.url, token: "tok-a" },
        "peer-b": { getUrl: () => peerB.url, token: "tok-b" },
        "peer-down": { getUrl: () => undefined, token: "tok-down" },
      },
      localMachineId: "local-machine",
    });
  }

  /** An engine-armed (non-client) fleet plane in fleet mode, with a REAL
   *  attached HubProxy (the single pointer's proxy) + keeper, plus the injected
   *  multiplexer. */
  function buildFleetPlane(multiplex: SessionMultiplexProxy): FleetPlane {
    const cred = () => readHubCredential();
    return {
      getMode: () => "fleet",
      hub: new HubProxy({ getUrl: () => undefined, credential: cred }),
      attached: new HubProxy({ getUrl: () => attachedStub.url, credential: cred }),
      keeper: new HubProxy({ getUrl: () => keeperStub.url, credential: cred }),
      multiplex,
    };
  }

  function bootServer(mux: SessionMultiplexProxy): AmicodeServiceServer {
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    server.attachFleetPlane(buildFleetPlane(mux));
    return server;
  }

  it("flag ON: two session-pathed requests owned by different reachable peers route to their OWN owner; the single attachment pointer is NOT dialed", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    expect(fleetMultiplexEnabled()).toBe(true);
    const server = bootServer(populatedMultiplex());
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const attachedBefore = attachedStub.requests.length;
    try {
      const rA = await fetch(`${origin}/api/session/ses-A/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: "{}",
      });
      expect(((await rA.json()) as { marker: string }).marker).toBe(peerA.marker);
      expect(peerA.requests.some((r) => r.includes("ses-A/message"))).toBe(true);

      const rB = await fetch(`${origin}/api/session/ses-B/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: "{}",
      });
      expect(((await rB.json()) as { marker: string }).marker).toBe(peerB.marker);
      expect(peerB.requests.some((r) => r.includes("ses-B/message"))).toBe(true);

      // cross-check: A never saw B, B never saw A
      expect(peerA.requests.some((r) => r.includes("ses-B"))).toBe(false);
      expect(peerB.requests.some((r) => r.includes("ses-A"))).toBe(false);
      // RETIREMENT: the single attachment pointer's proxy was NEVER dialed
      expect(attachedStub.requests.length).toBe(attachedBefore);
    } finally {
      await server.stop();
    }
  });

  it("flag ON: an owned-but-UNREACHABLE session yields FLEET_PEER_UNREACHABLE 503 — NEVER local, NEVER the attachment pointer", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const server = bootServer(populatedMultiplex());
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const engineBefore = engineStub.requests.length;
    const attachedBefore = attachedStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-down/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: "{}",
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: string; reason?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe(FLEET_PEER_UNREACHABLE_ERROR);
      // never local, never the attachment pointer
      expect(engineStub.requests.length).toBe(engineBefore);
      expect(attachedStub.requests.length).toBe(attachedBefore);
    } finally {
      await server.stop();
    }
  });

  it("flag ON: a keyless (unowned) session-pathed request resolves LOCAL (the local engine), never a peer", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const server = bootServer(populatedMultiplex());
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerABefore = peerA.requests.length;
    const attachedBefore = attachedStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-not-in-map/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: "{}",
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(engineStub.marker);
      expect(peerA.requests.length).toBe(peerABefore);
      expect(attachedStub.requests.length).toBe(attachedBefore);
    } finally {
      await server.stop();
    }
  });

  it("flag ON: /amicode/roster still routes to the KEEPER (the multiplexer shadows ONLY the attached arm)", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const server = bootServer(populatedMultiplex());
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const keeperBefore = keeperStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/roster`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(((await res.json()) as { marker: string }).marker).toBe(keeperStub.marker);
      expect(keeperStub.requests.length).toBe(keeperBefore + 1);
    } finally {
      await server.stop();
    }
  });

  it("flag OFF (explicit): a session-pathed attached-arm request routes to the SINGLE attachment pointer — byte-identical to pre-multiplexer", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "0";
    expect(fleetMultiplexEnabled()).toBe(false);
    const mux = populatedMultiplex();
    const spy = vi.spyOn(mux, "resolveTarget");
    const server = bootServer(mux);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const attachedBefore = attachedStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-A/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: "{}",
      });
      // routed to the single attachment pointer, as today
      expect(((await res.json()) as { marker: string }).marker).toBe(attachedStub.marker);
      expect(attachedStub.requests.length).toBe(attachedBefore + 1);
      expect(spy).not.toHaveBeenCalled(); // structural: OFF → multiplexer never consulted
    } finally {
      spy.mockRestore();
      await server.stop();
    }
  });
});

describe("#1794 — a 403 ownership refresh drops the peer's sessions at once, as a 401 does", () => {
  it("through the REAL routing projection: a peer that held sessions and then answers 403 is dropped immediately, not retained", async () => {
    let studioRefused = false;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("http://studio") && studioRefused) return new Response("forbidden", { status: 403 });
      if (url.endsWith("/global/health")) return new Response(JSON.stringify({ version: "t" }), { status: 200 });
      if (url.startsWith("http://studio")) return new Response(JSON.stringify(/archived=true/.test(url) ? [] : [{ id: "ses-s1" }]), { status: 200 });
      return new Response(JSON.stringify([]), { status: 200 }); // local
    }) as unknown as typeof fetch;
    const ownerMap = new SessionOwnerMap();
    const lines: string[] = [];
    const feed = new OwnerMapFeed({
      ownerMap,
      log: (l) => lines.push(l),
      buildProjection: async () => {
        const p = await buildOwnerRoutingProjection({
          localMachineId: "macbook",
          local: { getUrl: () => "http://local" },
          peers: [{ machineId: "studio", getUrl: () => "http://studio", token: "tok" }],
          rosterLookup: () => undefined,
          fetchImpl,
        });
        return { sessions: p.sessions as SessionEntry[], peers: p.peers };
      },
    });
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-s1")).toBe("studio");
    studioRefused = true;
    await feed.refreshOnce();
    expect(ownerMap.resolveOwner("ses-s1")).toBeUndefined(); // dropped at once — not held for the 60 s window
    expect(ownerMap.ownerMachineIds()).toEqual(["studio"]); // still named unavailable
    expect(lines.at(-1)).toMatch(/^\[owner-map\] refresh peer=studio outcome=unauthorized duration_ms=\d+ entries=0 reason=unauthorized retention=dropped dropped=1$/);
  });
});
