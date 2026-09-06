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
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import {
  fleetHubFile,
  readHubCredential,
  writeHubCredential,
  clearHubCredential,
  hubUpstreamAuthHeader,
} from "../src/amicode_service/hub_credential";
import { deriveCurrency } from "../src/amicode_service/merged_projection";
import { stageFleetDataPlane } from "../src/amicode_service/fleet_staging";

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
