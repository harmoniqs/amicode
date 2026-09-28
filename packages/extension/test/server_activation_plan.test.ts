import { describe, it, expect } from "vitest";
import { planServerActivation } from "../src/server_lifecycle";

// ============================================================================
// #1576 — one engine per serving machine. A role=server editor window must RIDE
// the launchd hub engine (4093, unarmed) instead of spawning its own ext-engine
// on 4094 (the #1354 allocation this reverses). The prior owner-guard/ELECTRON
// fixes were band-aids; the real fix is this activation decision.
//
// The pure decision (mirrors planEngineRestart) drives three modes:
//   own-engine     — standalone (non-fleet-server): today's behavior, unchanged.
//   ride-hub       — fleet server + hub reachable: adopt the hub, spawn NOTHING.
//   local-fallback — fleet server + hub down (after the poll budget): pragmatic
//                    local spawn + honest banner so the editor is never
//                    engine-less; still never sweeps or clobbers the handshake.
//
// Two safety invariants are load-bearing and asserted as fields:
//   • runStraySweep is NEVER true on a fleet server — the machine-wide sweep was
//     what SIGTERM-churned the hub (36 SIGTERMs logged). Only a standalone sweeps.
//   • writeHandshake is NEVER true on a fleet server — the single un-namespaced
//     handshake belongs to the hub; a window write is the clobber (currently
//     {4094,armed} shadowing the hub's {4093,unarmed}).
// ============================================================================

describe("planServerActivation — the #1576 one-engine activation decision", () => {
  it("standalone machine → own-engine: spawn, sweep, and write the handshake (today's path, unchanged)", () => {
    const plan = planServerActivation({ isServerMachine: false, hubReachable: false });
    expect(plan.mode).toBe("own-engine");
    expect(plan.spawnLocalEngine).toBe(true);
    expect(plan.runStraySweep).toBe(true);
    expect(plan.writeHandshake).toBe(true);
    expect(plan.hubDownBanner).toBe(false);
  });

  it("standalone is unaffected by hubReachable (a standalone has no hub)", () => {
    const up = planServerActivation({ isServerMachine: false, hubReachable: true });
    const down = planServerActivation({ isServerMachine: false, hubReachable: false });
    expect(up).toEqual(down);
    expect(up.mode).toBe("own-engine");
  });

  it("fleet server + hub reachable → ride-hub: spawn NOTHING, never sweep, never write the handshake", () => {
    const plan = planServerActivation({ isServerMachine: true, hubReachable: true });
    expect(plan.mode).toBe("ride-hub");
    expect(plan.spawnLocalEngine).toBe(false); // retires the ext-engine on 4094
    expect(plan.runStraySweep).toBe(false); // the definitive SIGTERM-churn fix
    expect(plan.writeHandshake).toBe(false); // the hub's record stays authoritative
    expect(plan.hubDownBanner).toBe(false);
  });

  it("fleet server + hub down → local-fallback: spawn locally + banner, but STILL never sweep or clobber", () => {
    const plan = planServerActivation({ isServerMachine: true, hubReachable: false });
    expect(plan.mode).toBe("local-fallback");
    expect(plan.spawnLocalEngine).toBe(true); // never engine-less on the daily driver
    expect(plan.runStraySweep).toBe(false); // a returning hub must not be reaped
    expect(plan.writeHandshake).toBe(false); // the hub owns the shared handshake
    expect(plan.hubDownBanner).toBe(true); // honest "hub down — running local"
  });

  it("INVARIANT: a fleet server NEVER runs the stray-engine sweep (either hub state)", () => {
    expect(planServerActivation({ isServerMachine: true, hubReachable: true }).runStraySweep).toBe(false);
    expect(planServerActivation({ isServerMachine: true, hubReachable: false }).runStraySweep).toBe(false);
  });

  it("INVARIANT: a fleet server NEVER writes the shared handshake (either hub state)", () => {
    expect(planServerActivation({ isServerMachine: true, hubReachable: true }).writeHandshake).toBe(false);
    expect(planServerActivation({ isServerMachine: true, hubReachable: false }).writeHandshake).toBe(false);
  });
});
