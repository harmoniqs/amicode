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

// ── #1544 (slice 4) THE STATE CHANNEL DATA CONTRACT ──────────────────────────
//
// The reason/eligibility logic above is a PURE module with (before this slice)
// NO app consumer. This section names the APP-VISIBLE shape and projects it from
// resolveRemoteSessionState — the SINGLE SOURCE OF TRUTH for the fail-closed
// chip.
//
// CARRIER (stated explicitly, per the deliberate-review correction): the shape
// rides the fleet projection the app ALREADY consumes — GET /amicode/fleet/
// sessions (buildFleetProjection). Each projection session entry is tagged with
// the `amicode_owner` overlay (merged_projection.ts tagSessionsWithOwner); this
// slice adds a SIBLING overlay field `amicode_control: SessionControlProjection`
// on the same entry, derived here. The app reads it off DropdownSession
// (session-fleet-peers.ts). No new endpoint — the control state travels beside
// the owner tag it is scoped to.
//
// WHY NOT THE RAW WRITE-GATE REASON: evaluateRemoteWriteGate COLLAPSES
// `revocation-pending` → `grant-revoked`. This module keeps them distinct, and
// that distinction must reach the UI, so the chip is projected from HERE, never
// from the write gate (ADR 0034 D4/D5).

/** EXACTLY the reasons the SoT (resolveRemoteSessionState) can emit — no more,
 *  no fewer. The fail-closed chip's vocabulary. */
export const CONTROL_CHIP_REASONS = [
  "no-control-grant",
  "grant-revoked",
  "revocation-pending",
  "insufficient-scope",
  "transport-down",
] as const;

export type ControlChipReason = (typeof CONTROL_CHIP_REASONS)[number];

/** Whether — and which — control affordance should appear for the session:
 *  `enable-control` (self-owned, one explicit act), `request-control` (shared,
 *  routed to the peer's lifecycle-admin authority — backend is #1545), or
 *  `none` (control already held, or the session is local). */
export type ControlEligibility = "enable-control" | "request-control" | "none";

/** The APP-VISIBLE control shape carried on GET /amicode/fleet/sessions as the
 *  `amicode_control` sibling of `amicode_owner`. Projected from the SoT. */
export interface SessionControlProjection {
  /** The remote_session_state kind — the state the fail-closed surface honors. */
  controlState: RemoteSessionState["kind"];
  /** The chip reason (distinct from the collapsed write-gate reason), or null
   *  when control is held / the session is local. */
  reason: ControlChipReason | null;
  /** The affordance derived from ownership + current state. */
  eligibility: ControlEligibility;
}

/** Project the SoT state into the app-visible shape. Pure.
 *  - controlState mirrors the state kind (the four fail-closed states);
 *  - reason is the state's reason for the read-only / suspended cases (kept
 *    DISTINCT — revocation-pending is never collapsed to grant-revoked), else
 *    null (local / interactive carry no chip);
 *  - eligibility: control-held (local / interactive) → none; control NOT held
 *    (read-only / suspended) → enable-control when self-owned, else
 *    request-control (the shared-peer handshake affordance). */
export function projectSessionControlState(
  state: RemoteSessionState,
  opts: { selfOwned: boolean },
): SessionControlProjection {
  if (state.kind === "local") {
    return { controlState: "local", reason: null, eligibility: "none" };
  }
  if (state.kind === "interactive") {
    return { controlState: "interactive", reason: null, eligibility: "none" };
  }
  // read-only | suspended — control is NOT held: fail-closed + an affordance to
  // acquire it. The reason is carried verbatim (its distinctness is the point).
  const reason = state.reason as ControlChipReason;
  return {
    controlState: state.kind,
    reason,
    eligibility: opts.selfOwned ? "enable-control" : "request-control",
  };
}

/** Per-owner resolver for the projection carrier (the route wiring, index.ts).
 *  Composes resolveRemoteSessionState + projectSessionControlState so index.ts
 *  only supplies the grant/reachability/ownership deps and stamps the result on
 *  each fleet-projection entry. `isSelfOwned(peerId)` answers whether this
 *  operator owns the peer (self-owned fast-path) vs a shared peer. */
export function buildControlResolver(deps: RemoteSessionDeps & {
  isSelfOwned: (peerId: string) => boolean;
}): (ownerMachineId: string, isLocal: boolean) => SessionControlProjection {
  return (ownerMachineId, isLocal) => {
    if (isLocal || ownerMachineId === deps.localMachineId) {
      return { controlState: "local", reason: null, eligibility: "none" };
    }
    const state = resolveRemoteSessionState(ownerMachineId, ownerMachineId, deps);
    return projectSessionControlState(state, { selfOwned: deps.isSelfOwned(ownerMachineId) });
  };
}
