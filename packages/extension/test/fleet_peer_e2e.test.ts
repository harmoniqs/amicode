// fleet_peer_e2e.test.ts — #1383: real-SSH two-engine e2e test — AC2/AC3 proof,
// CI-gated.
//
// This integration test proves the full end-to-end path: two distinct mock
// engines → a real `ssh -L` forward to the "peer" engine → the
// AmicodeServiceServer's D3 resolver routing engine requests to the peer
// (through the SSH tunnel) and /amicode/roster requests to the keeper (direct).
//
// What this proves beyond the unit tests (fleet_client_relay,
// attachment_pointer): those prove the resolver in isolation. This proves
// the full dispatch path: attach → traffic lands on the peer's engine over
// real SSH — distinct from the local engine.
//
// CI-gated (AC5): runs in the main test suite (`pnpm --filter amicode test`),
// not behind an opt-in env var. Gated on the same loopback-SSH readiness probe
// as the Slice-3/Slice-4 harnesses: when no loopback sshd is reachable, the
// suite `describe.skip`s — never a fabricated pass.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../src/amicode_service/credentials";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthHeader } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import { writeKeeperPointerFile } from "../src/amicode_service/keeper_pointer";
import { writeAttachmentPointerFile } from "../src/amicode_service/attachment_pointer";
import {
  bringUpSshAttachment,
  type AttachmentTransportHandle,
} from "../src/amicode_service/attachment_transport";

// ── SSH readiness probe (module scope) — identical to the Slice-3/Slice-4
//    harnesses (attachment_transport, attach_switch_latency). A loopback sshd
//    the current OS user can authenticate to: zero-mutation identity first,
//    else a throwaway ed25519 key installed and verified (rolled back on every
//    run). When NOT ready, the entire describe.skip's — never a fabricated pass.
const AUTHORIZED_KEYS_PATH = join(homedir(), ".ssh", "authorized_keys");

interface SshReadiness {
  ready: boolean;
  reason?: string;
  identityArgs: string[];
  throwaway?: { keyDir: string; originalAuthorizedKeys: string };
}

function sshProbeBaseArgs(): string[] {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];
}

function canConnectLoopback(identityArgs: readonly string[]): boolean {
  try {
    execFileSync("ssh", [...sshProbeBaseArgs(), ...identityArgs, "127.0.0.1", "true"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const SSH_READY: SshReadiness = (() => {
  if (canConnectLoopback([])) return { ready: true, identityArgs: [] };
  let tmpDir: string | undefined;
  let originalAuthorizedKeys: string | undefined;
  try {
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-peer-e2e-sshkey-"));
    const keyPath = join(tmpDir, "id_peer_e2e_test");
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", `amicode-peer-e2e-test-${process.pid}`, "-f", keyPath],
      { stdio: "ignore", timeout: 10_000 },
    );
    const pubKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
    originalAuthorizedKeys = existsSync(AUTHORIZED_KEYS_PATH) ? readFileSync(AUTHORIZED_KEYS_PATH, "utf8") : "";
    const sep = originalAuthorizedKeys === "" || originalAuthorizedKeys.endsWith("\n") ? "" : "\n";
    atomicWriteFileSync(AUTHORIZED_KEYS_PATH, `${originalAuthorizedKeys}${sep}${pubKey}\n`);
    const identityArgs = ["-i", keyPath, "-o", "IdentitiesOnly=yes"];
    if (canConnectLoopback(identityArgs)) {
      return { ready: true, identityArgs, throwaway: { keyDir: tmpDir, originalAuthorizedKeys } };
    }
    atomicWriteFileSync(AUTHORIZED_KEYS_PATH, originalAuthorizedKeys);
    rmSync(tmpDir, { recursive: true, force: true });
    return { ready: false, identityArgs: [], reason: "installed a throwaway key but the connection still failed" };
  } catch (e) {
    if (originalAuthorizedKeys !== undefined) {
      try { atomicWriteFileSync(AUTHORIZED_KEYS_PATH, originalAuthorizedKeys); } catch { /* best-effort */ }
    }
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    return { ready: false, identityArgs: [], reason: `loopback ssh probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
})();

if (!SSH_READY.ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[fleet_peer_e2e.test.ts] SKIPPING the real-SSH two-engine e2e suite: ${SSH_READY.reason ?? "no loopback ssh access"}. ` +
      "This is an HONEST skip, not a fabricated pass.",
  );
}

// ── mock engine factory ─────────────────────────────────────────────────────
// Two lightweight HTTP servers that return a DISTINCT marker in every
// authenticated response. The marker is the proof: a response carrying
// PEER_MARKER came through the SSH tunnel to the peer engine; one carrying
// KEEPER_MARKER hit the keeper engine directly — no local handler can produce
// either, so the marker IS the routing proof.
const PEER_MARKER = "peer-engine-e2e-1383";
const KEEPER_MARKER = "keeper-engine-e2e-1383";

interface MockEngine {
  url: string;
  port: number;
  marker: string;
  requests: string[];
  stop(): Promise<void>;
}

function startMockEngine(marker: string, hubPassword: string): Promise<MockEngine> {
  const requests: string[] = [];
  const expectedAuth = hubUpstreamAuthHeader(hubPassword);
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        marker,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function pickFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head></head><body></body></html>");
  writeFileSync(join(dist, "assets", "app.js"), "// mock\n");
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

/** p95 by nearest-rank over a copy of the samples (ascending). */
function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * s.length);
  return s[Math.min(rank, s.length) - 1];
}

// ── constants ───────────────────────────────────────────────────────────────
const HUB_PASSWORD = "e2e-hub-credential-1383";
const SERVICE_PASSWORD = "e2e-service-mint-1383";

// ── the suite ───────────────────────────────────────────────────────────────
describe.skipIf(!SSH_READY.ready)(
  "fleet peer e2e — two engines, real SSH, D3 resolver (#1383: AC2/AC3 proof, CI-gated)",
  () => {
    let root: string;
    let dist: string;
    let overlaySource: string;
    let hubFile: string;
    let keeperFile: string;
    let attachmentFile: string;
    let peer: MockEngine;
    let keeper: MockEngine;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "amicode-peer-e2e-"));
      dist = buildMockDist(root);
      overlaySource = join(root, "overlay-source");
      writeDataPlaneManifest(overlaySource);

      // Pointer + credential files in the temp dir
      hubFile = join(root, "fleet-hub.json");
      keeperFile = join(root, "keeper.json");
      attachmentFile = join(root, "attachment.json");

      // Save and override env vars so the resolver reads OUR temp pointer files
      for (const k of ["AMICO_FLEET_HUB_FILE", "AMICO_FLEET_KEEPER_FILE", "AMICO_FLEET_ATTACHMENT_FILE"]) {
        savedEnv[k] = process.env[k];
      }
      process.env.AMICO_FLEET_HUB_FILE = hubFile;
      process.env.AMICO_FLEET_KEEPER_FILE = keeperFile;
      process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;

      // Start the two mock engines on distinct ports
      peer = await startMockEngine(PEER_MARKER, HUB_PASSWORD);
      keeper = await startMockEngine(KEEPER_MARKER, HUB_PASSWORD);

      // Write hub credential (the HubProxy reads this per-request for auth translation)
      writeHubCredential(
        { baseUrl: peer.url, token: HUB_PASSWORD },
        { env: { AMICO_FLEET_HUB_FILE: hubFile } },
      );

      // Write pointer files (the D3 resolver reads these per-request)
      writeAttachmentPointerFile(
        { sshAlias: `${userInfo().username}@127.0.0.1`, transport: "ssh", machine_id: "peer-e2e" },
        { attachmentFile },
      );
      writeKeeperPointerFile(
        { sshAlias: "keeper-alias", transport: "ssh" },
        { keeperFile },
      );
    }, 30_000);

    afterAll(async () => {
      await peer?.stop();
      await keeper?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(root, { recursive: true, force: true });
      if (SSH_READY.throwaway) {
        atomicWriteFileSync(AUTHORIZED_KEYS_PATH, SSH_READY.throwaway.originalAuthorizedKeys);
        rmSync(SSH_READY.throwaway.keyDir, { recursive: true, force: true });
      }
    });

    /** Bring up a real `ssh -L` forward from a random local port to the peer
     *  engine's port — the FULL path the production per-attachment transport
     *  uses. Returns the handle (whose `localUrl` is the loopback entry to the
     *  tunnel) and the allocated local port. */
    async function bringUpPeerForward(): Promise<AttachmentTransportHandle> {
      const localPort = await pickFreeLoopbackPort();
      return bringUpSshAttachment({
        target: {
          sshAlias: `${userInfo().username}@127.0.0.1`,
          transport: "ssh",
          machine_id: "peer-e2e",
        },
        remotePort: peer.port,
        localPort,
        extraSshOptions: [...sshProbeBaseArgs(), ...SSH_READY.identityArgs],
      });
    }

    /** Boot an AmicodeServiceServer wired as a peer relay:
     *  - engine-armed (non-client), fleet mode
     *  - attached → the SSH forward's loopback URL
     *  - keeper → the keeper engine's direct URL
     *  The service's dispatch() reads the D3 resolver per-request, which reads
     *  the pointer files we wrote in beforeAll. */
    function bootPeerService(sshUrl: string) {
      return createAmicodeService({
        password: SERVICE_PASSWORD,
        shelf: { distRoot: dist },
        engine: { getUrl: () => undefined }, // engine-armed (non-client), no real engine
        fleet: {
          client: false,
          entitlements: ["amicissimo"],
          overlaySource,
          hub: { getUrl: () => undefined },
          getMode: () => "fleet",
          attached: { getUrl: () => sshUrl },
          keeper: { getUrl: () => keeper.url },
          posture: { hubDownConsecutiveNoResponses: 100, recoveryConsecutiveHealthy: 100 },
          dataPlaneTimeoutMs: 5000,
        },
      });
    }

    // ── AC1: two engine instances on distinct local ports ────────────────────

    it("AC1 — the peer and keeper engines run on distinct local ports", () => {
      expect(peer.port).not.toBe(keeper.port);
      expect(peer.url).not.toBe(keeper.url);
    });

    // ── AC2 + AC3: real ssh -L forward + engine requests land on the peer ───

    it("AC2+AC3 — engine + amicode requests through the real ssh -L forward and D3 resolver land on the PEER engine (verified by distinct marker)", async () => {
      const handle = await bringUpPeerForward();
      try {
        const svc = bootPeerService(handle.localUrl);
        const origin = (await svc.start()).toString().replace(/\/$/, "");
        const auth = serverAuthHeader(SERVICE_PASSWORD);

        try {
          // (a) Non-amicode engine path: /session → resolver says "attached" → peer
          const peerBefore = peer.requests.length;
          const keeperBefore = keeper.requests.length;
          const engineRes = await fetch(`${origin}/session`, { headers: { Authorization: auth } });
          expect(engineRes.status).toBe(200);
          const engineBody = (await engineRes.json()) as { ok: boolean; marker: string };
          expect(engineBody.marker).toBe(PEER_MARKER);
          expect(peer.requests.length).toBeGreaterThan(peerBefore);
          expect(keeper.requests.length).toBe(keeperBefore); // the keeper saw NOTHING

          // (b) Amicode path: /amicode/vaults → resolver says "attached" → peer
          const amicodeRes = await fetch(`${origin}/amicode/vaults`, { headers: { Authorization: auth } });
          expect(amicodeRes.status).toBe(200);
          const amicodeBody = (await amicodeRes.json()) as { ok: boolean; marker: string };
          expect(amicodeBody.marker).toBe(PEER_MARKER);

          // (c) SSE-like path: /api/session/test/event → resolver says "attached" → peer
          const sseRes = await fetch(`${origin}/api/session/test-ses/event`, { headers: { Authorization: auth } });
          expect(sseRes.status).toBe(200);
          const sseBody = (await sseRes.json()) as { ok: boolean; marker: string };
          expect(sseBody.marker).toBe(PEER_MARKER);
        } finally {
          await svc.stop();
        }
      } finally {
        await handle.stop();
      }
    }, 30_000);

    // ── AC4: /amicode/roster lands on the keeper ────────────────────────────

    it("AC4 — /amicode/roster through the resolver lands on the KEEPER engine (verified by distinct marker), not the peer", async () => {
      const handle = await bringUpPeerForward();
      try {
        const svc = bootPeerService(handle.localUrl);
        const origin = (await svc.start()).toString().replace(/\/$/, "");
        const auth = serverAuthHeader(SERVICE_PASSWORD);

        try {
          const peerBefore = peer.requests.length;
          const keeperBefore = keeper.requests.length;
          const res = await fetch(`${origin}/amicode/roster`, { headers: { Authorization: auth } });
          expect(res.status).toBe(200);
          const body = (await res.json()) as { ok: boolean; marker: string };
          expect(body.marker).toBe(KEEPER_MARKER); // from the KEEPER, not the peer
          expect(keeper.requests.length).toBeGreaterThan(keeperBefore); // the keeper served it
          expect(peer.requests.length).toBe(peerBefore); // the peer saw NOTHING
        } finally {
          await svc.stop();
        }
      } finally {
        await handle.stop();
      }
    }, 30_000);

    // ── AC6: p95 attach-to-first-response ≤ 2000 ms ────────────────────────

    it("AC6 — p95 attach-to-first-response through the full service path ≤ 2000 ms", async () => {
      const P95_CEILING_MS = 2000;
      const SAMPLES = 8;
      const samples: number[] = [];

      // A long-lived service whose attached URL updates per iteration.
      let currentSshUrl: string | undefined;
      const svc = createAmicodeService({
        password: SERVICE_PASSWORD,
        shelf: { distRoot: dist },
        engine: { getUrl: () => undefined },
        fleet: {
          client: false,
          entitlements: ["amicissimo"],
          overlaySource,
          hub: { getUrl: () => undefined },
          getMode: () => "fleet",
          attached: { getUrl: () => currentSshUrl },
          keeper: { getUrl: () => keeper.url },
          posture: { hubDownConsecutiveNoResponses: 100, recoveryConsecutiveHealthy: 100 },
          dataPlaneTimeoutMs: 5000,
        },
      });
      const origin = (await svc.start()).toString().replace(/\/$/, "");
      const auth = serverAuthHeader(SERVICE_PASSWORD);

      try {
        for (let i = 0; i < SAMPLES; i++) {
          const t0 = Date.now();
          const handle = await bringUpPeerForward();
          currentSshUrl = handle.localUrl;

          const res = await fetch(`${origin}/session`, { headers: { Authorization: auth } });
          const ms = Date.now() - t0;
          expect(res.status).toBe(200);
          const body = (await res.json()) as { ok: boolean; marker: string };
          expect(body.marker).toBe(PEER_MARKER); // proven: the response came from the peer
          samples.push(ms);

          await handle.stop();
          currentSshUrl = undefined;
        }

        const measured = p95(samples);
        // eslint-disable-next-line no-console
        console.log(
          `[AC6] peer_e2e_p95_ms=${measured} (n=${samples.length}; ` +
            `samples=${samples.map((m) => `${m}ms`).join(", ")}; ceiling=${P95_CEILING_MS}ms)`,
        );
        expect(samples.length).toBe(SAMPLES);
        expect(measured).toBeLessThanOrEqual(P95_CEILING_MS);
      } finally {
        await svc.stop();
      }
    }, 120_000);
  },
);
