// amicode_service_observe_read_routing.test.ts — #1537 (Fleet Studio B2b, read
// seam): on the OBSERVATION-ONLY path (the base peer-studio READ routes are
// mounted but NO premium FleetPlane is attached, so getMode stays "engine"), a
// GET/HEAD read for a PEER-OWNED session must proxy to the owner peer with that
// peer's OWN reader token — instead of falling through to the LOCAL engine that
// never held the peer's session (which rendered "This session cannot be found",
// the B2a regression). Everything else falls through byte-identical to local.
//
// The owner signal is PATH-BASED (empirically settled): the app emits the
// session id in the URL for BOTH client shapes — /session/{id} (v1 legacy) and
// /api/session/{id} (v2 vendored), incl. the BARE detail read (no trailing
// sub-segment) — mirrored from the engine's OWN getWorkspaceRouteSessionID
// (packages/opencode/src/server/shared/workspace-routing.ts). The multiplexer's
// existing extractSessionIdFromPath is too narrow (misses the v1 shape AND the
// bare read), so a new extractSessionIdFromReadPath + ObservationReadRouter are
// the additive, observation-only seam. No SSE fan-in, no writes, no /amicode/*.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";

import { AmicodeServiceServer } from "../src/amicode_service/server";
import { createAmicodeService } from "../src/amicode_service";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import {
  SessionOwnerMap,
  ObservationReadRouter,
  extractSessionIdFromReadPath,
  type PeerTransport,
} from "../src/amicode_service/session_multiplexer";
import { createObservationReadPlane } from "../src/amicode_service/observation_read_plane";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
import { serverAuthHeader } from "../src/server_auth";

const PW = "observe-read-1537";

// ── a path-aware marker stub: records {method, path, auth}, answers a session
//    ARRAY for GET /session (the projection fan-out) + a version for
//    /global/health, and a distinct marker for every other path (the detail /
//    messages reads). ────────────────────────────────────────────────────────
interface Stub {
  url: string;
  marker: string;
  requests: Array<{ method: string; path: string; auth?: string }>;
  stop(): Promise<void>;
}
function startStub(marker: string, sessions: Array<Record<string, unknown>> = []): Promise<Stub> {
  const requests: Stub["requests"] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    requests.push({
      method: req.method ?? "GET",
      path: u.pathname,
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (u.pathname === "/session" && (req.method ?? "GET") === "GET") return void res.end(JSON.stringify(sessions));
    if (u.pathname === "/global/health") return void res.end(JSON.stringify({ version: "stub-1537" }));
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

let localStub: Stub;
let peerStub: Stub;

beforeAll(async () => {
  localStub = await startStub("LOCAL-1537", [{ id: "ses-local", time: { created: 1, updated: 2 } }]);
  peerStub = await startStub("PEER-1537", [{ id: "ses-studio", time: { created: 3, updated: 4 } }]);
});
afterAll(async () => {
  await localStub?.stop();
  await peerStub?.stop();
});

/** An observation-mode server: local EngineProxy + the read plane, NO fleet
 *  plane (getMode stays "engine"). `owners` seeds the SessionOwnerMap; `peer`
 *  resolves the owner's transport. */
function bootObserve(
  owners: Array<{ id: string; owner: string }>,
  peer: (machineId: string) => PeerTransport | undefined,
  localMachineId = "macbook",
): AmicodeServiceServer {
  const ownerMap = new SessionOwnerMap();
  ownerMap.update(
    owners.map((o) => ({ id: o.id, amicode_owner: { owner_machine_id: o.owner, owner_name: o.owner, is_local: o.owner === localMachineId } })),
  );
  const server = new AmicodeServiceServer({ password: PW });
  server.attachEngineProxy(new EngineProxy({ getUrl: () => localStub.url }));
  server.attachObservationReadPlane(createObservationReadPlane({ ownerMap, localMachineId, peer }));
  return server;
}

const authed = { Authorization: serverAuthHeader(PW) };

// ══════════════════════════════════════════════════════════════════════════════
// The pure resolver — path shapes + resolution order (deterministic units)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 — extractSessionIdFromReadPath mirrors the engine's real path shapes", () => {
  it("extracts the id from BOTH client shapes incl. the BARE detail read (the not-found request)", () => {
    expect(extractSessionIdFromReadPath("/session/ses_abc")).toBe("ses_abc"); // v1 bare detail
    expect(extractSessionIdFromReadPath("/session/ses_abc/message")).toBe("ses_abc"); // v1 messages
    expect(extractSessionIdFromReadPath("/api/session/ses_bug")).toBe("ses_bug"); // v2 bare detail
    expect(extractSessionIdFromReadPath("/api/session/ses_bug/question/que_1/reply")).toBe("ses_bug");
    expect(extractSessionIdFromReadPath("/experimental/session/ses_bg/background")).toBe("ses_bg");
  });
  it("returns undefined for the list, the status poll, and non-session paths", () => {
    expect(extractSessionIdFromReadPath("/session")).toBeUndefined();
    expect(extractSessionIdFromReadPath("/session/status")).toBeUndefined();
    expect(extractSessionIdFromReadPath("/config")).toBeUndefined();
    expect(extractSessionIdFromReadPath("/amicode/fleet/sessions")).toBeUndefined();
  });
});

describe("#1537 — ObservationReadRouter resolution order", () => {
  const ownerMap = new SessionOwnerMap();
  ownerMap.update([
    { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    { id: "ses-local", amicode_owner: { owner_machine_id: "macbook", owner_name: "macbook", is_local: true } },
    { id: "ses-dark", amicode_owner: { owner_machine_id: "darkpeer", owner_name: "darkpeer", is_local: false } },
    { id: "ses-stranger", amicode_owner: { owner_machine_id: "stranger", owner_name: "stranger", is_local: false } },
  ]);
  const peer = (id: string): PeerTransport | undefined => {
    if (id === "studio") return { getUrl: () => "http://studio.invalid", token: "tok-studio" };
    if (id === "darkpeer") return { getUrl: () => undefined, token: "tok-dark" }; // known peer, transport down
    return undefined; // "stranger" is not a known peer
  };
  const r = new ObservationReadRouter({ ownerMap, localMachineId: "macbook", peer });

  it("a GET for a peer-owned session → the reachable peer target", () => {
    expect(r.resolve("GET", "/api/session/ses-studio")).toEqual({ kind: "peer", machineId: "studio", url: "http://studio.invalid", token: "tok-studio" });
    expect(r.resolve("GET", "/session/ses-studio")).toMatchObject({ kind: "peer", machineId: "studio" });
  });
  it("a WRITE (POST/PATCH/DELETE) NEVER routes — undefined (local)", () => {
    expect(r.resolve("POST", "/api/session/ses-studio/message")).toBeUndefined();
    expect(r.resolve("PATCH", "/session/ses-studio")).toBeUndefined();
    expect(r.resolve("DELETE", "/api/session/ses-studio")).toBeUndefined();
  });
  it("local-owned / unowned / not-a-known-peer → undefined (local)", () => {
    expect(r.resolve("GET", "/session/ses-local")).toBeUndefined(); // local-owned
    expect(r.resolve("GET", "/api/session/ses-unknown")).toBeUndefined(); // unowned
    expect(r.resolve("GET", "/api/session/ses-stranger")).toBeUndefined(); // owner not a known peer
  });
  it("/amicode/* (own honesty + local surface) → undefined (never proxied)", () => {
    expect(r.resolve("GET", "/amicode/fleet/status")).toBeUndefined();
    expect(r.resolve("GET", "/amicode/fleet/sessions")).toBeUndefined();
    expect(r.resolve("GET", "/amicode/profile")).toBeUndefined();
  });
  it("owner is a KNOWN peer but its transport is down → the honest DEGRADED variant (never local)", () => {
    expect(r.resolve("GET", "/api/session/ses-dark")).toEqual({ kind: "degraded", machineId: "darkpeer" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC1 (RED→GREEN core) — a GET for a PEER-OWNED session proxies to the peer with
// peerAuthHeader(token); the local engine is NOT dialed.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 AC1 — a peer-owned session read routes to the owner peer with its reader token", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;

  for (const path of ["/api/session/ses-studio", "/session/ses-studio", "/api/session/ses-studio/message"]) {
    it(`GET ${path} → dialed on the PEER with peerAuthHeader(token); local NOT dialed`, async () => {
      const server = bootObserve([{ id: "ses-studio", owner: "studio" }], peer);
      const origin = (await server.start()).toString().replace(/\/$/, "");
      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      try {
        const res = await fetch(`${origin}${path}`, { headers: authed });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker);
        expect(peerStub.requests.length).toBe(peerBefore + 1);
        const dialed = peerStub.requests.at(-1)!;
        expect(dialed.path).toBe(path); // proxied verbatim
        expect(dialed.auth).toBe(peerAuthHeader("tok-studio")); // the peer's OWN reader token
        expect(dialed.auth?.includes(PW)).toBe(false); // the local mint is NEVER forwarded outward
        expect(localStub.requests.length).toBe(localBefore); // the local engine was NOT dialed
      } finally {
        await server.stop();
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — a LOCAL-owned / unowned session read falls through to the local engine
// (byte-identical): the peer is NOT dialed.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 AC2 — a local/unowned read falls through byte-identical to the local engine", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;

  it("GET for a LOCAL-owned session → the local engine, peer NOT dialed", async () => {
    const server = bootObserve([{ id: "ses-local", owner: "macbook" }], peer);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-local`, { headers: authed });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore); // peer NOT dialed
    } finally {
      await server.stop();
    }
  });

  it("GET for an UNOWNED session → the local engine, peer NOT dialed", async () => {
    const server = bootObserve([], peer);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/session/ses-nobody`, { headers: authed });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore);
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — a WRITE for a peer-owned session NEVER routes (the no-remote-write
// invariant): it falls through to the local engine, the peer is NOT dialed.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 AC3 — no remote writes: a POST for a peer-owned session falls through to local", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;

  it("POST /api/session/ses-studio/message → local engine, peer NOT dialed", async () => {
    const server = bootObserve([{ id: "ses-studio", owner: "studio" }], peer);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore); // the peer was NOT written to
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC5 — a peer known but unreachable (getUrl undefined / token absent) → the
// honest peer-unreachable 503, NEVER local-dressed-as-peer (#1382 invariant).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 AC5 — a known-but-unreachable owner answers honestly, never local", () => {
  it("owner is a known peer whose transport is down → 503 peer-unreachable; local NOT dialed", async () => {
    const peer = (id: string): PeerTransport | undefined =>
      id === "studio" ? { getUrl: () => undefined, token: "tok-studio" } : undefined; // url down
    const server = bootObserve([{ id: "ses-dark", owner: "studio" }], peer);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const localBefore = localStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-dark`, { headers: authed });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; reason?: string; error?: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe("peer-unreachable");
      expect(localStub.requests.length).toBe(localBefore); // NOT served from the local engine
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC6 — production wiring: createAmicodeService on the OBSERVATION-ONLY path
// wires the seam (a peer-owned read routes to the peer); the armed path stays
// unchanged (the seam is never attached there).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1537 AC6 — production wiring (createAmicodeService observation-only path)", () => {
  let root: string;
  const savedHubFile = process.env.AMICO_FLEET_HUB_FILE;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amicode-1537-wire-"));
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
  });
  afterAll(() => {
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    rmSync(root, { recursive: true, force: true });
  });

  function servingPeerProvider() {
    return {
      localMachineId: "macbook",
      getServingPeers: () => [{ machineId: "studio" }],
      readPeerToken: (id: string) =>
        id === "studio"
          ? ({ ok: true as const, credential: { baseUrl: peerStub.url, token: "tok-studio" } })
          : ({ ok: false as const }),
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

  it("an observation-only boot with a serving peer routes a peer-owned read to the peer (its token), local NOT dialed", async () => {
    const svc = createAmicodeService({
      password: PW,
      engine: { password: "engine-mint", getUrl: () => localStub.url },
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // the owner-map feed rebuilds the fleet projection on boot (immediate
      // refresh); wait until it has fetched the peer's session list + health so
      // the map knows ses-studio → studio.
      await waitFor(() => peerStub.requests.some((r) => r.path === "/session") && peerStub.requests.some((r) => r.path === "/global/health"));
      await new Promise((r) => setTimeout(r, 250)); // settle the synchronous ownerMap.update after the awaited projection

      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      const res = await fetch(`${origin}/api/session/ses-studio`, { headers: { Authorization: serverAuthHeader("engine-mint") } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker);
      const dialed = peerStub.requests.slice(peerBefore).find((r) => r.path === "/api/session/ses-studio");
      expect(dialed).toBeDefined();
      expect(dialed!.auth).toBe(peerAuthHeader("tok-studio"));
      // the local engine was NOT dialed for the peer-owned detail read
      expect(localStub.requests.slice(localBefore).some((r) => r.path === "/api/session/ses-studio")).toBe(false);
    } finally {
      await svc.stop();
    }
  });
});
