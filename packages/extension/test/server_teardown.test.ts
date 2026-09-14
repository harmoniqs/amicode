import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHandshake, PROTOCOL_VERSION, type HandshakeRecord } from "../src/server_handshake";
import { stopSurvivingServer, type TeardownDeps } from "../src/rebuild/server_teardown";

// ============================================================================
// #1178 — confirm-before-delete teardown.
//
// The rebuild's pre-deploy teardown must NEVER delete the handshake unless the
// target PORT is verified free. It targets the port (using the recorded PID as
// a hint, not the authority): after killing the recorded PID it re-probes the
// port; if still occupied it escalates to kill-by-port; if the port cannot be
// freed it returns a hard, surfaced failure with the handshake PRESERVED.
//
// Every process/port seam is injected so tests need no real processes.
// ============================================================================

const TEST_PORT = 43117;

function tmpHandshakePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "teardown-test-"));
  return join(dir, "server", "standalone.json");
}

function sampleRecord(overrides?: Partial<HandshakeRecord>): HandshakeRecord {
  return {
    port: TEST_PORT,
    pid: 12345,
    startedAt: new Date().toISOString(),
    password: "test-password-base64url",
    binaryHash: "abc123",
    configHash: "def456",
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

/**
 * Build a deterministic port/process world for teardown.
 *
 * `portHolder` is the PID currently holding the port (null = port free).
 * `alivePids` is the set of PIDs that answer the existence probe.
 * `killFrees(pid)` decides whether killing `pid` releases the port; when it
 * returns true the holder is cleared. A stubborn process returns false forever.
 */
function world(opts: {
  portHolder: number | null;
  alivePids?: number[];
  killFrees?: (pid: number) => boolean;
}) {
  const state = { holder: opts.portHolder };
  const alive = new Set(opts.alivePids ?? (opts.portHolder !== null ? [opts.portHolder] : []));
  const killFrees = opts.killFrees ?? ((pid: number) => pid === state.holder);
  const seen = { pidOnPortCalls: 0, killed: [] as Array<{ pid: number; signal: string }> };

  const deps: TeardownDeps = {
    log: () => {},
    fallbackPort: TEST_PORT,
    isPortOccupied: () => state.holder !== null,
    pidOnPort: () => {
      seen.pidOnPortCalls++;
      return state.holder ?? undefined;
    },
    isAlive: (pid: number) => alive.has(pid),
    kill: (pid: number, signal) => {
      seen.killed.push({ pid, signal: String(signal) });
      if (killFrees(pid)) {
        state.holder = null;
        alive.delete(pid);
      }
    },
    sleep: async () => {},
  };
  return { deps, state, seen };
}

// ── AC: confirm-before-delete — stale recorded PID escalates to kill-by-port ──

describe("stopSurvivingServer — stale recorded PID → kill-by-port", () => {
  it("escalates to kill-by-port when the recorded PID is stale, then deletes on a freed port", async () => {
    const fp = tmpHandshakePath();
    // Recorded PID 99999 is stale (dead); the REAL holder is 4242.
    writeHandshake(sampleRecord({ pid: 99999 }), fp);
    const { deps, state, seen } = world({ portHolder: 4242, alivePids: [4242] });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.stopped).toBe(true);
    expect(result.failed).toBeFalsy();
    expect(result.method).toBe("kill-by-port");
    expect(seen.pidOnPortCalls).toBeGreaterThan(0); // escalation happened
    expect(seen.killed.some((k) => k.pid === 4242)).toBe(true);
    expect(state.holder).toBeNull(); // port freed
    expect(existsSync(fp)).toBe(false); // handshake deleted only after free
  });
});

// ── AC: hard failure when the port can't be freed — no silent orphan ──

describe("stopSurvivingServer — process survives SIGTERM + SIGKILL", () => {
  it("returns a hard failure and PRESERVES the handshake when the port cannot be freed", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord({ pid: 4242 }), fp);
    // Stubborn: killing anything never frees the port.
    const { deps } = world({ portHolder: 4242, alivePids: [4242], killFrees: () => false });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.failed).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.error).toContain(String(TEST_PORT));
    expect(existsSync(fp)).toBe(true); // NEVER delete while the server holds the port
  });

  it("a stale 'already dead' recorded PID does not license a delete while the port is still held", async () => {
    const fp = tmpHandshakePath();
    // Recorded PID looks dead, but a DIFFERENT live process holds the port and
    // survives every kill — the old 'already-dead → delete' branch would orphan it.
    writeHandshake(sampleRecord({ pid: 99999 }), fp);
    const { deps } = world({ portHolder: 4242, alivePids: [4242], killFrees: () => false });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.failed).toBe(true);
    expect(existsSync(fp)).toBe(true);
  });
});

// ── AC: port verified free → handshake deleted ──

describe("stopSurvivingServer — port verified free → delete", () => {
  it("deletes the handshake after SIGTERM frees the recorded PID's port", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord({ pid: 4242 }), fp);
    const { deps, state } = world({ portHolder: 4242, alivePids: [4242] });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.stopped).toBe(true);
    expect(result.failed).toBeFalsy();
    expect(result.method).toBe("handshake");
    expect(state.holder).toBeNull();
    expect(existsSync(fp)).toBe(false);
  });

  it("clears a stale handshake when the port is already free (nothing to kill)", async () => {
    const fp = tmpHandshakePath();
    writeHandshake(sampleRecord({ pid: 12345 }), fp);
    const { deps, seen } = world({ portHolder: null });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.stopped).toBe(false);
    expect(result.failed).toBeFalsy();
    expect(seen.killed).toHaveLength(0); // never killed anything — port was free
    expect(existsSync(fp)).toBe(false); // safe to clear: port confirmed free
  });
});

// ── AC: orphan with no handshake — occupied port is freed by port ──

describe("stopSurvivingServer — no handshake, orphaned port", () => {
  it("frees an occupied port via kill-by-port even with no handshake record", async () => {
    const fp = tmpHandshakePath(); // no file written
    const { deps, state } = world({ portHolder: 7777, alivePids: [7777] });

    const result = await stopSurvivingServer({ ...deps, handshakePath: fp });

    expect(result.stopped).toBe(true);
    expect(result.method).toBe("kill-by-port");
    expect(state.holder).toBeNull();
  });
});
