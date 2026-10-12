import { describe, expect, test } from "bun:test"
import { createStreamEndResync, isUnexpectedStreamEnd, shouldReconnectIdleStream } from "./stream-liveness"

// #1584 — the client-side SSE liveness watchdog's DECISION, extracted as a
// zero-dependency pure fn so it runs in-place (`bun test --conditions=solid`)
// without the materialized tree: no solid-js, no @opencode-ai/* imports (that
// is exactly what breaks stream-gap.test.ts in-place). The watchdog and both
// wake re-arm handlers in server-sdk.tsx call THIS fn; here we pin the verdict.
//
// Verdict: reconnect iff the stream believes itself "connected" AND no frame
// has arrived for strictly longer than staleMs. A "disconnected" stream is
// already reconnecting via the loop, so the watchdog leaves it alone; a stream
// exactly at the threshold is not yet stale (strict `>`).

describe("shouldReconnectIdleStream (#1584) — the liveness watchdog's decision", () => {
  test("connected + idle beyond the staleness threshold → reconnect", () => {
    expect(
      shouldReconnectIdleStream({ status: "connected", now: 100_000, lastFrameAt: 60_000, staleMs: 30_000 }),
    ).toBe(true)
  })

  test("connected + a recent frame → no reconnect", () => {
    expect(
      shouldReconnectIdleStream({ status: "connected", now: 100_000, lastFrameAt: 95_000, staleMs: 30_000 }),
    ).toBe(false)
  })

  test("disconnected → never reconnect, however idle (the loop already owns it)", () => {
    expect(
      shouldReconnectIdleStream({ status: "disconnected", now: 100_000, lastFrameAt: 0, staleMs: 30_000 }),
    ).toBe(false)
  })

  test("exactly at the threshold → no reconnect (strict greater-than)", () => {
    expect(
      shouldReconnectIdleStream({ status: "connected", now: 90_000, lastFrameAt: 60_000, staleMs: 30_000 }),
    ).toBe(false)
  })
})

// #1773 — an unexpected NORMAL end of the global stream is a loss. The global
// stream never ends on purpose except on shutdown, so a clean end the client did
// not ask for means events were dropped somewhere on the relay chain (a severed
// fan-in listener, a relay that ended instead of erroring). The loop used to
// reconnect 250 ms later without refetching anything. Now it forces a resync —
// but NOT for a user-initiated stop, a page hide, or the client's own abort.
describe("isUnexpectedStreamEnd (#1773) — which normal ends are a loss", () => {
  test("a completed stream the client neither aborted nor stopped → unexpected (a loss)", () => {
    expect(isUnexpectedStreamEnd({ attemptAborted: false, stopped: false })).toBe(true)
  })

  test("a user-initiated stop / page hide (the loop is stopped) → expected, no resync", () => {
    expect(isUnexpectedStreamEnd({ attemptAborted: true, stopped: true })).toBe(false)
    expect(isUnexpectedStreamEnd({ attemptAborted: false, stopped: true })).toBe(false)
  })

  test("the client's own abort (watchdog, error handling, reset) → expected, no resync here", () => {
    expect(isUnexpectedStreamEnd({ attemptAborted: true, stopped: false })).toBe(false)
  })
})

describe("createStreamEndResync (#1773) — an unexpected end resyncs once the stream is back", () => {
  test("after an unexpected end, the reconnected stream's FIRST frame fires the resync — exactly once", () => {
    const resync = createStreamEndResync()
    expect(resync.frame()).toBe(false) // a healthy stream never resyncs
    resync.ended({ attemptAborted: false, stopped: false })
    expect(resync.pending()).toBe(true)
    // the refetch waits for the re-subscription (the first frame on the new
    // stream), so events between the end and the reconnect cannot slip past it
    expect(resync.frame()).toBe(true)
    expect(resync.frame()).toBe(false)
    expect(resync.pending()).toBe(false)
  })

  test("a user stop or a page hide arms nothing — the next stream resyncs nothing", () => {
    const resync = createStreamEndResync()
    resync.ended({ attemptAborted: true, stopped: true }) // stop() / pagehide
    expect(resync.pending()).toBe(false)
    expect(resync.frame()).toBe(false)
  })

  test("the client's own abort arms nothing (its own path already heals: watchdog bump, disconnect edge)", () => {
    const resync = createStreamEndResync()
    resync.ended({ attemptAborted: true, stopped: false })
    expect(resync.frame()).toBe(false)
  })

  test("several unexpected ends before the stream is back still resync once", () => {
    const resync = createStreamEndResync()
    resync.ended({ attemptAborted: false, stopped: false })
    resync.ended({ attemptAborted: false, stopped: false })
    expect([resync.frame(), resync.frame()]).toEqual([true, false])
  })
})
