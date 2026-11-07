import { describe, it, expect } from "vitest";
import { planEngineRestart } from "../src/server_lifecycle";

// ============================================================================
// The engine toggle's restart decision must be fleet-aware, or "toggle on"
// re-creates the two-engine bug it is meant to avoid.
//
// Three cases:
//   fleet client        → re-probe the tunnel (no local engine to kill/spawn)
//   riding unarmed hub   → reclaim + re-adopt (kill the hub engine; launchd
//                          respawns it; re-adopt — NEVER cold-spawn a rival on
//                          the editor port, which is what split one engine into
//                          two on one DB)
//   window owns engine   → stop then respawn a fresh one (the simple case)
// ============================================================================

describe("planEngineRestart — the toggle's fleet-aware restart decision", () => {
  it("fleet client → reprobe the tunnel (never kills/spawns a local engine)", () => {
    expect(planEngineRestart({ isFleetClient: true, ridingUnarmedHub: false })).toBe("reprobe-tunnel");
  });

  it("fleet client takes precedence even if a hub record is present", () => {
    expect(planEngineRestart({ isFleetClient: true, ridingUnarmedHub: true })).toBe("reprobe-tunnel");
  });

  it("server window riding the unarmed hub → reclaim + re-adopt (never cold-spawns a rival)", () => {
    expect(planEngineRestart({ isFleetClient: false, ridingUnarmedHub: true })).toBe("reclaim-and-readopt");
  });

  it("window that owns its engine → stop then respawn a fresh one", () => {
    expect(planEngineRestart({ isFleetClient: false, ridingUnarmedHub: false })).toBe("stop-and-respawn");
  });
});
