import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coldSpawnHandshakeHook,
  readHandshake,
  hashString,
  PROTOCOL_VERSION,
} from "../src/server_handshake";
import { adoptOrSpawn, type AdoptOrSpawnDeps } from "../src/server_lifecycle";

// ============================================================================
// #1181 — the cold-spawn handshake write (the activation seam that was missing).
//
// The feature's linchpin: on cold spawn, once healthy, record a handshake a
// later reload can adopt. These prove the WRITE happens and is ADOPTABLE — the
// round-trip a reload depends on. (extension.ts installing the hook is verified
// by typecheck + inspection; the reload-adopts-survivor proof is human-gated.)
// ============================================================================

function tmpHs(): string {
  return join(mkdtempSync(join(tmpdir(), "coldspawn-hs-")), "server", "standalone.json");
}

function allPassDeps(over?: Partial<AdoptOrSpawnDeps>): AdoptOrSpawnDeps {
  return {
    healthCheck: async () => true,
    pidAlive: () => true,
    passwordChallenge: async () => true,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn: async () => ({ port: 1, pid: 1, password: "should-not-be-used" }),
    ...over,
  };
}

describe("#1181 coldSpawnHandshakeHook — writes an adoptable record", () => {
  it("writes port/pid/password + hashes once healthy", () => {
    const fp = tmpHs();
    const hook = coldSpawnHandshakeHook({
      binaryHash: "bin-hash",
      configHash: hashString("config-content"),
      password: "spawned-pw",
      filePath: fp,
    });

    expect(existsSync(fp)).toBe(false);   // nothing written until healthy
    hook({ port: 43117, pid: 4242 });

    const hs = readHandshake(fp);
    expect(hs.status).toBe("ok");
    if (hs.status !== "ok") return;
    expect(hs.record.port).toBe(43117);
    expect(hs.record.pid).toBe(4242);
    expect(hs.record.password).toBe("spawned-pw");
    expect(hs.record.binaryHash).toBe("bin-hash");
    expect(hs.record.configHash).toBe(hashString("config-content"));
    expect(hs.record.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("round-trip: the written record is ADOPTABLE (write → adopt)", async () => {
    const fp = tmpHs();
    coldSpawnHandshakeHook({ binaryHash: "b", configHash: "c", password: "reuse-me", filePath: fp })(
      { port: 43117, pid: 4242 },
    );

    let spawned = false;
    const result = await adoptOrSpawn(fp, allPassDeps({
      coldSpawn: async () => { spawned = true; return { port: 1, pid: 1, password: "x" }; },
    }));

    expect(result.outcome).toBe("adopted");
    expect(result.password).toBe("reuse-me"); // recorded password reused verbatim
    expect(result.port).toBe(43117);
    expect(spawned).toBe(false);              // adopted the survivor, no new spawn
  });

  it("is best-effort: a write failure never throws (boot must not crash)", () => {
    // Point the handshake path UNDER a regular file → mkdirSync(dirname) fails
    // (ENOTDIR). The hook must swallow it and log, not throw.
    const fileNotDir = join(mkdtempSync(join(tmpdir(), "coldspawn-hs-")), "afile");
    writeFileSync(fileNotDir, "x");
    const badPath = join(fileNotDir, "sub", "standalone.json");

    const logs: string[] = [];
    const hook = coldSpawnHandshakeHook({
      binaryHash: "b", configHash: "c", password: "pw", filePath: badPath,
      log: (l) => logs.push(l),
    });

    expect(() => hook({ port: 43117, pid: 4242 })).not.toThrow();
    expect(logs.some((l) => /failed/i.test(l))).toBe(true);
    expect(existsSync(badPath)).toBe(false);
  });
});
