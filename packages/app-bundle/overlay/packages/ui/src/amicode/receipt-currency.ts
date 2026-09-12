import type { EventView } from "./problem"

// AMICODE: is a given diff receipt the CURRENT state of the ACTIVE problem?
//
// WHY THIS EXISTS (spec-20260727-164748 §9.4). Every amicode_* receipt used to
// render the full entity view inline, and that view read the LIVE problem view
// rather than a snapshot at its own seq. Two consequences, both wrong:
//
//   1. N updates to one entity painted N identical copies of the present — the
//      transcript looked like a history and carried none.
//   2. The transcript fetches the globally-active problem with NO ?slug=, and
//      ~/.amico/problems/active is a single global file. So switching problems
//      mid-chat retroactively rewrote every earlier receipt to the new problem.
//
// The rule: exactly the current receipt renders live; everything else renders
// from the captured sentinel diff it already carries. This module is the pure
// predicate for "current", kept out of card.tsx so it is testable without
// rendering anything.
//
// Deliberately permissive in the ambiguous cases. card.tsx's original gate note
// warns that "a record+update lands as two events but one receipt, and the view
// can lag a beat, so tighter gates hid the view entirely" — so a kind with no
// events YET stays current rather than collapsing to a chip that would look
// like data loss.

/** Highest `seq` among events for `kind`, or undefined when that kind has none.
 *  Does not assume the events are sorted. */
export function latestSeqForEntity(events: EventView[], kind: string): number | undefined {
  let latest: number | undefined
  for (const event of events) {
    if (event.entity !== kind) continue
    if (latest === undefined || event.seq > latest) latest = event.seq
  }
  return latest
}

export interface ReceiptRef {
  /** Problem slug the receipt was captured against (sentinel `problem`). */
  problem?: string
  entity: string
  seq?: number
}

export interface CurrencyView {
  slug?: string
  events: EventView[]
}

/** True when this receipt should render LIVE (it is the current state of the
 *  active problem); false when it should render from its captured diff. */
export function receiptIsCurrent(receipt: ReceiptRef, view: CurrencyView | undefined): boolean {
  // No view: currency is unknowable. Render captured rather than guess.
  if (!view) return false
  // A receipt with no seq cannot be placed in the entity's history.
  if (typeof receipt.seq !== "number") return false
  // Captured against a DIFFERENT problem than the one now active → history.
  // Skipped when either side lacks a slug: we cannot detect a switch, so fall
  // through to the seq check rather than collapsing every receipt.
  if (receipt.problem !== undefined && view.slug !== undefined && receipt.problem !== view.slug) return false
  // Superseded by a later event for the same kind → history.
  const latest = latestSeqForEntity(view.events, receipt.entity)
  if (latest !== undefined && receipt.seq !== latest) return false
  return true
}
