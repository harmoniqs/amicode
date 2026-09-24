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
import { windowModeFromRemoteName } from "../src/fleet_window_mode_state";
import { divertToFleetRelay, type FleetTopologyState } from "../src/fleet_topology";

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

// ============================================================================
// #1270 — host-side relocation over Remote-SSH: attach to the durable hub,
// never fork at the handshake seam (ADR 0025, invariants 2 + 5).
//
// Scenario: a VS Code Remote-SSH window is opened ONTO the durable-hub host.
// Because the extension declares `extensionKind: ["workspace"]`, the extension
// host RELOCATES to the host — where the durable-hub engine (#1258) already runs
// on the canonical port with its handshake recorded. The host-side activation
// must ADOPT that engine at the handshake (AC2: no second engine, no second
// store), and when the running hub presents NO adoptable handshake it must
// SURFACE the foreign/failed result — never a silent cold-spawn of a rival
// writer (AC3). ADR 0025 inv.2: "Remote-SSH runs the engine on the host,
// adopting the durable hub service; it does not spawn a client-side shard."
//
// This is a COMPOSITION of the three seams the host-side path walks, end to end
// — proving the never-fork guarantee holds for the relocation scenario. It adds
// no production code: the existing adoptOrSpawn primitive + its activation
// wiring already surface foreign/incompatible outcomes without spawning; this
// test PINS that they do so for the relocation case specifically.
//   1. windowModeFromRemoteName — the relocation SIGNAL (#1272): ssh-remote → remote-ssh
//   2. divertToFleetRelay       — the hub host is role=server, so it does NOT
//                                 divert to a client relay; it PROCEEDS to adopt-or-spawn
//   3. adoptOrSpawn             — against the live durable-hub survivor: adopts / surfaces
//
// It reuses the #1185 live-server fixtures VERBATIM (startArmedServer /
// tmpHandshake / plantHandshake): the durable hub is modeled by the same
// password-armed loopback server on an EPHEMERAL port (never 43117; handshake
// under a tmpdir) — the same live-session safety this file already holds.
// ============================================================================

/** A Remote-SSH window onto the hub host reads role=server from the host's own
 *  fleet projection (this machine IS the canonical server). Mirrors the
 *  fleet_never_fork.test.ts server fixture. */
const hubHostServerState: FleetTopologyState = {
  kind: "ok",
  role: "server",
  canonical: { host: "hub", port: 43117, sshAlias: "hub" },
  mode: "fleet",
  posture: "ok",
  freshness: {},
  provenanceSource: "fleet.json",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
/** The installed never-fork guard binary as a host would carry it. */
const GUARD_BINARY = "/home/user/.local/bin/amico-opencode-fleet-guard";

describe("#1270 host-side relocation over Remote-SSH — adopt the durable hub, never fork", () => {
  it("detects the host-side relocation SIGNAL: an ssh-remote window is remote-ssh, a local window is not (#1272 seam)", () => {
    // The signal the host-side path keys on. `ssh-remote…` → the window relocated
    // onto the host; `undefined`/other remotes → local (not this scenario). This
    // is the detection the sibling slices (#1271/#1273/#1274) reuse.
    expect(windowModeFromRemoteName("ssh-remote+deadbeef")).toBe("remote-ssh");
    expect(windowModeFromRemoteName(undefined)).toBe("local");
  });

  it("on the hub host the relocated extension does NOT divert to a client relay — it proceeds to adopt-or-spawn", () => {
    // ADR 0025 inv.2 / mount_policy.ts: a Remote-SSH client runs the extension
    // host ON THE HOST, which reads role=server — NOT a fleet client. So it never
    // relays; it reaches the adopt path. A regression that diverted server-role
    // to the relay would silently break host-side adoption — this pins it shut.
    expect(divertToFleetRelay(GUARD_BINARY, hubHostServerState)).toBe(false);
  });

  it("ADOPTS the running durable-hub engine at the handshake — no second engine, no second store (AC2)", async () => {
    // Relocation signal present (proven above); the durable hub is live on the
    // canonical (here ephemeral) port with its handshake recorded.
    expect(windowModeFromRemoteName("ssh-remote+hub")).toBe("remote-ssh");

    const PW = "durable-hub-pw";
    const hub = await startArmedServer(PW);
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, hub.port, PW); // the durable hub's recorded handshake

      let spawned = false;
      const deps = buildLiveDeps(async () => {
        spawned = true; // a SECOND engine spawn — the never-fork violation
        return { port: 0, pid: 0, password: "rival-should-not-be-used" };
      }, hub.port);

      const result = await adoptOrSpawn(fp, deps);

      expect(result.outcome).toBe("adopted"); // attached at the handshake, no fork
      expect(result.port).toBe(hub.port);     // the SAME hub — one canonical writer
      expect(result.password).toBe(PW);       // recorded credential reused verbatim
      // No second engine spawned → no second store/DB opened (a store is only
      // opened by a spawned engine; adoption reuses the survivor's).
      expect(spawned).toBe(false);
    } finally {
      await hub.close();
    }
  });

  it("when the running hub presents NO adoptable handshake, SURFACES foreign — never a silent cold-spawn (AC3)", async () => {
    // The hub is up and reachable, but the recorded handshake credential does not
    // authenticate (an unrecognized / unadoptable handshake). ADR 0025 inv.5:
    // this is a SURFACED result (foreign-error carries the message the activation
    // site shows), NOT a silent cold-spawn of a rival writer onto the hub's port.
    const hub = await startArmedServer("the-hubs-real-pw");
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, hub.port, "STALE-unadoptable-pw"); // != what the hub accepts

      let spawned = false;
      const deps = buildLiveDeps(async () => {
        spawned = true;
        return { port: 0, pid: 0, password: "rival-should-not-be-used" };
      }, hub.port);

      const result = await adoptOrSpawn(fp, deps);

      expect(result.outcome).toBe("foreign-error"); // reachable but not adoptable → surfaced
      expect(result.error).toBeTruthy();             // carries the message the UI surfaces
      expect(spawned).toBe(false);                   // never cold-spawn a rival onto the hub's port
    } finally {
      await hub.close();
    }
  });
});
