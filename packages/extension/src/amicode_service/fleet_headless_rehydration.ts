// HEADLESS PEER RELATIONSHIP REHYDRATION (#1487, ADR 0034) — the one-contract
// lifecycle that restores identity, transport supervision, Observe state, and
// suspended Control state when a headless peer reboots without an editor.
//
// Builds ON the existing lifecycle grant store (#1486) and fleet-peer provider
// (#1446). This module is READ-ONLY against the grant store — it never writes,
// mints, or modifies grants. It is the REHYDRATION, not the issuance.
//
// Recovery states:
//   active           — identity/transport/trust all valid; Observe restored.
//   reconciling      — grant exists but peer is not in the serving set;
//                      transport reconciliation will retry.
//   transport-failed — peer is serving but transport credential is missing.
//   identity-changed — peer's identity state is blocking (alias-conflict /
//                      key-changed); Observe NOT restored.
//   revoked          — grant is revoked or revocation-pending; nothing restored.
//   suspended        — control-scoped grant with valid identity/transport/trust;
//                      Observe restored, Control suspended until explicit re-enable.
//
// Ordering invariant (AC2): identity → transport → trust before Observe.
// Control never auto-restores (AC2).
// Generation fence (AC3): stale async completions are rejected.
import type { LifecycleGrantDeps } from "./fleet_control_lifecycle";
import { readAllLifecycleGrants, readLifecycleGrant } from "./fleet_control_lifecycle";
import type { FleetPeerProvider } from "./fleet_peer_provider";

// ── recovery state vocabulary ────────────────────────────────────────────────

export type PeerRecoveryState =
  | "active"
  | "reconciling"
  | "transport-failed"
  | "identity-changed"
  | "revoked"
  | "suspended";

// ── rehydrated peer record ───────────────────────────────────────────────────

export interface RehydratedPeer {
  peerId: string;
  state: PeerRecoveryState;
  scope: string;
  generation: number;
  /** True when Observe is restored (identity/transport/trust all valid). */
  observeRestored: boolean;
  /** True when Control is suspended (control-scoped grants + all revoked). */
  controlSuspended: boolean;
}

// ── rehydration result ───────────────────────────────────────────────────────

export interface RehydrationResult {
  peers: RehydratedPeer[];
  /** The rehydration ran without an editor (headless). */
  headless: true;
}

// ── rehydration dependencies ─────────────────────────────────────────────────

export interface RehydrationDeps {
  /** Lifecycle grant store deps (for reading persisted grants). */
  grantDeps?: LifecycleGrantDeps;
  /** The fleet peer provider (for transport/identity validation). */
  peerProvider: FleetPeerProvider;
}

// ── the rehydration function (READ-ONLY) ─────────────────────────────────────

/** Rehydrate persisted peer relationships into named recovery states.
 *
 *  READ-ONLY: never writes, mints, or modifies grants. Pure function of
 *  persisted lifecycle grants + current peer provider state.
 *
 *  Ordering (AC2): for each grant, identity is checked first (blocking
 *  identity states refuse Observe), then transport (missing credential
 *  refuses Observe), then trust (revoked/pending refuses everything).
 *  Control is NEVER auto-restored (AC2). */
export function rehydratePeerRelationships(deps: RehydrationDeps): RehydrationResult {
  const grants = readAllLifecycleGrants(deps.grantDeps);
  if (grants.length === 0) {
    return { peers: [], headless: true };
  }

  const provider = deps.peerProvider;

  // Build lookup sets from the peer provider's current state.
  const servingSet = new Set(provider.getServingPeers().map((p) => p.machineId));
  const blockedPeers = provider.getBlockedPeers();
  const blockedSet = new Set(blockedPeers.map((p) => p.machineId));

  const peers: RehydratedPeer[] = [];

  for (const grant of grants) {
    const peerId = grant.requesterMachineId;

    // ── trust gate (AC2): revoked/pending → nothing restored ─────────
    if (grant.state === "revoked" || grant.state === "revocation-pending") {
      peers.push({
        peerId,
        state: "revoked",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: false,
        controlSuspended: true,
      });
      continue;
    }

    // ── identity gate (AC2): blocking identity → Observe not restored ─
    if (blockedSet.has(peerId)) {
      peers.push({
        peerId,
        state: "identity-changed",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: false,
        controlSuspended: true,
      });
      continue;
    }

    // ── transport gate (AC2): peer must be serving AND have a token ───
    if (!servingSet.has(peerId)) {
      // Grant exists but the peer is not currently serving — reconciliation
      // will retry once the peer comes back.
      peers.push({
        peerId,
        state: "reconciling",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: false,
        controlSuspended: grant.scope === "control",
      });
      continue;
    }

    const tokenRead = provider.readPeerToken(peerId);
    if (!tokenRead.ok) {
      // Peer is serving but we have no transport credential for it.
      peers.push({
        peerId,
        state: "transport-failed",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: false,
        controlSuspended: grant.scope === "control",
      });
      continue;
    }

    // ── all gates passed ─────────────────────────────────────────────
    // Identity: not blocked. Transport: serving + token present. Trust: active.

    if (grant.scope === "control") {
      // AC2: Control is NEVER auto-restored — Observe is restored, Control
      // remains suspended until explicit re-enable.
      peers.push({
        peerId,
        state: "suspended",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: true,
        controlSuspended: true,
      });
    } else {
      // Observe or lifecycle-admin: fully restored.
      peers.push({
        peerId,
        state: "active",
        scope: grant.scope,
        generation: grant.generation,
        observeRestored: true,
        controlSuspended: false,
      });
    }
  }

  return { peers, headless: true };
}

// ── generation fence (AC3) ───────────────────────────────────────────────────

/** The generation fence: prevents stale async completions from advancing a
 *  revoked or superseded relationship generation.
 *
 *  Reads the grant store FRESH each call (no cache) — a revoke or re-admit
 *  that lands between two fence checks is immediately visible.
 *
 *  Rules:
 *  - An unknown peer (no grant) is allowed (no fence to enforce).
 *  - A revoked or revocation-pending grant blocks ALL generations.
 *  - An active grant allows ONLY the current generation (stale = rejected). */
export class RehydrationGenerationFence {
  private readonly grantDeps: LifecycleGrantDeps;

  constructor(grantDeps: LifecycleGrantDeps) {
    this.grantDeps = grantDeps;
  }

  /** Returns true if an operation at this generation can proceed.
   *  Reads the grant store fresh (no cache). */
  allows(peerId: string, generation: number): boolean {
    const grant = readLifecycleGrant(peerId, this.grantDeps);

    // No grant = no fence. An unknown peer has nothing to fence against.
    if (grant === undefined) return true;

    // Revoked or revocation-pending: no generation is allowed.
    if (grant.state === "revoked" || grant.state === "revocation-pending") {
      return false;
    }

    // Active: only the current generation is allowed (stale = rejected).
    return grant.generation === generation;
  }
}
