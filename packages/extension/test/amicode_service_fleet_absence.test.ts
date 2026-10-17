// amicode_service_fleet_absence.test.ts — #1812: the fleet routes the APP
// calls answer the DOCUMENTED no-fleet absence {ok:false, reason:"no-fleet-peers"}
// on every boot, never the generic no-route 404 the panel render gate refuses.
//
// #1768's discipline, extended: GET /amicode/fleet/session-status already
// mounts unconditionally and answers the not-served 404 {ok:false,
// reason:"no-fleet-peers"} (the app's silent-fallback signal) wherever no
// fleet topology exists. But the OTHER app-called fleet routes — sessions
// (+ ?scope= / ?archived=), grants, creation-target, peer-home-base — only
// mounted WITH a staged/topology-bearing boot, so a no-topology machine (the
// hub: hub_fleet_wiring resolves no server/standalone machine id → the unarmed
// base service) served them the generic `no route` 404. This suite pins:
//
//   AC1 — sessions (bare, ?scope=all, ?archived=true) answers 404
//         {ok:false, reason:"no-fleet-peers"} on EVERY fleetless boot
//         (no fleet option; armed-but-unentitled staging refusal; an
//         observation-only provider with ZERO serving peers);
//   AC2 — the other app-called fleet routes (grants, creation-target,
//         peer-home-base) answer the SAME absence, and the always-on family
//         (session-status, attachment, effective-stream) keeps its documented
//         answers; /amicode/fleet/status — NOT app-called — keeps the #391
//         base no-route 404 (H3 preserved where it still means something);
//   AC3 — with a topology (an observation-only serving peer; a premium
//         staged plane), the SAME routes serve REAL data — the always-on
//         absence never shadows the staged registration;
//   auth — the absence answers are credential-gated like every /amicode/* read.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";

const LOCAL_ID = "test-laptop";
const PEER_ID = "test-studio";
const ENGINE_PW = "engine-mint-1812";
const PEER_TOKEN = "tok-studio-1812";
const PEER_HOME = "/Users/peer/harmoniqs";
const ABSENCE = { ok: false, reason: "no-fleet-peers" };

interface Stub {
  url: string;
  stop(): Promise<void>;
}

/** An engine/peer stub: /experimental/session lists `sessions`, /global/health
 *  stamps the version, behind `credential` (Basic server-auth shape). */
function startStub(sessions: unknown[], credential: string, peerWorkspace = false): Promise<Stub> {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== serverAuthHeader(credential)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.setHeader("content-type", "application/json");
    const u = new URL(req.url ?? "/", "http://stub");
    if (req.method === "GET" && (u.pathname === "/session" || u.pathname === "/experimental/session")) {
      const archived = u.searchParams.get("archived") === "true";
      res.end(JSON.stringify(archived ? [] : sessions));
      return;
    }
    if (req.method === "GET" && u.pathname === "/global/health") {
      res.end(JSON.stringify({ healthy: true, version: "v1.18.29" }));
      return;
    }
    // the peer's OWN workspace truth (#1643): what peer-home-base dials
    if (peerWorkspace && req.method === "GET" && u.pathname === "/amicode/fleet/peer-workspace") {
      res.end(JSON.stringify({ ok: true, home_base: PEER_HOME, projects: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
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

const auth = () => ({ Authorization: `Basic ${serverAuthToken(ENGINE_PW)}` });

/** Fetch one route on a booted origin, returning {status, body}. */
async function get(origin: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${origin}${path}`, { headers: auth() });
  return { status: res.status, body: await res.json() };
}

describe("#1812 — the app-called fleet routes answer the documented no-fleet absence", () => {
  let root: string;
  let overlaySource: string;
  let engine: Stub;
  let peer: Stub;
  const savedEnv: Record<string, string | undefined> = {};

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

  function boot(fleet: Parameters<typeof createAmicodeService>[0]["fleet"]) {
    return createAmicodeService({
      password: "service-own-mint",
      engine: { password: ENGINE_PW, getUrl: () => engine.url },
      ...(fleet === undefined ? {} : { fleet }),
    });
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1812-absence-"));
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    engine = await startStub([{ id: "ses-local", title: "local", time: { created: 1, updated: 2 } }], ENGINE_PW);
    peer = await startStub([{ id: "ses-peer", title: "peer", time: { created: 3, updated: 4 } }], PEER_TOKEN, true);
    // isolate every real store the routes read (hub credential, lifecycle
    // grants, control requests) so the fleetless answers are deterministic
    for (const k of ["AMICO_FLEET_HUB_FILE", "AMICO_FLEET_LIFECYCLE_GRANT_FILE", "AMICO_FLEET_CONTROL_REQUEST_FILE"]) {
      savedEnv[k] = process.env[k];
      process.env[k] = join(root, `${k.toLowerCase()}-absent.json`);
    }
  });

  afterAll(async () => {
    await engine.stop();
    await peer.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  // the fleetless boot shapes from the wild: the hub's unarmed base service,
  // the armed-but-unentitled staging refusal, and a fleet-of-one observer
  const fleetlessBoots = () => [
    { name: "a base boot (no fleet option at all — the hub's unarmed shape)", fleet: undefined },
    {
      name: "an armed-but-unentitled boot (the staging gate refuses)",
      fleet: { entitlements: [] as string[], overlaySource, hub: { getUrl: () => undefined } },
    },
    {
      name: "an observation-only boot whose provider resolves ZERO serving peers",
      fleet: { hub: { getUrl: () => undefined }, observationOnly: true as const, fleetPeers: noPeerProvider() },
    },
  ];

  // ── AC1: sessions (every variant the app calls) ─────────────────────────────
  it.each(fleetlessBoots())(
    "$name: GET /amicode/fleet/sessions (bare, ?scope=all, ?archived=true) answers 404 {ok:false, reason:'no-fleet-peers'}",
    async ({ fleet }) => {
      const svc = boot(fleet);
      const origin = (await svc.start()).toString().replace(/\/$/, "");
      try {
        for (const q of ["", "?scope=all", "?archived=true"]) {
          const r = await get(origin, `/amicode/fleet/sessions${q}`);
          expect(r.status).toBe(404);
          expect(r.body).toEqual(ABSENCE);
        }
      } finally {
        await svc.stop();
      }
    },
  );

  // ── AC2: the other app-called fleet routes + the always-on family ─────────
  it.each(fleetlessBoots())(
    "$name: grants, creation-target, and peer-home-base answer the SAME documented absence",
    async ({ fleet }) => {
      const svc = boot(fleet);
      const origin = (await svc.start()).toString().replace(/\/$/, "");
      try {
        for (const path of [
          "/amicode/fleet/grants",
          `/amicode/fleet/creation-target?machine=${encodeURIComponent(PEER_ID)}`,
          `/amicode/fleet/peer-home-base?machine=${encodeURIComponent(PEER_ID)}`,
        ]) {
          const r = await get(origin, path);
          expect(r.status).toBe(404);
          expect(r.body).toEqual(ABSENCE);
        }
      } finally {
        await svc.stop();
      }
    },
  );

  it("a fleetless boot: session-status answers its documented absence and attachment/effective-stream stay served (the always-on family)", async () => {
    const svc = boot(undefined);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const status = await get(origin, "/amicode/fleet/session-status?ids=ses-peer");
      expect(status.status).toBe(404);
      expect(status.body).toEqual(ABSENCE);
      const attachment = await get(origin, "/amicode/fleet/attachment");
      expect(attachment.status).toBe(200);
      const stream = await get(origin, "/amicode/fleet/effective-stream");
      expect(stream.status).toBe(200);
    } finally {
      await svc.stop();
    }
  });

  it("a fleetless boot: /amicode/fleet/status (NOT app-called) keeps the #391 base no-route 404 — H3 where it still means something", async () => {
    const svc = boot(undefined);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const r = await get(origin, "/amicode/fleet/status");
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ ok: false, error: "no route: GET /amicode/fleet/status" });
    } finally {
      await svc.stop();
    }
  });

  it("the absence answers are credential-gated exactly like every other /amicode read", async () => {
    const svc = boot(undefined);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/amicode/fleet/sessions`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Basic realm="amicode-service"');
    } finally {
      await svc.stop();
    }
  });

  // ── AC3: with a topology, the SAME routes serve REAL data ─────────────────
  it.each([
    { name: "an observation-only boot with a serving peer", premium: false },
    { name: "a premium staged plane with a serving peer", premium: true },
  ])("$name: the routes serve real data — the always-on absence never shadows the staged registration", async ({ premium }) => {
    const svc = boot({
      hub: { getUrl: () => undefined },
      fleetPeers: servingPeerProvider(),
      ...(premium ? { entitlements: ["amicissimo"], overlaySource } : { observationOnly: true }),
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const sessions = await get(origin, "/amicode/fleet/sessions");
      expect(sessions.status).toBe(200);
      expect((sessions.body as { ok: boolean }).ok).toBe(true);
      expect((sessions.body as { sources: Record<string, { present: boolean }> }).sources[PEER_ID].present).toBe(true);

      const grants = await get(origin, "/amicode/fleet/grants");
      expect(grants.status).toBe(200);
      expect((grants.body as { ok: boolean }).ok).toBe(true);

      const target = await get(origin, `/amicode/fleet/creation-target?machine=${encodeURIComponent(PEER_ID)}`);
      expect(target.status).toBe(200);
      expect((target.body as { ok: boolean }).ok).toBe(true);
      expect((target.body as { target: { machineId?: string } }).target.machineId).toBe(PEER_ID);

      const homeBase = await get(origin, `/amicode/fleet/peer-home-base?machine=${encodeURIComponent(PEER_ID)}`);
      expect(homeBase.status).toBe(200);
      expect(homeBase.body).toEqual({ ok: true, directory: PEER_HOME });
    } finally {
      await svc.stop();
    }
  });
});
