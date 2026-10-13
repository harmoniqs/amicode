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
  handleEnableControlRequest,
  type ControlBootstrapRequest,
  type EnableControlHandlerDeps,
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

// ═══════════════════════════════════════════════════════════════════════════
// #1551 — handleEnableControlRequest: the LIVE caller decision path
//
// The self-owned enable act's extension-side handler — the one the app→extension
// `fleet-enable-control` envelope drives. It CONFIRMS first (the ADR 0034 D4
// native modal, injected), then composes establishManagementVerified +
// enableSelfOwnedControl to mint. Cancelling mints nothing (AC3); a non-self-
// owned / unverified peer mints nothing (no-privilege-bleed, AC4).
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// #1551 / #1562-followup (Slice B) — handleEnableControlRequest: the LIVE caller
//
// The self-owned enable act's extension-side handler — the one the app→extension
// `fleet-enable-control` envelope drives. It CONFIRMS first (the ADR 0034 D4
// native modal, injected). Slice B makes it:
//   · SELF-HEAL the dominant real-world failure — a self-owned, serving,
//     reader-token-held peer with a MISSING lifecycle-authority record (any
//     fleet enrolled before authority-seeding landed): record self as the
//     authority, then proceed. Gated STRICTLY on self-owned (no privilege bleed).
//   · report DISTINCT outcomes — shared-requires-approval (a shared peer, the
//     #1545 handshake), peer-unreachable (not serving / no token), and
//     authority-not-established (a self-owned peer whose authority names a
//     DIFFERENT machine — never silently overwritten).
// Cancelling still mints nothing (AC3); a shared peer still mints nothing (AC4).
// ═══════════════════════════════════════════════════════════════════════════
describe("#1551/#1562 handleEnableControlRequest — confirm → self-heal → mint; distinct honest failure reasons", () => {
  let grantDeps: LifecycleGrantDeps;
  let root: string;
  beforeEach(() => {
    root = tmproot();
    grantDeps = {
      grantStoreFile: join(root, "lifecycle-grants.json"),
      tokenFactory: () => "ENABLE-TOKEN-1551",
      now: () => "2026-09-24T00:00:00.000Z",
    };
  });

  // A verified, self-owned deps set — the happy path. `confirm` is injected so
  // the native modal never runs in-test; `recorded` captures any self-heal write.
  function verifiedDeps(
    confirm: (owner: string) => Promise<boolean>,
    recorded: LifecycleAuthorityRecord[] = [],
  ): EnableControlHandlerDeps {
    return {
      self: { machineId: SELF_ID, identityKey: SELF_KEY },
      targetIdentityKey: () => PEER_KEY,
      ownershipOf: () => "self-owned",
      getServingPeers: () => [{ machineId: PEER_ID }],
      readPeerToken: (id) => ({ ok: id === PEER_ID }),
      resolveAuthority: (t) => (t === PEER_ID ? authorityFor(PEER_ID, SELF_ID) : undefined),
      recordAuthority: (rec) => recorded.push(rec),
      now: () => "2026-09-24T00:00:00.000Z",
      confirm,
      grantDeps,
    };
  }

  it("confirm=true on a self-owned, already-authorised peer MINTS (no self-heal needed)", async () => {
    let asked = "";
    const recorded: LifecycleAuthorityRecord[] = [];
    const outcome = await handleEnableControlRequest(
      { ownerMachineId: PEER_ID, sessionID: "ses_abc" },
      verifiedDeps(async (owner) => {
        asked = owner;
        return true;
      }, recorded),
    );
    expect(asked).toBe(PEER_ID); // the modal was asked about the target peer
    expect(outcome.outcome).toBe("minted");
    if (outcome.outcome === "minted") expect(outcome.selfHealed).toBe(false);
    expect(recorded).toHaveLength(0); // authority already existed → no self-heal write
    const grant = findControlGrantByTarget(PEER_ID, grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.scope).toBe("control");
    expect(grant!.state).toBe("active");
    expect(grant!.targetMachineId).toBe(PEER_ID);
    expect(grant!.requesterMachineId).toBe(SELF_ID);
  });

  it("SELF-HEAL: self-owned + serving + token but MISSING authority → records self as authority, then mints", async () => {
    const recorded: LifecycleAuthorityRecord[] = [];
    const deps = verifiedDeps(async () => true, recorded);
    deps.resolveAuthority = () => undefined; // the pre-seeding fleet: no authority record

    const outcome = await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "ses_abc" }, deps);

    // it self-healed: recorded SELF as the authority for the target
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual({
      targetMachineId: PEER_ID,
      authorityMachineId: SELF_ID,
      authorityIdentityKey: SELF_KEY,
      recordedAt: "2026-09-24T00:00:00.000Z",
    });
    // then authorised + minted
    expect(outcome.outcome).toBe("minted");
    if (outcome.outcome === "minted") expect(outcome.selfHealed).toBe(true);
    const grant = findControlGrantByTarget(PEER_ID, grantDeps);
    expect(grant).toBeDefined();
    expect(grant!.scope).toBe("control");
    expect(grant!.state).toBe("active");
  });

  it("confirm=false (native modal cancelled) MINTS NOTHING and self-heals NOTHING (AC3)", async () => {
    const recorded: LifecycleAuthorityRecord[] = [];
    const deps = verifiedDeps(async () => false, recorded);
    deps.resolveAuthority = () => undefined;
    const outcome = await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "ses_abc" }, deps);
    expect(outcome.outcome).toBe("cancelled");
    expect(recorded).toHaveLength(0); // a cancelled modal writes no authority
    expect(findControlGrantByTarget(PEER_ID, grantDeps)).toBeUndefined();
  });

  it("no privilege bleed: a SHARED peer mints NOTHING and self-heals NOTHING, even with no authority (AC4)", async () => {
    const recorded: LifecycleAuthorityRecord[] = [];
    const deps = verifiedDeps(async () => true, recorded);
    deps.ownershipOf = () => "shared";
    deps.resolveAuthority = () => undefined; // shared peer must NOT self-heal into a mint
    const outcome = await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "ses_abc" }, deps);
    expect(outcome.outcome).toBe("shared-requires-approval");
    expect(recorded).toHaveLength(0); // NEVER records authority for a shared peer
    expect(findControlGrantByTarget(PEER_ID, grantDeps)).toBeUndefined();
  });

  it("a self-owned peer that is NOT reachable (transport down) → peer-unreachable, no self-heal", async () => {
    const recorded: LifecycleAuthorityRecord[] = [];
    const deps = verifiedDeps(async () => true, recorded);
    deps.getServingPeers = () => []; // peer not serving → genuinely unreachable
    const outcome = await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "ses_abc" }, deps);
    expect(outcome.outcome).toBe("peer-unreachable");
    expect(recorded).toHaveLength(0);
    expect(findControlGrantByTarget(PEER_ID, grantDeps)).toBeUndefined();
  });

  it("a self-owned peer whose authority names a DIFFERENT machine is NOT overwritten → authority-not-established", async () => {
    const recorded: LifecycleAuthorityRecord[] = [];
    const deps = verifiedDeps(async () => true, recorded);
    deps.resolveAuthority = () => authorityFor(PEER_ID, "someone-else"); // a real, foreign authority
    const outcome = await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "ses_abc" }, deps);
    expect(outcome.outcome).toBe("authority-not-established");
    expect(recorded).toHaveLength(0); // must NOT clobber a foreign authority
    expect(findControlGrantByTarget(PEER_ID, grantDeps)).toBeUndefined();
  });

  it("the three failure reasons are DISTINCT (a real code split, not one collapsed 'not-authorized')", async () => {
    const shared = verifiedDeps(async () => true);
    shared.ownershipOf = () => "shared";
    const unreachable = verifiedDeps(async () => true);
    unreachable.getServingPeers = () => [];
    const foreign = verifiedDeps(async () => true);
    foreign.resolveAuthority = () => authorityFor(PEER_ID, "someone-else");

    const reasons = new Set(
      await Promise.all(
        [shared, unreachable, foreign].map(async (deps) =>
          (await handleEnableControlRequest({ ownerMachineId: PEER_ID, sessionID: "s" }, deps)).outcome,
        ),
      ),
    );
    expect(reasons).toEqual(
      new Set(["shared-requires-approval", "peer-unreachable", "authority-not-established"]),
    );
  });
});
