// amicode_service_fleet_session_status_route.test.ts — #1766 checkpoint 3: the
// GET /amicode/fleet/session-status ROUTE (route-level, beside the fleet route
// suites). Pins:
//   - namespace: it lives under the machine's own never-proxied /amicode/fleet/*
//     prefix (the D3 resolver, the session multiplexer, and the observation read
//     router all keep it local; a live boot serves it from the local route table);
//   - auth: a missing or invalid service credential is refused EXACTLY as the
//     neighbouring /amicode/fleet/sessions read refuses it;
//   - not served without fleet peers: 404 {ok:false, reason:"no-fleet-peers"}
//     wherever no fleet-peer provider / owner map exists, so the app falls back;
//   - served: it reads the LIVE owner map of whichever boot branch built one
//     (observation-only base peer AND the premium staged plane), fanning out to
//     the owner in the session's exact directory with the owner's own credential.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import { resolveAttachmentPointer, resolveAmicodeTarget } from "../src/amicode_service/attachment_pointer";
import { resolveKeeperPointer } from "../src/amicode_service/keeper_pointer";
import {
  SessionOwnerMap,
  SessionMultiplexProxy,
  ObservationReadRouter,
  OWNER_ROUTING_HEADER,
} from "../src/amicode_service/session_multiplexer";
import type { FleetSessionStatusResponse } from "../src/amicode_service/fleet_session_status";

export const FLEET_SESSION_STATUS_PATH = "/amicode/fleet/session-status";

// ── stub engines: a session list (with directory) + per-directory status ─────

interface StubEngine {
  url: string;
  requests: Array<{ method: string; url: string; auth: string | undefined }>;
  stop(): Promise<void>;
}

/** An engine stub: `/experimental/session` lists `sessions` (each carries its
 *  record's `directory`); `/session/status?directory=<d>` answers
 *  `statusByDirectory[d]` (absent directory → `{}`); `credential` gates every
 *  request when set (401 otherwise). */
function startStubEngine(opts: {
  sessions: Array<{ id: string; directory: string }>;
  statusByDirectory: Record<string, Record<string, unknown>>;
  credential?: string;
}): Promise<StubEngine> {
  const requests: StubEngine["requests"] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/", auth: req.headers.authorization });
    if (opts.credential !== undefined && req.headers.authorization !== serverAuthHeader(opts.credential)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://stub");
    if (req.method === "GET" && u.pathname === "/experimental/session") {
      const archived = u.searchParams.get("archived") === "true";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(archived ? [] : opts.sessions.map((s) => ({ ...s, title: s.id, time: { created: 1, updated: 2 } }))));
      return;
    }
    if (req.method === "GET" && u.pathname === "/session/status") {
      const d = u.searchParams.get("directory") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(opts.statusByDirectory[d] ?? {}));
      return;
    }
    if (req.method === "GET" && u.pathname === "/global/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version: "v1.18.29" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function writeDataPlaneManifest(sourceRoot: string): void {
  const dir = join(sourceRoot, "fleet_overlay", "overlays");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fleet-data-plane.json"),
    JSON.stringify({
      overlay_id: "fleet-data-plane",
      overlay_version: 1,
      base_version: "v1.18.29",
      surfaces: [
        {
          surface_id: "data-plane-routing",
          fleet_class: "data-plane routing",
          fields: [
            { name: "upstream_mode", base_default: "engine", description: "the routing mode" },
            { name: "hub_upstream", base_default: null, description: "the hub over the fleet tunnel" },
            { name: "hub_credential_entry", base_default: null, description: "the hub mint's store entry" },
            { name: "merged_projection", base_default: null, description: "the merged read path" },
          ],
        },
      ],
    }),
  );
}

const LOCAL_ID = "test-laptop";
const PEER_ID = "test-studio";
const ENGINE_PW = "engine-mint-1766";
const PEER_TOKEN = "tok-studio-1766";
const LOCAL_DIR = "/Users/jj/harmoniqs/local proj";
const PEER_DIR = "/Users/jj/harmoniqs/amicode/";

/** Poll the read until `done(body)` (the owner map is fed asynchronously by the
 *  OwnerMapFeed; a read issued before it catches up answers `unknown`). */
async function readUntil(
  origin: string,
  ids: string,
  done: (b: FleetSessionStatusResponse) => boolean,
): Promise<FleetSessionStatusResponse> {
  const deadline = Date.now() + 5000;
  let last: FleetSessionStatusResponse | undefined;
  while (Date.now() < deadline) {
    const res = await fetch(`${origin}${FLEET_SESSION_STATUS_PATH}?ids=${encodeURIComponent(ids)}`, {
      headers: { Authorization: `Basic ${serverAuthToken(ENGINE_PW)}` },
    });
    expect(res.status).toBe(200);
    last = (await res.json()) as FleetSessionStatusResponse;
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`fleet session-status never converged: ${JSON.stringify(last)}`);
}

describe("#1766 — GET /amicode/fleet/session-status (route-level)", () => {
  let root: string;
  let overlaySource: string;
  let localEngine: StubEngine;
  let peer: StubEngine;
  let savedHubFile: string | undefined;

  const servingPeerProvider = () => ({
    localMachineId: LOCAL_ID,
    getServingPeers: () => [{ machineId: PEER_ID }],
    readPeerToken: (id: string) =>
      id === PEER_ID
        ? { ok: true as const, credential: { baseUrl: peer.url, token: PEER_TOKEN } }
        : { ok: false as const },
    rosterLookup: (id: string) => ({ name: id }),
  });
  const noPeerProvider = () => ({
    localMachineId: LOCAL_ID,
    getServingPeers: () => [] as Array<{ machineId: string }>,
    readPeerToken: () => ({ ok: false as const }),
    rosterLookup: (id: string) => ({ name: id }),
  });

  const engine = () => ({ password: ENGINE_PW, getUrl: () => localEngine.url });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1766-route-"));
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    localEngine = await startStubEngine({
      sessions: [{ id: "ses-local", directory: LOCAL_DIR }],
      statusByDirectory: {}, // the local session is quiet → idle by absence
      credential: ENGINE_PW,
    });
    peer = await startStubEngine({
      sessions: [{ id: "ses-peer", directory: PEER_DIR }],
      statusByDirectory: { [PEER_DIR]: { "ses-peer": { type: "busy" } } },
      credential: PEER_TOKEN,
    });
    savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
  });

  afterAll(async () => {
    await localEngine.stop();
    await peer.stop();
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    rmSync(root, { recursive: true, force: true });
  });

  // ── namespace: never proxied ───────────────────────────────────────────────
  it("lives under the never-proxied /amicode/fleet/* prefix: every router keeps it local, even for a peer-owned id + owner header", () => {
    expect(FLEET_SESSION_STATUS_PATH.startsWith("/amicode/fleet/")).toBe(true);
    const scratch = mkdtempSync(join(tmpdir(), "amicode-1766-ns-"));
    const decision = resolveAmicodeTarget(FLEET_SESSION_STATUS_PATH, {
      attached: resolveAttachmentPointer({ attachmentFile: join(scratch, "attachment.json") }),
      keeper: resolveKeeperPointer({ keeperFile: join(scratch, "keeper.json") }),
    });
    expect(decision.target).toBe("local");
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-peer", directory: PEER_DIR, amicode_owner: { owner_machine_id: PEER_ID, owner_name: PEER_ID, is_local: false } }]);
    const mux = new SessionMultiplexProxy({ ownerMap, peers: { [PEER_ID]: { getUrl: () => "http://127.0.0.1:9" } }, localMachineId: LOCAL_ID });
    expect(mux.resolveTarget("GET", FLEET_SESSION_STATUS_PATH, { [OWNER_ROUTING_HEADER]: PEER_ID })).toBeUndefined();
    const reader = new ObservationReadRouter({ ownerMap, localMachineId: LOCAL_ID, peer: () => ({ getUrl: () => "http://127.0.0.1:9", token: "t" }) });
    expect(reader.resolve("GET", FLEET_SESSION_STATUS_PATH)).toBeUndefined();
    rmSync(scratch, { recursive: true, force: true });
  });

  // ── auth: same refusal as the neighbouring fleet read ───────────────────────
  it("refuses a missing or invalid service credential exactly as /amicode/fleet/sessions does", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: engine(),
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      for (const headers of [{}, { Authorization: `Basic ${serverAuthToken("wrong-password")}` }, { Authorization: "Bearer nope" }]) {
        const status = await fetch(`${o}${FLEET_SESSION_STATUS_PATH}?ids=ses-peer`, { headers });
        const sessions = await fetch(`${o}/amicode/fleet/sessions`, { headers });
        expect(status.status).toBe(401);
        expect(status.status).toBe(sessions.status);
        expect(status.headers.get("www-authenticate")).toBe(sessions.headers.get("www-authenticate"));
        expect(await status.text()).toBe(await sessions.text());
      }
      // and NOTHING reached an upstream on a refused read
      expect(peer.requests.some((r) => r.url.startsWith("/session/status"))).toBe(false);
    } finally {
      await svc.stop();
    }
  });

  // ── not served without fleet peers ──────────────────────────────────────────
  it.each([
    { name: "a base boot (no fleet option at all)", fleet: undefined },
    {
      name: "an observation-only boot whose provider resolves zero serving peers",
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: "none" as const },
    },
    {
      name: "a premium staged plane with NO fleet-peer provider",
      fleet: { hub: { getUrl: () => undefined }, entitlements: ["amicissimo"], staged: true },
    },
  ])("$name answers 404 {ok:false, reason:'no-fleet-peers'} (the app's silent fallback signal)", async ({ fleet }) => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: engine(),
      ...(fleet === undefined
        ? {}
        : {
            fleet: {
              hub: fleet.hub,
              ...("observationOnly" in fleet ? { observationOnly: true, fleetPeers: noPeerProvider() } : {}),
              ...("staged" in fleet ? { entitlements: fleet.entitlements, overlaySource } : {}),
            },
          }),
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${o}${FLEET_SESSION_STATUS_PATH}?ids=ses-peer`, {
        headers: { Authorization: `Basic ${serverAuthToken(ENGINE_PW)}` },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, reason: "no-fleet-peers" });
    } finally {
      await svc.stop();
    }
  });

  // ── served: the live owner map of whichever branch built one ────────────────
  it.each([
    { name: "observation-only base peer", premium: false },
    { name: "premium staged plane", premium: true },
  ])("$name: reads the live owner map, fans out per (owner, exact directory) with each owner's own credential", async ({ premium }) => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: engine(),
      fleet: {
        hub: { getUrl: () => undefined },
        fleetPeers: servingPeerProvider(),
        ...(premium ? { entitlements: ["amicissimo"], overlaySource } : { observationOnly: true }),
      },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const peerBefore = peer.requests.length;
    try {
      const body = await readUntil(o, "ses-peer,ses-local", (b) => b.unresolved.length === 0);
      expect(body).toEqual({
        ok: true,
        statuses: { "ses-peer": { type: "busy" }, "ses-local": { type: "idle" } },
        sources: {
          [PEER_ID]: { present: true, directories: { [PEER_DIR]: { ok: true, sessions: 1 } } },
          [LOCAL_ID]: { present: true, directories: { [LOCAL_DIR]: { ok: true, sessions: 1 } } },
        },
        unresolved: [],
      });
      // the peer was asked for status IN THE SESSION'S EXACT DIRECTORY, with ITS token;
      // the route itself was never proxied to it
      const peerStatusReads = peer.requests.slice(peerBefore).filter((r) => r.url.startsWith("/session/status"));
      expect(peerStatusReads.length).toBeGreaterThan(0);
      for (const r of peerStatusReads) {
        expect(new URL(r.url, "http://x").searchParams.get("directory")).toBe(PEER_DIR);
        expect(r.auth).toBe(serverAuthHeader(PEER_TOKEN));
      }
      expect(peer.requests.some((r) => r.url.startsWith("/amicode/"))).toBe(false);
      // the local engine was asked in ITS session's directory with the engine credential
      const localStatusReads = localEngine.requests.filter((r) => r.url.startsWith("/session/status"));
      expect(localStatusReads.some((r) => new URL(r.url, "http://x").searchParams.get("directory") === LOCAL_DIR)).toBe(true);
      expect(localStatusReads.every((r) => r.auth === serverAuthHeader(ENGINE_PW))).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  // ── #1771: both boot branches log the owner-map refresh + the fan-in census ──
  it.each([
    { name: "observation-only base peer", premium: false, plane: "observe" },
    { name: "premium staged plane", premium: true, plane: "premium" },
  ])("#1771 $name: the service log gets each refresh's per-peer outcome and the fan-in census", async ({ premium, plane }) => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const lines: string[] = [];
    let notify: (() => void) | undefined;
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: engine(),
      fleet: {
        hub: { getUrl: () => undefined },
        fleetPeers: servingPeerProvider(),
        ...(premium ? { entitlements: ["amicissimo"], overlaySource } : { observationOnly: true }),
      },
      log: (l) => {
        lines.push(l);
        notify?.();
      },
    });
    try {
      // the feed's immediate refresh reaches the peer: ONE line for the peer
      const isPeerLine = (l: string) => l.startsWith(`[owner-map] refresh peer=${PEER_ID} `);
      if (!lines.some(isPeerLine)) await new Promise<void>((r) => (notify = () => lines.some(isPeerLine) && r()));
      expect(lines.find(isPeerLine)).toMatch(new RegExp(`^\\[owner-map\\] refresh peer=${PEER_ID} outcome=ok duration_ms=\\d+ entries=1$`));
      expect(lines.some((l) => l.includes(`peer=${LOCAL_ID} `))).toBe(false); // the local engine is not a peer
      vi.advanceTimersByTime(30_000);
      expect(lines.filter((l) => l.startsWith(`[fanin] census plane=${plane} listeners=0 `))).toHaveLength(1);
    } finally {
      await svc.stop();
      vi.useRealTimers();
    }
  });

  it("an empty / missing ids parameter is an empty 200 map with no upstream status call", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: engine(),
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true, fleetPeers: servingPeerProvider() },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const before = peer.requests.filter((r) => r.url.startsWith("/session/status")).length;
    try {
      for (const q of ["", "?ids=", "?ids=,%20,"]) {
        const res = await fetch(`${o}${FLEET_SESSION_STATUS_PATH}${q}`, {
          headers: { Authorization: `Basic ${serverAuthToken(ENGINE_PW)}` },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, statuses: {}, sources: {}, unresolved: [] });
      }
      expect(peer.requests.filter((r) => r.url.startsWith("/session/status")).length).toBe(before);
    } finally {
      await svc.stop();
    }
  });
});
