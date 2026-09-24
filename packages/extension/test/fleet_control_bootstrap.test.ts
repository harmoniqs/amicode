// fleet_control_bootstrap.test.ts — #1541 (ADR 0034 D3): the SELF-OWNED CONTROL
// fast-path. A NEW control-scoped bootstrap decision, structurally mirroring
// evaluateObserveBootstrap (fleet_observe_bootstrap.ts) — which EXPLICITLY
// refuses a control outcome. This suite pins:
//
//   · evaluateControlBootstrap — self-owned + verified-management-access
//     AUTHORIZES the explicit enable; every other case requires approval.
//   · management-verified is a DEFINED predicate (enroll-seeded authority + a
//     serving peer + a held reader token), not a bare boolean.
//   · enableSelfOwnedControl mints an ACTIVE `control` grant on the explicit
//     enable, with NO target-side interaction, and the grant is owner-resolvable
//     + token-bearing (the read #1542 needs).
//   · no privilege bleed — a shared peer NEVER borrows the self-owned fast-path.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateControlBootstrap,
  evaluateManagementVerified,
  establishManagementVerified,
  enableSelfOwnedControl,
  type ControlBootstrapRequest,
} from "../src/amicode_service/fleet_control_bootstrap";
import {
  findControlGrantByTarget,
  readLifecycleGrant,
  type LifecycleGrantDeps,
} from "../src/amicode_service/fleet_control_lifecycle";
import type { LifecycleAuthorityRecord } from "../src/amicode_service/fleet_lifecycle_authority";

function tmproot(): string {
  return mkdtempSync(join(tmpdir(), "amicode-1541-control-bootstrap-"));
}

const SELF_ID = "my-macbook";
const SELF_KEY = "SHA256:self-fingerprint";
const PEER_ID = "the-studio";
const PEER_KEY = "SHA256:studio-fingerprint";

function makeDeps(root?: string): LifecycleGrantDeps {
  const r = root ?? tmproot();
  return {
    grantStoreFile: join(r, "lifecycle-grants.json"),
    tokenFactory: () => "CONTROL-TOKEN-001",
    now: () => "2026-09-24T00:00:00.000Z",
  };
}

// A seeded authority record naming SELF as the target-peer's lifecycle-admin
// authority (what Enroll persists on the target machine).
function authorityFor(target: string, authority: string): LifecycleAuthorityRecord {
  return {
    targetMachineId: target,
    authorityMachineId: authority,
    authorityIdentityKey: authority,
    recordedAt: "2026-09-24T00:00:00.000Z",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// evaluateControlBootstrap — the self-owned fast-path predicate
// ═══════════════════════════════════════════════════════════════════════════
describe("evaluateControlBootstrap — self-owned + management-verified authorizes; everything else requires approval", () => {
  it("a SELF-OWNED, management-verified peer authorizes the explicit enable", () => {
    const req: ControlBootstrapRequest = { ownership: "self-owned", managementVerified: true };
    expect(evaluateControlBootstrap(req).decision).toBe("authorize-control");
  });

  it("a self-owned peer WITHOUT verified management access requires approval (management access is the gate)", () => {
    const req: ControlBootstrapRequest = { ownership: "self-owned", managementVerified: false };
    expect(evaluateControlBootstrap(req).decision).toBe("requires-approval");
  });

  it("a SHARED peer requires approval — control never auto-establishes for a different operator's machine", () => {
    const req: ControlBootstrapRequest = { ownership: "shared", managementVerified: false };
    expect(evaluateControlBootstrap(req).decision).toBe("requires-approval");
  });

  it("no privilege bleed: a shared peer CANNOT borrow the self-owned fast-path even claiming management access", () => {
    const req: ControlBootstrapRequest = { ownership: "shared", managementVerified: true };
    expect(evaluateControlBootstrap(req).decision).toBe("requires-approval");
  });

  it("there is NO targetApproved fast-path for control (unlike observe) — a shared peer routes to the handshake, never a direct grant", () => {
    // control bootstrap only knows two inputs: ownership + managementVerified.
    // A shared peer is always requires-approval here (the request→approve
    // handshake is slice 5), so it can never mint control from this decision.
    expect(evaluateControlBootstrap({ ownership: "shared", managementVerified: true }).decision).toBe(
      "requires-approval",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// management-verified — a DEFINED predicate, not a bare boolean
// ═══════════════════════════════════════════════════════════════════════════
describe("evaluateManagementVerified — the named identity/transport/token check", () => {
  it("all three facts true (authority seeded + serving peer + held reader token) → verified", () => {
    expect(
      evaluateManagementVerified({ authoritySeededForSelf: true, peerServing: true, readerTokenHeld: true }),
    ).toBe(true);
  });

  it("missing the enroll-seeded authority → NOT verified", () => {
    expect(
      evaluateManagementVerified({ authoritySeededForSelf: false, peerServing: true, readerTokenHeld: true }),
    ).toBe(false);
  });

  it("the peer is not serving (transport down) → NOT verified", () => {
    expect(
      evaluateManagementVerified({ authoritySeededForSelf: true, peerServing: false, readerTokenHeld: true }),
    ).toBe(false);
  });

  it("no held reader token (bilateral token state absent) → NOT verified", () => {
    expect(
      evaluateManagementVerified({ authoritySeededForSelf: true, peerServing: true, readerTokenHeld: false }),
    ).toBe(false);
  });
});

describe("establishManagementVerified — composes the enroll-seeded authority + serving peer + held reader token", () => {
  it("verified when SELF holds the enroll-seeded authority for a serving peer we hold a token for", () => {
    const verified = establishManagementVerified({
      selfMachineId: SELF_ID,
      targetMachineId: PEER_ID,
      getServingPeers: () => [{ machineId: PEER_ID }],
      readPeerToken: (id) => ({ ok: id === PEER_ID }),
      resolveAuthority: (t) => (t === PEER_ID ? authorityFor(PEER_ID, SELF_ID) : undefined),
    });
    expect(verified).toBe(true);
  });

  it("NOT verified when no authority is seeded for the peer", () => {
    const verified = establishManagementVerified({
      selfMachineId: SELF_ID,
      targetMachineId: PEER_ID,
      getServingPeers: () => [{ machineId: PEER_ID }],
      readPeerToken: () => ({ ok: true }),
      resolveAuthority: () => undefined,
    });
    expect(verified).toBe(false);
  });

  it("NOT verified when the seeded authority names a DIFFERENT machine (not self)", () => {
    const verified = establishManagementVerified({
      selfMachineId: SELF_ID,
      targetMachineId: PEER_ID,
      getServingPeers: () => [{ machineId: PEER_ID }],
      readPeerToken: () => ({ ok: true }),
      resolveAuthority: () => authorityFor(PEER_ID, "someone-else"),
    });
    expect(verified).toBe(false);
  });

  it("NOT verified when the peer is not in the serving set", () => {
    const verified = establishManagementVerified({
      selfMachineId: SELF_ID,
      targetMachineId: PEER_ID,
      getServingPeers: () => [],
      readPeerToken: () => ({ ok: true }),
      resolveAuthority: () => authorityFor(PEER_ID, SELF_ID),
    });
    expect(verified).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// enableSelfOwnedControl — the explicit enable mints an ACTIVE control grant
// ═══════════════════════════════════════════════════════════════════════════
describe("enableSelfOwnedControl — a self-owned, management-verified peer mints an active control grant (no target-side interaction)", () => {
  let deps: LifecycleGrantDeps;
  beforeEach(() => {
    deps = makeDeps();
  });

  it("mints an ACTIVE control grant on the explicit enable — self-issued, keyed by the controlling machine", () => {
    const result = enableSelfOwnedControl(
      {
        ownership: "self-owned",
        managementVerified: true,
        self: { machineId: SELF_ID, identityKey: SELF_KEY },
        target: { machineId: PEER_ID, identityKey: PEER_KEY },
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.scope).toBe("control");
    expect(result.grant.state).toBe("active");
    expect(result.grant.requesterMachineId).toBe(SELF_ID);
    expect(result.grant.targetMachineId).toBe(PEER_ID);
    expect(result.grant.token).toBe("CONTROL-TOKEN-001");

    // the grant persisted on the controlling machine, keyed by the requester (self)
    const stored = readLifecycleGrant(SELF_ID, deps);
    expect(stored!.scope).toBe("control");
    expect(stored!.state).toBe("active");
  });

  it("the minted grant is owner-resolvable + token-bearing (the read #1542 needs)", () => {
    enableSelfOwnedControl(
      {
        ownership: "self-owned",
        managementVerified: true,
        self: { machineId: SELF_ID, identityKey: SELF_KEY },
        target: { machineId: PEER_ID, identityKey: PEER_KEY },
      },
      deps,
    );
    const found = findControlGrantByTarget(PEER_ID, deps);
    expect(found).toBeDefined();
    expect(found!.scope).toBe("control");
    expect(found!.state).toBe("active");
    expect(found!.targetMachineId).toBe(PEER_ID);
    expect(found!.token).toBe("CONTROL-TOKEN-001");
  });

  it("a self-owned peer WITHOUT management access does NOT mint — held for approval, no grant", () => {
    const result = enableSelfOwnedControl(
      {
        ownership: "self-owned",
        managementVerified: false,
        self: { machineId: SELF_ID, identityKey: SELF_KEY },
        target: { machineId: PEER_ID, identityKey: PEER_KEY },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("requires-approval");
    expect(findControlGrantByTarget(PEER_ID, deps)).toBeUndefined();
  });

  it("no privilege bleed: a SHARED peer (even management-verified) does NOT mint — no grant survives", () => {
    const result = enableSelfOwnedControl(
      {
        ownership: "shared",
        managementVerified: true,
        self: { machineId: SELF_ID, identityKey: SELF_KEY },
        target: { machineId: PEER_ID, identityKey: PEER_KEY },
      },
      deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("requires-approval");
    expect(findControlGrantByTarget(PEER_ID, deps)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// #1545 — shared-peer arm: the request→approve handshake path
//
// When evaluateControlBootstrap returns `requires-approval` for a shared peer,
// the caller issues a control request (fleet_control_request.ts). Approval
// (from the lifecycle-admin authority holder) mints a control grant via the
// SAME issueLifecycleGrant machinery the self-owned path uses — but the shared
// peer NEVER reaches enableSelfOwnedControl. This is the no-privilege-bleed
// invariant: two distinct paths, one grant model.
// ═══════════════════════════════════════════════════════════════════════════
import {
  submitControlRequest,
  approveControlRequest,
  denyControlRequest,
  readPendingRequests,
  type ControlRequestDeps,
} from "../src/amicode_service/fleet_control_request";

describe("#1545 — shared-peer arm: requires-approval → request→approve handshake → control grant", () => {
  let deps: ControlRequestDeps;
  beforeEach(() => {
    const root = tmproot();
    deps = {
      requestStoreFile: join(root, "control-requests.json"),
      grantDeps: {
        grantStoreFile: join(root, "lifecycle-grants.json"),
        tokenFactory: () => "SHARED-CONTROL-TOKEN",
        now: () => "2026-09-24T12:00:00.000Z",
      },
      now: () => "2026-09-24T10:00:00.000Z",
    };
  });

  it("the shared-peer path: bootstrap requires-approval → submit request → approve → control grant", () => {
    // Step 1: the bootstrap decision for a shared peer
    const decision = evaluateControlBootstrap({ ownership: "shared", managementVerified: false });
    expect(decision.decision).toBe("requires-approval");

    // Step 2: submit a control request
    const submitResult = submitControlRequest(
      {
        requesterMachineId: SELF_ID,
        requesterIdentityKey: SELF_KEY,
        targetMachineId: PEER_ID,
        targetIdentityKey: PEER_KEY,
      },
      deps,
    );
    expect(submitResult.ok).toBe(true);
    expect(submitResult.status).toBe("pending");

    // Step 3: the authority holder sees the pending request
    const pending = readPendingRequests(deps);
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterMachineId).toBe(SELF_ID);

    // Step 4: approve → control grant minted
    const approveResult = approveControlRequest(SELF_ID, PEER_ID, deps);
    expect(approveResult.ok).toBe(true);
    if (!approveResult.ok) return;
    expect(approveResult.grant.scope).toBe("control");
    expect(approveResult.grant.state).toBe("active");
    expect(approveResult.grant.token).toBe("SHARED-CONTROL-TOKEN");

    // Step 5: the requester now has a control grant resolvable by target
    const grant = findControlGrantByTarget(PEER_ID, deps.grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.scope).toBe("control");
  });

  it("the shared-peer path denied: bootstrap requires-approval → submit → deny → NO grant", () => {
    const decision = evaluateControlBootstrap({ ownership: "shared", managementVerified: false });
    expect(decision.decision).toBe("requires-approval");

    submitControlRequest(
      {
        requesterMachineId: SELF_ID,
        requesterIdentityKey: SELF_KEY,
        targetMachineId: PEER_ID,
        targetIdentityKey: PEER_KEY,
      },
      deps,
    );

    denyControlRequest(SELF_ID, PEER_ID, deps);
    const grant = findControlGrantByTarget(PEER_ID, deps.grantDeps);
    expect(grant).toBeUndefined();
  });

  it("no privilege bleed: enableSelfOwnedControl REFUSES a shared peer — only the handshake path works", () => {
    // Attempt the self-owned path with shared ownership
    const selfOwnedResult = enableSelfOwnedControl(
      {
        ownership: "shared",
        managementVerified: true,
        self: { machineId: SELF_ID, identityKey: SELF_KEY },
        target: { machineId: PEER_ID, identityKey: PEER_KEY },
      },
      deps.grantDeps,
    );
    expect(selfOwnedResult.ok).toBe(false);
    if (selfOwnedResult.ok) return;
    expect(selfOwnedResult.reason).toBe("requires-approval");

    // The handshake path works for the same shared peer
    submitControlRequest(
      {
        requesterMachineId: SELF_ID,
        requesterIdentityKey: SELF_KEY,
        targetMachineId: PEER_ID,
        targetIdentityKey: PEER_KEY,
      },
      deps,
    );
    const approveResult = approveControlRequest(SELF_ID, PEER_ID, deps);
    expect(approveResult.ok).toBe(true);
    if (!approveResult.ok) return;
    expect(approveResult.grant.scope).toBe("control");
  });
});
