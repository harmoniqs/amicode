// SESSION CREATION ROUTE (#1643, completes #1484 AC3) — the service-side
// pre-flight gate the app calls BEFORE a session.create.
//
//   GET /amicode/fleet/creation-target?machine=<id>
//
// The app's composer, on a remote pick, calls this to learn whether the create
// can be dispatched to the peer and — if not — the EXACT reason, so a blocked
// state renders inline before any session is created. The route wraps the pure
// resolveCreationTarget resolver, composing the raw lifecycle-grant store into
// the CreationGrantRead shape the resolver needs.
//
// Under /amicode/fleet/* → the machine's OWN honesty surface (never proxied,
// ADR 0027 §4): the grant + reachability truth is local. No I/O in this module
// beyond the injected readers; deps are injected so it is unit-testable.

import {
  resolveCreationTarget,
  type CreationTarget,
  type CreationGrantRead,
} from "./session_creation_target";
import type { LifecycleGrant } from "./fleet_control_lifecycle";

// ── deps ───────────────────────────────────────────────────────────────────

export interface CreationRouteDeps {
  /** This machine's id (deps.fleetPeers.localMachineId at the call site). */
  localMachineId: string;
  /** Read ALL lifecycle grants (readAllLifecycleGrants) — the route narrows
   *  them to the target's most-relevant grant itself, because the resolver
   *  needs the raw scope+state to produce distinct blocked reasons (a
   *  control/active-only reader cannot tell no-grant from revoked/observe). */
  readGrants: () => LifecycleGrant[];
  /** Whether a peer's transport is currently reachable. */
  peerReachable: (peerId: string) => boolean;
}

export interface RouteResult {
  status?: number;
  body: string;
}

// ── grant selection ──────────────────────────────────────────────────────────

/** Pick the grant that best represents the target's creation eligibility:
 *  prefer an active control grant (the one that authorizes creation); else the
 *  newest grant for the target (highest generation) so revoked/observe states
 *  surface their specific reason. undefined → no grant at all. */
export function selectGrantForTarget(
  grants: LifecycleGrant[],
  targetMachineId: string,
): CreationGrantRead | undefined {
  const forTarget = grants.filter((g) => g.targetMachineId === targetMachineId);
  if (forTarget.length === 0) return undefined;
  const controlActive = forTarget.find((g) => g.scope === "control" && g.state === "active");
  const chosen = controlActive ?? forTarget.reduce((a, b) => (b.generation >= a.generation ? b : a));
  return { scope: chosen.scope, state: chosen.state };
}

// ── route handler ────────────────────────────────────────────────────────────

/** GET /amicode/fleet/creation-target?machine=<id>. Never throws: a missing
 *  param is a 400; every resolvable case is a 200 with {ok, target}. */
export function creationTargetResponse(
  machine: string | undefined,
  deps: CreationRouteDeps,
): RouteResult {
  if (machine === undefined || machine.trim() === "") {
    return { status: 400, body: JSON.stringify({ ok: false, reason: "missing-machine" }) };
  }
  const target: CreationTarget = resolveCreationTarget(machine, {
    localMachineId: deps.localMachineId,
    grantReader: (peerId) => selectGrantForTarget(deps.readGrants(), peerId),
    peerReachable: deps.peerReachable,
  });
  return { status: 200, body: JSON.stringify({ ok: true, target }) };
}
