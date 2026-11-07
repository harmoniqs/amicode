// session_creation_route.test.ts — #1643 (completes #1484 AC3): the service
// route that wraps resolveCreationTarget for the app's pre-flight gate.
//
// GET /amicode/fleet/creation-target?machine=<id> — the app calls this BEFORE
// a session.create so blocked states surface an exact reason inline, before any
// create is attempted. This module is the pure handler: it composes the raw
// lifecycle-grant store into resolveCreationTarget's CreationGrantRead shape and
// returns the resolved target as the response body. No I/O — deps injected.
import { describe, it, expect } from "vitest";
import {
  creationTargetResponse,
  type CreationRouteDeps,
} from "../src/amicode_service/session_creation_route";
import type { LifecycleGrant } from "../src/amicode_service/fleet_control_lifecycle";

const LOCAL = "local-mac";

function grant(over: Partial<LifecycleGrant>): LifecycleGrant {
  return {
    requesterMachineId: LOCAL,
    requesterIdentityKey: "rk",
    targetMachineId: "peer-a",
    targetIdentityKey: "tk",
    scope: "control",
    generation: 1,
    state: "active",
    token: "tok",
    issuedAt: "2026-09-28T00:00:00Z",
    ...over,
  } as LifecycleGrant;
}

function deps(over?: Partial<CreationRouteDeps>): CreationRouteDeps {
  return {
    localMachineId: LOCAL,
    readGrants: () => [grant({ targetMachineId: "peer-a", scope: "control", state: "active" })],
    peerReachable: (id) => id === "peer-a",
    ...over,
  };
}

function parse(body: string) {
  return JSON.parse(body) as { ok: boolean; target?: { kind: string; machineId?: string; reason?: string }; reason?: string };
}

describe("#1643 GET /amicode/fleet/creation-target — pre-flight gate route", () => {
  it("missing machine param → 400 with reason", () => {
    const res = creationTargetResponse(undefined, deps());
    expect(res.status).toBe(400);
    expect(parse(res.body).ok).toBe(false);
    expect(parse(res.body).reason).toBe("missing-machine");
  });

  it("local machine id → ok, target local", () => {
    const res = creationTargetResponse(LOCAL, deps());
    expect(res.status ?? 200).toBe(200);
    const b = parse(res.body);
    expect(b.ok).toBe(true);
    expect(b.target?.kind).toBe("local");
  });

  it("remote peer with active control grant + reachable → ok, target remote", () => {
    const res = creationTargetResponse("peer-a", deps());
    const b = parse(res.body);
    expect(b.ok).toBe(true);
    expect(b.target?.kind).toBe("remote");
    expect(b.target?.machineId).toBe("peer-a");
  });

  it("remote peer with no grant → ok, target blocked no-control-grant", () => {
    const res = creationTargetResponse("peer-x", deps());
    const b = parse(res.body);
    expect(b.ok).toBe(true);
    expect(b.target?.kind).toBe("blocked");
    expect(b.target?.reason).toBe("no-control-grant");
  });

  it("remote peer with revoked grant → blocked grant-revoked", () => {
    const res = creationTargetResponse("peer-a", deps({
      readGrants: () => [grant({ targetMachineId: "peer-a", scope: "control", state: "revoked" })],
    }));
    expect(parse(res.body).target?.reason).toBe("grant-revoked");
  });

  it("remote peer with observe-only grant → blocked insufficient-scope", () => {
    const res = creationTargetResponse("peer-a", deps({
      readGrants: () => [grant({ targetMachineId: "peer-a", scope: "observe", state: "active" })],
    }));
    expect(parse(res.body).target?.reason).toBe("insufficient-scope");
  });

  it("remote peer control+active but unreachable → blocked transport-down", () => {
    const res = creationTargetResponse("peer-a", deps({ peerReachable: () => false }));
    expect(parse(res.body).target?.reason).toBe("transport-down");
  });

  it("prefers the control/active grant when multiple grants exist for the target", () => {
    const res = creationTargetResponse("peer-a", deps({
      readGrants: () => [
        grant({ targetMachineId: "peer-a", scope: "observe", state: "active" }),
        grant({ targetMachineId: "peer-a", scope: "control", state: "active" }),
      ],
    }));
    expect(parse(res.body).target?.kind).toBe("remote");
  });
});
