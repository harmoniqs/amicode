// AMICODE: collapses RUNS of consecutive amicode_* receipt cards that share
// (problem, entity, action) into one card carrying a count — the fix for a
// real user report: "these repeated amico cards add a lot of clutter can we
// avoid this?" Four amicode_* calls that all update the same entity via the
// same action render four visually-identical cards; amico-presence.ts's
// design intent is that Amico pops in, works, and pops out clean — a wall of
// look-alike receipts is exactly the clutter that breaks.
//
// Pure + DOM-free (fork convention — see thinking.ts, run-series.ts,
// receipt-currency.ts): this module knows nothing about SDK part/message
// types. It works over an abstract `Ref` — message-part.tsx supplies
// PartGroup entries as Refs and reduces the result back into its render list.
//
// Conservative by construction, per the spec's rules:
//  - Only a PARSED AMICODE_DIFF sentinel carries (problem, entity, action).
//    A receipt whose sentinel doesn't parse (the legacy Chip fallback —
//    receipt.ts's parseDiffSentinel, card.tsx's Chip) has no key and never
//    merges with anything, including another unparseable receipt.
//  - INLINE_KINDS entities (receipt.ts) never merge either, even though
//    their sentinel parses fine. Whether such a receipt renders as a Chip or
//    the live InlineEntityView depends on receipt-currency.ts's
//    receiptIsCurrent, which reads the LIVE problem view — reactive
//    UI-bridge state this pure module has no access to. Collapsing one of
//    those into a single representative card risks silently dropping
//    whichever render path the representative doesn't take, which would be
//    exactly the information loss this feature must not cause. Left to
//    render exactly as before; only entities that always take the Chip body
//    (e.g. "recommend", "problem") are collapse-eligible.
//  - "Latest" reuses receipt-currency's seq semantics — highest numeric seq
//    wins, order not assumed (see latestSeqForEntity) — rather than
//    inventing a parallel notion of "current". A collapsed card must open
//    the highest seq in its run because later receipts supersede earlier
//    ones.

import { INLINE_KINDS, type DiffSentinel } from "./receipt"

export interface ReceiptKey {
  problem: string
  entity: string
  action: string
}

function sameKey(a: ReceiptKey, b: ReceiptKey): boolean {
  return a.problem === b.problem && a.entity === b.entity && a.action === b.action
}

/** The (problem, entity, action) a receipt would merge on, or undefined when
 *  it must never merge: no sentinel parsed, or its entity has a live inline
 *  view this module can't safely predict the routing for (see module docs). */
export function receiptRunKey(sentinel: DiffSentinel | undefined): ReceiptKey | undefined {
  if (!sentinel) return undefined
  if (INLINE_KINDS.has(sentinel.entity)) return undefined
  return { problem: sentinel.problem, entity: sentinel.entity, action: sentinel.action }
}

export interface ReceiptCandidate<Ref> {
  ref: Ref
  /** undefined ⇒ this candidate can never merge, with anything. */
  key?: ReceiptKey
  seq?: number
}

export interface ReceiptRun<Ref> {
  /** Members in transcript order. Length 1 for a non-merged (or unmergeable) receipt. */
  refs: Ref[]
  /** The member to render: highest seq; ties or all-missing seq prefer the LATER member. */
  latestRef: Ref
  count: number
}

/** Highest-seq member of a run. Ties, or a run where no member carries a
 *  seq, prefer the member that occurs LATER in the run — transcript order is
 *  itself a proxy for recency when the sentinel omits `seq`. Mirrors
 *  receipt-currency's latestSeqForEntity (max wins, order not assumed)
 *  without requiring every member to carry a seq the way EventView does. */
function pickLatest<Ref>(items: ReceiptCandidate<Ref>[]): Ref {
  let best = items[0]
  for (let i = 1; i < items.length; i++) {
    const item = items[i]
    if (item.seq !== undefined && (best.seq === undefined || item.seq > best.seq)) best = item
    else if (item.seq === undefined && best.seq === undefined) best = item
  }
  return best.ref
}

/** Collapse consecutive candidates that share a key into one run. A
 *  candidate with no key never merges with its neighbours — not even with
 *  another keyless candidate — so it always surfaces as its own run of one,
 *  and it breaks any run adjacent to it. */
export function collapseReceiptRuns<Ref>(items: ReceiptCandidate<Ref>[]): ReceiptRun<Ref>[] {
  const runs: ReceiptRun<Ref>[] = []
  let open: ReceiptCandidate<Ref>[] = []

  const flushOpen = () => {
    if (open.length === 0) return
    runs.push({ refs: open.map((item) => item.ref), latestRef: pickLatest(open), count: open.length })
    open = []
  }

  for (const item of items) {
    if (!item.key) {
      flushOpen()
      runs.push({ refs: [item.ref], latestRef: item.ref, count: 1 })
      continue
    }
    const current = open[open.length - 1]
    if (current?.key && sameKey(current.key, item.key)) open.push(item)
    else {
      flushOpen()
      open.push(item)
    }
  }
  flushOpen()

  return runs
}
