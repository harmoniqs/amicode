import { describe, expect, test } from "bun:test"
import { shouldReconnectIdleStream } from "./stream-liveness"

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
