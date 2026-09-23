// Slice 4b — the local-shell data plane (amicissimo#391, spec
// spec-20260905-193000-local-shell-data-plane Slice A): the proxy's FLEET
// mode (D1), the MERGED projection read path (D2), and the HUB credential
// (D5 — three mints, one honesty rule), all staged through the #394
// resolver's dispatch so ZERO fleet surfaces exist without the entitlement.
//
// The staging fixture (H3) is the first describe block: with no entitlement,
// client-visible bytes are IDENTICAL to the base service — the fleet mode
// does not exist. Everything else pins the staged behavior: mode-driven
// upstream routing (assets never cross the WAN — the shelf serves them
// locally in fleet mode too), the provenance-tagged merged projection with
// currency derived over what is actually fetched, and the named hub-mint
// outcomes (a missing credential is NAMED, never a silent fallback).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { startAmicodeService } from "../src/amicode_service_wiring";
import type { AmicodeServiceBoot } from "../src/amicode_service_wiring";
import type { FleetActivation } from "../src/fleet_activation";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import {
  fleetHubFile,
  readHubCredential,
  writeHubCredential,
  clearHubCredential,
  hubUpstreamAuthHeader,
} from "../src/amicode_service/hub_credential";
import { deriveCurrency, buildFleetProjection, type SessionOwnerTag, type FleetProjection } from "../src/amicode_service/merged_projection";
import { stageFleetDataPlane } from "../src/amicode_service/fleet_staging";
import { buildFleetPeerProvider, fleetPeerTransports } from "../src/amicode_service/fleet_peer_provider";
import { writePeerToken } from "../src/amicode_service/fleet_peer_store";
import type { RosterRow } from "@amicode/schema";

// ── mock dist (the app-shelf test's shape) ───────────────────────────────────

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>amicode app</title></head><body><div id=root></div></body></html>",
  );
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app bundle');\n");
  writeFileSync(join(dist, "site.webmanifest"), '{"name":"Amicode"}\n');
  return dist;
}

// ── mock engine: /session (list) + /global/health (the version stamp) ───────

interface MockOrigin {
  url: string;
  requests: string[];
  stop(): Promise<void>;
}

function startMockEngine(sessions: unknown[]): Promise<MockOrigin> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const auth = req.headers.authorization ?? "";
    if (auth !== serverAuthHeader("engine-mint-password")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
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

// ── mock hub: requires the HUB mint, tracks every request it sees ────────────

function startMockHub(sessions: unknown[], password: string): Promise<MockOrigin> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const auth = req.headers.authorization ?? "";
    if (auth !== hubUpstreamAuthHeader(password)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
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

// ── the data-plane overlay manifest fixture (the shipped manifest's shape) ──

function writeDataPlaneManifest(sourceRoot: string, baseVersion = "v1.18.29"): void {
  const dir = join(sourceRoot, "fleet_overlay", "overlays");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fleet-data-plane.json"),
    JSON.stringify({
      overlay_id: "fleet-data-plane",
      overlay_version: 1,
      base_version: baseVersion,
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

const LOCAL_SESSIONS = [
  { id: "ses-local-1", title: "local one", time: { created: 1000, updated: 5000 } },
  { id: "ses-both", title: "local copy", time: { created: 2000, updated: 7000 } },
];
const HUB_SESSIONS = [
  { id: "ses-hub-1", title: "hub one", time: { created: 3000, updated: 9000 } },
  { id: "ses-both", title: "hub copy (store of record)", time: { created: 2000, updated: 8000 } },
];

// ══════════════════════════════════════════════════════════════════════════════
// H3 — the staging fixture: zero fleet surfaces without the entitlement
// ══════════════════════════════════════════════════════════════════════════════

describe("H3 staging fixture — zero fleet surfaces without the entitlement (byte identity)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let baseService: ReturnType<typeof createAmicodeService>;
  let gatedService: ReturnType<typeof createAmicodeService>;
  let baseOrigin: string;
  let gatedOrigin: string;
  let engineToken: string;

  /** The client-visible request set the no-entitlement criterion measures:
   *  document + assets + manifest + API + proxied + unknown + fleet paths. */
  const REQUEST_SET: Array<{ path: string; accept?: string; auth?: "engine" }> = [
    { path: "/", accept: "text/html" },
    { path: "/assets/app.js" },
    { path: "/site.webmanifest" },
    { path: "/amicode/profile", auth: "engine" },
    { path: "/session", auth: "engine" },
    { path: "/amicode/nope", auth: "engine" },
    { path: "/amicode/fleet/sessions", auth: "engine" },
    { path: "/amicode/fleet/status", auth: "engine" },
    { path: "/new-session", accept: "text/html", auth: "engine" },
  ];

  async function capture(origin: string) {
    const out: Array<{ path: string; status: number; contentType: string; body: string }> = [];
    for (const r of REQUEST_SET) {
      const res = await fetch(`${origin}${r.path}`, {
        headers: {
          ...(r.accept ? { Accept: r.accept } : {}),
          ...(r.auth === "engine" ? { Authorization: `Basic ${engineToken}` } : {}),
        },
      });
      out.push({
        path: r.path,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: await res.text(),
      });
    }
    const anon = await fetch(`${origin}/amicode/profile`);
    out.push({
      path: "(anon)/amicode/profile",
      status: anon.status,
      contentType: anon.headers.get("content-type") ?? "",
      body: await anon.text(),
    });
    return out;
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-h3-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    // NOTE: no manifest is ever written into overlaySource in this block —
    // with no entitlement the resolver must not even read it.
    engine = await startMockEngine(LOCAL_SESSIONS);
    engineToken = serverAuthToken("engine-mint-password");
    const engineOpts = { password: "engine-mint-password", getUrl: () => engine.url };
    baseService = createAmicodeService({
      password: "service-own-mint",
      engine: engineOpts,
      shelf: { distRoot: dist },
    });
    gatedService = createAmicodeService({
      password: "service-own-mint",
      engine: engineOpts,
      shelf: { distRoot: dist },
      // The fleet plane CONFIGURED but the entitlement ABSENT — the staging
      // gate must light nothing: zero fleet surfaces, byte-identical base.
      fleet: { entitlements: [], overlaySource, hub: { getUrl: () => "http://127.0.0.1:9" } },
    });
    baseOrigin = (await baseService.start()).toString().replace(/\/$/, "");
    gatedOrigin = (await gatedService.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await baseService.stop();
    await gatedService.stop();
    await engine.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("with no entitlement, every client-visible response is byte-identical to the base service", async () => {
    const base = await capture(baseOrigin);
    const gated = await capture(gatedOrigin);
    expect(gated).toEqual(base);
  });

  it("with no entitlement, the fleet paths answer the base no-route shape (the fleet mode does not exist)", async () => {
    const res = await fetch(`${gatedOrigin}/amicode/fleet/sessions`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "no route: GET /amicode/fleet/sessions" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The staging resolver composition (fleet_staging)
// ══════════════════════════════════════════════════════════════════════════════

describe("fleet staging — the #394 resolver's dispatch, transport-side", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-stage-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("without the entitlement the overlay source is never even read (zero fleet surfaces)", () => {
    // The source path is hostile on purpose: if staging READ it, this throws.
    const result = stageFleetDataPlane({
      entitlements: [],
      overlaySource: "/proc/amicode-fleet-must-not-read-this",
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(false);
    expect(result.receipt.entitlement).toBe("absent");
    expect(result.receipt.rejections).toEqual([]);
  });

  it("with the entitlement and a lawful manifest, the fleet surfaces stage with provenance", () => {
    const src = join(root, "valid");
    writeDataPlaneManifest(src);
    const result = stageFleetDataPlane({
      entitlements: ["amicissimo"],
      overlaySource: src,
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(true);
    expect(result.receipt.entitlement).toBe("present");
    expect(result.receipt.overlay_id).toBe("fleet-data-plane");
    expect(result.receipt.overlay_base_version).toBe("v1.18.29");
    expect(result.receipt.skew).toBeUndefined();
  });

  it("an overlay stamped against a different base stages with a named skew note, never silently", () => {
    const src = join(root, "stale");
    writeDataPlaneManifest(src, "v1.17.0");
    const result = stageFleetDataPlane({
      entitlements: ["amicissimo"],
      overlaySource: src,
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(true);
    expect(result.receipt.skew).toContain("v1.17.0");
    expect(result.receipt.skew).toContain("re-validated");
  });

  it("entitled but the overlay source is absent → named absence, not staged, never an error", () => {
    const result = stageFleetDataPlane({
      entitlements: ["amicissimo"],
      overlaySource: join(root, "does-not-exist"),
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(false);
    expect(result.receipt.absence_reason).toBe("overlay-source-absent");
  });

  it("entitled but the manifest is malformed → a recorded rejection, not staged", () => {
    const src = join(root, "malformed");
    const dir = join(src, "fleet_overlay", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fleet-data-plane.json"), "{not json");
    const result = stageFleetDataPlane({
      entitlements: ["amicissimo"],
      overlaySource: src,
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(false);
    expect(result.receipt.rejections.length).toBe(1);
    expect(result.receipt.absence_reason).toBe("manifest-invalid");
  });

  it("entitled but the manifest declares no data-plane-routing surface → not staged (nothing lawful to arm)", () => {
    const src = join(root, "wrong-surface");
    const dir = join(src, "fleet_overlay", "overlays");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fleet-data-plane.json"),
      JSON.stringify({
        overlay_id: "fleet-data-plane",
        overlay_version: 1,
        base_version: "v1.18.29",
        surfaces: [
          { surface_id: "attach-state", fields: [{ name: "posture_mode", base_default: "standalone" }] },
        ],
      }),
    );
    const result = stageFleetDataPlane({
      entitlements: ["amicissimo"],
      overlaySource: src,
      now: () => "2026-09-06T12:00:00Z",
    });
    expect(result.staged).toBe(false);
    expect(result.receipt.absence_reason).toBe("surface-not-declared");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Staged: the fleet mode + the merged projection + the hub credential
// ══════════════════════════════════════════════════════════════════════════════

describe("fleet mode staged — routing, merged projection, hub credential", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startMockHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";

  function bootService(getMode: () => "engine" | "fleet") {
    return createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode,
      },
    });
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-live-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine(LOCAL_SESSIONS);
    hub = await startMockHub(HUB_SESSIONS, HUB_PASSWORD);
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = bootService(() => "fleet");
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("in fleet mode, proxied data requests route to the HUB with the hub mint — never the client's token", async () => {
    const res = await fetch(`${origin}/session?auth_token=${encodeURIComponent(engineToken)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect((body as { id: string }[]).some((s) => s.id === "ses-hub-1")).toBe(true);
    // the hub saw the request, WITHOUT the ?auth_token carrier (stripped)…
    expect(hub.requests.some((r) => r.startsWith("GET /session"))).toBe(true);
    // …and it authenticated with the HUB mint (the mock 401s anything else).
  });

  it("in fleet mode, UI assets still serve LOCALLY from the shelf — they never cross the WAN", async () => {
    const hubBefore = hub.requests.length;
    const res = await fetch(`${origin}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("app bundle");
    const res2 = await fetch(`${origin}/?auth_token=${encodeURIComponent(engineToken)}`, {
      headers: { Accept: "text/html" },
    });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain("<div id=root>");
    expect(hub.requests.length).toBe(hubBefore); // the hub saw NOTHING for these
  });

  it("the merged projection composes BOTH stores, provenance-tagged, hub the store of record on conflicts", async () => {
    const res = await fetch(`${origin}/amicode/fleet/sessions`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      mode: string;
      sessions: Array<Record<string, unknown> & { amicode_provenance?: string }>;
      sources: Record<string, { present: boolean; count?: number; version?: string }>;
      currency: { token: string; sources: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("fleet");
    const byId = new Map(body.sessions.map((s) => [s.id as string, s]));
    expect(byId.get("ses-local-1")?.amicode_provenance).toBe("local");
    expect(byId.get("ses-hub-1")?.amicode_provenance).toBe("hub");
    // the store-of-record rule: a session in BOTH stores reads hub-side
    expect(byId.get("ses-both")?.amicode_provenance).toBe("hub");
    expect(byId.get("ses-both")?.title).toBe("hub copy (store of record)");
    expect(body.sources.local.present).toBe(true);
    expect(body.sources.local.count).toBe(2);
    expect(body.sources.hub.count).toBe(2);
    expect(body.sources.hub.version).toBe("v1.18.29");
    // currency is tagged with the sources it was derived over
    expect([...body.currency.sources].sort()).toEqual(["hub", "local"]);
  });

  it("W0 invariant (#1446): fleet configured but fleetPeers UNSET → the sessions route still serves the legacy 2-source projection (deps.fleetPeers undefined at index.ts:474)", async () => {
    // `service` here is booted via bootService() — a full fleet plane with NO
    // `fleetPeers` set (W0 constructs the provider but never assigns it; that
    // flip is W2, #1447). The legacy buildMergedProjection keys sources by the
    // "local"/"hub" pair; the N-peer buildFleetProjection would key by
    // machine_id and carry NO "hub" source. A "hub"-keyed source is therefore
    // proof the else-branch (index.ts:489) served — production byte-identical.
    const res = await fetch(`${origin}/amicode/fleet/sessions`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: Record<string, unknown> };
    expect(Object.keys(body.sources).sort()).toEqual(["hub", "local"]);
  });

  it("the merged projection's currency is derived over what is FETCHED (the hub gone → local-tagged token)", async () => {
    // Boot a second service whose hub getter yields undefined (no tunnel).
    const svc2 = bootService(() => "fleet");
    const hubGetter = hub;
    void hubGetter;
    // …but simulate the tunnel down by pointing a THIRD service at a dead hub
    const svc3 = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => undefined },
        getMode: () => "fleet",
      },
    });
    const origin3 = (await svc3.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin3}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: Array<{ amicode_provenance?: string }>;
        sources: Record<string, { present: boolean; reason?: string }>;
        currency: { token: string; sources: string[] };
      };
      // the hub source is a NAMED absence — never a silent one
      expect(body.sources.hub.present).toBe(false);
      expect(body.sources.hub.reason).toBe("no-upstream");
      expect(body.sources.local.present).toBe(true);
      expect(body.currency.sources).toEqual(["local"]);
      // and the local-only token is NOT the both-sources token (a token derived
      // over one upstream is never compared against another)
      const full = await fetch(`${origin}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      const fullBody = (await full.json()) as { currency: { token: string } };
      expect(body.currency.token).not.toBe(fullBody.currency.token);
    } finally {
      await svc3.stop();
    }
  });

  it("fleet mode with the hub unreachable: proxied requests get the honest named 503 (no silent engine fallback)", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => undefined },
        getMode: () => "fleet",
      },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${o}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "hub upstream not available" });
    } finally {
      await svc.stop();
    }
  });

  it("a missing hub credential is a NAMED outcome — never a silent mint fallback", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
      },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    const savedFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "missing-hub.json");
    try {
      // proxied data path: named 503
      const res = await fetch(`${o}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "hub-credential-missing", reason: "absent" });
      // projection: the hub source is named credential-missing, local still fetched
      const proj = await fetch(`${o}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      const body = (await proj.json()) as {
        sessions: Array<{ amicode_provenance?: string }>;
        sources: Record<string, { present: boolean; reason?: string }>;
        currency: { sources: string[] };
      };
      expect(body.sources.hub.present).toBe(false);
      expect(body.sources.hub.reason).toBe("credential-missing");
      expect(body.sources.local.present).toBe(true);
      expect(body.currency.sources).toEqual(["local"]);
      // status: the three mints are named, the hub mint absent
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      const sbody = (await status.json()) as {
        ok: boolean;
        mode: string;
        mints: Array<{ mint: string; present: boolean }>;
        hub_credential: { ok: boolean; reason?: string };
      };
      expect(sbody.ok).toBe(true);
      expect(sbody.mode).toBe("fleet");
      expect(sbody.mints.map((m) => m.mint).sort()).toEqual(["engine", "hub", "service"]);
      expect(sbody.mints.find((m) => m.mint === "hub")?.present).toBe(false);
      expect(sbody.hub_credential).toMatchObject({ ok: false, reason: "absent" });
    } finally {
      process.env.AMICO_FLEET_HUB_FILE = savedFile;
      await svc.stop();
    }
  });

  it("the hub mint is NEVER accepted on the service's own routes (per-mode credential discipline)", async () => {
    const res = await fetch(`${origin}/amicode/profile`, {
      headers: { Authorization: hubUpstreamAuthHeader(HUB_PASSWORD) },
    });
    expect(res.status).toBe(401);
  });

  it("mode selection is data-driven: getMode() → engine routes to the engine again (standalone posture intact)", async () => {
    const hubBefore = hub.requests.length;
    const svc = bootService(() => "engine");
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${o}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.some((s) => s.id === "ses-local-1")).toBe(true);
      expect(hub.requests.length).toBe(hubBefore);
      // the fleet routes stay mounted (the entitlement is present) and report the mode
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(((await status.json()) as { mode: string }).mode).toBe("engine");
    } finally {
      await svc.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The hub credential store entry — F4 version stamp + base-reader guarantee
// ══════════════════════════════════════════════════════════════════════════════

describe("hub credential store — version stamp, base-reader guarantee, named outcomes", () => {
  let root: string;
  let file: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amicode-hub-cred-"));
    file = join(root, "fleet-hub.json");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("write → read roundtrip carries the version stamp, the mint name, and the credential", () => {
    writeHubCredential({ baseUrl: "http://127.0.0.1:9", token: "tok" }, { env: { AMICO_FLEET_HUB_FILE: file } });
    const raw = JSON.parse(readFileSync(fleetHubFile({ AMICO_FLEET_HUB_FILE: file }), "utf8")) as Record<string, unknown>;
    expect(raw["store_version"]).toBe(1);
    expect(raw["mint"]).toBe("hub");
    const read = readHubCredential({ AMICO_FLEET_HUB_FILE: file });
    expect(read).toEqual({ ok: true, mint: "hub", storeVersion: 1, credential: { baseUrl: "http://127.0.0.1:9", token: "tok" } });
  });

  it("preserves keys it does not understand (base-reader guarantee, never clobbers)", () => {
    writeFileSync(
      file,
      JSON.stringify({ store_version: 1, mint: "hub", base_url: "http://a", token: "t", future_field: { x: 1 } }),
    );
    writeHubCredential({ baseUrl: "http://b", token: "t2" }, { env: { AMICO_FLEET_HUB_FILE: file } });
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(raw["future_field"]).toEqual({ x: 1 });
    expect(raw["base_url"]).toBe("http://b");
  });

  it("a store a base reader could have written (no stamp, unknown keys) still reads — tolerant, never throws", () => {
    writeFileSync(file, JSON.stringify({ base_url: "http://c", token: "t3", mystery: true }));
    const read = readHubCredential({ AMICO_FLEET_HUB_FILE: file });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.credential.baseUrl).toBe("http://c");
      expect(read.storeVersion).toBeUndefined();
    }
  });

  it("a missing credential is a named absent; a malformed one is a named malformed", () => {
    expect(readHubCredential({ AMICO_FLEET_HUB_FILE: join(root, "nope.json") })).toEqual({
      ok: false,
      mint: "hub",
      reason: "absent",
    });
    writeFileSync(file, "{broken");
    const read = readHubCredential({ AMICO_FLEET_HUB_FILE: file });
    expect(read).toMatchObject({ ok: false, mint: "hub", reason: "malformed" });
  });

  it("an incomplete entry (credential fields missing) is named incomplete, never half-present", () => {
    writeFileSync(file, JSON.stringify({ store_version: 1, mint: "hub", base_url: "http://x" }));
    expect(readHubCredential({ AMICO_FLEET_HUB_FILE: file })).toMatchObject({
      ok: false,
      mint: "hub",
      reason: "incomplete",
    });
  });

  it("clear removes the entry; clearing an absent entry is a no-op", () => {
    writeHubCredential({ baseUrl: "http://d", token: "t4" }, { env: { AMICO_FLEET_HUB_FILE: file } });
    clearHubCredential({ AMICO_FLEET_HUB_FILE: file });
    expect(readHubCredential({ AMICO_FLEET_HUB_FILE: file })).toMatchObject({ ok: false, reason: "absent" });
    clearHubCredential({ AMICO_FLEET_HUB_FILE: file });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The currency token (D2's client-side derivation, transport-side form)
// ══════════════════════════════════════════════════════════════════════════════

describe("currency token — derived over what is fetched, tagged with its data source", () => {
  it("changes when the fetched data changes (count/max/sum per source)", () => {
    const a = deriveCurrency([
      { source: "local", present: true, count: 2, max: 7000, sum: 12000, version: "v1" },
      { source: "hub", present: true, count: 2, max: 9000, sum: 17000, version: "v1" },
    ]);
    const b = deriveCurrency([
      { source: "local", present: true, count: 2, max: 7000, sum: 12000, version: "v1" },
      { source: "hub", present: true, count: 3, max: 9500, sum: 18000, version: "v1" },
    ]);
    expect(a.token).not.toBe(b.token);
  });

  it("a token derived over one upstream is never equal to a token over another (the source list is in the hash)", () => {
    const localOnly = deriveCurrency([{ source: "local", present: true, count: 2, max: 7000, sum: 12000, version: "v1" }]);
    const hubOnly = deriveCurrency([{ source: "hub", present: true, count: 2, max: 7000, sum: 12000, version: "v1" }]);
    expect(localOnly.token).not.toBe(hubOnly.token);
    expect(localOnly.sources).toEqual(["local"]);
    expect(hubOnly.sources).toEqual(["hub"]);
  });

  it("an unfetched source contributes nothing to the token", () => {
    const withAbsent = deriveCurrency([
      { source: "local", present: true, count: 1, max: 1, sum: 1, version: "v1" },
      { source: "hub", present: false, reason: "no-upstream" },
    ]);
    const localOnly = deriveCurrency([{ source: "local", present: true, count: 1, max: 1, sum: 1, version: "v1" }]);
    expect(withAbsent.token).toBe(localOnly.token);
    expect(withAbsent.sources).toEqual(["local"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Fleet-wide projection — N-peer, machine-keyed fan-out (#1439)
// ══════════════════════════════════════════════════════════════════════════════

// Mock peer: accepts the peer token via the same Basic auth scheme as the engine
function startMockPeer(sessions: unknown[], peerToken: string): Promise<MockOrigin> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const auth = req.headers.authorization ?? "";
    if (auth !== serverAuthHeader(peerToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
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

describe("fleet-wide projection — N-peer, machine-keyed fan-out (#1439)", () => {
  // ≥3-source fixture: local + 2 reachable peers + 1 unreachable peer = 4 sources
  const STUDIO_SESSIONS = [
    { id: "ses-studio-1", title: "studio session", directory: "/studio/proj", time: { created: 1000, updated: 5000 } },
    { id: "ses-studio-2", title: "another studio", directory: "/studio/proj", time: { created: 1500, updated: 5500 } },
  ];
  const MINI_SESSIONS = [
    { id: "ses-mini-1", title: "mini session", directory: "/mini/proj", time: { created: 2000, updated: 6000 } },
  ];
  const LOCAL_FLEET_SESSIONS = [
    { id: "ses-local-1", title: "local session", directory: "/local/proj", time: { created: 3000, updated: 7000 } },
  ];

  const ROSTER: Record<string, { name: string; device_type?: string }> = {
    "macbook-pro-local": { name: "MacBook Pro", device_type: "laptop" },
    "mac-studio-peer": { name: "Mac Studio", device_type: "desktop" },
    "mac-mini-peer": { name: "Mac Mini", device_type: "server" },
    "unreachable-box": { name: "Unreachable Box", device_type: "server" },
  };
  const rosterLookup = (id: string) => ROSTER[id];

  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let miniPeer: MockOrigin;

  beforeAll(async () => {
    localEngine = await startMockEngine(LOCAL_FLEET_SESSIONS);
    studioPeer = await startMockPeer(STUDIO_SESSIONS, "tok-studio");
    miniPeer = await startMockPeer(MINI_SESSIONS, "tok-mini");
  });

  afterAll(async () => {
    await localEngine.stop();
    await studioPeer.stop();
    await miniPeer.stop();
  });

  function buildOpts(overrides: Partial<Parameters<typeof buildFleetProjection>[0]> = {}) {
    return {
      localMachineId: "macbook-pro-local",
      local: { getUrl: () => localEngine.url, password: "engine-mint-password" },
      peers: [
        { machineId: "mac-studio-peer", getUrl: () => studioPeer.url, token: "tok-studio" },
        { machineId: "mac-mini-peer", getUrl: () => miniPeer.url, token: "tok-mini" },
        { machineId: "unreachable-box", getUrl: () => undefined as string | undefined },
      ],
      rosterLookup,
      ...overrides,
    };
  }

  it("returns sessions from every reachable serving peer (≥3 sources), each tagged with owner", async () => {
    const projection = await buildFleetProjection(buildOpts());

    expect(projection.ok).toBe(true);
    expect(projection.mode).toBe("fleet");
    // 2 studio + 1 mini + 1 local = 4 sessions total
    expect(projection.sessions).toHaveLength(4);

    // Local session tagged with is_local: true
    const localSes = projection.sessions.find((s) => s.id === "ses-local-1");
    expect(localSes).toBeDefined();
    expect(localSes!.amicode_owner).toMatchObject({
      owner_machine_id: "macbook-pro-local",
      owner_name: "MacBook Pro",
      device_type: "laptop",
      directory: "/local/proj",
      is_local: true,
    });

    // Remote studio session tagged with is_local: false
    const studioSes = projection.sessions.find((s) => s.id === "ses-studio-1");
    expect(studioSes).toBeDefined();
    expect(studioSes!.amicode_owner).toMatchObject({
      owner_machine_id: "mac-studio-peer",
      owner_name: "Mac Studio",
      device_type: "desktop",
      directory: "/studio/proj",
      is_local: false,
    });

    // Remote mini session
    const miniSes = projection.sessions.find((s) => s.id === "ses-mini-1");
    expect(miniSes).toBeDefined();
    expect(miniSes!.amicode_owner).toMatchObject({
      owner_machine_id: "mac-mini-peer",
      owner_name: "Mac Mini",
      device_type: "server",
      directory: "/mini/proj",
      is_local: false,
    });
  });

  it("unreachable peer is a named absence — reachable peers still render", async () => {
    const projection = await buildFleetProjection(buildOpts());

    // Unreachable peer: named, not silently dropped
    expect(projection.sources["unreachable-box"]).toBeDefined();
    expect(projection.sources["unreachable-box"].present).toBe(false);
    expect(projection.sources["unreachable-box"].reason).toBe("no-upstream");

    // Reachable peers and local: all present
    expect(projection.sources["macbook-pro-local"].present).toBe(true);
    expect(projection.sources["mac-studio-peer"].present).toBe(true);
    expect(projection.sources["mac-mini-peer"].present).toBe(true);

    // Reachable sessions are in the list
    expect(projection.sessions.some((s) => s.id === "ses-studio-1")).toBe(true);
    expect(projection.sessions.some((s) => s.id === "ses-mini-1")).toBe(true);
    expect(projection.sessions.some((s) => s.id === "ses-local-1")).toBe(true);
  });

  it("currency derives over contributing sources only — unreachable excluded", async () => {
    const projection = await buildFleetProjection(buildOpts());

    const sorted = [...projection.currency.sources].sort();
    expect(sorted).toContain("macbook-pro-local");
    expect(sorted).toContain("mac-studio-peer");
    expect(sorted).toContain("mac-mini-peer");
    expect(sorted).not.toContain("unreachable-box");
    expect(projection.currency.derived_over).toBe("fetched");
  });

  it("roster lookup enriches the owner tag — fallback to machine_id when roster entry is absent", async () => {
    const sparseRoster = (id: string) => {
      if (id === "macbook-pro-local") return { name: "MacBook Pro", device_type: "laptop" as string | undefined };
      return undefined; // no roster entry for peers
    };
    const projection = await buildFleetProjection(buildOpts({ rosterLookup: sparseRoster }));

    // Local session: has roster entry
    const localSes = projection.sessions.find((s) => s.id === "ses-local-1");
    expect(localSes!.amicode_owner!.owner_name).toBe("MacBook Pro");

    // Remote session: no roster entry → falls back to machine_id
    const studioSes = projection.sessions.find((s) => s.id === "ses-studio-1");
    expect(studioSes!.amicode_owner!.owner_name).toBe("mac-studio-peer");
    expect(studioSes!.amicode_owner!.device_type).toBeUndefined();
  });

  it("a peer with revoked credential (unauthorized) is a named absence — reachable peers still render", async () => {
    const projection = await buildFleetProjection(buildOpts({
      peers: [
        { machineId: "mac-studio-peer", getUrl: () => studioPeer.url, token: "tok-studio" },
        { machineId: "mac-mini-peer", getUrl: () => miniPeer.url, token: "WRONG-TOKEN" }, // revoked/wrong
        { machineId: "unreachable-box", getUrl: () => undefined as string | undefined },
      ],
    }));

    // Mini peer: named unauthorized
    expect(projection.sources["mac-mini-peer"].present).toBe(false);
    expect(projection.sources["mac-mini-peer"].reason).toBe("unauthorized");

    // Studio and local still render
    expect(projection.sources["mac-studio-peer"].present).toBe(true);
    expect(projection.sources["macbook-pro-local"].present).toBe(true);
    expect(projection.sessions.some((s) => s.id === "ses-studio-1")).toBe(true);
    expect(projection.sessions.some((s) => s.id === "ses-local-1")).toBe(true);
    expect(projection.sessions.some((s) => s.id === "ses-mini-1")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration: GET /amicode/fleet/sessions returns fleet-wide tagged list (#1439)
// ══════════════════════════════════════════════════════════════════════════════

describe("GET /amicode/fleet/sessions — fleet-wide tagged list via the route (#1439)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let miniPeer: MockOrigin;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;

  const FLEET_LOCAL = [
    { id: "ses-local-x", title: "local work", directory: "/local", time: { created: 100, updated: 200 } },
  ];
  const FLEET_STUDIO = [
    { id: "ses-studio-x", title: "studio work", directory: "/studio", time: { created: 300, updated: 400 } },
  ];
  const FLEET_MINI = [
    { id: "ses-mini-x", title: "mini work", directory: "/mini", time: { created: 500, updated: 600 } },
  ];

  const ROSTER: Record<string, { name: string; device_type?: string }> = {
    "my-macbook": { name: "My MacBook", device_type: "laptop" },
    "the-studio": { name: "The Studio", device_type: "desktop" },
    "the-mini": { name: "The Mini", device_type: "server" },
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-route-1439-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    localEngine = await startMockEngine(FLEET_LOCAL);
    studioPeer = await startMockPeer(FLEET_STUDIO, "tok-studio-route");
    miniPeer = await startMockPeer(FLEET_MINI, "tok-mini-route");
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => "http://127.0.0.1:9" }, // unused — fleetPeers takes over
        getMode: () => "fleet",
        fleetPeers: {
          localMachineId: "my-macbook",
          getServingPeers: () => [{ machineId: "the-studio" }, { machineId: "the-mini" }],
          readPeerToken: (id) => {
            if (id === "the-studio") return { ok: true as const, credential: { baseUrl: studioPeer.url, token: "tok-studio-route" } };
            if (id === "the-mini") return { ok: true as const, credential: { baseUrl: miniPeer.url, token: "tok-mini-route" } };
            return { ok: false as const };
          },
          rosterLookup: (id) => ROSTER[id],
        },
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await localEngine.stop();
    await studioPeer.stop();
    await miniPeer.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("the route returns sessions from all reachable peers, each with amicode_owner tags", async () => {
    const res = await fetch(`${origin}/amicode/fleet/sessions`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetProjection;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("fleet");
    expect(body.sessions).toHaveLength(3);

    // Local session: tagged is_local
    const local = body.sessions.find((s) => s.id === "ses-local-x") as Record<string, unknown> & { amicode_owner?: SessionOwnerTag };
    expect(local).toBeDefined();
    expect(local!.amicode_owner).toMatchObject({
      owner_machine_id: "my-macbook",
      owner_name: "My MacBook",
      device_type: "laptop",
      is_local: true,
    });

    // Remote studio session: tagged is_local: false
    const studio = body.sessions.find((s) => s.id === "ses-studio-x") as Record<string, unknown> & { amicode_owner?: SessionOwnerTag };
    expect(studio).toBeDefined();
    expect(studio!.amicode_owner).toMatchObject({
      owner_machine_id: "the-studio",
      owner_name: "The Studio",
      device_type: "desktop",
      is_local: false,
    });

    // Sources keyed by machine_id, not "local"/"hub"
    expect(body.sources["my-macbook"]).toBeDefined();
    expect(body.sources["my-macbook"].present).toBe(true);
    expect(body.sources["the-studio"].present).toBe(true);
    expect(body.sources["the-mini"].present).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W0 — the production fleet-peer provider (#1446): the roster + reader
// peer-store composed into the 4-method provider object the fleet-sessions
// route (index.ts:474) and the W1 multiplexer both consume — plus its
// projection into the Record<string, PeerTransport> shape. This slice builds
// the provider; it does NOT assign opts.fleet.fleetPeers (that flip is W2,
// #1447), so production stays byte-identical (the AC3 block below pins that).
// ══════════════════════════════════════════════════════════════════════════════

function w0RosterRow(opts: {
  id: string;
  name: string;
  serving: boolean;
  reachable: boolean;
  device_type?: string;
}): RosterRow {
  return {
    machine_id: opts.id,
    name: opts.name,
    server_mode: "fleet",
    capabilities: opts.serving ? ["serving"] : [],
    sshAlias: opts.id,
    transport: "ssh",
    last_report: "2026-09-22T00:00:00Z",
    health: opts.reachable ? "reachable" : "down",
    ...(opts.device_type !== undefined ? { device_type: opts.device_type } : {}),
  };
}

describe("W0 — production fleet-peer provider from roster + peer-store (#1446)", () => {
  let root: string;
  let rosterFile: string;
  let peerStoreFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amicode-w0-provider-"));
    rosterFile = join(root, "roster.json");
    peerStoreFile = join(root, "peer-tokens.json");
    // A REAL roster document on disk — the production default reader parses it
    // (no test stubs in the production path). self + one serving∧reachable peer
    // with a stored token + one serving-but-down peer + one reachable non-server.
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [
          w0RosterRow({ id: "self-mac", name: "My Mac", serving: true, reachable: true, device_type: "laptop" }),
          w0RosterRow({ id: "studio-peer", name: "Mac Studio", serving: true, reachable: true, device_type: "desktop" }),
          w0RosterRow({ id: "mini-peer", name: "Mac Mini", serving: true, reachable: false, device_type: "server" }),
          w0RosterRow({ id: "laptop-peer", name: "Laptop", serving: false, reachable: true }),
        ],
      }),
    );
    // A REAL reader peer-store entry for the studio peer (the production reader).
    writePeerToken("studio-peer", { baseUrl: "http://127.0.0.1:5555", token: "tok-studio" }, { storeFile: peerStoreFile });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("composes the 4-method object from the real roster + real peer-store (no stubs): a serving∧reachable peer with a stored token is yielded by getServingPeers() and its credential by readPeerToken()", () => {
    const provider = buildFleetPeerProvider({ localMachineId: "self-mac", rosterFile, peerStoreFile });

    // localMachineId is the composed provider's own id
    expect(provider.localMachineId).toBe("self-mac");

    // getServingPeers() = serving∧reachable rows, MINUS self, MINUS unreachable,
    // MINUS non-serving — resolved from the real roster on disk.
    const servingIds = provider.getServingPeers().map((p) => p.machineId).sort();
    expect(servingIds).toEqual(["studio-peer"]);

    // readPeerToken() surfaces the studio peer's stored credential (real store).
    const studio = provider.readPeerToken("studio-peer");
    expect(studio.ok).toBe(true);
    if (studio.ok) {
      expect(studio.credential.baseUrl).toBe("http://127.0.0.1:5555");
      expect(studio.credential.token).toBe("tok-studio");
    }
    // a peer with no stored token is a named miss, never a fabricated credential
    expect(provider.readPeerToken("mini-peer").ok).toBe(false);

    // rosterLookup() enriches from the same roster (name + device_type)
    expect(provider.rosterLookup("studio-peer")).toEqual({ name: "Mac Studio", device_type: "desktop" });
    expect(provider.rosterLookup("nobody")).toBeUndefined();
  });

  it("projects the SAME peer set into both production-consumed shapes — getServingPeers() and the Record<string, PeerTransport> map list the same machine_ids", () => {
    const provider = buildFleetPeerProvider({
      localMachineId: "self-mac",
      rosterRows: () => [
        w0RosterRow({ id: "self-mac", name: "My Mac", serving: true, reachable: true }),
        w0RosterRow({ id: "studio-peer", name: "Mac Studio", serving: true, reachable: true }),
        w0RosterRow({ id: "mini-peer", name: "Mac Mini", serving: true, reachable: true }),
        w0RosterRow({ id: "down-peer", name: "Down", serving: true, reachable: false }),
      ],
      readPeerToken: (id) => {
        if (id === "studio-peer") return { ok: true as const, credential: { baseUrl: "http://studio", token: "t-studio" } };
        if (id === "mini-peer") return { ok: true as const, credential: { baseUrl: "http://mini", token: "t-mini" } };
        return { ok: false as const, reason: "absent" as const };
      },
    });

    const servingIds = provider.getServingPeers().map((p) => p.machineId).sort();
    const transports = fleetPeerTransports(provider);
    const transportIds = Object.keys(transports).sort();

    // the two shapes are two VIEWS of the ONE serving-peer set — same ids
    expect(transportIds).toEqual(servingIds);
    expect(servingIds).toEqual(["mini-peer", "studio-peer"]);

    // each transport resolves the peer's late-bound URL + token from that set
    expect(transports["studio-peer"].getUrl()).toBe("http://studio");
    expect(transports["studio-peer"].token).toBe("t-studio");
    expect(transports["mini-peer"].getUrl()).toBe("http://mini");
    expect(transports["mini-peer"].token).toBe("t-mini");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// W2 — the wiring assembler assigns opts.fleet.fleetPeers (#1447): the single
// production flip. W0 (#1446) CONSTRUCTS the provider; W2 assigns it at the
// wiring site (amicode_service_wiring.ts's fleet={...} assembly) so the
// fleet-sessions route takes the N-peer branch (index.ts:474→483) instead of the
// legacy 2-source else (index.ts:489). These tests boot the ACTUAL assembler
// (startAmicodeService) — NOT createAmicodeService with a hand-set fleetPeers —
// so they prove the PRODUCTION wiring assigns the provider (the #1439 route
// describe above, :946-1050, covers the route-level selection with a hand-set
// provider; this covers the assembler that assigns it).
//
// Honesty (issue Constraints & Invariants): these are IN-PROCESS / stub-green —
// the route SELECTS the N-peer builder and fans out to loopback peer origins; a
// REAL cross-machine session is NOT proven here.
// ══════════════════════════════════════════════════════════════════════════════

const w2Sink = () => ({ appendLine: (_l: string) => undefined });

function w2ArmedActivation(opts: { entitledDir: string; overlaySource: string }) {
  return {
    armed: true as const,
    hubUrl: "http://127.0.0.1:9",
    tunnelAlias: "fleet-hub",
    posture: {
      degradedLatencyP95Ms: 3000,
      degradedWindowSamples: 10,
      hubDownConsecutiveNoResponses: 3,
      recoveryConsecutiveHealthy: 2,
    },
    notes: [] as string[],
    entitlements: ["amicissimo"] as string[],
    entitlementConfigDir: opts.entitledDir,
    overlaySource: opts.overlaySource,
  };
}

/** Write a lawful entitled dir + data-plane overlay so the armed activation
 *  actually stages the fleet plane (and thus registers the sessions route). */
function w2StageInputs(root: string): { entitledDir: string; overlaySource: string } {
  const overlaySource = join(root, "overlay-source");
  writeDataPlaneManifest(overlaySource);
  const entitledDir = join(root, "entitled");
  mkdirSync(entitledDir, { recursive: true });
  writeFileSync(join(entitledDir, "entitlements.toml"), `codes = ["amicissimo"]\n`);
  return { entitledDir, overlaySource };
}

describe("W2 — the wiring assembler assigns the N-peer provider (#1447)", () => {
  let root: string;
  let dist: string;
  let stage: { entitledDir: string; overlaySource: string };
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let miniPeer: MockOrigin;
  let boot: AmicodeServiceBoot | undefined;
  let origin: string;
  let engineToken: string;
  const savedEnv: Record<string, string | undefined> = {};

  const W2_LOCAL = [{ id: "ses-w2-local", title: "local", time: { created: 100, updated: 200 } }];
  const W2_STUDIO = [{ id: "ses-w2-studio", title: "studio", time: { created: 300, updated: 400 } }];
  const W2_MINI = [{ id: "ses-w2-mini", title: "mini", time: { created: 500, updated: 600 } }];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-w2-assembler-"));
    dist = buildMockDist(root);
    stage = w2StageInputs(root);

    localEngine = await startMockEngine(W2_LOCAL);
    studioPeer = await startMockPeer(W2_STUDIO, "tok-studio-w2");
    miniPeer = await startMockPeer(W2_MINI, "tok-mini-w2");

    const rosterFile = join(root, "roster.json");
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [
          w0RosterRow({ id: "self-mac", name: "My Mac", serving: true, reachable: true, device_type: "laptop" }),
          w0RosterRow({ id: "studio-peer", name: "Mac Studio", serving: true, reachable: true, device_type: "desktop" }),
          w0RosterRow({ id: "mini-peer", name: "Mac Mini", serving: true, reachable: true, device_type: "server" }),
        ],
      }),
    );
    const peerStoreFile = join(root, "peer-tokens.json");
    writePeerToken("studio-peer", { baseUrl: studioPeer.url, token: "tok-studio-w2" }, { storeFile: peerStoreFile });
    writePeerToken("mini-peer", { baseUrl: miniPeer.url, token: "tok-mini-w2" }, { storeFile: peerStoreFile });

    for (const k of ["AMICO_FLEET_ROSTER_FILE", "AMICO_FLEET_PEER_TOKEN_FILE", "AMICO_FLEET_HUB_FILE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.AMICO_FLEET_ROSTER_FILE = rosterFile;
    process.env.AMICO_FLEET_PEER_TOKEN_FILE = peerStoreFile;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred.json");

    engineToken = serverAuthToken("engine-mint-password");
    boot = await startAmicodeService(w2Sink(), {
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      appDistRoot: dist,
      fleetActivation: w2ArmedActivation(stage),
      localMachineId: "self-mac",
    });
    if (!boot) throw new Error("W2 assembler boot failed");
    origin = boot.url;
  });

  afterAll(async () => {
    await boot?.service.stop();
    await localEngine.stop();
    await studioPeer.stop();
    await miniPeer.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("AC1: booting the assembler with a configured fleet + a ≥3-machine roster serves the N-peer machine-keyed projection (index.ts:474), never the legacy local|hub else", async () => {
    const res = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FleetProjection;
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("fleet");
    // sources keyed by machine_id (the N-peer builder), NEVER the legacy
    // "local"/"hub" pair — the signature proving the ASSEMBLER assigned the provider.
    expect(Object.keys(body.sources).sort()).toEqual(["mini-peer", "self-mac", "studio-peer"]);
    expect(Object.keys(body.sources)).not.toContain("hub");
    // machine-attributed sessions from the local engine + both serving peers.
    expect(body.sources["self-mac"].present).toBe(true);
    expect(body.sources["studio-peer"].present).toBe(true);
    expect(body.sources["mini-peer"].present).toBe(true);
    expect(body.sessions.map((s) => s.id).sort()).toEqual(["ses-w2-local", "ses-w2-mini", "ses-w2-studio"]);
  });

  it("AC3: every session in the assembler-served projection carries its owner machine id (amicode_owner.owner_machine_id)", async () => {
    const res = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
    const body = (await res.json()) as FleetProjection;
    expect(body.sessions.length).toBe(3);
    for (const s of body.sessions) {
      const owner = (s as { amicode_owner?: SessionOwnerTag }).amicode_owner;
      expect(owner).toBeDefined();
      expect(typeof owner!.owner_machine_id).toBe("string");
      expect(owner!.owner_machine_id.length).toBeGreaterThan(0);
    }
    const local = body.sessions.find((s) => s.id === "ses-w2-local") as { amicode_owner?: SessionOwnerTag };
    expect(local.amicode_owner).toMatchObject({ owner_machine_id: "self-mac", owner_name: "My Mac", is_local: true });
    const studio = body.sessions.find((s) => s.id === "ses-w2-studio") as { amicode_owner?: SessionOwnerTag };
    expect(studio.amicode_owner).toMatchObject({ owner_machine_id: "studio-peer", is_local: false });
  });
});

describe("W2 — present-but-empty peers ≠ undefined peers (#1447)", () => {
  let root: string;
  let dist: string;
  let stage: { entitledDir: string; overlaySource: string };
  let localEngine: MockOrigin;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-w2-empty-"));
    dist = buildMockDist(root);
    stage = w2StageInputs(root);
    localEngine = await startMockEngine([{ id: "ses-w2-el", title: "local", time: { created: 1, updated: 2 } }]);
    for (const k of ["AMICO_FLEET_ROSTER_FILE", "AMICO_FLEET_PEER_TOKEN_FILE", "AMICO_FLEET_HUB_FILE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred.json");
    process.env.AMICO_FLEET_PEER_TOKEN_FILE = join(root, "no-peer-tokens.json");
  });

  afterAll(async () => {
    await localEngine.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("AC2: a present provider with ZERO serving peers → the 1-source machine-keyed projection (local only), explicitly NOT the 2-source local|hub shape", async () => {
    // A roster whose ONLY serving∧reachable row is self (excluded from the
    // serving-peer set) → getServingPeers() === [] → the provider is present but
    // EMPTY. The route must still take the N-peer branch (1 source keyed by the
    // local machine_id), never fall back to the legacy 2-source builder.
    const rosterFile = join(root, "roster-empty.json");
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [
          w0RosterRow({ id: "self-mac", name: "My Mac", serving: true, reachable: true }),
          w0RosterRow({ id: "down-peer", name: "Down", serving: true, reachable: false }),
          w0RosterRow({ id: "idle-peer", name: "Idle", serving: false, reachable: true }),
        ],
      }),
    );
    process.env.AMICO_FLEET_ROSTER_FILE = rosterFile;
    const boot = await startAmicodeService(w2Sink(), {
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      appDistRoot: dist,
      fleetActivation: w2ArmedActivation(stage),
      localMachineId: "self-mac",
    });
    if (!boot) throw new Error("W2 empty-peers boot failed");
    try {
      const engineToken = serverAuthToken("engine-mint-password");
      const res = await fetch(`${boot.url}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FleetProjection;
      expect(body.mode).toBe("fleet");
      expect(Object.keys(body.sources)).toEqual(["self-mac"]); // 1-source, machine-keyed
      expect(Object.keys(body.sources).sort()).not.toEqual(["hub", "local"]); // NOT the 2-source shape
    } finally {
      await boot.service.stop();
    }
  });

  it("AC2: fleet armed but NO localMachineId → fleetPeers stays undefined → the legacy 2-source (local|hub) projection (byte-identity holds ONLY here)", async () => {
    // No localMachineId → the assembler cannot build the provider → the route's
    // deps.fleetPeers is undefined → the else-branch (index.ts:489) serves. The
    // "hub"/"local" source keys are the 2-source builder's signature.
    const rosterFile = join(root, "roster-undef.json");
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [w0RosterRow({ id: "studio-peer", name: "Mac Studio", serving: true, reachable: true })],
      }),
    );
    process.env.AMICO_FLEET_ROSTER_FILE = rosterFile;
    const boot = await startAmicodeService(w2Sink(), {
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      appDistRoot: dist,
      fleetActivation: w2ArmedActivation(stage),
      // localMachineId intentionally omitted — the undefined path.
    });
    if (!boot) throw new Error("W2 undefined-peers boot failed");
    try {
      const engineToken = serverAuthToken("engine-mint-password");
      const res = await fetch(`${boot.url}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { mode: string; sources: Record<string, unknown> };
      expect(Object.keys(body.sources).sort()).toEqual(["hub", "local"]); // legacy 2-source
    } finally {
      await boot.service.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #1478 — BASE peer-studio activation (AC1/AC2/AC5): an unentitled INDEPENDENT
// SERVING PEER mounts the base peer-studio OBSERVATION routes
// (/amicode/fleet/status + /amicode/fleet/sessions) WITHOUT an amicissimo
// entitlement and WITHOUT the premium data-plane overlay. Base peer-studio and
// the managed premium overlay are DISTINCT authorities: the routes mount for a
// verified peer through the base authority, and the staging receipt still reads
// entitlement:"absent" (NO entitlement forgery). A no-peer base install and a
// fleet-of-one stay local-only (byte-compatible); a client relay is never
// base-activated (its /amicode/* relay is governed by the attached FleetPlane,
// untouched here → AC5).
//
// SCOPE (Binding Amendment): this slice owns base peer-studio activation ONLY.
// AC3 (production service/engine accept-set parity) and AC4 (headless reboot
// posture) are owned by #1485 / #1487 — deliberately NOT implemented or
// asserted here.
// ══════════════════════════════════════════════════════════════════════════════

describe("#1478 base peer-studio activation — unentitled serving peer (AC1/AC2/AC5)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let engineToken: string;
  let savedHubFile: string | undefined;

  const ROSTER_1478: Record<string, { name: string; device_type?: string }> = {
    "my-macbook": { name: "My MacBook", device_type: "laptop" },
    "the-studio": { name: "The Studio", device_type: "desktop" },
  };

  // A serving-peer provider: one reachable serving peer beyond self.
  function servingPeerProvider() {
    return {
      localMachineId: "my-macbook",
      getServingPeers: () => [{ machineId: "the-studio" }],
      readPeerToken: (id: string) =>
        id === "the-studio"
          ? { ok: true as const, credential: { baseUrl: studioPeer.url, token: "tok-studio-1478" } }
          : { ok: false as const },
      rosterLookup: (id: string) => ROSTER_1478[id],
    };
  }

  // A no-peer provider: fleet-configured but ZERO serving peers beyond self
  // (the no-peer base install / fleet-of-one shape).
  function noPeerProvider() {
    return {
      localMachineId: "my-macbook",
      getServingPeers: () => [] as Array<{ machineId: string }>,
      readPeerToken: () => ({ ok: false as const }),
      rosterLookup: (id: string) => ROSTER_1478[id],
    };
  }

  function bootBase(fleet: Parameters<typeof createAmicodeService>[0]["fleet"]) {
    return createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      shelf: { distRoot: dist },
      fleet,
    });
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1478-base-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource); // present but NEVER read (unentitled)
    localEngine = await startMockEngine([
      { id: "ses-1478-local", title: "local", time: { created: 1, updated: 2 } },
    ]);
    studioPeer = await startMockPeer(
      [{ id: "ses-1478-studio", title: "studio", time: { created: 3, updated: 4 } }],
      "tok-studio-1478",
    );
    engineToken = serverAuthToken("engine-mint-password");
    // Isolate the hub-credential read (status route) from any real machine file.
    savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
  });

  afterAll(async () => {
    await localEngine.stop();
    await studioPeer.stop();
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    rmSync(root, { recursive: true, force: true });
  });

  it("AC1: an unentitled independent serving peer mounts the base peer-studio routes (status + sessions)", async () => {
    const svc = bootBase({
      entitlements: [], // NO amicissimo entitlement
      overlaySource,
      hub: { getUrl: () => undefined }, // a base peer, NOT a premium hub relay
      fleetPeers: servingPeerProvider(),
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(200);
      const sbody = (await status.json()) as { ok: boolean; mode: string };
      expect(sbody.ok).toBe(true);
      // honest routing mode: a base peer has NO hub upstream → engine routing
      // (it never falsely claims fleet hub-routing).
      expect(sbody.mode).toBe("engine");

      const sessions = await fetch(`${o}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(sessions.status).toBe(200);
      const body = (await sessions.json()) as FleetProjection;
      // the N-peer machine-keyed projection — the verified peer is observable
      expect(body.sources["the-studio"].present).toBe(true);
      expect(body.sources["my-macbook"].present).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  it("AC1: a no-peer base install (fleet configured, ZERO serving peers) remains local-only — the peer-studio routes 404", async () => {
    const svc = bootBase({
      entitlements: [],
      overlaySource,
      hub: { getUrl: () => undefined },
      fleetPeers: noPeerProvider(),
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(404);
      const sessions = await fetch(`${o}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(sessions.status).toBe(404);
    } finally {
      await svc.stop();
    }
  });

  it("AC2: the premium overlay is NOT the sole route-mount authority — base routes mount with the entitlement ABSENT (no forgery)", async () => {
    const svc = bootBase({
      entitlements: [],
      overlaySource,
      hub: { getUrl: () => undefined },
      fleetPeers: servingPeerProvider(),
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(200);
      const sbody = (await status.json()) as { staging: { entitlement: string; staged: boolean } };
      // the base authority mounted the routes WITHOUT an entitlement — the
      // staging receipt honestly reports absent / not-staged (no forged flag).
      expect(sbody.staging.entitlement).toBe("absent");
      expect(sbody.staging.staged).toBe(false);
    } finally {
      await svc.stop();
    }
  });

  it("AC2: the premium overlay remains ADDITIVE — an entitled boot still mounts the peer-studio routes (a second, coexisting authority)", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => undefined },
        getMode: () => "fleet",
      },
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(200);
      const sbody = (await status.json()) as { staging: { entitlement: string; staged: boolean } };
      expect(sbody.staging.entitlement).toBe("present");
      expect(sbody.staging.staged).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  it("AC5: a client relay is never base-activated — its /amicode/fleet/* honesty surface stays local (404 unentitled), relay behavior unchanged", async () => {
    const svc = bootBase({
      entitlements: [],
      overlaySource,
      client: true, // a fleet CLIENT (no-local-engine relay)
      hub: { getUrl: () => undefined },
      fleetPeers: servingPeerProvider(), // even WITH serving peers…
    });
    const o = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // base activation must NOT fire for a client — the route stays a local 404
      // (byte-compatible with today; a client's relay is governed by the
      // attached FleetPlane, which base activation never attaches).
      const status = await fetch(`${o}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(404);
    } finally {
      await svc.stop();
    }
  });
});

describe("#1478 base peer-studio activation — the real wiring seam (AC1 production path)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let unentitledDir: string;
  let localEngine: MockOrigin;
  let studioPeer: MockOrigin;
  let engineToken: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1478-wiring-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    // an UNENTITLED entitlements dir (no amicissimo) — the base peer path
    unentitledDir = join(root, "unentitled");
    mkdirSync(unentitledDir, { recursive: true });
    writeFileSync(join(unentitledDir, "entitlements.toml"), `codes = []\n`);

    localEngine = await startMockEngine([{ id: "ses-w-local", title: "local", time: { created: 1, updated: 2 } }]);
    studioPeer = await startMockPeer(
      [{ id: "ses-w-studio", title: "studio", time: { created: 3, updated: 4 } }],
      "tok-studio-wire",
    );

    const rosterFile = join(root, "roster.json");
    writeFileSync(
      rosterFile,
      JSON.stringify({
        schema_version: 1,
        rows: [
          w0RosterRow({ id: "self-mac", name: "My Mac", serving: true, reachable: true, device_type: "laptop" }),
          w0RosterRow({ id: "studio-peer", name: "Mac Studio", serving: true, reachable: true, device_type: "desktop" }),
        ],
      }),
    );
    const peerStoreFile = join(root, "peer-tokens.json");
    writePeerToken("studio-peer", { baseUrl: studioPeer.url, token: "tok-studio-wire" }, { storeFile: peerStoreFile });

    for (const k of ["AMICO_FLEET_ROSTER_FILE", "AMICO_FLEET_PEER_TOKEN_FILE", "AMICO_FLEET_HUB_FILE"]) {
      savedEnv[k] = process.env[k];
    }
    process.env.AMICO_FLEET_ROSTER_FILE = rosterFile;
    process.env.AMICO_FLEET_PEER_TOKEN_FILE = peerStoreFile;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");

    engineToken = serverAuthToken("engine-mint-password");
  });

  afterAll(async () => {
    await localEngine.stop();
    await studioPeer.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("AC1 (production): an unentitled armed activation + localMachineId + a serving-peer roster mounts the base peer-studio routes, entitlement ABSENT", async () => {
    const activation: FleetActivation = {
      armed: true,
      hubUrl: "http://127.0.0.1:9",
      tunnelAlias: "fleet-hub",
      posture: {
        degradedLatencyP95Ms: 3000,
        degradedWindowSamples: 10,
        hubDownConsecutiveNoResponses: 3,
        recoveryConsecutiveHealthy: 2,
      },
      notes: [],
      entitlements: [],
      entitlementConfigDir: unentitledDir,
      overlaySource,
    };
    const boot = await startAmicodeService(
      { appendLine: () => undefined },
      {
        engine: { password: "engine-mint-password", getUrl: () => localEngine.url },
        appDistRoot: dist,
        fleetActivation: activation,
        localMachineId: "self-mac",
      },
    );
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      const status = await fetch(`${boot.url}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(status.status).toBe(200);
      const sbody = (await status.json()) as { ok: boolean; staging: { entitlement: string; staged: boolean } };
      expect(sbody.ok).toBe(true);
      // no forgery through the REAL wiring — the receipt reads entitlement absent
      expect(sbody.staging.entitlement).toBe("absent");
      expect(sbody.staging.staged).toBe(false);

      const sessions = await fetch(`${boot.url}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(sessions.status).toBe(200);
      const body = (await sessions.json()) as FleetProjection;
      expect(body.sources["studio-peer"].present).toBe(true);
    } finally {
      await boot.service.stop();
    }
  });
});
