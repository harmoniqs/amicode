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
  stop(): Promise<void>;
}
function startStubHost(sessions: unknown[], hubPassword: string): Promise<StubHost> {
  const requests: string[] = [];
  const authSeen: string[] = [];
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
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, authSeen, stop: () => new Promise((r) => server.close(() => r())) });
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
});
