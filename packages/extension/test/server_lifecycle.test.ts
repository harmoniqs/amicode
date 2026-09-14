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
  type AdoptOrSpawnDeps,
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
