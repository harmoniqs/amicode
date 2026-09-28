import { describe, it, expect } from "vitest";
import {
  planServerActivation,
  adoptedTheHub,
  classifyHubProbe,
  shouldRideDeterministicHub,
} from "../src/server_lifecycle";
import { hubEnginePortFor, HUB_ENGINE_PORT_OFFSET } from "../src/amicode_service/fleet_hub_service";

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

// ============================================================================
// #1607 (HIGH): the hubReachable signal fed to planServerActivation must mean
// "adopted the UNARMED hub", not "adopted ANYTHING". A clobbered handshake can
// point a server at an ARMED PEER window's engine; adopting that is NOT riding
// the hub, and must fall to local-fallback rather than silently "ride-hub" a
// peer. The wiring computes hubReachable via adoptedTheHub({adopted, adoptedUnarmed}).
// ============================================================================

describe("adoptedTheHub — a server reaches the hub only by adopting the UNARMED hub (#1607)", () => {
  it("adopted the unarmed hub → true (genuinely rode the hub)", () => {
    expect(adoptedTheHub({ adopted: true, adoptedUnarmed: true })).toBe(true);
  });

  it("adopted an ARMED peer engine → false (a clobbered handshake is NOT the hub)", () => {
    expect(adoptedTheHub({ adopted: true, adoptedUnarmed: false })).toBe(false);
  });

  it("did not adopt anything → false (hub genuinely unreachable)", () => {
    expect(adoptedTheHub({ adopted: false, adoptedUnarmed: false })).toBe(false);
    expect(adoptedTheHub({ adopted: false, adoptedUnarmed: true })).toBe(false);
  });

  it("composed: an ARMED adopt on a server → local-fallback, NOT ride-hub", () => {
    const plan = planServerActivation({
      isServerMachine: true,
      hubReachable: adoptedTheHub({ adopted: true, adoptedUnarmed: false }),
    });
    expect(plan.mode).toBe("local-fallback");
    expect(plan.runStraySweep).toBe(false); // still never sweeps on a server
    expect(plan.writeHandshake).toBe(false); // still never clobbers on a server
  });

  it("composed: adopting the unarmed hub on a server → ride-hub", () => {
    const plan = planServerActivation({
      isServerMachine: true,
      hubReachable: adoptedTheHub({ adopted: true, adoptedUnarmed: true }),
    });
    expect(plan.mode).toBe("ride-hub");
  });
});

// ============================================================================
// #1607 Slice 2: a fleet server must never DELETE the shared handshake either.
// The keepalive's onServerGone deletes it un-gated today; on a server the hub
// owns the handshake lifecycle (launchd respawns + rewrites), so a window
// deleting it strands the next reload (the incident: hub crashed → window's
// keepalive deleted the record → window couldn't find the live hub → fell back
// to a rival engine). mayDeleteHandshake is the read-side twin of writeHandshake.
// ============================================================================

describe("planServerActivation — a fleet server never DELETES the shared handshake (#1607 Slice 2)", () => {
  it("standalone owns its handshake → mayDeleteHandshake true (today's behavior)", () => {
    expect(planServerActivation({ isServerMachine: false, hubReachable: false }).mayDeleteHandshake).toBe(true);
  });

  it("ride-hub → mayDeleteHandshake false (the hub owns its record)", () => {
    expect(planServerActivation({ isServerMachine: true, hubReachable: true }).mayDeleteHandshake).toBe(false);
  });

  it("local-fallback → mayDeleteHandshake false (still never mutate the hub's record)", () => {
    expect(planServerActivation({ isServerMachine: true, hubReachable: false }).mayDeleteHandshake).toBe(false);
  });

  it("INVARIANT: a fleet server never WRITES and never DELETES the shared handshake (either hub state)", () => {
    for (const hubReachable of [true, false]) {
      const p = planServerActivation({ isServerMachine: true, hubReachable });
      expect(p.writeHandshake).toBe(false);
      expect(p.mayDeleteHandshake).toBe(false);
    }
  });
});

// ============================================================================
// #1607 Slice 1: find the hub DETERMINISTICALLY. Instead of trusting the
// (deletable/clobberable/stale) handshake for hub identity, a server probes the
// hub engine's port — derived from a SHARED constant (FLEET_PORT − offset, no
// re-typed literal) — and confirms the occupant is the UNARMED hub (anonymous
// GET: 200 = unarmed hub; 401/403 = armed peer, NOT the hub; no response = down).
// This closes: a clobbered handshake (armed peer), a stale pid after a hub
// respawn, and an absent handshake with a live hub.
// ============================================================================

describe("hubEnginePortFor — the shared hub-engine-port constant (#1607 Slice 1)", () => {
  it("offset is 3 (FLEET_PORT-3 hub-engine, per the #1354 layout)", () => {
    expect(HUB_ENGINE_PORT_OFFSET).toBe(3);
  });
  it("derives the hub engine port from the canonical/service port", () => {
    expect(hubEnginePortFor(4096)).toBe(4093);
    expect(hubEnginePortFor(5000)).toBe(4997);
  });
});

describe("classifyHubProbe — is the occupant the UNARMED hub? (#1607 Slice 1)", () => {
  it("no response → down", () => {
    expect(classifyHubProbe({ reached: false })).toBe("down");
  });
  it("200 (anonymous OK) → unarmed (the hub is passwordless)", () => {
    expect(classifyHubProbe({ reached: true, status: 200 })).toBe("unarmed");
  });
  it("401/403 (anonymous rejected) → armed — an armed peer, NOT the unarmed hub", () => {
    expect(classifyHubProbe({ reached: true, status: 401 })).toBe("armed");
    expect(classifyHubProbe({ reached: true, status: 403 })).toBe("armed");
  });
});

describe("shouldRideDeterministicHub — ride only a probed UNARMED hub, on a server (#1607 Slice 1)", () => {
  it("server + unarmed probe → ride", () => {
    expect(shouldRideDeterministicHub({ isServerMachine: true, hubProbe: "unarmed" })).toBe(true);
  });
  it("server + armed probe → do NOT ride (it's a peer, not the hub)", () => {
    expect(shouldRideDeterministicHub({ isServerMachine: true, hubProbe: "armed" })).toBe(false);
  });
  it("server + down probe → do NOT ride (fall through to poll/fallback)", () => {
    expect(shouldRideDeterministicHub({ isServerMachine: true, hubProbe: "down" })).toBe(false);
  });
  it("non-server never rides the deterministic hub (standalone owns its engine)", () => {
    expect(shouldRideDeterministicHub({ isServerMachine: false, hubProbe: "unarmed" })).toBe(false);
  });
});
