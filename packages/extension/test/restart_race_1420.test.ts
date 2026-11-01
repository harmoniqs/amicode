// #1420 — restarting the server races a second window's activation.
//
// `amicode.restartServer` deletes the handshake before the replacement server's
// handshake is written. A second window activating in that gap sees "no
// handshake" and reclaims the port / cold-spawns a rival. The fix: the
// restarting window publishes a restart-in-progress marker; adopt-or-spawn
// waits for a NEW handshake (startedAt >= marker) while the marker is fresh,
// and never adopts or spawns over the restart.
//
// RED list (derived from the issue's repro — the issue body carries no
// Acceptance Criteria section):
//   AC1  no handshake + fresh marker → wait, adopt the replacement; no reclaim, no spawn
//   AC2  old live handshake + fresh marker → do NOT adopt the old record; adopt the replacement
//   AC3  stale marker (crashed restart) → no wait; normal cold-spawn path
//   AC4  fresh marker, replacement never appears → budget expires → normal fallthrough
//   AC5  marker helpers round-trip (mark → in-progress → clear → not in progress)
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeHandshake,
  readHandshake,
  PROTOCOL_VERSION,
  type HandshakeRecord,
} from "../src/server_handshake";
import {
  markRestartInProgress,
  clearRestartInProgress,
  restartInProgressSince,
  restartMarkerPath,
  RESTART_MARKER_MAX_AGE_MS,
} from "../src/server_handshake";
import { adoptOrSpawn, type AdoptOrSpawnDeps } from "../src/server_lifecycle";

function tmpHandshakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "restart-race-1420-"));
  return join(dir, "server", "standalone.json");
}

function record(overrides?: Partial<HandshakeRecord>): HandshakeRecord {
  return {
    port: 43117,
    pid: 12345,
    startedAt: new Date().toISOString(),
    password: "old-pw",
    binaryHash: "b",
    configHash: "c",
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

function deps(overrides?: Partial<AdoptOrSpawnDeps>): AdoptOrSpawnDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    healthCheck: async () => true,
    pidAlive: () => true,
    passwordChallenge: async () => true,
    protocolVersion: PROTOCOL_VERSION,
    coldSpawn: async () => { calls.push("coldSpawn"); return { port: 55555, pid: 99999, password: "spawned" }; },
    configuredPort: 43117,
    probePort: async () => { calls.push("probePort"); return { occupied: true, isOurServer: true, pid: 777 }; },
    reclaimPort: async () => { calls.push("reclaimPort"); return true; },
    restartPollBudgetMs: 3000,
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("#1420 AC1 — fresh restart marker, no handshake yet", () => {
  it("waits for the replacement handshake and adopts it; never reclaims or cold-spawns", async () => {
    const fp = tmpHandshakePath();
    markRestartInProgress(fp);
    // The restarting window's replacement server publishes its handshake later.
    setTimeout(() => {
      writeHandshake(record({ port: 43117, pid: 4242, password: "new-pw", startedAt: new Date().toISOString() }), fp);
    }, 300);

    const d = deps();
    const result = await adoptOrSpawn(fp, d);

    expect(result.outcome).toBe("adopted");
    expect(result.pid).toBe(4242);
    expect(result.password).toBe("new-pw");
    expect(d.calls).toEqual([]);
  });
});

describe("#1420 AC2 — fresh restart marker, old live handshake still on disk", () => {
  it("does not adopt the about-to-die old record; adopts the replacement", async () => {
    const fp = tmpHandshakePath();
    // Old server: live, healthy, authenticated — the restart is about to kill it.
    const oldStartedAt = new Date(Date.now() - 60_000).toISOString();
    writeHandshake(record({ pid: 1111, startedAt: oldStartedAt }), fp);
    markRestartInProgress(fp);
    setTimeout(() => {
      writeHandshake(record({ pid: 2222, password: "new-pw", startedAt: new Date().toISOString() }), fp);
    }, 300);

    const d = deps();
    const result = await adoptOrSpawn(fp, d);

    expect(result.outcome).toBe("adopted");
    expect(result.pid).toBe(2222);
    expect(d.calls).toEqual([]);
  });
});

describe("#1420 AC3 — stale marker from a crashed restart", () => {
  it("ignores a marker older than the max age and takes the normal cold-spawn path", async () => {
    const fp = tmpHandshakePath();
    markRestartInProgress(fp, Date.now() - RESTART_MARKER_MAX_AGE_MS - 5_000);

    const d = deps({ probePort: async () => ({ occupied: false, isOurServer: false }) });
    const t0 = Date.now();
    const result = await adoptOrSpawn(fp, d);

    expect(result.outcome).toBe("cold-spawned");
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("#1420 AC4 — fresh marker, replacement never appears", () => {
  it("falls through to the normal path once the poll budget expires", async () => {
    const fp = tmpHandshakePath();
    markRestartInProgress(fp);

    const d = deps({ restartPollBudgetMs: 400, probePort: async () => ({ occupied: false, isOurServer: false }) });
    const result = await adoptOrSpawn(fp, d);

    expect(result.outcome).toBe("cold-spawned");
    expect(d.calls).toEqual(["coldSpawn"]);
  });
});

describe("#1420 AC5 — marker helpers", () => {
  it("mark → in progress → clear → not in progress; marker lives beside the handshake", () => {
    const fp = tmpHandshakePath();
    expect(restartMarkerPath(fp)).toBe(`${fp}.restarting`);
    expect(restartInProgressSince(fp)).toBeUndefined();

    markRestartInProgress(fp, 1_000_000);
    expect(restartInProgressSince(fp, 1_000_000 + 1000)).toBe(1_000_000);

    clearRestartInProgress(fp);
    expect(restartInProgressSince(fp)).toBeUndefined();
    // clearing an absent marker is a no-op
    expect(() => clearRestartInProgress(fp)).not.toThrow();
    // the handshake file itself is never touched by the marker
    expect(readHandshake(fp).status).toBe("absent");
  });
});
