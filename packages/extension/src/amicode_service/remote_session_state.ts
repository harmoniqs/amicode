// REMOTE SESSION STATE (#1484, AC4) — resolves the UI state for a remote
// session: can you interact? can you only read? is it suspended? is it local?
//
// This composes the same grant + transport checks the ControlGatedResolver
// uses (#1482), but at the SESSION UI level rather than the routing level.
// The four states map to UI behaviors:
//
//   "local"       — the session is owned by this machine. Full interaction.
//   "interactive" — the session is owned by a remote peer with active Control
//                   grant and reachable transport. Full interaction through
//                   the single origin (ADR 0027).
//   "read-only"   — the session is owned by a remote peer but the grant is
//                   missing, revoked, or observe-only. The session is VISIBLE
//                   (never hidden) but the composer is disabled.
//   "suspended"   — the session is owned by a remote peer with a grant that
//                   is revocation-pending or transport-down with active grant.
//                   Visible, read-only, recoverable.
//
// Central invariant: a known remote session NEVER falls through to "local".
// The caller never needs to check this — the type system enforces it.

// ── types ────────────────────────────────────────────────────────────────────

export type RemoteSessionState =
  | { kind: "local" }
  | { kind: "interactive"; machineId: string }
  | { kind: "read-only"; machineId: string; reason: string }
  | { kind: "suspended"; machineId: string; reason: string };

/** The narrowed grant view (same vocabulary as the sidebar and creation target). */
export interface SessionGrantRead {
  scope: "observe" | "control" | "lifecycle-admin";
  state: "active" | "revocation-pending" | "revoked";
}

export interface RemoteSessionDeps {
  localMachineId: string;
  grantReader: (peerId: string) => SessionGrantRead | undefined;
  peerReachable: (peerId: string) => boolean;
}

// ── resolver ─────────────────────────────────────────────────────────────────

/** Resolve the UI state for a session given its owner.
 *  Pure: no I/O — the caller injects dependencies. */
export function resolveRemoteSessionState(
  _sessionId: string,
  ownerMachineId: string,
  deps: RemoteSessionDeps,
): RemoteSessionState {
  // Local session → full interaction
  if (ownerMachineId === deps.localMachineId) {
    return { kind: "local" };
  }

  // Remote session: check grant
  const grant = deps.grantReader(ownerMachineId);

  if (!grant) {
    return { kind: "read-only", machineId: ownerMachineId, reason: "no-control-grant" };
  }

  // Fully revoked → read-only (session visible, no interaction)
  if (grant.state === "revoked") {
    return { kind: "read-only", machineId: ownerMachineId, reason: "grant-revoked" };
  }

  // Revocation-pending → suspended (visible, read-only, recoverable)
  if (grant.state === "revocation-pending") {
    return { kind: "suspended", machineId: ownerMachineId, reason: "revocation-pending" };
  }

  // Scope gate: only "control" authorizes interaction
  if (grant.scope !== "control") {
    return { kind: "read-only", machineId: ownerMachineId, reason: "insufficient-scope" };
  }

  // Transport gate: active control but unreachable → suspended
  if (!deps.peerReachable(ownerMachineId)) {
    return { kind: "suspended", machineId: ownerMachineId, reason: "transport-down" };
  }

  // All gates passed → interactive
  return { kind: "interactive", machineId: ownerMachineId };
}
