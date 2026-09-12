import { createSignal } from "solid-js"
import type { ApprovalRequest, Warrant } from "./approval"

// AMICODE: module-level bridge between the approval card (rendered deep inside the
// message-part dispatch, where no app context is reachable) and the host that can
// actually reach the ledger. Same shape and lifetime as ./ask-bridge.ts.
//
// WHY A SEPARATE BRIDGE FROM ask-bridge (spec-20260727-164748 §9.5). The ask bridge's
// `send` submits text as the user's next CHAT MESSAGE. Routing an approval through it
// would mean the agent reads the message and then writes the ledger row itself, so the
// only durable provenance for the approval would read "the agent says the user
// approved". `approve` instead reaches `amico ledger approve` on the host, which is the
// ledger's single writer (#212). The distinction is the point; do not "simplify" these
// two bridges into one.
//
// The read-only interlock is inherited from the same discipline: when no bridge is
// registered — share page, headless embed, any surface with no host — the card renders
// non-actionable rather than optimistically enabled. Absence of transport is the
// safe state, so it is the default.

export interface ApprovalBridge {
  /** Mint a warrant. Goes to the ledger via the host, NEVER through the chat. */
  approve: (request: ApprovalRequest) => void
  /** Warrants the host currently knows about — the card's state is derived from
   *  these rather than stored, so it stays correct across replay and reload. */
  warrants: () => readonly Warrant[]
}

const [current, setCurrent] = createSignal<ApprovalBridge | undefined>(undefined)

export const amicodeApprovalBridge = current

/** Register the host transport. Returns a disposer that only clears the signal if it
 *  is still the one it installed, so an unmount cannot wipe a newer registration. */
export function registerAmicodeApprovalBridge(bridge: ApprovalBridge): () => void {
  setCurrent(bridge)
  return () => {
    if (current() === bridge) setCurrent(undefined)
  }
}

/** Warrants known to the host, or an empty list when there is no transport. Empty
 *  means "no warrant", which the state machine reads as `pending` on a live surface
 *  and `unavailable` on a read-only one — never as "approved". */
export function amicodeWarrants(): readonly Warrant[] {
  return current()?.warrants() ?? []
}

/** True when a host transport is present. The card's actionability gate. */
export function hasApprovalBridge(): boolean {
  return current() !== undefined
}

/** Send an approval. A no-op without a bridge — a read-only surface must never
 *  appear to have approved something it could not record. */
export function submitApproval(request: ApprovalRequest): void {
  current()?.approve(request)
}
