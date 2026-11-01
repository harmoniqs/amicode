import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  writeHandshake,
  deleteHandshake,
  PROTOCOL_VERSION,
  restartMarkerPath,
  writeRestartMarker,
  clearRestartMarker,
  isRestartInProgress,
  type HandshakeRecord,
} from "../src/server_handshake";
import { adoptOrSpawn, type AdoptOrSpawnDeps } from "../src/server_lifecycle";

// #1420 — a restart in one window must not look "stale" to a second window's
// adopt-or-spawn: the restart marker covers the delete-handshake → new-handshake gap.

function tmpHandshakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "restart-race-"));
  return join(dir, "server", "standalone.json");
}

function record(overrides?: Partial<HandshakeRecord>): HandshakeRecord {
  return {
    port: 43117,
    pid: 4242,
    startedAt: new Date().toISOString(),
    password: "new-pw",
    binaryHash: "a",
    configHash: "b",
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

function deps(overrides?: Partial<AdoptOrSpawnDeps>): AdoptOrSpawnDeps {
  return {
    healthCheck: async () => true,
    pidAlive: () => true,
    passwordChallenge: async () => true,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn: async () => ({ port: 1, pid: 1, password: "rival" }),
    ...overrides,
  };
}

describe("restart marker (#1420)", () => {
  it("lives next to the handshake file", () => {
    const hp = tmpHandshakePath();
    expect(dirname(restartMarkerPath(hp))).toBe(dirname(hp));
  });

  it("write → in progress; clear → not in progress; clear is idempotent", () => {
    const hp = tmpHandshakePath();
    const mp = restartMarkerPath(hp);
    expect(isRestartInProgress(mp)).toBe(false);
    writeRestartMarker(mp);
    expect(existsSync(mp)).toBe(true);
    expect(isRestartInProgress(mp)).toBe(true);
    clearRestartMarker(mp);
    expect(isRestartInProgress(mp)).toBe(false);
    expect(() => clearRestartMarker(mp)).not.toThrow();
  });

  it("an expired marker is ignored (crashed restarter)", () => {
    const mp = restartMarkerPath(tmpHandshakePath());
    writeRestartMarker(mp, { now: () => Date.now() - 10 * 60_000 });
    expect(isRestartInProgress(mp)).toBe(false);
  });

  it("a marker whose writer pid is dead is ignored", () => {
    const mp = restartMarkerPath(tmpHandshakePath());
    writeRestartMarker(mp);
    expect(isRestartInProgress(mp, { pidAlive: () => false })).toBe(false);
  });

  it("a garbage marker is ignored", () => {
    const mp = restartMarkerPath(tmpHandshakePath());
    mkdirSync(dirname(mp), { recursive: true });
    writeFileSync(mp, "not json");
    expect(isRestartInProgress(mp)).toBe(false);
  });
});

describe("adoptOrSpawn waits out a restart in progress (#1420)", () => {
  it("does NOT cold-spawn when the handshake is absent but a restart marker is live; adopts the new handshake", async () => {
    const hp = tmpHandshakePath();
    const mp = restartMarkerPath(hp);
    // the restarter has deleted the handshake and published its marker
    writeRestartMarker(mp);
    let spawned = false;
    const logs: string[] = [];
    // the restarting window finishes ~600ms later: handshake written, marker cleared
    setTimeout(() => {
      writeHandshake(record(), hp);
      clearRestartMarker(mp);
    }, 600);
    const res = await adoptOrSpawn(
      hp,
      deps({ coldSpawn: async () => { spawned = true; return { port: 1, pid: 1, password: "x" }; }, log: (l) => logs.push(l) }),
    );
    expect(spawned).toBe(false);
    expect(res.outcome).toBe("adopted");
    expect(res.password).toBe("new-pw");
    expect(logs.join("\n")).toMatch(/restart in progress/i);
  });

  it("falls through to cold-spawn when the marker never clears within the budget", async () => {
    const hp = tmpHandshakePath();
    writeRestartMarker(restartMarkerPath(hp));
    let spawned = false;
    const res = await adoptOrSpawn(
      hp,
      deps({ restartWaitBudgetMs: 400, coldSpawn: async () => { spawned = true; return { port: 1, pid: 1, password: "x" }; } }),
    );
    expect(spawned).toBe(true);
    expect(res.outcome).toBe("cold-spawned");
  });

  it("also waits when a stale OLD handshake is still on disk during a restart", async () => {
    const hp = tmpHandshakePath();
    const mp = restartMarkerPath(hp);
    writeHandshake(record({ pid: 1111, password: "old-pw" }), hp);
    writeRestartMarker(mp);
    setTimeout(() => {
      writeHandshake(record(), hp);
      clearRestartMarker(mp);
    }, 400);
    let spawned = false;
    const res = await adoptOrSpawn(
      hp,
      deps({
        coldSpawn: async () => { spawned = true; return { port: 1, pid: 1, password: "x" }; },
        passwordChallenge: async (_p, pw) => pw === "new-pw",
      }),
    );
    expect(spawned).toBe(false);
    expect(res.outcome).toBe("adopted");
    expect(res.password).toBe("new-pw");
  });

  it("no marker → behaves exactly as before (absent handshake cold-spawns immediately)", async () => {
    const hp = tmpHandshakePath();
    deleteHandshake(hp);
    const t0 = Date.now();
    const res = await adoptOrSpawn(hp, deps());
    expect(res.outcome).toBe("cold-spawned");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
