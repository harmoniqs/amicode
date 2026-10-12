// fleet_reattach.test.ts — #1261 (Slice 1) AC5: reload-tolerant reattach.
//
// #792 Amendment B worried an extension-host relay would CHURN its SSE
// upstreams on every window reload (a hub connection storm). The answer is the
// lazy 1:1 pass-through: the relay opens exactly ONE host upstream per client
// stream and TEARS IT DOWN when the client disconnects. So N window reloads
// re-join each endpoint ONCE per reload — never accumulating N× concurrent
// upstreams.
//
// This pins that: a long-lived stream is opened through the relay and then the
// client is aborted (a reload closing its stream), N times. The host must never
// see more than ONE concurrent upstream, and must see exactly N total joins —
// each torn down before the next (not 2N, not an accumulating storm). A
// client-initiated abort must NOT count as a hub no-response (it must not
// falsely drive the hub-down posture).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";

// ── a stub HOST with a long-lived /event stream that TRACKS concurrency ──────
interface StreamHost {
  url: string;
  maxConcurrent: number;
  totalConnections: number;
  openNow(): number;
  stop(): Promise<void>;
}
function startStreamHost(hubPassword: string): Promise<StreamHost> {
  let open = 0;
  let maxConcurrent = 0;
  let total = 0;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== hubUpstreamAuthHeader(hubPassword)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/event")) {
      open++;
      total++;
      maxConcurrent = Math.max(maxConcurrent, open);
      const done = () => {
        open = Math.max(0, open - 1);
      };
      res.on("close", done);
      // SSE-like: send headers + a chunk, then hold the stream open forever
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      return; // never ends — the client (or the relay teardown) closes it
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get maxConcurrent() {
          return maxConcurrent;
        },
        get totalConnections() {
          return total;
        },
        openNow: () => open,
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const HUB_PASSWORD = "host-ops-credential";
const SERVICE_PASSWORD = "client-service-mint";

describe("reload-tolerant reattach (#1261 AC5) — exactly-once upstream re-join", () => {
  let root: string;
  let overlaySource: string;
  let hubFile: string;
  let host: StreamHost;
  let serviceToken: string;
  let svc: ReturnType<typeof createAmicodeService>;
  let origin: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-reattach-"));
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    host = await startStreamHost(HUB_PASSWORD);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    serviceToken = serverAuthToken(SERVICE_PASSWORD);
    svc = createAmicodeService({
      password: SERVICE_PASSWORD,
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => host.url },
        getMode: () => "fleet",
      },
    });
    origin = (await svc.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await svc.stop();
    await host.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("N window reloads re-join the host ONCE each — never an accumulating connection storm", async () => {
    const RELOADS = 4;
    for (let i = 0; i < RELOADS; i++) {
      const ctrl = new AbortController();
      const res = await fetch(`${origin}/event?auth_token=${encodeURIComponent(serviceToken)}`, { signal: ctrl.signal });
      expect(res.status).toBe(200);
      // read one chunk so the upstream is definitely established
      const reader = res.body!.getReader();
      await reader.read();
      await waitFor(() => host.openNow() >= 1); // the relay opened exactly one upstream
      // the window reloads: the client stream closes
      await reader.cancel().catch(() => undefined);
      ctrl.abort();
      // the relay must TEAR DOWN the upstream — concurrency drops back to 0
      await waitFor(() => host.openNow() === 0);
    }
    // exactly-once: N reloads → N joins, each torn down before the next
    expect(host.totalConnections).toBe(RELOADS);
    expect(host.maxConcurrent).toBe(1); // never 2×, never an accumulating storm
  });

  it("a client-initiated abort does NOT count as a hub no-response (never falsely drives hub-down)", async () => {
    // After the reload storm above, the posture must still be fleet — the
    // client aborts were reloads, not hub failures.
    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${serviceToken}` },
    });
    const body = (await status.json()) as { posture: { state: string; no_response_streak: number } };
    expect(body.posture.state).toBe("fleet");
    expect(body.posture.no_response_streak).toBe(0);
  });
});
