// SELF-OWNED CONTROL BOOTSTRAP (#1541, ADR 0034 D3) — the NET-NEW control-scoped
// bootstrap decision. It structurally MIRRORS evaluateObserveBootstrap
// (fleet_observe_bootstrap.ts) but is a SEPARATE predicate: the observe
// bootstrap EXPLICITLY refuses a control outcome ("there is NO control outcome
// here — deliberately NOT implemented"). This is that deliberately-omitted
// control seam, authored per D3.
//
// The decision: a SELF-OWNED peer with VERIFIED MANAGEMENT ACCESS authorizes the
// explicit "Enable control" act; every other case (a shared peer, or a
// self-owned peer without verified management access) requires approval —
// routed, for a shared peer, to the request→approve handshake (slice 5). Unlike
// observe, there is NO targetApproved fast-path here: a shared peer can never
// mint control directly from this decision, so the no-privilege-bleed invariant
// holds (a shared peer NEVER borrows the self-owned fast-path).
//
// "Verified management access" (`managementVerified`) is a DEFINED predicate,
// not the bare boolean the observe path takes on trust — it composes the
// enroll-seeded lifecycle-admin authority + a serving peer + a held reader token
// (the identity/transport/trust triad, ordered as in fleet_headless_rehydration).
//
// On authorize, `enableSelfOwnedControl` mints an ACTIVE `control` grant via the
// existing grant machinery (issueLifecycleGrant) — self-issued, so the grant is
// keyed by the controlling machine (requester) and carries the driven owner as
// its `targetMachineId`, making it owner-resolvable via findControlGrantByTarget.
// Control lands per-session and is never auto-restored (fleet_headless_rehydration).
import {
  issueLifecycleGrant,
  type LifecycleGrant,
  type LifecycleGrantDeps,
} from "./fleet_control_lifecycle";
import type { PeerOwnership } from "./fleet_observe_bootstrap";
import type { LifecycleAuthorityRecord } from "./fleet_lifecycle_authority";

// ── the control bootstrap decision ───────────────────────────────────────────

/** The control bootstrap decision inputs. `managementVerified` is the "verified
 *  management access" the self-owned fast-path requires (a DEFINED predicate —
 *  see evaluateManagementVerified). There is no `targetApproved` here: a shared
 *  peer routes to the request→approve handshake, never a direct control grant. */
export interface ControlBootstrapRequest {
  ownership: PeerOwnership;
  managementVerified: boolean;
}

/** The control bootstrap outcome. `authorize-control` = mint control now (the
 *  self-owned fast-path); `requires-approval` = hold for the handshake (a shared
 *  peer, or a self-owned peer without verified management access). */
export type ControlBootstrapDecision =
  | { decision: "authorize-control" }
  | { decision: "requires-approval" };

/** The self-owned control fast-path, pure: a SELF-OWNED peer with VERIFIED
 *  MANAGEMENT ACCESS authorizes the explicit enable; every other case requires
 *  approval. Management access is NOT a substitute for ownership — a shared peer
 *  can never ride this path (no privilege bleed). Mirrors evaluateObserveBootstrap
 *  structurally, MINUS the targetApproved branch (control has no direct
 *  shared-peer grant — that is the request→approve handshake, slice 5). */
export function evaluateControlBootstrap(req: ControlBootstrapRequest): ControlBootstrapDecision {
  if (req.ownership === "self-owned" && req.managementVerified) {
    return { decision: "authorize-control" };
  }
  return { decision: "requires-approval" };
}

// ── management-verified: a DEFINED predicate ─────────────────────────────────

/** The three established facts that constitute "verified management access" to a
 *  self-owned peer: an enroll-seeded lifecycle-admin authority (naming self), a
 *  serving peer (transport up), and a held reader token (bilateral token state).
 *  This is the identity/transport/trust triad the headless rehydration gate
 *  orders — surfaced here as an explicit, testable predicate rather than a bare
 *  boolean set true only in tests. */
export interface ManagementAccessFacts {
  /** SELF holds the enroll-seeded lifecycle-admin authority for the peer. */
  authoritySeededForSelf: boolean;
  /** The peer is currently serving (in the serving∧reachable set). */
  peerServing: boolean;
  /** This machine holds a reader token for the peer (bilateral token state). */
  readerTokenHeld: boolean;
}

/** Verified management access holds iff ALL three facts hold — the authority is
 *  seeded for self, the peer is serving, and we hold its reader token. Any
 *  missing fact fails closed. */
export function evaluateManagementVerified(facts: ManagementAccessFacts): boolean {
  return facts.authoritySeededForSelf && facts.peerServing && facts.readerTokenHeld;
}

/** The inputs from which the three management-access facts are established: the
 *  self machine id, the target peer, the serving-peer + reader-token readers
 *  (the fleet-peer provider's projections), and the authority resolver (the
 *  enroll-seeded store). */
export interface ManagementAccessInputs {
  selfMachineId: string;
  targetMachineId: string;
  getServingPeers: () => Array<{ machineId: string }>;
  readPeerToken: (machineId: string) => { ok: boolean };
  resolveAuthority: (targetMachineId: string) => LifecycleAuthorityRecord | undefined;
}

/** Compose the three facts from the live inputs and decide verified management
 *  access. The authority must be seeded AND name THIS machine (self) — an
 *  authority naming a different machine does not verify self. */
export function establishManagementVerified(inp: ManagementAccessInputs): boolean {
  const authority = inp.resolveAuthority(inp.targetMachineId);
  const authoritySeededForSelf =
    authority !== undefined &&
    (authority.authorityMachineId === inp.selfMachineId || authority.authorityIdentityKey === inp.selfMachineId);
  const peerServing = inp.getServingPeers().some((p) => p.machineId === inp.targetMachineId);
  const readerTokenHeld = inp.readPeerToken(inp.targetMachineId).ok;
  return evaluateManagementVerified({ authoritySeededForSelf, peerServing, readerTokenHeld });
}

// ── the explicit enable → mint an active control grant ───────────────────────

export interface EnableControlRequest {
  ownership: PeerOwnership;
  managementVerified: boolean;
  /** The controlling machine (the grant's REQUESTER — self-issued). */
  self: { machineId: string; identityKey: string };
  /** The driven session's owner (the grant's TARGET). */
  target: { machineId: string; identityKey: string };
}

export type EnableControlResult =
  | { ok: true; grant: LifecycleGrant }
  | { ok: false; reason: "requires-approval" }
  | { ok: false; reason: "issue-failed"; issueReason: "identity-mismatch" | "target-mismatch" | "revoked" };

/** The explicit "Enable control" act on a self-owned peer: evaluate the control
 *  bootstrap and, on authorize, mint an ACTIVE `control` grant via the existing
 *  grant machinery — self-issued (requester = the controlling machine), so it is
 *  owner-resolvable by target via findControlGrantByTarget and carries its token.
 *  There is NO target-side interaction: issuance is a local mutation of the
 *  controlling machine's own grant store. A non-authorized decision mints
 *  nothing (held for approval) — a shared peer can never mint here. */
export function enableSelfOwnedControl(req: EnableControlRequest, deps: LifecycleGrantDeps = {}): EnableControlResult {
  const decision = evaluateControlBootstrap({ ownership: req.ownership, managementVerified: req.managementVerified });
  if (decision.decision !== "authorize-control") {
    return { ok: false, reason: "requires-approval" };
  }
  const issued = issueLifecycleGrant(
    {
      requesterMachineId: req.self.machineId,
      requesterIdentityKey: req.self.identityKey,
      targetMachineId: req.target.machineId,
      targetIdentityKey: req.target.identityKey,
      scope: "control",
    },
    deps,
  );
  if (!issued.ok) {
    return { ok: false, reason: "issue-failed", issueReason: issued.reason };
  }
  return { ok: true, grant: issued.grant };
}

// ── #1551: the LIVE caller — the extension-side enable-control handler ────────
//
// enableSelfOwnedControl had ZERO live callers (unit-tested, never invoked). This
// is the handler the app→extension `fleet-enable-control` envelope drives. It is
// pure of any vscode import — the NATIVE MODAL is injected as `confirm` (ADR 0034
// D4 lives in the extension wiring, not here), the management-verified inputs are
// injected from the live fleet-peer provider + authority resolver, and the grant
// store is the same injectable one enableSelfOwnedControl mints into. Ordering is
// deliberate: CONFIRM FIRST (a cancelled modal mints nothing, AC3), then compose
// establishManagementVerified + enableSelfOwnedControl. A non-self-owned or
// unverified peer mints nothing (no-privilege-bleed, AC4).

/** The deps the enable-control handler needs, all injectable so the decision path
 *  is testable without vscode / the real fleet stores. */
export interface EnableControlHandlerDeps {
  /** This machine's identity — the grant's requester (self-issued). */
  self: { machineId: string; identityKey: string };
  /** Resolve the driven peer's identity key (roster fingerprint; machineId
   *  fallback is the wiring's concern). Recorded on the minted grant's target. */
  targetIdentityKey: (ownerMachineId: string) => string;
  /** Whether the driven peer is self-owned (the base fast-path) vs shared. The
   *  shared-peer request→approve handshake (#1545) is the only other path. */
  ownershipOf: (ownerMachineId: string) => PeerOwnership;
  /** The live serving-peer set (transport up). */
  getServingPeers: () => Array<{ machineId: string }>;
  /** The reader peer-token read (bilateral token state). */
  readPeerToken: (machineId: string) => { ok: boolean };
  /** The enroll-seeded lifecycle-admin authority resolver. */
  resolveAuthority: (targetMachineId: string) => LifecycleAuthorityRecord | undefined;
  /** The ADR 0034 D4 native-modal confirm — resolves true on confirm, false on
   *  cancel. Injected so the modal never runs in-test. */
  confirm: (ownerMachineId: string) => Promise<boolean>;
  /** The grant store deps (default: the real ~/.amico store). */
  grantDeps?: LifecycleGrantDeps;
}

export type EnableControlHandlerOutcome =
  | { outcome: "minted"; grant: LifecycleGrant }
  | { outcome: "cancelled" }
  | { outcome: "not-authorized" }
  | { outcome: "issue-failed"; reason: "identity-mismatch" | "target-mismatch" | "revoked" };

/** Handle one `fleet-enable-control` intent: confirm (native modal) → verify →
 *  mint. Cancelling mints nothing; a shared / unverified peer mints nothing. */
export async function handleEnableControlRequest(
  payload: { ownerMachineId: string; sessionID: string },
  deps: EnableControlHandlerDeps,
): Promise<EnableControlHandlerOutcome> {
  const ownerMachineId = payload.ownerMachineId;
  // CONFIRM FIRST — the ADR 0034 D4 native modal. A cancelled modal mints
  // nothing and leaves the gated composer unchanged (AC3).
  const confirmed = await deps.confirm(ownerMachineId);
  if (!confirmed) return { outcome: "cancelled" };

  const managementVerified = establishManagementVerified({
    selfMachineId: deps.self.machineId,
    targetMachineId: ownerMachineId,
    getServingPeers: deps.getServingPeers,
    readPeerToken: deps.readPeerToken,
    resolveAuthority: deps.resolveAuthority,
  });

  const result = enableSelfOwnedControl(
    {
      ownership: deps.ownershipOf(ownerMachineId),
      managementVerified,
      self: deps.self,
      target: { machineId: ownerMachineId, identityKey: deps.targetIdentityKey(ownerMachineId) },
    },
    deps.grantDeps,
  );
  if (!result.ok) {
    return result.reason === "requires-approval"
      ? { outcome: "not-authorized" }
      : { outcome: "issue-failed", reason: result.issueReason };
  }
  return { outcome: "minted", grant: result.grant };
}
