import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeColdSpawnHandshake,
  coldSpawnHandshakeHook,
  writeHubHandshake,
  readHandshake,
  isUnarmedHandshake,
  PROTOCOL_VERSION,
} from "../src/server_handshake";
import { adoptOrSpawn, type AdoptOrSpawnDeps } from "../src/server_lifecycle";

// ============================================================================
// Hub-handshake owner-guard — the "one engine on a fleet server" invariant.
//
// A fleet SERVER machine runs a launchd hub that owns the single engine and
// writes an UNARMED adoption record to ~/.amico/ops/server/standalone.json.
// The editor window is supposed to ADOPT that engine. The bug (stale sessions,
// two engines): the window's cold-spawn handshake write blindly overwrote the
// hub's unarmed record with its own ARMED record, so the window then adopted
// its OWN rival engine forever — two engines on one DB.
//
// The fix: the cold-spawn write must REFUSE to clobber a LIVE unarmed hub
// record. These tests pin that guard and the resulting one-engine invariant.
// ============================================================================

function tmpHs(): string {
  return join(mkdtempSync(join(tmpdir(), "owner-guard-hs-")), "server", "standalone.json");
}

describe("hub handshake owner-guard (Layer 1)", () => {
  it("REFUSES to overwrite a live unarmed hub record", () => {
    const fp = tmpHs();
    // Hub (launchd) writes its unarmed record first.
    writeHubHandshake({ port: 4093, pid: 1000, binaryHash: "hub-bin", configHash: "", filePath: fp });

    // Window cold-spawn tries to write its ARMED record; hub PID is alive.
    const wrote = writeColdSpawnHandshake({
      port: 4094,
      pid: 2000,
      password: "armed-window-pw",
      binaryHash: "win-bin",
      configHash: "win-cfg",
      filePath: fp,
      isPidAlive: () => true, // the hub's PID is alive
    });

    expect(wrote).toBe(false); // refused
    const hs = readHandshake(fp);
    expect(hs.status).toBe("ok");
    if (hs.status !== "ok") return;
    expect(hs.record.port).toBe(4093); // hub record intact — NOT clobbered
    expect(isUnarmedHandshake(hs.record)).toBe(true);
  });

  it("DOES write when the unarmed hub record's PID is dead (hub genuinely gone)", () => {
    const fp = tmpHs();
    writeHubHandshake({ port: 4093, pid: 1000, binaryHash: "hub-bin", configHash: "", filePath: fp });

    const wrote = writeColdSpawnHandshake({
      port: 4094,
      pid: 2000,
      password: "armed-window-pw",
      binaryHash: "win-bin",
      configHash: "win-cfg",
      filePath: fp,
      isPidAlive: () => false, // hub PID dead — its record is stale, not authoritative
    });

    expect(wrote).toBe(true);
    const hs = readHandshake(fp);
    if (hs.status !== "ok") throw new Error("expected ok");
    expect(hs.record.port).toBe(4094); // window reclaimed the dead record
  });

  it("DOES overwrite a prior ARMED record (a normal cold-spawn refresh, not the hub)", () => {
    const fp = tmpHs();
    writeColdSpawnHandshake({ port: 4094, pid: 1, password: "old", binaryHash: "b", configHash: "c", filePath: fp });

    const wrote = writeColdSpawnHandshake({
      port: 4094,
      pid: 2,
      password: "new",
      binaryHash: "b",
      configHash: "c",
      filePath: fp,
      isPidAlive: () => true,
    });

    expect(wrote).toBe(true);
    const hs = readHandshake(fp);
    if (hs.status !== "ok") throw new Error("expected ok");
    expect(hs.record.password).toBe("new"); // own armed record freely refreshed
  });

  it("writes normally when there is no existing record", () => {
    const fp = tmpHs();
    const wrote = writeColdSpawnHandshake({
      port: 4094, pid: 1, password: "pw", binaryHash: "b", configHash: "c",
      filePath: fp, isPidAlive: () => true,
    });
    expect(wrote).toBe(true);
    expect(existsSync(fp)).toBe(true);
  });

  it("coldSpawnHandshakeHook logs a skip and leaves the hub record intact", () => {
    const fp = tmpHs();
    writeHubHandshake({ port: 4093, pid: 1000, binaryHash: "hub-bin", configHash: "", filePath: fp });

    const logs: string[] = [];
    coldSpawnHandshakeHook({
      binaryHash: "win-bin",
      configHash: "win-cfg",
      password: "armed",
      filePath: fp,
      isPidAlive: () => true,
      log: (l) => logs.push(l),
    })({ port: 4094, pid: 2000 });

    expect(logs.some((l) => /hub|skip|clobber/i.test(l))).toBe(true);
    const hs = readHandshake(fp);
    if (hs.status !== "ok") throw new Error("expected ok");
    expect(hs.record.port).toBe(4093); // unchanged
  });
});

describe("one-engine invariant on a fleet server (Layer 3 regression guard)", () => {
  function allPassDeps(over?: Partial<AdoptOrSpawnDeps>): AdoptOrSpawnDeps {
    return {
      healthCheck: async () => true,
      pidAlive: () => true,
      passwordChallenge: async () => true, // an unarmed engine accepts any auth
      protocolVersion: PROTOCOL_VERSION,
      coldSpawn: async () => ({ port: 4094, pid: 2000, password: "rival" }),
      ...over,
    };
  }

  it("after a boot-race, the window ADOPTS the hub (4093) and never spawns a rival", async () => {
    const fp = tmpHs();

    // 1. Hub comes up (launchd RunAtLoad) and writes its unarmed record.
    writeHubHandshake({ port: 4093, pid: 1000, binaryHash: "hub-bin", configHash: "", filePath: fp });

    // 2. The window's cold-spawn hook fires in the boot-race — guarded, so it
    //    does NOT clobber the hub's record.
    coldSpawnHandshakeHook({
      binaryHash: "win-bin", configHash: "win-cfg", password: "armed",
      filePath: fp, isPidAlive: () => true,
    })({ port: 4094, pid: 2000 });

    // 3. A re-activation reads the handshake and runs the adoption gate.
    let spawned = false;
    const result = await adoptOrSpawn(
      fp,
      allPassDeps({ coldSpawn: async () => { spawned = true; return { port: 4094, pid: 2000, password: "rival" }; } }),
    );

    expect(result.outcome).toBe("adopted");
    expect(result.port).toBe(4093); // the HUB engine — not a rival on 4094
    expect(spawned).toBe(false); // no rival cold-spawned
  });
});
