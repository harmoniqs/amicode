// fleet_never_fork.test.ts — #1261 (Slice 1) AC3: cross-platform never-fork.
//
// The load-bearing cross-platform assertion. A fleet CLIENT spawns NO local
// engine — on macOS, linux, AND WSL alike (ADR 0005's never-fork, held on all
// platforms). The bug this pins dead: `isFleetClientGuard` early-returned on
// `process.platform !== "darwin"`, so a linux/WSL client silently cold-spawned
// a local engine (the ADR-0005 split-brain the guard exists to prevent, #1227).
//
// The role read is OS-neutral (the projection, via fleet_topology). So the
// divert-to-relay decision is PLATFORM-AGNOSTIC by construction — this test
// asserts that directly (a NON-darwin fixture gets the same `true` a mac does)
// and guards the source against the darwin early-return returning.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { divertToFleetRelay, FLEET_GUARD_BINARY_SUFFIX, type FleetTopologyState } from "../src/fleet_topology";

// The guard binary as a linux client would carry it (~/.local/bin) — the
// installed never-fork signal, OS-neutral.
const GUARD_BINARY = `/home/user/.local/bin/${FLEET_GUARD_BINARY_SUFFIX}`;

const okClient: FleetTopologyState = {
  kind: "ok",
  role: "client",
  canonical: { host: "canon", port: 4096, sshAlias: "canon" },
  mode: "fleet",
  posture: "ok",
  freshness: {},
  provenanceSource: "fleet.json",
  projection: { schema_version: 1, contract_version: 1, sections: {} },
};
const okServer: FleetTopologyState = { ...okClient, role: "server" };
const okStandalone: FleetTopologyState = { ...okClient, role: "standalone" };
const absent: FleetTopologyState = { kind: "absent", detail: "fleet projection absent — refresh via `amico fleet status --projection`" };
const broken: FleetTopologyState = { kind: "broken", detail: "contract v2; consumer speaks v1 — refusing loudly" };

describe("cross-platform never-fork (#1261 AC3)", () => {
  it("a client-role machine with the guard binary diverts to the relay — the NON-darwin fixture gets the same true a mac does (platform-agnostic)", () => {
    // divertToFleetRelay consults NO process.platform: this true holds on
    // linux and WSL exactly as it does on darwin. That is the whole fix.
    expect(divertToFleetRelay(GUARD_BINARY, okClient)).toBe(true);
  });

  it("server and standalone roles never divert — they spawn/attach normally on every platform", () => {
    expect(divertToFleetRelay(GUARD_BINARY, okServer)).toBe(false);
    expect(divertToFleetRelay(GUARD_BINARY, okStandalone)).toBe(false);
  });

  it("without the guard binary configured, never divert — the installed guard is the OS-neutral signal", () => {
    expect(divertToFleetRelay(undefined, okClient)).toBe(false);
    expect(divertToFleetRelay("/usr/local/bin/opencode", okClient)).toBe(false);
    expect(divertToFleetRelay("", okClient)).toBe(false);
  });

  it("absent / broken projections are the base standalone floor — NOT a client (spawn locally, stated by the caller)", () => {
    expect(divertToFleetRelay(GUARD_BINARY, absent)).toBe(false);
    expect(divertToFleetRelay(GUARD_BINARY, broken)).toBe(false);
  });

  it("extension.ts's isFleetClientGuard carries NO `process.platform !== \"darwin\"` early-return (the removed load-bearing bug)", () => {
    // The codebase's source-guard idiom (fleet_topology_single_parser pattern):
    // the client-role decision must not gate on platform — a reintroduced
    // darwin early-return fails here even if no behavioral test catches it.
    const s = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
    const start = s.indexOf("function isFleetClientGuard");
    expect(start).toBeGreaterThan(-1);
    const rest = s.slice(start);
    const end = rest.indexOf("\nfunction ", 1);
    const body = rest.slice(0, end === -1 ? 2000 : end);
    // Target the early-RETURN statement (`… !== "darwin") return …`), not prose
    // that merely names the removed bug — the defect was the guarded return.
    expect(body).not.toMatch(/process\.platform\s*!==\s*"darwin"\s*\)\s*return/);
  });
});
