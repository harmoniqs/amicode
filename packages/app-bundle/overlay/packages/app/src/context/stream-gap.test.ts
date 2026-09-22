import { describe, expect, test } from "bun:test"
import { reduceStreamGap } from "./stream-gap"

// amicode#1203 — the RENDER response to SSE loss. The #638 honest-liveness
// machine (server-sdk's `event.status()`) keeps its transitions untouched; this
// file pins the derived state the render layer may act on: the GAP — a stream
// loss AFTER a first successful connect. Pure reducer tests: bun test resolves
// solid-js to its server build, where memos are not reactive (see
// lineage-ledger-panel.test.tsx for the repo-wide pattern of pure substance +
// thin reactive wiring).

describe("stream gap (#1203) — the render layer's read of the #638 machine", () => {
  test("boot — a stream that never connected is NOT the gap", () => {
    // The banner boot-renders "disconnected" transiently while the stream is
    // being set up; the render layer must treat that as normal, not degraded.
    expect(reduceStreamGap([])).toBe(false)
    expect(reduceStreamGap(["disconnected", "disconnected"])).toBe(false)
  })

  test("a live stream is not the gap", () => {
    expect(reduceStreamGap(["connected"])).toBe(false)
    expect(reduceStreamGap(["connected", "connected"])).toBe(false)
  })

  test("a loss AFTER a first successful connect IS the gap", () => {
    expect(reduceStreamGap(["connected", "disconnected"])).toBe(true)
  })

  test("the gap survives repeated disconnect reports during the loss", () => {
    expect(reduceStreamGap(["connected", "disconnected", "disconnected"])).toBe(true)
  })

  test("reconnect clears the gap — the render response must un-degrade in place", () => {
    expect(reduceStreamGap(["connected", "disconnected", "connected"])).toBe(false)
  })

  test("a loss after a reconnect is a NEW gap, not a latched one", () => {
    expect(reduceStreamGap(["connected", "disconnected", "connected", "disconnected"])).toBe(true)
  })
})
