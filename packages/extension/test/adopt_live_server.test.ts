import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeHealth,
  challengePassword,
  adoptOrSpawn,
  buildLiveDeps,
} from "../src/server_lifecycle";
import { coldSpawnHandshakeHook, readHandshake, PROTOCOL_VERSION } from "../src/server_handshake";
import { serverAuthHeader } from "../src/server_auth";

// ============================================================================
// #1185 — adopt-on-reload against a REAL password-armed server.
//
// The bug: probeHealth did an UNAUTHENTICATED GET /, and every server is
// spawned with OPENCODE_SERVER_PASSWORD armed (#163), which 401s an anonymous
// GET. probeHealth returned false → healthy=false → classifyGate could never
// reach "adoptable" → every reload cold-spawned. It shipped green because every
// adopt test injected `healthCheck: async () => true` and probeHealth was tested
// against NOTHING. These tests run the REAL seams (probeHealth, challengePassword,
// adoptOrSpawn via buildLiveDeps) against a live http server that behaves exactly
// like a password-armed opencode: 401 without the credential, 200 with it.
//
// Live-session safety: the server ALWAYS binds an ephemeral port (listen(0)) —
// never 43117 — and the handshake is written under a tmpdir, never
// ~/.amico/ops/server/standalone.json.
// ============================================================================

/** A live http server with opencode-style Basic auth on an EPHEMERAL port.
 *  Answers 200 iff the request carries `Basic base64("opencode:<password>")`,
 *  401 otherwise — the exact contract #163 arms and challengePassword speaks. */
async function startArmedServer(password: string): Promise<{ port: number; close: () => Promise<void> }> {
  const expected = serverAuthHeader(password);
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === expected) {
      res.statusCode = 200;
      res.end("ok");
    } else {
      res.statusCode = 401;
      res.end("unauthorized");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function tmpHandshake(): string {
  return join(mkdtempSync(join(tmpdir(), "adopt-live-hs-")), "server", "standalone.json");
}

/** Plant a valid handshake pointing at (port, pid) with `password`. pid defaults
 *  to this test process, which is alive → the pidAlive check passes. */
function plantHandshake(fp: string, port: number, password: string, pid = process.pid): void {
  coldSpawnHandshakeHook({ binaryHash: "b", configHash: "c", password, filePath: fp })({ port, pid });
  // sanity: the record round-trips and pins the current protocol
  const hs = readHandshake(fp);
  expect(hs.status).toBe("ok");
}

describe("#1185 probeHealth — reachability, not 2xx", () => {
  it("treats a password-armed server's 401 as reachable (the bug)", async () => {
    const s = await startArmedServer("pw-abc");
    try {
      // A password-armed server 401s an anonymous GET — but it IS up. probeHealth
      // must say so; the password challenge decides ownership, not this probe.
      expect(await probeHealth(s.port)).toBe(true);
    } finally {
      await s.close();
    }
  });

  it("returns false when nothing is listening (connection refused)", async () => {
    const s = await startArmedServer("pw-abc");
    const deadPort = s.port;
    await s.close(); // free the port → nothing there now
    expect(await probeHealth(deadPort)).toBe(false);
  });
});

describe("#1185 challengePassword — the ownership seam", () => {
  it("passes with the correct password, fails with the wrong one", async () => {
    const s = await startArmedServer("correct-horse");
    try {
      expect(await challengePassword(s.port, "correct-horse")).toBe(true);
      expect(await challengePassword(s.port, "wrong-horse")).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe("#1185 adoptOrSpawn — real seams against a live survivor", () => {
  it("ADOPTS a live password-armed survivor (no cold-spawn)", async () => {
    const PW = "survivor-pw";
    const s = await startArmedServer(PW);
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, s.port, PW);

      let spawned = false;
      const deps = buildLiveDeps(async () => {
        spawned = true;
        return { port: 0, pid: 0, password: "should-not-be-used" };
      }, s.port);

      const result = await adoptOrSpawn(fp, deps);

      expect(result.outcome).toBe("adopted");
      expect(result.port).toBe(s.port);
      expect(result.password).toBe(PW); // recorded password reused verbatim
      expect(spawned).toBe(false); // adopted the survivor — no new spawn, no port collision
    } finally {
      await s.close();
    }
  });

  it("classifies a live server that fails the recorded-password challenge as foreign — no adopt, no spawn", async () => {
    const s = await startArmedServer("the-servers-real-pw");
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, s.port, "WRONG-recorded-pw"); // handshake pw != what the server accepts

      let spawned = false;
      const deps = buildLiveDeps(async () => {
        spawned = true;
        return { port: 0, pid: 0, password: "x" };
      }, s.port);

      const result = await adoptOrSpawn(fp, deps);

      expect(result.outcome).toBe("foreign-error"); // reachable but not ours
      expect(spawned).toBe(false); // never spawn onto an occupied foreign port
    } finally {
      await s.close();
    }
  });
});
