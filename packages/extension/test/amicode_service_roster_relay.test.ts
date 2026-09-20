// amicode_service_roster_relay.test.ts — #1318 (ADR 0026), AC4: a fleet CLIENT
// reaches the HOST's authoritative fleet-wide roster through the /amicode/*→host
// proxy (#1262) and receives it BYTE-IDENTICALLY.
//
// This is the "/amicode/* proxy relay test" pattern (fleet_client_relay.test.ts)
// pointed at the SHARED stub host (test/support/stub_hub.ts), which the Testing
// Decisions extend with a GET /amicode/roster route. The proof has two parts:
//   1. byte-identity — the bytes the client receives equal the bytes the stub
//      emitted (the relay streams the host body through, never re-serializes);
//   2. provenance — the seeded roster's rows could only have come from the HOST
//      (the client holds NO local roster), and the stub actually saw the GET.
// Deliberately NOT /amicode/fleet/* — that prefix stays local (the client's own
// honesty surface); /amicode/roster IS proxied, which is the whole point.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import { writeHubCredential } from "../src/amicode_service/hub_credential";
import { startStubHub, type StubHub } from "./support/stub_hub";

// A realistic fleet-wide roster (two machines) the HOST owns and serves.
const HOST_ROSTER = {
  schema_version: 1,
  rows: [
    {
      machine_id: "mac-studio-01",
      name: "Studio",
      server_mode: "server",
      capabilities: ["compute"],
      sshAlias: "studio",
      transport: "tailscale",
      last_report: "2026-09-20T10:00:00Z",
      health: "reachable",
    },
    {
      machine_id: "macbook-02",
      name: "MacBook",
      server_mode: "client",
      capabilities: ["roaming", "gpu-box-3090"],
      sshAlias: "macbook",
      transport: "ssh",
      last_report: "2026-09-20T11:00:00Z",
      health: "degraded",
    },
  ],
};

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root></div></body></html>");
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

const SERVICE_PASSWORD = "client-service-mint";
const HUB_PASSWORD = "host-ops-credential";

describe("#1318 AC4 — a fleet client receives the HOST's roster byte-identically through the proxy", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let host: StubHub;
  let serviceToken: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-roster-relay-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    host = await startStubHub({ roster: HOST_ROSTER });
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    serviceToken = serverAuthToken(SERVICE_PASSWORD);
  });

  afterAll(async () => {
    await host.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  function bootClientRelay() {
    return createAmicodeService({
      password: SERVICE_PASSWORD,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => host.url },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 400,
      },
    });
  }

  it("GET /amicode/roster through the relay returns the HOST's roster, byte-identical to what the stub serves", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const seenBefore = host.requests.filter((r) => r.startsWith("GET /amicode/roster")).length;
    try {
      // through the relay (the client mint is translated to the hub mint at the hop)
      const viaRelay = await fetch(`${origin}/amicode/roster?auth_token=${encodeURIComponent(serviceToken)}`);
      expect(viaRelay.status).toBe(200);
      const relayText = await viaRelay.text();
      // provenance: the relay GET reached the HOST (measured BEFORE the direct
      // ground-truth fetch below, which would otherwise also increment the count)
      const seenAfterRelay = host.requests.filter((r) => r.startsWith("GET /amicode/roster")).length;
      expect(seenAfterRelay).toBe(seenBefore + 1); // the host served the proxied GET (not a local fabrication)

      // directly from the stub — the ground-truth bytes the host emitted
      const direct = await fetch(`${host.url}/amicode/roster`);
      const directText = await direct.text();

      // (1) byte-identity: the relay streamed the host body through untouched
      expect(relayText).toBe(directText);
      // (2) the roster is the HOST's, carried whole
      expect(JSON.parse(relayText)).toEqual(HOST_ROSTER);
    } finally {
      await svc.stop();
    }
  });

  it("the client holds NO local roster of its own — the rows it returns can ONLY be the host's", async () => {
    // The client was booted with no AMICO_FLEET_ROSTER_FILE seeded to these ids,
    // so a locally-served /amicode/roster would carry an EMPTY rows[]. Receiving
    // the two host machine_ids proves the proxy carried the host's state.
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/amicode/roster`, { headers: { Authorization: serverAuthHeader(SERVICE_PASSWORD) } });
      const body = (await res.json()) as { rows: Array<{ machine_id: string }> };
      const ids = body.rows.map((r) => r.machine_id).sort();
      expect(ids).toEqual(["mac-studio-01", "macbook-02"]);
    } finally {
      await svc.stop();
    }
  });
});
