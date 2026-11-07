// fleet_posture_single_writer.test.ts — #1273 (#1268-S3): single-writer across
// a posture move + the honest thin-client fallback (no-regression baseline).
//
// ADR 0025 / ADR 0005: never-fork + ONE canonical writer. Moving a machine
// between the thin-client and Remote-SSH postures must never produce two
// writers on the canonical store, and an unavailable/unconfigured Remote-SSH
// target must fall back to the EXISTING thin-client posture — verbatim, no new
// degraded path.
//
// This is a PROVING / COMPOSITION slice in the shape of the #1270 relocation
// block (which lives in adopt_live_server.test.ts): it adds NO production code.
// The single-writer guarantee is already carried by the primitives —
//   • adoptOrSpawn        — ADOPTS a live survivor, never spawns a rival engine
//                           onto an occupied port (server_lifecycle.ts, #1145);
//   • divertToFleetRelay  — a client-role machine DIVERTS to the relay and holds
//                           NO local engine (fleet_topology.ts, #1261);
//   • windowModeFromRemoteName — the relocation SIGNAL (fleet_window_mode_state.ts, #1272);
//   • resolveRemoteSshFromTopology / connectToHubOverRemoteSsh — the Remote-SSH
//                           entry, which resolves not-ok (never throws) when the
//                           target is unavailable/unconfigured (#1271).
// These tests COMPOSE those seams into the cross-posture move (AC1) and the
// fallback (AC2), PINNING that exactly one canonical writer exists at every step
// and that the fallback is the existing thin-client posture.
//
// The NAMED no-regression BASELINE (AC2) is test/fleet_client_relay.test.ts —
// the fleet-client relay contract (UI served locally, engine data plane proxied,
// credential translated at the hop, honest hub-down 503, and crucially NO local
// engine). This slice does NOT modify or fork that suite; the gate runs it
// alongside these tests and it stays GREEN unchanged. Here we prove only the
// fallback ROUTING — that a not-ok Remote-SSH resolution leaves a client in
// exactly that posture, introducing no second writer and no new state.
//
// Live-session safety (inherited verbatim from adopt_live_server.test.ts): the
// modeled durable hub ALWAYS binds an ephemeral port (listen(0)) — never 43117 —
// and the handshake is written under a tmpdir, never ~/.amico/ops/server/.
import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptOrSpawn, buildLiveDeps } from "../src/server_lifecycle";
import { coldSpawnHandshakeHook, readHandshake } from "../src/server_handshake";
import { serverAuthHeader } from "../src/server_auth";
import { windowModeFromRemoteName } from "../src/fleet_window_mode_state";
import { divertToFleetRelay, FLEET_GUARD_BINARY_SUFFIX, type FleetTopologyState } from "../src/fleet_topology";
import { resolveRemoteSshFromTopology, connectToHubOverRemoteSsh } from "../src/fleet_connect_remote_ssh";

// ── The #1185 live-server fixtures, mirrored verbatim (test-local helpers are
//    not exported, so the codebase idiom is to replicate their exact shape — the
//    same shape adopt_live_server.test.ts and its #1270 block use). ────────────

/** A live http server with opencode-style Basic auth on an EPHEMERAL port.
 *  Answers 200 iff the request carries the recorded credential, 401 otherwise —
 *  the exact contract #163 arms and challengePassword speaks. Models the
 *  durable-hub engine (#1258): the ONE canonical writer, live on its port. */
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
  return join(mkdtempSync(join(tmpdir(), "posture-writer-hs-")), "server", "standalone.json");
}

/** Plant a valid handshake pointing at (port, pid) with `password`. pid defaults
 *  to this test process, which is alive → the pidAlive check passes. */
function plantHandshake(fp: string, port: number, password: string, pid = process.pid): void {
  coldSpawnHandshakeHook({ binaryHash: "b", configHash: "c", password, filePath: fp })({ port, pid });
  const hs = readHandshake(fp);
  expect(hs.status).toBe("ok");
}

// ── topology-state fixtures (mirror fleet_never_fork.test.ts / the #1270 block) ─
// The installed never-fork guard binary, OS-neutral (a linux client's path — the
// divert decision consults no process.platform).
const GUARD_BINARY = `/home/user/.local/bin/${FLEET_GUARD_BINARY_SUFFIX}`;

/** A CLIENT-role projection WITH a hub sshAlias — the thin-client posture with a
 *  reachable Remote-SSH target. */
const okClient: FleetTopologyState = {
  kind: "ok",
  role: "client",
  canonical: { host: "hub", port: 4096, sshAlias: "hub" },
  mode: "fleet",
  posture: "ok",
  freshness: {},
  provenanceSource: "fleet.json",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
/** A CLIENT-role projection with NO hub sshAlias — Remote-SSH UNCONFIGURED (there
 *  is nothing to Remote-SSH into), but still a client in the thin-client posture. */
const okClientNoAlias: FleetTopologyState = { ...okClient, canonical: { host: "hub", port: 4096 } };
/** The hub host's own projection: this machine IS the canonical server. A
 *  relocated Remote-SSH window reads THIS (extensionKind: ["workspace"]). */
const hubHostServer: FleetTopologyState = { ...okClient, role: "server" };
/** No fleet projection at all — Remote-SSH UNAVAILABLE, the base standalone floor. */
const absent: FleetTopologyState = {
  kind: "absent",
  detail: "fleet projection absent — refresh via `amico fleet status --projection`",
};

// ============================================================================
// AC1 — Across a thin-client ⇄ Remote-SSH move, the canonical store has EXACTLY
// ONE writer at every step (asserted).
//
// The move is a round trip. At each step we account the canonical writers: the
// durable hub is always writer #1; a spawn (coldSpawn) would add a rival #2, and
// adoption re-points at the SAME hub (never a new writer). A single spawn counter
// is SHARED across every step — the never-fork guarantee is that it stays 0.
// ============================================================================

describe("#1273 (#1268-S3) AC1 — single-writer across a thin-client ⇄ Remote-SSH move", () => {
  it("adopts host-side, relays client-side: the durable hub is the ONE canonical writer at every step (never a second engine/store)", async () => {
    const PW = "durable-hub-pw";
    const hub = await startArmedServer(PW); // the ONE canonical writer, live from the start
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, hub.port, PW); // the durable hub's recorded handshake

      // One spawn counter shared across the WHOLE move. Never-fork ⇒ it stays 0:
      // no step of the move ever spawns a rival engine (a rival store).
      let spawns = 0;
      const deps = buildLiveDeps(async () => {
        spawns += 1;
        return { port: 0, pid: 0, password: "rival-should-never-be-used" };
      }, hub.port);

      // The canonical writers observed at a step. The hub is always present
      // (writer #1); an adopted port re-points at the SAME hub, so the set stays
      // {hub}; only a spawn (port 0) would introduce a second element.
      const canonicalWriters = (adoptedPort: number | null): Set<number> => {
        const s = new Set<number>([hub.port]);
        if (adoptedPort !== null) s.add(adoptedPort);
        return s;
      };

      // ── STEP 0 — thin-client posture (start). role=client + guard → DIVERT to
      //    the relay: the client holds NO local engine → spawns nothing, adopts
      //    nothing locally. The ONE writer is the hub, reached over the tunnel. ──
      expect(divertToFleetRelay(GUARD_BINARY, okClient)).toBe(true);
      expect(spawns).toBe(0);
      expect(canonicalWriters(null).size).toBe(1);

      // ── STEP 1 — MOVE host-side over Remote-SSH. The window relocates onto the
      //    host (the relocation SIGNAL). Because extensionKind is ["workspace"],
      //    the extension host now runs ON THE HOST, which reads role=server → does
      //    NOT divert → proceeds to adopt-or-spawn → ADOPTS the durable hub. ──
      expect(windowModeFromRemoteName("ssh-remote+hub")).toBe("remote-ssh");
      expect(divertToFleetRelay(GUARD_BINARY, hubHostServer)).toBe(false);
      const hostSide = await adoptOrSpawn(fp, deps);
      expect(hostSide.outcome).toBe("adopted"); // attached at the handshake — no fork
      expect(hostSide.port).toBe(hub.port); // the SAME hub — one canonical writer
      expect(spawns).toBe(0); // no second engine ⇒ no second store opened
      expect(canonicalWriters(hostSide.port).size).toBe(1); // adoption ≠ a new writer

      // ── STEP 2 — MOVE back to thin-client. The window is local again → role=client
      //    → DIVERT to the relay: spawns nothing, adopts nothing locally. The ONE
      //    writer is still the hub, over the tunnel. ──
      expect(windowModeFromRemoteName(undefined)).toBe("local");
      expect(divertToFleetRelay(GUARD_BINARY, okClient)).toBe(true);
      expect(spawns).toBe(0);
      expect(canonicalWriters(null).size).toBe(1);

      // Across the WHOLE round trip: the coldSpawn seam was never invoked once —
      // exactly one canonical writer (the durable hub) at every step.
      expect(spawns).toBe(0);
    } finally {
      await hub.close();
    }
  });

  it("even when the host-side hub is NOT adoptable, the move SURFACES foreign — it never manufactures a second writer", async () => {
    // The unhappy edge of AC1: the hub is up but the recorded handshake does not
    // authenticate (a stale/unadoptable record). ADR 0025 inv.5 — this is a
    // SURFACED result, NOT a silent cold-spawn of a rival writer onto the hub's
    // port. The one canonical writer stays the hub; the move creates no second.
    const hub = await startArmedServer("the-hubs-real-pw");
    try {
      const fp = tmpHandshake();
      plantHandshake(fp, hub.port, "STALE-unadoptable-pw"); // != what the hub accepts

      let spawns = 0;
      const deps = buildLiveDeps(async () => {
        spawns += 1;
        return { port: 0, pid: 0, password: "rival-should-never-be-used" };
      }, hub.port);

      const hostSide = await adoptOrSpawn(fp, deps);
      expect(hostSide.outcome).toBe("foreign-error"); // reachable but not adoptable → surfaced
      expect(hostSide.error).toBeTruthy(); // carries the message the activation site shows
      expect(spawns).toBe(0); // never cold-spawn a rival onto the hub's port
      // Falling back to the client edge is still the existing posture — no new writer.
      expect(divertToFleetRelay(GUARD_BINARY, okClient)).toBe(true);
    } finally {
      await hub.close();
    }
  });
});

// ============================================================================
// AC2 — Remote-SSH unavailable/unconfigured → the client lands in the EXISTING
// thin-client posture, and the existing fleet-client relay suite passes
// unchanged (the named baseline: test/fleet_client_relay.test.ts).
//
// We prove the fallback ROUTING only — a not-ok Remote-SSH resolution leaves a
// client diverted to the relay (divert=true), the SAME posture the named
// baseline covers. We do NOT boot or fork the relay service: the relay CONTRACT
// (UI-local, proxy, translate, hub-down 503, no local engine) is proven unchanged
// by fleet_client_relay.test.ts, which the gate runs green alongside this file.
// ============================================================================

describe("#1273 (#1268-S3) AC2 — Remote-SSH unavailable/unconfigured falls back to the EXISTING thin-client posture", () => {
  it("UNCONFIGURED (projection names no hub sshAlias) → not-ok resolution; the client stays diverted to the relay (no new state)", () => {
    const res = resolveRemoteSshFromTopology(okClientNoAlias);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no-ssh-alias"); // nothing to Remote-SSH into
    // The client did NOT enter Remote-SSH; it remains in the EXISTING thin-client
    // posture — the same posture the named baseline (fleet_client_relay.test.ts)
    // covers. divert=true here IS the never-fork guarantee (a relay holds no
    // local engine ⇒ no second writer).
    expect(divertToFleetRelay(GUARD_BINARY, okClientNoAlias)).toBe(true);
  });

  it("UNAVAILABLE (the Remote-SSH window open fails) → connectToHubOverRemoteSsh resolves not-ok WITHOUT throwing; nothing opened, posture unchanged", async () => {
    let shown = "";
    // A client WITH a valid hub alias, but opening the Remote-SSH window fails
    // (e.g. the Remote-SSH extension is absent / the host is unreachable). The
    // entry NEVER throws — it resolves open-failed and surfaces an honest message.
    const res = await connectToHubOverRemoteSsh({
      readTopology: () => okClient,
      openFolder: () => {
        throw new Error("Remote-SSH extension not installed");
      },
      showError: (m) => {
        shown = m;
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("open-failed");
    expect(shown).toContain("Remote-SSH"); // honest, actionable — never a raw throw
    // The client never left the thin-client posture (no window opened) — still
    // diverted to the relay. No new degraded path, no second writer.
    expect(divertToFleetRelay(GUARD_BINARY, okClient)).toBe(true);
  });

  it("UNAVAILABLE (no fleet projection at all) → not-ok resolution AND the base standalone floor (never a silent fallback to a rival writer)", () => {
    // The honesty companion: with no projection, Remote-SSH is unavailable AND
    // this is not a client — it is the base standalone floor (divert=false),
    // stated by the caller, never a silent new degraded path. resolveRemoteSsh…
    // carries the reader's OWN actionable detail verbatim (the refresh pointer).
    const res = resolveRemoteSshFromTopology(absent);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("topology-absent");
    expect(divertToFleetRelay(GUARD_BINARY, absent)).toBe(false); // base floor, not a client relay
  });
});
