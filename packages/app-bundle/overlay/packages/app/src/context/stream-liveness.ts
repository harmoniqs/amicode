// #1584 — the client-side SSE liveness watchdog's decision, extracted as a
// ZERO-DEPENDENCY pure fn so its test runs in-place (`bun test --conditions=solid`)
// outside the materialized tree. It MUST NOT import solid-js or @opencode-ai/*
// (that dependency is exactly what makes stream-gap.test.ts fail in-place).
//
// Mirrors the `applySseError` pattern (server-sdk.tsx): the part that reads as
// redundant — "why reconnect a stream that says it is connected?" — is the part
// a silently half-open socket makes essential, so it is covered by a test.
//
// The overlay app's v1 event iterator "neither throws nor completes" when the
// socket goes half-open (sleep/wake, Wi-Fi blip, engine replaced without
// FIN/RST): `onSseError` never fires, the `for await` parks forever, and
// `streamStatus` stays "connected" while the transcript freezes. This watchdog
// catches that: a stream that BELIEVES itself connected but has seen no frame
// for strictly longer than `staleMs` is force-reconnected (abort the parked
// attempt so the loop re-opens with the `lastEventID` cursor — lossless).

/** Reconnect a stale-but-"connected" stream — the watchdog's decision.
 *
 *  Returns `true` iff the stream believes itself `"connected"` AND no frame has
 *  arrived for strictly longer than `staleMs`. A `"disconnected"` stream is
 *  already being reconnected by the loop, so the watchdog leaves it alone; a
 *  stream exactly at the threshold is not yet stale (strict `>`). */
export function shouldReconnectIdleStream(input: {
  status: "connected" | "disconnected"
  now: number
  lastFrameAt: number
  staleMs: number
}): boolean {
  return input.status === "connected" && input.now - input.lastFrameAt > input.staleMs
}

// #1773 — an unexpected NORMAL end of the global stream is a loss. The global
// stream never ends on purpose except on shutdown, so a clean end the client did
// not ask for means events were dropped somewhere on the relay chain (a severed
// fan-in listener, a relay that ended instead of erroring). The loop used to
// reconnect 250 ms later without refetching anything: the viewed transcript and
// the entity rail stayed silently behind. Kept even once replay exists (defense
// in depth).

/** Is this completion of the stream iterator a LOSS (a resync is owed)? Only
 *  when the client neither aborted the attempt (its watchdog, its error
 *  handling, a reset — those paths heal on their own) nor stopped the loop (a
 *  user-initiated stop, a page hide, teardown). */
export function isUnexpectedStreamEnd(input: { attemptAborted: boolean; stopped: boolean }): boolean {
  return !input.attemptAborted && !input.stopped
}

/** The stream loop's end-of-stream resync latch. `ended()` is told every normal
 *  completion; an unexpected one ARMS a resync, which fires on the reconnected
 *  stream's FIRST frame (`frame()` returns true exactly once) — after the
 *  re-subscription is live, so a refetch cannot run ahead of the reconnect and
 *  miss the events in between. */
export function createStreamEndResync() {
  let armed = false
  return {
    ended(input: { attemptAborted: boolean; stopped: boolean }): void {
      if (isUnexpectedStreamEnd(input)) armed = true
    },
    /** A frame arrived: true when it is the first since an unexpected end. */
    frame(): boolean {
      if (!armed) return false
      armed = false
      return true
    },
    pending: (): boolean => armed,
  }
}
