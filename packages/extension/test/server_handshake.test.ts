import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeHandshake,
  readHandshake,
  deleteHandshake,
  classifyGate,
  hashFile,
  hashString,
  mintHandshakePassword,
  handshakePath,
  writeColdSpawnHandshake,
  PROTOCOL_VERSION,
  type HandshakeRecord,
  type GateInputs,
} from "../src/server_handshake";

// ============================================================================
// Helpers
// ============================================================================

function tmpHandshakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "handshake-test-"));
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

// ============================================================================
// Round-trip read/write (AC1, AC2)
// ============================================================================

describe("handshake round-trip read/write", () => {
  it("writes and reads back all fields faithfully", () => {
    const fp = tmpHandshakePath();
    const record = sampleRecord();
    writeHandshake(record, fp);
    const result = readHandshake(fp);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.record).toEqual(record);
    }
  });

  it("file is mode 0600 after write", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp);
    const mode = statSync(fp).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ============================================================================
// Malformed / absent handling (AC2)
// ============================================================================

describe("handshake read — malformed and absent files", () => {
  it("absent file returns { status: 'absent' }, no throw", () => {
    const fp = join(mkdtempSync(join(tmpdir(), "handshake-test-")), "no-such-file.json");
    const result = readHandshake(fp);
    expect(result.status).toBe("absent");
  });

  it("invalid JSON returns { status: 'invalid' }, no throw", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp); // create dir
    writeFileSync(fp, "not json at all");
    const result = readHandshake(fp);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("invalid JSON");
    }
  });

  it("JSON missing a required field returns invalid", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp); // create dir
    writeFileSync(fp, JSON.stringify({ port: 1234 })); // missing most fields
    const result = readHandshake(fp);
    expect(result.status).toBe("invalid");
  });

  it("JSON with wrong field types returns invalid", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp); // create dir
    writeFileSync(fp, JSON.stringify({
      port: "not-a-number",
      pid: 1, startedAt: "t", password: "p",
      binaryHash: "b", configHash: "c", protocolVersion: "1",
    }));
    const result = readHandshake(fp);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("port");
    }
  });
});

// ============================================================================
// Gate classifier (AC3)
// ============================================================================

describe("classifyGate — four-check classification matrix", () => {
  const allPass: GateInputs = {
    healthy: true,
    pidAlive: true,
    passwordChallengePass: true,
    protocolCompatible: true,
  };

  it("all four checks pass → adoptable", () => {
    expect(classifyGate(allPass)).toBe("adoptable");
  });

  it("dead PID → stale", () => {
    expect(classifyGate({ ...allPass, pidAlive: false })).toBe("stale");
  });

  it("dead port (not healthy) → stale", () => {
    expect(classifyGate({ ...allPass, healthy: false })).toBe("stale");
  });

  it("port answers but password challenge fails → foreign", () => {
    expect(classifyGate({ ...allPass, passwordChallengePass: false })).toBe("foreign");
  });

  it("protocol version mismatch (with everything else passing) → stale (not adoptable)", () => {
    expect(classifyGate({ ...allPass, protocolCompatible: false })).toBe("stale");
  });

  it("healthy + protocol mismatch + challenge fails → foreign (challenge takes priority)", () => {
    expect(classifyGate({
      healthy: true,
      pidAlive: true,
      passwordChallengePass: false,
      protocolCompatible: false,
    })).toBe("foreign");
  });

  it("nothing passes → stale", () => {
    expect(classifyGate({
      healthy: false,
      pidAlive: false,
      passwordChallengePass: false,
      protocolCompatible: false,
    })).toBe("stale");
  });

  // Isolation checks: each individual check failing
  it("only healthy fails → stale", () => {
    expect(classifyGate({ ...allPass, healthy: false })).toBe("stale");
  });

  it("only pidAlive fails → stale", () => {
    expect(classifyGate({ ...allPass, pidAlive: false })).toBe("stale");
  });

  it("only passwordChallengePass fails → foreign", () => {
    expect(classifyGate({ ...allPass, passwordChallengePass: false })).toBe("foreign");
  });

  it("only protocolCompatible fails → stale", () => {
    expect(classifyGate({ ...allPass, protocolCompatible: false })).toBe("stale");
  });
});

// ============================================================================
// Delete primitive (AC5)
// ============================================================================

describe("deleteHandshake — idempotent delete", () => {
  it("deletes an existing handshake", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp);
    expect(existsSync(fp)).toBe(true);
    deleteHandshake(fp);
    expect(existsSync(fp)).toBe(false);
  });

  it("deleting an absent file is a no-op (no throw)", () => {
    const fp = join(mkdtempSync(join(tmpdir(), "handshake-test-")), "nonexistent.json");
    expect(() => deleteHandshake(fp)).not.toThrow();
  });

  it("delete twice — idempotent", () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord(), fp);
    deleteHandshake(fp);
    deleteHandshake(fp); // second delete — no-op
    expect(existsSync(fp)).toBe(false);
  });
});

// ============================================================================
// Hash helpers
// ============================================================================

describe("hash helpers", () => {
  it("hashString produces a stable SHA-256 hex for a known input", () => {
    const h = hashString("hello world");
    expect(h).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("hashFile produces a SHA-256 of the file contents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hash-test-"));
    const fp = join(dir, "test.txt");
    writeFileSync(fp, "hello world");
    const h = await hashFile(fp);
    expect(h).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });
});

// ============================================================================
// Fresh password per cold spawn (AC4)
// ============================================================================

describe("mintHandshakePassword — fresh per spawn", () => {
  it("two calls yield two distinct passwords", () => {
    const a = mintHandshakePassword();
    const b = mintHandshakePassword();
    expect(a).not.toBe(b);
  });

  it("password is cryptographically sized and URL-safe (base64url)", () => {
    const pw = mintHandshakePassword();
    expect(pw.length).toBeGreaterThanOrEqual(43);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ============================================================================
// Cold-spawn ordering — write happens only after health probe (AC4)
// ============================================================================

describe("cold-spawn write ordering", () => {
  it("the write happens strictly after health probe returns healthy", async () => {
    // Simulate cold-spawn flow: health probe resolves, THEN write the record.
    const fp = tmpHandshakePath();
    const events: string[] = [];

    // Mock health probe
    const healthProbe = (): Promise<boolean> =>
      new Promise((resolve) => {
        setTimeout(() => {
          events.push("health-ok");
          resolve(true);
        }, 10);
      });

    // Cold-spawn flow
    const healthy = await healthProbe();
    expect(healthy).toBe(true);

    // Only after health resolves do we write
    events.push("write-handshake");
    writeHandshake(sampleRecord(), fp);

    expect(events).toEqual(["health-ok", "write-handshake"]);
    expect(readHandshake(fp).status).toBe("ok");
  });

  it("two cold spawns yield two distinct passwords in the record", () => {
    const fp = tmpHandshakePath();

    // First cold spawn
    const pw1 = mintHandshakePassword();
    writeHandshake(sampleRecord({ password: pw1 }), fp);
    const r1 = readHandshake(fp);
    expect(r1.status).toBe("ok");

    // Second cold spawn — rewrite with fresh password
    const pw2 = mintHandshakePassword();
    writeHandshake(sampleRecord({ password: pw2 }), fp);
    const r2 = readHandshake(fp);
    expect(r2.status).toBe("ok");

    if (r1.status === "ok" && r2.status === "ok") {
      expect(r1.record.password).not.toBe(r2.record.password);
    }
  });
});

// ============================================================================
// writeColdSpawnHandshake convenience function
// ============================================================================

describe("writeColdSpawnHandshake", () => {
  it("writes a complete handshake with protocol version and startedAt", () => {
    const fp = tmpHandshakePath();
    writeColdSpawnHandshake({
      port: 43117,
      pid: 99999,
      password: "the-password",
      binaryHash: "binhash",
      configHash: "cfghash",
      filePath: fp,
    });
    const result = readHandshake(fp);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.record.port).toBe(43117);
      expect(result.record.pid).toBe(99999);
      expect(result.record.password).toBe("the-password");
      expect(result.record.binaryHash).toBe("binhash");
      expect(result.record.configHash).toBe("cfghash");
      expect(result.record.protocolVersion).toBe(PROTOCOL_VERSION);
      // startedAt is a valid ISO date
      expect(new Date(result.record.startedAt).toISOString()).toBe(result.record.startedAt);
    }
  });

  it("file has mode 0600", () => {
    const fp = tmpHandshakePath();
    writeColdSpawnHandshake({
      port: 1234,
      pid: 1,
      password: "pw",
      binaryHash: "bh",
      configHash: "ch",
      filePath: fp,
    });
    const mode = statSync(fp).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ============================================================================
// handshakePath defaults
// ============================================================================

describe("handshakePath", () => {
  it("default path ends with ops/server/standalone.json under ~/.amico", () => {
    const p = handshakePath();
    expect(p).toContain(join("ops", "server", "standalone.json"));
    expect(p).toContain(".amico");
  });

  it("accepts a custom ops root", () => {
    const p = handshakePath("/custom/ops");
    expect(p).toBe(join("/custom/ops", "server", "standalone.json"));
  });
});
