// amicode_service_attach_switch_latency.test.ts — #1344 (ADR 0027 §3/§6, Slice
// 4): the attach/switch p95 latency harness. AC4 (attach_switch_p95_ms <= 2000).
//
// This measures BOTH an initial attach and a SWITCH between two attached peers
// over Slice 3's REAL per-attachment transport (bringUpSshAttachment — a real
// `ssh -N -L` child), NOT a stub. "Usable" is the FIRST 2xx FROM THE PEER
// ENGINE: a response carrying the peer's own `peer_identity` field, minted by
// the stub peer at listen time this run — a value the local process could not
// forge, so a peer 2xx is provably distinguished from a local 2xx. p95 across
// the samples must be ≤ 2000 ms (the amicode.fleetDegradedLatencyP95Ms ceiling;
// "swift" is the intent).
//
// Gated behind the SAME honest, self-contained loopback-SSH readiness probe the
// Slice-3 transport suite uses (SSH_READY): it tries the current identity first
// (zero mutation), else installs a throwaway ed25519 key it verifies and rolls
// back every run. When no loopback sshd is reachable at all, the whole suite
// `describe.skip`s with a printed reason — NEVER a fabricated stub pass (a faked
// "real transport" pass is the one unforgivable outcome for AC4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as http from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { atomicWriteFileSync } from "../src/amicode_service/credentials";
import {
  bringUpSshAttachment,
  type AttachmentTarget,
  type AttachmentTransportHandle,
} from "../src/amicode_service/attachment_transport";
import { attachmentUpstreamAuthHeader } from "../src/amicode_service/attachment_credential";

// ── a stub "peer engine" — 401s without the expected auth, 2xx with a FRESH,
//    per-run-random peer_identity a credentialed request could not have forged ──
interface StubPeerEngine {
  url: string;
  port: number;
  identity: string;
  token: string;
  requests: string[];
  stop(): Promise<void>;
}

function startStubPeerEngine(token: string): Promise<StubPeerEngine> {
  const identity = `stub-peer-${randomBytes(12).toString("hex")}`;
  const expected = attachmentUpstreamAuthHeader(token);
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, peer_identity: identity }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        identity,
        token,
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

// ── the loopback SSH readiness probe (synchronous, module scope) — identical in
//    spirit to amicode_service_attachment_transport.test.ts's SSH_READY ────────
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
    tmpDir = mkdtempSync(join(tmpdir(), "amicode-attach-switch-sshkey-"));
    const keyPath = join(tmpDir, "id_attach_switch_test");
    execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", `amicode-attach-switch-latency-test-${process.pid}`, "-f", keyPath],
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
      try {
        atomicWriteFileSync(AUTHORIZED_KEYS_PATH, originalAuthorizedKeys);
      } catch {
        /* best-effort rollback */
      }
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    return { ready: false, identityArgs: [], reason: `loopback ssh probe failed: ${e instanceof Error ? e.message : String(e)}` };
  }
})();

if (!SSH_READY.ready) {
  // eslint-disable-next-line no-console
  console.warn(
    `[amicode_service_attach_switch_latency.test.ts] SKIPPING the AC4 real-SSH p95 harness: ${SSH_READY.reason ?? "no loopback ssh access"}. ` +
      "attach_switch_p95_ms is NOT measured on this machine (no loopback sshd the current user can authenticate to). This is an HONEST skip, not a fabricated pass.",
  );
}

/** p95 by nearest-rank over a copy of the samples (ascending). */
function p95(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * s.length);
  return s[Math.min(rank, s.length) - 1];
}

describe.skipIf(!SSH_READY.ready)(
  "attach/switch p95 over the REAL per-attachment transport (#1344 AC4: attach_switch_p95_ms <= 2000)",
  () => {
    const P95_CEILING_MS = 2000; // amicode.fleetDegradedLatencyP95Ms
    let peerA: StubPeerEngine;
    let peerB: StubPeerEngine;
    let live: AttachmentTransportHandle | undefined;

    beforeAll(async () => {
      peerA = await startStubPeerEngine("peer-a-token");
      peerB = await startStubPeerEngine("peer-b-token");
    }, 30_000);

    afterAll(async () => {
      await live?.stop();
      await peerA?.stop();
      await peerB?.stop();
      if (SSH_READY.throwaway) {
        atomicWriteFileSync(AUTHORIZED_KEYS_PATH, SSH_READY.throwaway.originalAuthorizedKeys);
        rmSync(SSH_READY.throwaway.keyDir, { recursive: true, force: true });
      }
    });

    /** Bring up a REAL ssh forward to `peer` and return the ms elapsed until the
     *  FIRST 2xx FROM THE PEER ENGINE (peer_identity present == peer.identity).
     *  A local 2xx (or a 401) never satisfies the identity check, so "usable" is
     *  measured against the real peer, not a same-process stand-in. */
    async function attachAndProbe(peer: StubPeerEngine): Promise<{ handle: AttachmentTransportHandle; ms: number }> {
      const localPort = await pickFreeLoopbackPort();
      const username = userInfo().username;
      const target: AttachmentTarget = { sshAlias: `${username}@127.0.0.1`, transport: "ssh", machine_id: `peer-${peer.port}` };
      const t0 = Date.now();
      const handle = await bringUpSshAttachment({
        target,
        remotePort: peer.port,
        localPort,
        extraSshOptions: [...sshProbeBaseArgs(), ...SSH_READY.identityArgs],
      });
      // first usable peer 2xx (authenticated): the peer_identity proves it came
      // from THIS peer engine, over the real tunnel — not a local response.
      const res = await fetch(handle.localUrl, { headers: { Authorization: attachmentUpstreamAuthHeader(peer.token) } });
      const body = (await res.json()) as { peer_identity?: string };
      const ms = Date.now() - t0;
      expect(res.status).toBe(200);
      expect(body.peer_identity).toBe(peer.identity); // distinguished from a local 2xx
      return { handle, ms };
    }

    it("initial attach + repeated switches between two peers stay under the p95 ceiling, each proven usable by the peer's own identity", async () => {
      const attachSamples: number[] = [];
      const switchSamples: number[] = [];

      // INITIAL ATTACH (from no attachment) — peer A.
      const first = await attachAndProbe(peerA);
      attachSamples.push(first.ms);
      live = first.handle;

      // SWITCHES between the two attached peers: leave the current, arrive the
      // other, measure time-to-usable. Alternating A/B, 6 switches → a small
      // distribution for p95.
      const SWITCHES = 6;
      for (let i = 0; i < SWITCHES; i++) {
        const target = i % 2 === 0 ? peerB : peerA;
        const t0 = Date.now();
        await live!.stop(); // tear the current forward down (the "leave")
        const arrived = await attachAndProbe(target);
        switchSamples.push(Date.now() - t0);
        live = arrived.handle;
      }

      const all = [...attachSamples, ...switchSamples];
      const measured = p95(all);
      // eslint-disable-next-line no-console
      console.log(
        `[AC4] attach_switch_p95_ms=${measured} (n=${all.length}; initial-attach=${attachSamples[0]}ms; ` +
          `switch samples=${switchSamples.map((m) => `${m}ms`).join(", ")}; ceiling=${P95_CEILING_MS}ms)`,
      );

      expect(attachSamples.length).toBe(1); // an initial attach WAS measured
      expect(switchSamples.length).toBe(SWITCHES); // switches between two attached peers WERE measured
      expect(measured).toBeLessThanOrEqual(P95_CEILING_MS);
    }, 120_000);
  },
);
