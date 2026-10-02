/**
 * remote-create-preflight.ts — #1643 (completes #1484 AC3)
 *
 * The composer's pre-flight orchestration — the app-side GATE that runs BEFORE
 * a session.create so a blocked remote pick surfaces its exact reason inline
 * and no session is created. It composes the two service routes:
 *
 *   1. GET /amicode/fleet/creation-target?machine=<id> → local | remote | blocked
 *   2. for a remote target, GET /amicode/fleet/peer-home-base?machine=<id>
 *      → the directory the remote create lands in (unresolvable → no-remote-root)
 *
 * The decision:
 *   - local              → proceed, no arm, no remote directory (unchanged path)
 *   - remote + directory → proceed, arm the owner, carry the remote directory
 *   - blocked / no-root  → refuse, carry the reason for inline display
 *   - any fetch error    → refuse as transport-down (NEVER a silent local
 *     create dressed as remote — the #1382 fallback the design forbids)
 *
 * Pure over injected fetchers; the live composer wires them to amicodeGet.
 */

import { planRemoteCreate, type BlockedReason, type CreationTargetView } from "./remote-create-header"

export interface CreationTargetResponse {
  ok: boolean
  target?: CreationTargetView
  reason?: string
}

export interface PeerHomeBaseResponse {
  ok: boolean
  directory?: string
  reason?: string
}

export interface PreflightFetchers {
  getCreationTarget: (machine: string) => Promise<CreationTargetResponse>
  getPeerHomeBase: (machine: string) => Promise<PeerHomeBaseResponse>
}

export interface PreflightResult {
  /** Whether the composer should proceed with the create. */
  proceed: boolean
  /** The owner id to arm (remote target only); undefined for local. */
  ownerToArm?: string
  /** The directory the remote create must use (remote target only). */
  remoteDirectory?: string
  /** The blocked reason when proceed is false. */
  blockedReason?: BlockedReason
  /** Human-readable inline text when blocked. */
  displayText?: string
}

/** Run the pre-flight gate for a picked machine. No selection or a local pick
 *  proceeds locally with no arming. */
export async function runCreatePreflight(
  selectedMachineId: string | undefined,
  fetchers: PreflightFetchers,
): Promise<PreflightResult> {
  if (selectedMachineId === undefined || selectedMachineId.trim() === "") {
    return { proceed: true }
  }

  let target: CreationTargetView
  try {
    const res = await fetchers.getCreationTarget(selectedMachineId)
    if (!res.ok || !res.target) {
      return { proceed: false, blockedReason: "transport-down", displayText: "Couldn't check that machine." }
    }
    target = res.target
  } catch {
    // A gate we cannot reach is NOT a license to create locally under a remote
    // pick — refuse as transport-down (the #1382 no-silent-fallback invariant).
    return { proceed: false, blockedReason: "transport-down", displayText: "That machine is currently unreachable." }
  }

  const plan = planRemoteCreate(target)
  if (!plan.proceed) {
    return { proceed: false, blockedReason: plan.blockedReason, displayText: plan.displayText }
  }

  // Local target → proceed unchanged.
  if (target.kind === "local") {
    return { proceed: true }
  }

  // Remote target → resolve the peer's working directory before arming.
  try {
    const home = await fetchers.getPeerHomeBase(target.machineId)
    if (!home.ok || !home.directory) {
      const noRoot = planRemoteCreate({ kind: "blocked", machineId: target.machineId, reason: "no-remote-root" })
      return { proceed: false, blockedReason: "no-remote-root", displayText: noRoot.displayText }
    }
    return { proceed: true, ownerToArm: target.machineId, remoteDirectory: home.directory }
  } catch {
    return { proceed: false, blockedReason: "transport-down", displayText: "That machine is currently unreachable." }
  }
}
