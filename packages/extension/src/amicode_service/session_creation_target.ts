// SESSION CREATION TARGET (#1484, AC3) — resolves the machine picker's
// selection into the ACTUAL target for new session creation.
//
// The binding amendment rejects cosmetic implementations: "picker selection
// changes actual create target." This module is that enforcement — the
// picker's selectedMachineId flows through this resolver BEFORE any session
// creation dispatch. The output is the real dispatch target, not a UI label.
//
// Three outcomes:
//   "local"   — create on this machine (picker selected local or nothing)
//   "remote"  — create on the named peer (active Control grant + reachable)
//   "blocked" — the peer is known but can't be targeted (no grant, revoked,
//               observe-only, or transport down) — the UI shows the reason
//
// Pure function: no I/O, no store reads — the caller injects grant state
// and transport reachability.

// ── types ────────────────────────────────────────────────────────────────────

export type CreationTarget =
  | { kind: "local" }
  | { kind: "remote"; machineId: string }
  | { kind: "blocked"; machineId: string; reason: string };

/** The narrowed grant view the resolver needs — same vocabulary as the
 *  sidebar's PeerGrantInput (node-import-free). */
export interface CreationGrantRead {
  scope: "observe" | "control" | "lifecycle-admin";
  state: "active" | "revocation-pending" | "revoked";
}

export interface CreationTargetDeps {
  localMachineId: string;
  /** Read the grant for a peer — called per resolve. */
  grantReader: (peerId: string) => CreationGrantRead | undefined;
  /** Whether a peer's transport is currently reachable. */
  peerReachable: (peerId: string) => boolean;
}

// ── resolver ─────────────────────────────────────────────────────────────────

/** Resolve a picker selection into the actual session creation target.
 *  Pure: no I/O — the caller injects dependencies.
 *
 *  Gate order: local? → grant exists? → grant state? → scope? → reachable? */
export function resolveCreationTarget(
  selectedMachineId: string | undefined,
  deps: CreationTargetDeps,
): CreationTarget {
  // No selection or selected self → local
  if (selectedMachineId === undefined || selectedMachineId === deps.localMachineId) {
    return { kind: "local" };
  }

  // Grant gate
  const grant = deps.grantReader(selectedMachineId);
  if (!grant) {
    return { kind: "blocked", machineId: selectedMachineId, reason: "no-control-grant" };
  }

  // Grant state gate
  if (grant.state === "revoked" || grant.state === "revocation-pending") {
    return { kind: "blocked", machineId: selectedMachineId, reason: "grant-revoked" };
  }

  // Scope gate: only "control" authorizes session creation
  if (grant.scope !== "control") {
    return { kind: "blocked", machineId: selectedMachineId, reason: "insufficient-scope" };
  }

  // Transport gate
  if (!deps.peerReachable(selectedMachineId)) {
    return { kind: "blocked", machineId: selectedMachineId, reason: "transport-down" };
  }

  return { kind: "remote", machineId: selectedMachineId };
}
