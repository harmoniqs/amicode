import { createComputed, createMemo, createSignal, type Accessor } from "solid-js"

export type StreamStatus = "connected" | "disconnected"

/** Whether the stream has EVER connected — boot renders "disconnected"
 *  transiently while the stream is still being set up, and that boot transient
 *  must never read as a loss (the ConnectionBanner's connectedOnce gate). */
export type StreamGapState = { everConnected: boolean }

export const initialStreamGapState: StreamGapState = { everConnected: false }

/** One #638 status transition. The machine itself (server-sdk's
 *  `event.status()`) is untouched; this folds ITS output into the render state. */
export function nextStreamGapState(state: StreamGapState, status: StreamStatus): StreamGapState {
  return status === "connected" ? { everConnected: true } : state
}

/** The one piece of render state derived from the machine: the GAP — a stream
 *  loss AFTER a first successful connect. A live stream is not a gap; a boot
 *  transient is not a gap; a loss after connect is; reconnect clears it, and a
 *  subsequent loss is a new gap, not a latched one. */
export function isStreamGap(state: StreamGapState, status: StreamStatus): boolean {
  return nextStreamGapState(state, status).everConnected && status === "disconnected"
}

/** Fold a status sequence to the gap verdict — testable without a reactive
 *  runtime (bun test resolves solid-js to its server build). */
export function reduceStreamGap(sequence: StreamStatus[]): boolean {
  let state = initialStreamGapState
  for (const status of sequence) {
    state = nextStreamGapState(state, status)
  }
  return isStreamGap(state, sequence.at(-1) ?? "disconnected")
}

/**
 * amicode#1203 — reactive wiring of the pure reducer above to the #638 machine.
 * Consumers: the session page's reconnecting veil (dimmed last-rendered view,
 * never an unmounted one) and the composer's honest send refusal during the gap.
 */
export function createStreamGap(status: Accessor<StreamStatus>) {
  const [everConnected, setEverConnected] = createSignal(false)
  createComputed(() => {
    if (status() === "connected") setEverConnected(true)
  })
  return createMemo(() => isStreamGap({ everConnected: everConnected() }, status()))
}
