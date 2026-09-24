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
  type SessionEntry,
} from "../src/amicode_service/session_multiplexer";
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
// AC2 — per-session request routing on the ATTACHED arm (reachable → owner url;
//       owned-but-unreachable → 503 never local; keyless → local)
// AC3 (request path) — the single attachment pointer is RETIRED from the
//       attached arm; keeper + honesty arms preserved.
// ══════════════════════════════════════════════════════════════════════════════
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
    delete process.env[FLEET_MULTIPLEX_FLAG];

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
    delete process.env[FLEET_MULTIPLEX_FLAG];
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

  it("flag OFF (regression): a session-pathed attached-arm request routes to the SINGLE attachment pointer — byte-identical to today", async () => {
    delete process.env[FLEET_MULTIPLEX_FLAG];
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

