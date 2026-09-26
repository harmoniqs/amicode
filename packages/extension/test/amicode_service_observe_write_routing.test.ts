// amicode_service_observe_write_routing.test.ts — #1542 (Fleet Studio B2b,
// WRITE seam): the mirror of the #1537 observation READ seam, with the
// GET/non-GET decision INVERTED. On the OBSERVATION-ONLY path (the base
// peer-studio routes are mounted but NO premium FleetPlane is attached, so
// getMode stays "engine"), a NON-GET request (prompt / archive / delete) to a
// PEER-OWNED session must be AUTHORIZED by the control gate and, when allowed,
// ROUTED to the owner peer with the credential the owner accepts (the peer
// reader token — see the empirical note below); an unauthorized write is a
// NAMED, honest deny, NEVER executed locally (the #1382 invariant). GET is
// ignored here (the read plane owns it), and local-owned / unowned / non-session
// / /amicode/* writes fall through BYTE-IDENTICAL to the local engine.
//
// EMPIRICAL CREDENTIAL DECISION (resolved against reality, not assumed):
// the control grant is the CLIENT-SIDE authorization gate — it decides whether
// this machine may SEND the write at all. The transport credential presented to
// the owner is the PEER credential the owner accepts (today: the reader token,
// the SAME credential the read plane sources via fleetPeers.readPeerToken). A
// self-issued control-grant token the owner has never seen would 401. A distinct
// owner-enforced control token is a future tightening (the owner does not yet
// enforce a separate control scope on proxied /session). So the write plane
// presents target.token (the peer reader token) via its OWN proxyToPeer, NOT
// ControlGatedResolver/controlGatedMultiplexAdapter (whose adapter DROPS the
// peer credential).
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
  ObservationWriteRouter,
  type PeerTransport,
} from "../src/amicode_service/session_multiplexer";
import { createObservationReadPlane } from "../src/amicode_service/observation_read_plane";
import { createObservationWritePlane } from "../src/amicode_service/observation_write_plane";
import type { WriteGrantRead } from "../src/amicode_service/remote_write_gate";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
import { serverAuthHeader } from "../src/server_auth";

const PW = "observe-write-1542";

// ── a path-aware marker stub (same shape as the read-routing suite): records
//    {method, path, auth}, answers a session ARRAY for GET /session (the
//    projection fan-out) + a version for /global/health, and a distinct marker
//    for every other path. ──────────────────────────────────────────────────
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
    if ((u.pathname === "/session" || u.pathname === "/experimental/session") && (req.method ?? "GET") === "GET") return void res.end(JSON.stringify(sessions));
    if (u.pathname === "/global/health") return void res.end(JSON.stringify({ version: "stub-1542" }));
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
  localStub = await startStub("LOCAL-1542", [{ id: "ses-local", time: { created: 1, updated: 2 } }]);
  peerStub = await startStub("PEER-1542", [{ id: "ses-studio", time: { created: 3, updated: 4 } }]);
});
afterAll(async () => {
  await localStub?.stop();
  await peerStub?.stop();
});

const authed = { Authorization: serverAuthHeader(PW) };

// ══════════════════════════════════════════════════════════════════════════════
// The pure resolver — GET/non-GET INVERTED + the authorize decision (units).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 — ObservationWriteRouter resolution order (GET/non-GET INVERTED)", () => {
  const ownerMap = new SessionOwnerMap();
  ownerMap.update([
    { id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
    { id: "ses-local", amicode_owner: { owner_machine_id: "macbook", owner_name: "macbook", is_local: true } },
    { id: "ses-dark", amicode_owner: { owner_machine_id: "darkpeer", owner_name: "darkpeer", is_local: false } },
    { id: "ses-observe", amicode_owner: { owner_machine_id: "obspeer", owner_name: "obspeer", is_local: false } },
    { id: "ses-revoked", amicode_owner: { owner_machine_id: "revpeer", owner_name: "revpeer", is_local: false } },
    { id: "ses-pending", amicode_owner: { owner_machine_id: "pendpeer", owner_name: "pendpeer", is_local: false } },
    { id: "ses-nogrant", amicode_owner: { owner_machine_id: "ngpeer", owner_name: "ngpeer", is_local: false } },
    { id: "ses-stranger", amicode_owner: { owner_machine_id: "stranger", owner_name: "stranger", is_local: false } },
  ]);
  const peer = (id: string): PeerTransport | undefined => {
    if (id === "studio") return { getUrl: () => "http://studio.invalid", token: "tok-studio" };
    if (id === "darkpeer") return { getUrl: () => undefined, token: "tok-dark" }; // serving peer, transport down
    if (id === "obspeer") return { getUrl: () => "http://obs.invalid", token: "tok-obs" };
    if (id === "revpeer") return { getUrl: () => "http://rev.invalid", token: "tok-rev" };
    if (id === "pendpeer") return { getUrl: () => "http://pend.invalid", token: "tok-pend" };
    if (id === "ngpeer") return { getUrl: () => "http://ng.invalid", token: "tok-ng" };
    return undefined; // "stranger" is not a serving peer
  };
  const grantReader = (owner: string): WriteGrantRead | undefined => {
    if (owner === "studio") return { scope: "control", state: "active" };
    if (owner === "darkpeer") return { scope: "control", state: "active" }; // active but transport down
    if (owner === "obspeer") return { scope: "observe", state: "active" }; // wrong scope
    if (owner === "revpeer") return { scope: "control", state: "revoked" };
    if (owner === "pendpeer") return { scope: "control", state: "revocation-pending" };
    return undefined; // ngpeer + stranger: no grant
  };
  const r = new ObservationWriteRouter({ ownerMap, localMachineId: "macbook", peer, grantReader });

  it("a NON-GET for a peer-owned session (active control + reachable) → the peer target with the PEER reader token", () => {
    expect(r.resolve("POST", "/api/session/ses-studio/message")).toEqual({
      kind: "peer",
      machineId: "studio",
      url: "http://studio.invalid",
      token: "tok-studio",
    });
    expect(r.resolve("DELETE", "/session/ses-studio")).toMatchObject({ kind: "peer", machineId: "studio" });
    expect(r.resolve("PATCH", "/api/session/ses-studio")).toMatchObject({ kind: "peer", machineId: "studio" });
  });

  it("a GET/HEAD NEVER routes on the write plane (the read plane owns GET — the INVERTED decision)", () => {
    expect(r.resolve("GET", "/api/session/ses-studio")).toBeUndefined();
    expect(r.resolve("GET", "/session/ses-studio")).toBeUndefined();
    expect(r.resolve("HEAD", "/api/session/ses-studio")).toBeUndefined();
  });

  it("local-owned / unowned / not-a-known-peer → undefined (BYTE-IDENTICAL local fall-through)", () => {
    expect(r.resolve("POST", "/session/ses-local")).toBeUndefined(); // local-owned
    expect(r.resolve("POST", "/api/session/ses-unknown/message")).toBeUndefined(); // unowned
    expect(r.resolve("POST", "/api/session/ses-stranger/message")).toBeUndefined(); // owner not a serving peer
  });

  it("/amicode/* and non-session paths → undefined (never a write target)", () => {
    expect(r.resolve("POST", "/amicode/fleet/status")).toBeUndefined();
    expect(r.resolve("POST", "/amicode/profile")).toBeUndefined();
    expect(r.resolve("POST", "/session")).toBeUndefined(); // the list, no id
    expect(r.resolve("POST", "/session/status")).toBeUndefined(); // the status poll
  });

  it("no control grant → DENIED no-control-grant (never local, never a peer target)", () => {
    expect(r.resolve("POST", "/api/session/ses-nogrant/message")).toEqual({
      kind: "denied",
      machineId: "ngpeer",
      reason: "no-control-grant",
    });
  });

  it("a revoked grant → DENIED grant-revoked", () => {
    expect(r.resolve("DELETE", "/api/session/ses-revoked")).toEqual({
      kind: "denied",
      machineId: "revpeer",
      reason: "grant-revoked",
    });
  });

  it("a revocation-pending grant → DENIED grant-revoked (the gate COLLAPSES pending→revoked)", () => {
    expect(r.resolve("POST", "/api/session/ses-pending/message")).toEqual({
      kind: "denied",
      machineId: "pendpeer",
      reason: "grant-revoked",
    });
  });

  it("an observe-only grant → DENIED insufficient-scope (need control for writes)", () => {
    expect(r.resolve("POST", "/api/session/ses-observe/message")).toEqual({
      kind: "denied",
      machineId: "obspeer",
      reason: "insufficient-scope",
    });
  });

  it("an active control grant but transport down → DENIED transport-down (never local)", () => {
    expect(r.resolve("POST", "/api/session/ses-dark/message")).toEqual({
      kind: "denied",
      machineId: "darkpeer",
      reason: "transport-down",
    });
  });
});

// ── an observation-mode server with BOTH planes: local EngineProxy + the read
//    plane (#1537) + the write plane (#1542), NO fleet plane (getMode stays
//    "engine"). `owners` seeds the SessionOwnerMap; `peer` resolves transport;
//    `grantReader` is injected (isolates dispatch wiring from the grant store —
//    the real findControlGrantByTarget composition is exercised in the
//    production-wiring describe below). ─────────────────────────────────────
function bootObserveRW(
  owners: Array<{ id: string; owner: string }>,
  peer: (machineId: string) => PeerTransport | undefined,
  grantReader: (owner: string) => WriteGrantRead | undefined,
  localMachineId = "macbook",
): AmicodeServiceServer {
  const ownerMap = new SessionOwnerMap();
  ownerMap.update(
    owners.map((o) => ({
      id: o.id,
      amicode_owner: { owner_machine_id: o.owner, owner_name: o.owner, is_local: o.owner === localMachineId },
    })),
  );
  const server = new AmicodeServiceServer({ password: PW });
  server.attachEngineProxy(new EngineProxy({ getUrl: () => localStub.url }));
  server.attachObservationReadPlane(createObservationReadPlane({ ownerMap, localMachineId, peer }));
  server.attachObservationWritePlane(createObservationWritePlane({ ownerMap, localMachineId, peer, grantReader }));
  return server;
}

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — with NO control grant, a remote write is DENIED no-control-grant and is
// NEVER executed locally (nor sent to the peer).
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 AC1 — no control grant → remote write denied no-control-grant, never local", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;
  const grantReader = (): WriteGrantRead | undefined => undefined; // no grant anywhere

  for (const [method, path] of [
    ["POST", "/api/session/ses-studio/message"],
    ["DELETE", "/api/session/ses-studio"],
    ["PATCH", "/session/ses-studio"],
  ] as const) {
    it(`${method} ${path} → 403 no-control-grant; peer NOT dialed; local NOT dialed`, async () => {
      const server = bootObserveRW([{ id: "ses-studio", owner: "studio" }], peer, grantReader);
      const origin = (await server.start()).toString().replace(/\/$/, "");
      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      try {
        const res = await fetch(`${origin}${path}`, {
          method,
          headers: { ...authed, "content-type": "application/json" },
          body: method === "DELETE" ? undefined : JSON.stringify({ text: "hi" }),
        });
        expect(res.status).toBe(403);
        const body = (await res.json()) as { ok: boolean; reason?: string };
        expect(body.ok).toBe(false);
        expect(body.reason).toBe("no-control-grant");
        expect(peerStub.requests.length).toBe(peerBefore); // the peer was NOT written to
        expect(localStub.requests.length).toBe(localBefore); // and NEVER executed locally
      } finally {
        await server.stop();
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — with an active control grant + reachable transport, a prompt / archive /
// delete to a peer-owned session ROUTES to the owner with the credential the
// owner accepts (the PEER reader token); the local engine is NOT dialed.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 AC2 — active control + reachable → the write routes to the owner peer with the accepted credential", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;
  const grantReader = (owner: string): WriteGrantRead | undefined =>
    owner === "studio" ? { scope: "control", state: "active" } : undefined;

  for (const [method, path] of [
    ["POST", "/api/session/ses-studio/message"], // prompt
    ["DELETE", "/api/session/ses-studio"], // delete
    ["PATCH", "/session/ses-studio"], // archive (a mutation)
  ] as const) {
    it(`${method} ${path} → dialed on the PEER with peerAuthHeader(reader token); local NOT dialed`, async () => {
      const server = bootObserveRW([{ id: "ses-studio", owner: "studio" }], peer, grantReader);
      const origin = (await server.start()).toString().replace(/\/$/, "");
      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      try {
        const res = await fetch(`${origin}${path}`, {
          method,
          headers: { ...authed, "content-type": "application/json" },
          body: method === "DELETE" ? undefined : JSON.stringify({ text: "hi" }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker);
        expect(peerStub.requests.length).toBe(peerBefore + 1);
        const dialed = peerStub.requests.at(-1)!;
        expect(dialed.method).toBe(method); // the write verb proxied verbatim
        expect(dialed.path).toBe(path); // proxied verbatim
        expect(dialed.auth).toBe(peerAuthHeader("tok-studio")); // the PEER reader token the owner accepts
        expect(dialed.auth?.includes(PW)).toBe(false); // the local mint is NEVER forwarded outward
        expect(localStub.requests.length).toBe(localBefore); // the local engine was NOT dialed
      } finally {
        await server.stop();
      }
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — the fail-closed vocabulary: revoked / revocation-pending → grant-revoked;
// wrong scope → insufficient-scope; transport-down → transport-down. Mutation is
// suspended, but the session stays READABLE via the read plane (#1537). None of
// these ever executes locally.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 AC3 — the gate's real reasons; mutation suspended, session still readable", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;
  const peerDown = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => undefined, token: "tok-studio" } : undefined; // serving, transport down

  async function denyCase(
    grantReader: (o: string) => WriteGrantRead | undefined,
    peerFn: (id: string) => PeerTransport | undefined,
    expectStatus: number,
    expectReason: string,
  ) {
    const server = bootObserveRW([{ id: "ses-studio", owner: "studio" }], peerFn, grantReader);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const localBefore = localStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(expectStatus);
      const body = (await res.json()) as { ok: boolean; reason?: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toBe(expectReason);
      expect(localStub.requests.length).toBe(localBefore); // NEVER executed locally
    } finally {
      await server.stop();
    }
  }

  it("a revoked grant → 403 grant-revoked", async () => {
    await denyCase((o) => (o === "studio" ? { scope: "control", state: "revoked" } : undefined), peer, 403, "grant-revoked");
  });

  it("a revocation-pending grant → 403 grant-revoked (the gate collapses pending→revoked)", async () => {
    await denyCase((o) => (o === "studio" ? { scope: "control", state: "revocation-pending" } : undefined), peer, 403, "grant-revoked");
  });

  it("an observe-only grant → 403 insufficient-scope", async () => {
    await denyCase((o) => (o === "studio" ? { scope: "observe", state: "active" } : undefined), peer, 403, "insufficient-scope");
  });

  it("an active control grant but transport down → 503 transport-down (peer-unreachable), never local", async () => {
    await denyCase((o) => (o === "studio" ? { scope: "control", state: "active" } : undefined), peerDown, 503, "transport-down");
  });

  it("mutation suspended (insufficient-scope) yet the session stays READABLE via the read plane", async () => {
    // observe-only grant: the WRITE is denied, but a GET still routes to the
    // owner peer through the untouched read plane (session readable).
    const grantReader = (o: string): WriteGrantRead | undefined => (o === "studio" ? { scope: "observe", state: "active" } : undefined);
    const server = bootObserveRW([{ id: "ses-studio", owner: "studio" }], peer, grantReader);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      // WRITE denied
      const w = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(w.status).toBe(403);
      expect((await w.json() as { reason?: string }).reason).toBe("insufficient-scope");
      // READ still routes to the peer (the read plane owns GET, unaffected by the write gate)
      const rr = await fetch(`${origin}/api/session/ses-studio`, { headers: authed });
      expect(rr.status).toBe(200);
      expect(((await rr.json()) as { marker: string }).marker).toBe(peerStub.marker);
      const dialed = peerStub.requests.slice(peerBefore).find((q) => q.method === "GET" && q.path === "/api/session/ses-studio");
      expect(dialed).toBeDefined();
      expect(dialed!.auth).toBe(peerAuthHeader("tok-studio"));
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — local-owned and unowned sessions: writes fall through BYTE-IDENTICAL to
// the local engine (the plane is inert); the peer is NOT dialed.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 AC4 — local-owned / unowned writes fall through byte-identical to the local engine", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;
  const grantReader = (owner: string): WriteGrantRead | undefined =>
    owner === "studio" ? { scope: "control", state: "active" } : undefined;

  it("POST for a LOCAL-owned session → the local engine, peer NOT dialed", async () => {
    const server = bootObserveRW([{ id: "ses-local", owner: "macbook" }], peer, grantReader);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-local/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore); // peer NOT dialed
    } finally {
      await server.stop();
    }
  });

  it("POST for an UNOWNED session → the local engine, peer NOT dialed", async () => {
    const server = bootObserveRW([], peer, grantReader);
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-nobody/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore);
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Byte-identity when UNATTACHED — a server with NO write plane consults nothing:
// a POST for a peer-owned session falls through to the local engine (the
// `if (this.observeWrite)` block is a structural no-op). This is the flag-off /
// standalone / armed posture.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 — the write plane is INERT when unattached (structural byte-identity)", () => {
  const peer = (id: string): PeerTransport | undefined =>
    id === "studio" ? { getUrl: () => peerStub.url, token: "tok-studio" } : undefined;

  it("no write plane attached → a peer-owned POST falls through to the local engine, peer NOT dialed", async () => {
    // read plane attached (so the seam family is present) but the WRITE plane is NOT.
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-studio", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } }]);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => localStub.url }));
    server.attachObservationReadPlane(createObservationReadPlane({ ownerMap, localMachineId: "macbook", peer }));
    // NO attachObservationWritePlane
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(localStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore); // peer NOT dialed
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Production wiring — createAmicodeService on the OBSERVATION-ONLY path wires the
// write plane with the REAL findControlGrantByTarget composition (the D2 fix): a
// control grant resolved by targetMachineId === owner authorizes the write; NO
// grant denies no-control-grant. The read plane and armed path stay unchanged.
// ══════════════════════════════════════════════════════════════════════════════
describe("#1542 — production wiring (createAmicodeService observation-only path + real grant store)", () => {
  let root: string;
  const savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
  const savedGrantFile = process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE;
  const savedMultiplex = process.env.AMICO_FLEET_MULTIPLEX;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amicode-1542-wire-"));
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
    process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE = join(root, "lifecycle-grants.json");
    delete process.env.AMICO_FLEET_MULTIPLEX;
  });
  afterAll(() => {
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    if (savedGrantFile === undefined) delete process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE;
    else process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE = savedGrantFile;
    if (savedMultiplex === undefined) delete process.env.AMICO_FLEET_MULTIPLEX;
    else process.env.AMICO_FLEET_MULTIPLEX = savedMultiplex;
    rmSync(root, { recursive: true, force: true });
  });

  function servingPeerProvider() {
    return {
      localMachineId: "macbook",
      getServingPeers: () => [{ machineId: "studio" }],
      getBlockedPeers: () => [] as Array<{ machineId: string; reason: "identity-conflict" }>,
      readPeerToken: (id: string) =>
        id === "studio"
          ? ({ ok: true as const, credential: { baseUrl: peerStub.url, token: "tok-studio" } })
          : ({ ok: false as const }),
      rosterLookup: (id: string) => ({ name: id }),
    };
  }

  async function waitFor(cond: (() => boolean) | (() => Promise<boolean>), timeoutMs = 4000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return cond();
  }

  it("with an active control grant (target === studio), an observation-only boot routes a peer-owned WRITE to the peer (its reader token); local NOT dialed", async () => {
    // Seed the real lifecycle store with an active control grant whose TARGET is
    // the owner peer (studio) — the D2-corrected findControlGrantByTarget read.
    const { issueLifecycleGrant } = await import("../src/amicode_service/fleet_control_lifecycle");
    const issued = issueLifecycleGrant({
      requesterMachineId: "macbook",
      requesterIdentityKey: "id-macbook",
      targetMachineId: "studio",
      targetIdentityKey: "id-studio",
      scope: "control",
    });
    expect(issued.ok).toBe(true);

    const svc = createAmicodeService({
      password: PW,
      engine: { password: "engine-mint", getUrl: () => localStub.url },
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      await waitFor(() => peerStub.requests.some((r) => r.path === "/experimental/session" || r.path === "/session") && peerStub.requests.some((r) => r.path === "/global/health"));
      await new Promise((r) => setTimeout(r, 500)); // settle the synchronous ownerMap.update

      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      const res = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader("engine-mint"), "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker);
      const dialed = peerStub.requests.slice(peerBefore).find((r) => r.method === "POST" && r.path === "/api/session/ses-studio/message");
      expect(dialed).toBeDefined();
      expect(dialed!.auth).toBe(peerAuthHeader("tok-studio")); // the peer reader token the owner accepts
      expect(localStub.requests.slice(localBefore).some((r) => r.path === "/api/session/ses-studio/message")).toBe(false); // local NOT dialed
    } finally {
      await svc.stop();
    }
  });

  it("with NO grant in the store, the SAME peer-owned WRITE is denied no-control-grant; peer NOT dialed, local NOT dialed", async () => {
    // Clear the store (a fresh temp file with no grant).
    const freshGrantFile = join(root, "lifecycle-grants-empty.json");
    const saved = process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE;
    process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE = freshGrantFile;

    const svc = createAmicodeService({
      password: PW,
      engine: { password: "engine-mint", getUrl: () => localStub.url },
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      await waitFor(() => peerStub.requests.some((r) => r.path === "/experimental/session" || r.path === "/session") && peerStub.requests.some((r) => r.path === "/global/health"));
      await new Promise((r) => setTimeout(r, 500));

      const localBefore = localStub.requests.length;
      const peerBefore = peerStub.requests.length;
      const res = await fetch(`${origin}/api/session/ses-studio/message`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader("engine-mint"), "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { reason?: string }).reason).toBe("no-control-grant");
      expect(peerStub.requests.slice(peerBefore).some((r) => r.method === "POST" && r.path === "/api/session/ses-studio/message")).toBe(false);
      expect(localStub.requests.slice(localBefore).some((r) => r.path === "/api/session/ses-studio/message")).toBe(false);
    } finally {
      await svc.stop();
      if (saved === undefined) delete process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE;
      else process.env.AMICO_FLEET_LIFECYCLE_GRANT_FILE = saved;
    }
  });
});

