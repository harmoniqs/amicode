// REMOTE WRITE GATE (#1484, AC5) — enforces that remote file writes require
// BOTH active Control AND per-action human confirmation. An unavailable owner
// never writes locally.
//
// Two gates, BOTH must pass:
//   1. Control gate: the owner must have an active "control" grant with a
//      reachable transport. Anything less → denied.
//   2. Confirmation gate: even with active Control, every write action
//      requires explicit human confirmation. The confirmation is ACTION-BOUND
//      (each write operation confirms separately) and OWNER-BOUND (the
//      confirmation is scoped to the specific owner machine).
//
// Denied means denied — there is no local fallback. An unavailable owner
// produces a `{ allowed: false, reason }` result, never a redirect to local.
//
// Local writes (owner is this machine) are allowed without confirmation —
// the gate is only for REMOTE writes.

// ── types ────────────────────────────────────────────────────────────────────

/** The confirmation context: what the user is being asked to approve.
 *  Action-bound + owner-bound — each (owner, action, path) triple is distinct. */
export interface WriteConfirmationContext {
  ownerMachineId: string;
  action: string;
  path: string;
}

export type WriteGateResult =
  | { allowed: true; requiresConfirmation: false }
  | { allowed: true; requiresConfirmation: true; confirmationContext: WriteConfirmationContext }
  | { allowed: false; reason: string };

export interface WriteGateRequest {
  ownerMachineId: string;
  action: string;
  path: string;
}

/** The narrowed grant view (same vocabulary). */
export interface WriteGrantRead {
  scope: "observe" | "control" | "lifecycle-admin";
  state: "active" | "revocation-pending" | "revoked";
}

export interface WriteGateDeps {
  localMachineId: string;
  grantReader: (peerId: string) => WriteGrantRead | undefined;
  peerReachable: (peerId: string) => boolean;
}

// ── gate ─────────────────────────────────────────────────────────────────────

/** Evaluate whether a write can proceed. Pure: no I/O. */
export function evaluateRemoteWriteGate(
  request: WriteGateRequest,
  deps: WriteGateDeps,
): WriteGateResult {
  // Local owner → allowed, no confirmation needed
  if (request.ownerMachineId === deps.localMachineId) {
    return { allowed: true, requiresConfirmation: false };
  }

  // ── Control gate ─────────────────────────────────────────────────────────
  const grant = deps.grantReader(request.ownerMachineId);

  if (!grant) {
    return { allowed: false, reason: "no-control-grant" };
  }

  if (grant.state === "revoked" || grant.state === "revocation-pending") {
    return { allowed: false, reason: "grant-revoked" };
  }

  if (grant.scope !== "control") {
    return { allowed: false, reason: "insufficient-scope" };
  }

  if (!deps.peerReachable(request.ownerMachineId)) {
    return { allowed: false, reason: "transport-down" };
  }

  // ── Confirmation gate ────────────────────────────────────────────────────
  // Active Control + reachable → allowed, but requires human confirmation.
  // The confirmation context is action-bound and owner-bound.
  return {
    allowed: true,
    requiresConfirmation: true,
    confirmationContext: {
      ownerMachineId: request.ownerMachineId,
      action: request.action,
      path: request.path,
    },
  };
}
