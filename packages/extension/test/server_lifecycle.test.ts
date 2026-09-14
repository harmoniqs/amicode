import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeHandshake,
  PROTOCOL_VERSION,
  type HandshakeRecord,
} from "../src/server_handshake";
import {
  adoptOrSpawn,
  isPidAlive,
  detectStaleEngine,
  surfaceStaleNotice,
  restartEngine,
  type AdoptOrSpawnDeps,
  type StaleNoticeDeps,
  type RestartEngineDeps,
} from "../src/server_lifecycle";

// ============================================================================
// Helpers
// ============================================================================

function tmpHandshakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  return join(dir, "server", "standalone.json");
}

function sampleRecord(overrides?: Partial<HandshakeRecord>): HandshakeRecord {
  return {
    port: 43117,
    pid: 12345,
    startedAt: new Date().toISOString(),
    password: "test-password-base64url",
    binaryHash: "abc123",
    configHash: "def456",
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

/** Build deps with all four live checks passing (adoptable server). */
function adoptableDeps(overrides?: Partial<AdoptOrSpawnDeps>): AdoptOrSpawnDeps {
  return {
    healthCheck: async () => true,
    pidAlive: () => true,
    passwordChallenge: async () => true,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn: async () => ({ port: 55555, pid: 99999, password: "new-pw" }),
    ...overrides,
  };
}

// ============================================================================
// AC1: Adopt path — valid handshake + all 4 checks pass
// ============================================================================

describe("adoptOrSpawn — adopt path", () => {
  it("returns 'adopted' with the recorded port/pid/password when all checks pass", async () => {
    const fp = tmpHandshakePath();
    const record = sampleRecord();
    writeHandshake(record, fp);

    let spawnCalled = false;
    const deps = adoptableDeps({
      coldSpawn: async () => { spawnCalled = true; return { port: 1, pid: 1, password: "x" }; },
    });
    const result = await adoptOrSpawn(fp, deps);

    expect(result.outcome).toBe("adopted");
    expect(result.port).toBe(record.port);
    expect(result.pid).toBe(record.pid);
    expect(result.password).toBe(record.password);
    expect(spawnCalled).toBe(false);
  });

  it("the adopted password is the exact recorded bytes — not regenerated (AC2)", async () => {
    const fp = tmpHandshakePath();
    const specificPassword = "dGhpcy1pcy1hLXNwZWNpZmljLXRlc3QtcGFzc3dvcmQ";
    const record = sampleRecord({ password: specificPassword });
    writeHandshake(record, fp);

    const result = await adoptOrSpawn(fp, adoptableDeps());

    expect(result.outcome).toBe("adopted");
    // Byte-identical: the password is reused verbatim, not regenerated
    expect(result.password).toBe(specificPassword);
  });
});

// ============================================================================
// AC3: Stale path — dead PID
// ============================================================================

describe("adoptOrSpawn — stale path (dead PID)", () => {
  it("cold-spawns when the recorded PID is dead", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp);

    const result = await adoptOrSpawn(fp, adoptableDeps({
      pidAlive: () => false,
    }));

    expect(result.outcome).toBe("cold-spawned");
    expect(result.port).toBe(55555);
    expect(result.pid).toBe(99999);
    expect(result.password).toBe("new-pw");
  });
});

// ============================================================================
// AC3: Stale path — no responder (health check fails)
// ============================================================================

describe("adoptOrSpawn — stale path (no responder)", () => {
  it("cold-spawns when the health check fails", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp);

    const result = await adoptOrSpawn(fp, adoptableDeps({
      healthCheck: async () => false,
    }));

    expect(result.outcome).toBe("cold-spawned");
  });
});

// ============================================================================
// AC4: Foreign path — port answers but password challenge fails
// ============================================================================

describe("adoptOrSpawn — foreign path", () => {
  it("returns foreign-error naming port and PID, no kill, no spawn", async () => {
    const fp = tmpHandshakePath();
    const record = sampleRecord({ port: 43117, pid: 12345 });
    writeHandshake(record, fp);

    let killCalled = false;
    let spawnCalled = false;
    const result = await adoptOrSpawn(fp, adoptableDeps({
      passwordChallenge: async () => false,
      coldSpawn: async () => { spawnCalled = true; return { port: 1, pid: 1, password: "x" }; },
    }));

    expect(result.outcome).toBe("foreign-error");
    expect(result.error).toContain("43117");
    expect(result.error).toContain("12345");
    expect(spawnCalled).toBe(false);
  });
});

// ============================================================================
// AC5: Incompatible protocol — auth succeeds but version mismatch
// ============================================================================

describe("adoptOrSpawn — incompatible protocol", () => {
  it("returns incompatible-error, no spawn, error says restart needed", async () => {
    const fp = tmpHandshakePath();
    const record = sampleRecord({ protocolVersion: "0" }); // stale version
    writeHandshake(record, fp);

    let spawnCalled = false;
    const result = await adoptOrSpawn(fp, adoptableDeps({
      protocolVersion: PROTOCOL_VERSION, // current = "1", handshake = "0"
      coldSpawn: async () => { spawnCalled = true; return { port: 1, pid: 1, password: "x" }; },
    }));

    expect(result.outcome).toBe("incompatible-error");
    expect(result.error).toContain("Restart");
    expect(spawnCalled).toBe(false);
  });
});

// ============================================================================
// No handshake — fresh install → cold-spawn
// ============================================================================

describe("adoptOrSpawn — no handshake file", () => {
  it("cold-spawns when no handshake file exists", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "no-such-file.json");

    const result = await adoptOrSpawn(fp, adoptableDeps());

    expect(result.outcome).toBe("cold-spawned");
    expect(result.port).toBe(55555);
    expect(result.pid).toBe(99999);
  });

  it("cold-spawns when the handshake file is invalid", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp); // create dir
    writeFileSync(fp, "not valid json");

    const result = await adoptOrSpawn(fp, adoptableDeps());

    expect(result.outcome).toBe("cold-spawned");
  });
});

// ============================================================================
// #1178 — reclaim an orphaned port on the no-handshake path
// ============================================================================

describe("adoptOrSpawn — orphaned-port reclaim (no handshake)", () => {
  it("reclaims our orphaned server on the configured port, then cold-spawns", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "absent.json");
    let reclaimed = false;
    let spawnCalled = false;
    const result = await adoptOrSpawn(fp, adoptableDeps({
      configuredPort: 43117,
      probePort: async () => ({ occupied: true, isOurServer: true, pid: 4242 }),
      reclaimPort: async () => { reclaimed = true; return true; },
      coldSpawn: async () => { spawnCalled = true; return { port: 43117, pid: 5555, password: "fresh" }; },
    }));

    expect(reclaimed).toBe(true);
    expect(spawnCalled).toBe(true);
    expect(result.outcome).toBe("cold-spawned");
    expect(result.reclaimed).toBe(true);
    expect(result.pid).toBe(5555);
  });

  it("does NOT reclaim or spawn when the port holder is foreign", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "absent.json");
    let reclaimCalled = false;
    let spawnCalled = false;
    const result = await adoptOrSpawn(fp, adoptableDeps({
      configuredPort: 43117,
      probePort: async () => ({ occupied: true, isOurServer: false, pid: 8888 }),
      reclaimPort: async () => { reclaimCalled = true; return true; },
      coldSpawn: async () => { spawnCalled = true; return { port: 1, pid: 1, password: "x" }; },
    }));

    expect(result.outcome).toBe("foreign-error");
    expect(result.error).toContain("43117");
    expect(result.error).toContain("8888");
    expect(reclaimCalled).toBe(false); // never kill a foreign process
    expect(spawnCalled).toBe(false);   // never spawn on the occupied port
  });

  it("surfaces an error and does not spawn when reclaim fails", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "absent.json");
    let spawnCalled = false;
    const result = await adoptOrSpawn(fp, adoptableDeps({
      configuredPort: 43117,
      probePort: async () => ({ occupied: true, isOurServer: true, pid: 4242 }),
      reclaimPort: async () => false, // stubborn — could not free
      coldSpawn: async () => { spawnCalled = true; return { port: 1, pid: 1, password: "x" }; },
    }));

    expect(result.outcome).toBe("foreign-error");
    expect(result.error).toContain("reclaim");
    expect(spawnCalled).toBe(false);
  });

  it("cold-spawns normally when the configured port is free (no orphan)", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "absent.json");
    const result = await adoptOrSpawn(fp, adoptableDeps({
      configuredPort: 43117,
      probePort: async () => ({ occupied: false, isOurServer: false }),
    }));

    expect(result.outcome).toBe("cold-spawned");
    expect(result.reclaimed).toBeFalsy();
  });
});

// ============================================================================
// isPidAlive — production PID probe
// ============================================================================

describe("isPidAlive — production PID probe", () => {
  it("returns true for this process (alive PID)", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID that cannot exist", () => {
    // PID 2^30 is extremely unlikely to be alive on any real system
    expect(isPidAlive(2 ** 30)).toBe(false);
  });
});


describe("adoptOrSpawn — adopted result includes adoptedHashes (#1148)", () => {
  it("adoption result carries the server recorded binary + config hashes", async () => {
    const fp = tmpHandshakePath();
    const record = sampleRecord({ binaryHash: "bin-aaa", configHash: "cfg-bbb" });
    writeHandshake(record, fp);
    const result = await adoptOrSpawn(fp, adoptableDeps());
    expect(result.outcome).toBe("adopted");
    expect(result.adoptedHashes).toEqual({ binaryHash: "bin-aaa", configHash: "cfg-bbb" });
  });
  it("cold-spawned result does not carry adoptedHashes", async () => {
    const fp = join(mkdtempSync(join(tmpdir(), "lifecycle-test-")), "absent.json");
    const result = await adoptOrSpawn(fp, adoptableDeps());
    expect(result.outcome).toBe("cold-spawned");
    expect(result.adoptedHashes).toBeUndefined();
  });
});

describe("detectStaleEngine — pure hash comparison (#1148)", () => {
  it("returns not-stale when both hashes match", () => {
    const r = detectStaleEngine({ binaryHash: "abc", configHash: "def" }, { binaryHash: "abc", configHash: "def" });
    expect(r.stale).toBe(false);
    expect(r.binaryChanged).toBe(false);
    expect(r.configChanged).toBe(false);
  });
  it("detects binary-only change", () => {
    const r = detectStaleEngine({ binaryHash: "old", configHash: "same" }, { binaryHash: "new", configHash: "same" });
    expect(r.stale).toBe(true);
    expect(r.binaryChanged).toBe(true);
    expect(r.configChanged).toBe(false);
  });
  it("detects config-only change (stale-config notice even when overlay unchanged)", () => {
    const r = detectStaleEngine({ binaryHash: "same", configHash: "old" }, { binaryHash: "same", configHash: "new" });
    expect(r.stale).toBe(true);
    expect(r.binaryChanged).toBe(false);
    expect(r.configChanged).toBe(true);
  });
  it("detects both changed", () => {
    const r = detectStaleEngine({ binaryHash: "old1", configHash: "old2" }, { binaryHash: "new1", configHash: "new2" });
    expect(r.stale).toBe(true);
    expect(r.binaryChanged).toBe(true);
    expect(r.configChanged).toBe(true);
  });
});

describe("surfaceStaleNotice — non-blocking informational notice (#1148)", () => {
  it("shows an info message mentioning the changed component when stale", async () => {
    const shown: string[] = [];
    const deps: StaleNoticeDeps = {
      showInformationMessage: async (msg: string) => { shown.push(msg); return undefined; },
      onRestartRequested: async () => {},
    };
    surfaceStaleNotice({ stale: true, binaryChanged: true, configChanged: false }, deps);
    await new Promise(r => setTimeout(r, 0));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("binary");
  });
  it("does nothing when not stale", () => {
    let called = false;
    const deps: StaleNoticeDeps = {
      showInformationMessage: async () => { called = true; return undefined; },
      onRestartRequested: async () => {},
    };
    surfaceStaleNotice({ stale: false, binaryChanged: false, configChanged: false }, deps);
    expect(called).toBe(false);
  });
  it("returns immediately — does not await the message (turn keeps advancing)", () => {
    let resolved = false;
    const deps: StaleNoticeDeps = {
      showInformationMessage: () => new Promise<string | undefined>(resolve => {
        setTimeout(() => { resolved = true; resolve(undefined); }, 100);
      }),
      onRestartRequested: async () => {},
    };
    surfaceStaleNotice({ stale: true, binaryChanged: true, configChanged: false }, deps);
    expect(resolved).toBe(false);
  });
  it("calls onRestartRequested when Restart Engine is clicked", async () => {
    let restarted = false;
    const deps: StaleNoticeDeps = {
      showInformationMessage: async (_msg: string, ..._items: string[]) => "Restart Engine" as string | undefined,
      onRestartRequested: async () => { restarted = true; },
    };
    surfaceStaleNotice({ stale: true, binaryChanged: false, configChanged: true }, deps);
    await new Promise(r => setTimeout(r, 0));
    expect(restarted).toBe(true);
  });
  it("mentions config when only config changed", async () => {
    const shown: string[] = [];
    const deps: StaleNoticeDeps = {
      showInformationMessage: async (msg: string) => { shown.push(msg); return undefined; },
      onRestartRequested: async () => {},
    };
    surfaceStaleNotice({ stale: true, binaryChanged: false, configChanged: true }, deps);
    await new Promise(r => setTimeout(r, 0));
    expect(shown[0]).toContain("config");
  });
});

describe("restartEngine — gated restart (#1148)", () => {
  it("warns when in-flight turns exist and proceeds on confirm (AC2)", async () => {
    let warningShown = false, stopped = false, handshakeDeleted = false, coldSpawned = false;
    await restartEngine({
      hasInflightTurns: () => true,
      showWarningMessage: async () => { warningShown = true; return "Restart anyway"; },
      stopServer: async () => { stopped = true; },
      deleteHandshake: () => { handshakeDeleted = true; },
      coldSpawn: async () => { coldSpawned = true; },
    });
    expect(warningShown).toBe(true);
    expect(stopped).toBe(true);
    expect(handshakeDeleted).toBe(true);
    expect(coldSpawned).toBe(true);
  });
  it("aborts when user cancels the in-flight warning", async () => {
    let stopped = false;
    await restartEngine({
      hasInflightTurns: () => true,
      showWarningMessage: async () => "Cancel",
      stopServer: async () => { stopped = true; },
      deleteHandshake: () => {},
      coldSpawn: async () => {},
    });
    expect(stopped).toBe(false);
  });
  it("proceeds directly when no in-flight turns — no warning shown", async () => {
    let warningShown = false, stopped = false, coldSpawned = false;
    await restartEngine({
      hasInflightTurns: () => false,
      showWarningMessage: async () => { warningShown = true; return undefined; },
      stopServer: async () => { stopped = true; },
      deleteHandshake: () => {},
      coldSpawn: async () => { coldSpawned = true; },
    });
    expect(warningShown).toBe(false);
    expect(stopped).toBe(true);
    expect(coldSpawned).toBe(true);
  });
  it("clears the handshake before cold-spawn — deliberate-kill ordering (AC5)", async () => {
    const order: string[] = [];
    await restartEngine({
      hasInflightTurns: () => false,
      showWarningMessage: async () => undefined,
      stopServer: async () => { order.push("stop"); },
      deleteHandshake: () => { order.push("deleteHandshake"); },
      coldSpawn: async () => { order.push("coldSpawn"); },
    });
    expect(order).toEqual(["stop", "deleteHandshake", "coldSpawn"]);
  });
  it("a failed cold-spawn leaves no handshake pointing at the killed PID (AC5)", async () => {
    let handshakeDeleted = false;
    await expect(restartEngine({
      hasInflightTurns: () => false,
      showWarningMessage: async () => undefined,
      stopServer: async () => {},
      deleteHandshake: () => { handshakeDeleted = true; },
      coldSpawn: async () => { throw new Error("spawn failed"); },
    })).rejects.toThrow("spawn failed");
    expect(handshakeDeleted).toBe(true);
  });
  it("post-Restart cold-spawn writes a fresh handshake (AC4 — verified via ordering)", async () => {
    const events: string[] = [];
    await restartEngine({
      hasInflightTurns: () => false,
      showWarningMessage: async () => undefined,
      stopServer: async () => { events.push("stop"); },
      deleteHandshake: () => { events.push("delete"); },
      coldSpawn: async () => { events.push("spawn"); },
    });
    expect(events.indexOf("delete")).toBeLessThan(events.indexOf("spawn"));
  });
});
