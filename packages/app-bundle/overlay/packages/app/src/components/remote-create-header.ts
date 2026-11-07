/**
 * remote-create-header.ts — #1643 (completes #1484 AC3)
 *
 * The OWNER-HEADER PRODUCER — the missing emitter for ADR 0031 §D1a leg 2. The
 * per-session multiplexer has read `x-amicode-owner` since #1449; nothing in the
 * app ever set it, so every create resolved local (the AC3-shipped-incomplete
 * finding). This module is that producer, as a pure decision function:
 *
 *   given the pre-flight-resolved creation target (from GET
 *   /amicode/fleet/creation-target), decide whether the composer proceeds and,
 *   if remote, WHAT header the session.create attaches.
 *
 *   - local   → proceed, no header (byte-unchanged from today's local create)
 *   - remote  → proceed, attach x-amicode-owner: <machineId>
 *   - blocked → do NOT proceed; carry the reason for inline display
 *
 * Pure: no I/O. The composer runs the pre-flight fetch, feeds the target here,
 * and either dispatches with plan.headers or renders plan.displayText inline.
 */

/** The routing header. MUST byte-match session_multiplexer.ts
 *  OWNER_ROUTING_HEADER — the multiplexer reads exactly this key. */
export const OWNER_HEADER = "x-amicode-owner"

/** The blocked reasons the service's creation-target route can return, plus
 *  no-remote-root from the peer-home-base route. Closed vocabulary. */
export type BlockedReason =
  | "no-control-grant"
  | "grant-revoked"
  | "insufficient-scope"
  | "transport-down"
  | "no-remote-root"

/** The creation target as the service route reports it (mirrors CreationTarget
 *  in session_creation_target.ts, plus no-remote-root from the home-base gate). */
export type CreationTargetView =
  | { kind: "local" }
  | { kind: "remote"; machineId: string }
  | { kind: "blocked"; machineId: string; reason: BlockedReason }

export interface RemoteCreatePlan {
  /** Whether the composer should proceed with session.create. */
  proceed: boolean
  /** Headers to attach to the create request (empty for local). */
  headers: Record<string, string>
  /** The blocked reason, when proceed is false. */
  blockedReason?: BlockedReason
  /** Human-readable inline text to render when blocked. */
  displayText?: string
}

const BLOCKED_TEXT: Record<BlockedReason, string> = {
  "no-control-grant": "No control grant for that machine — request control before creating a session there.",
  "grant-revoked": "The control grant for that machine was revoked.",
  "insufficient-scope": "That grant is observe-only — creating a session needs control scope.",
  "transport-down": "That machine is currently unreachable.",
  "no-remote-root": "Couldn't resolve a working directory on that machine.",
}

/** Decide the composer's create plan from the resolved target. Pure. */
export function planRemoteCreate(target: CreationTargetView): RemoteCreatePlan {
  if (target.kind === "local") {
    return { proceed: true, headers: {} }
  }
  if (target.kind === "remote") {
    // Defensive: a remote target must carry a non-empty machineId, else we would
    // emit an empty routing header (which the multiplexer treats as local — the
    // exact silent-local-fallback #1382 forbids). Refuse instead.
    if (!target.machineId || target.machineId.trim() === "") {
      return { proceed: false, headers: {}, displayText: "Remote target is missing a machine id." }
    }
    return { proceed: true, headers: { [OWNER_HEADER]: target.machineId } }
  }
  // blocked
  return {
    proceed: false,
    headers: {},
    blockedReason: target.reason,
    displayText: BLOCKED_TEXT[target.reason],
  }
}
