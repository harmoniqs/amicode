// fleet_client_relay.test.ts — #1261 (Slice 1): the fleet-client relay skeleton.
//
// A fleet CLIENT runs the extension-host amicode_service as a RELAY: it serves
// the UI shelf LOCALLY and reverse-proxies the engine data plane to the HOST
// over the tunnel, translating the credential at the hop. Crucially a client
// holds NO local engine (never-fork, ADR 0005) — so the relay is configured
// with `client: true` and NO `engine` option.
//
// This pins the client-specific behavior Slice 1 adds on top of the existing
// #391/#392 data plane:
//   AC1 — UI served locally (zero assets cross the WAN); host sessions listed
//         via the proxied engine data plane.
//   AC2 — the credential is TRANSLATED (client mint stripped, hub mint attached
//         from fleet-hub.json); the webview never holds the host credential.
//   AC6 — HONEST hub-down: with the host unreachable the relay emits its OWN
//         named hub-down 503 (never "engine upstream not available" — there is
//         no local engine) and NEVER flips standalone→engine for a client.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";

// ── a stub HOST (the far end of the tunnel — an opencode server expecting its
//    OWN hub mint; it 401s anything else, so a 200 proves the translation) ────
interface StubHost {
  url: string;
  requests: string[];
  authSeen: string[];
  /** #1262: the /amicode/* mutations the host RECEIVED (path + verbatim body)
   *  — the "the mutation landed on the host" evidence. */
  amicodePosts: { path: string; body: string }[];
  stop(): Promise<void>;
}
/** #1262: the sentinel a proxied /amicode/* GET returns — a value the client's
 *  OWN local amicode_service handlers never emit, so its presence PROVES the
 *  response came from the host, not the client's local ~/.amico. */
const HOST_AMICODE_MARKER = "HOST-OWNS-AMICODE-STATE";
function startStubHost(sessions: unknown[], hubPassword: string): Promise<StubHost> {
  const requests: string[] = [];
  const authSeen: string[] = [];
  const amicodePosts: { path: string; body: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    authSeen.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== hubUpstreamAuthHeader(hubPassword)) {
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
    // #1262: the HOST's authoritative /amicode/* surface. A GET returns the
    // host sentinel; a POST (a mutation) is RECORDED whole and accepted — the
    // host binds loopback, so its own mutation guard passes (the SSH mesh is
    // the client→host boundary, per ADR 0024).
    if (req.method === "GET" && req.url?.startsWith("/amicode/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, host_marker: HOST_AMICODE_MARKER, path: req.url }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/amicode/")) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        amicodePosts.push({ path: req.url!, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, host_marker: HOST_AMICODE_MARKER, accepted: req.url }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, authSeen, amicodePosts, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>amicode</title></head><body><div id=root></div></body></html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app bundle');\n");
  return dist;
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
            { name: "upstream_mode", base_default: "engine" },
            { name: "hub_upstream", base_default: null },
            { name: "hub_credential_entry", base_default: null },
            { name: "merged_projection", base_default: null },
          ],
        },
      ],
    }),
  );
}

const HOST_SESSIONS = [
  { id: "ses-host-1", title: "host one", time: { created: 3000, updated: 9000 } },
  { id: "ses-host-2", title: "host two", time: { created: 4000, updated: 9500 } },
];
const HUB_PASSWORD = "host-ops-credential";
const SERVICE_PASSWORD = "client-service-mint";

describe("fleet-client relay skeleton (#1261) — a client holds NO local engine", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let host: StubHost;
  let serviceToken: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-client-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    host = await startStubHost(HOST_SESSIONS, HUB_PASSWORD);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    serviceToken = serverAuthToken(SERVICE_PASSWORD);
  });

  afterAll(async () => {
    await host.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  /** The client relay: fleet mode, NO engine (never-fork), hub → the host. */
  function bootClientRelay(hubUrl: () => string | undefined) {
    return createAmicodeService({
      password: SERVICE_PASSWORD,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: hubUrl },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 400,
      },
    });
  }

  it("AC1 — the UI shelf serves LOCALLY (zero assets cross to the host)", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const hostBefore = host.requests.length;
    try {
      const asset = await fetch(`${origin}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("app bundle");
      const doc = await fetch(`${origin}/?auth_token=${encodeURIComponent(serviceToken)}`, { headers: { Accept: "text/html" } });
      expect(doc.status).toBe(200);
      expect(await doc.text()).toContain("<div id=root>");
      expect(host.requests.length).toBe(hostBefore); // the host saw NONE of the UI
    } finally {
      await svc.stop();
    }
  });

  it("AC1 — host sessions list via the proxied engine data plane", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/session?auth_token=${encodeURIComponent(serviceToken)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.some((s) => s.id === "ses-host-1")).toBe(true);
      expect(body.some((s) => s.id === "ses-host-2")).toBe(true);
      expect(host.requests.some((r) => r.startsWith("GET /session"))).toBe(true);
    } finally {
      await svc.stop();
    }
  });

  it("AC2 — the credential is TRANSLATED: the host sees the HUB mint, never the client's service mint", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/session`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      expect(res.status).toBe(200); // the host 401s anything but the hub mint → a 200 proves translation
      const hubAuth = hubUpstreamAuthHeader(HUB_PASSWORD);
      const serviceAuth = serverAuthHeader(SERVICE_PASSWORD);
      const sessionAuths = host.authSeen.filter((_, i) => host.requests[i].startsWith("GET /session"));
      expect(sessionAuths.every((a) => a === hubAuth)).toBe(true); // every proxied call carried the hub mint
      expect(sessionAuths.some((a) => a === serviceAuth)).toBe(false); // the client's own mint NEVER crossed
    } finally {
      await svc.stop();
    }
  });

  it("AC6 — host unreachable → the relay's OWN named hub-down 503, never \"engine upstream not available\"", async () => {
    const svc = bootClientRelay(() => undefined); // no upstream bound (tunnel down)
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/session`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: string; pointer?: string };
      expect(body.error).toBe("fleet-hub-down");
      expect(body.error).not.toBe("engine upstream not available"); // there is NO local engine on a client
      expect(body.pointer).toBeTruthy(); // honest, recoverable — carries a pointer
    } finally {
      await svc.stop();
    }
  });

  it("AC6 — a client NEVER flips standalone→engine: mode stays fleet even in the hub-down posture", async () => {
    const svc = bootClientRelay(() => undefined);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // drive the posture to standalone (N=2 no-responses tuned above)
      for (let i = 0; i < 3; i++) {
        await fetch(`${origin}/session`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      }
      const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      const body = (await status.json()) as { mode: string; posture: { state: string } };
      expect(body.posture.state).toBe("standalone"); // the posture DID reach hub-down
      expect(body.mode).toBe("fleet"); // …but the client never flips to the (nonexistent) engine
    } finally {
      await svc.stop();
    }
  });

  // ── #1262: the HOST owns all /amicode/* state; a fleet client PROXIES it ────
  // Slice 1 (#1261) proxied only the ENGINE data plane; /amicode/* was still
  // served LOCALLY by the client's own amicode_service (a REGISTERED route hits
  // the exact-match table before the fleet branch). These pin the bypass: in
  // fleet-client mode the ENTIRE local /amicode/* dispatch (exact-match table +
  // catch-all) is skipped and the request routes to the host.

  it("#1262 AC1 — a REGISTERED /amicode/* GET returns the HOST's state (the exact-match table no longer shadows the proxy)", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const seen = () => host.requests.filter((r) => r === "GET /amicode/profile").length;
    const before = seen();
    try {
      // GET /amicode/profile is a REGISTERED route (registerProfileRoutes) — pre
      // fix it is served LOCALLY (never carries the host marker). Post fix it
      // proxies to the host, which answers the sentinel a local handler cannot.
      const res = await fetch(`${origin}/amicode/profile?auth_token=${encodeURIComponent(serviceToken)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; host_marker?: string };
      expect(body.host_marker).toBe(HOST_AMICODE_MARKER); // came from the HOST, not local ~/.amico
      expect(seen()).toBe(before + 1); // the host actually served the registered route
    } finally {
      await svc.stop();
    }
  });

  it("#1262 AC1 — the client's OWN /amicode/fleet/* honesty surface stays LOCAL (never proxied)", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; mode: string; host_marker?: string };
      expect(body.mode).toBe("fleet"); // the client's LOCAL fleet-plane status
      expect(body.host_marker).toBeUndefined(); // NOT the proxied host sentinel — this surface is local
      expect(host.requests.some((r) => r.startsWith("GET /amicode/fleet"))).toBe(false); // the host never saw it
    } finally {
      await svc.stop();
    }
  });

  it("#1262 AC2 — a MUTATION (POST /amicode/solver-mode) lands on the host, is ACCEPTED, and carries the TRANSLATED hub mint", async () => {
    const svc = bootClientRelay(() => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // The host binds loopback → its own mutation guard passes (the SSH mesh
      // is the client→host boundary, ADR 0024). A 200 proves the write LANDED
      // AND was accepted; the host 401s anything but the hub mint, so it also
      // proves credential translation on the write path.
      const res = await fetch(`${origin}/amicode/solver-mode`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD), "content-type": "application/json" },
        body: JSON.stringify({ mode: "piccolo" }),
      });
      expect(res.status).toBe(200); // delivered + accepted by the host
      const landed = host.amicodePosts.find((p) => p.path === "/amicode/solver-mode");
      expect(landed).toBeTruthy(); // the mutation reached the HOST, not the client's local store
      expect(JSON.parse(landed!.body)).toEqual({ mode: "piccolo" }); // the whole body, intact
      // the write crossed with the HUB mint — the client's own service mint NEVER did
      const postAuths = host.authSeen.filter((_, i) => host.requests[i] === "POST /amicode/solver-mode");
      expect(postAuths.length).toBeGreaterThan(0);
      expect(postAuths.every((a) => a === hubUpstreamAuthHeader(HUB_PASSWORD))).toBe(true);
      expect(postAuths.some((a) => a === serverAuthHeader(SERVICE_PASSWORD))).toBe(false);
    } finally {
      await svc.stop();
    }
  });

  it("#1262 AC5 — STANDALONE (non-fleet) is unchanged: /amicode/* is still served LOCALLY", async () => {
    // No fleet block → no fleet plane → shouldProxyAmicodeToHost is false: the
    // exact-match table serves /amicode/profile locally, byte-identically.
    const svc = createAmicodeService({ password: SERVICE_PASSWORD, shelf: { distRoot: dist } });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const hostBefore = host.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/profile?auth_token=${encodeURIComponent(serviceToken)}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; host_marker?: string };
      expect(body.ok).toBe(true); // the LOCAL handler's shape
      expect(body.host_marker).toBeUndefined(); // never the host sentinel — served locally
      expect(host.requests.length).toBe(hostBefore); // the host saw NOTHING
    } finally {
      await svc.stop();
    }
  });
});
