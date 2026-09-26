import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import {
  startReconcileTimer,
  cancelReconcileTimer,
  cancelAllReconcileTimers,
  hasReconcileTimer,
} from "./session-status-reconcile"

// amicode#1567 — reconciliation safety valve for optimistic "busy" status.
// The timer fires when the SSE event resolving "busy" never arrives (fan-in
// gap, network loss). Pure timer management tests: injectable timeout keeps
// assertions sub-second without fake-timer machinery.

const SHORT_MS = 30

describe("session-status-reconcile (#1567)", () => {
  beforeEach(() => cancelAllReconcileTimers())
  afterEach(() => cancelAllReconcileTimers())

  test("startReconcileTimer calls onReconcile after timeout", async () => {
    const onReconcile = mock(() => {})
    startReconcileTimer("s1", onReconcile, SHORT_MS)
    expect(onReconcile).not.toHaveBeenCalled()
    expect(hasReconcileTimer("s1")).toBe(true)
    await new Promise((r) => setTimeout(r, SHORT_MS + 20))
    expect(onReconcile).toHaveBeenCalledTimes(1)
    expect(onReconcile.mock.calls[0]).toEqual(["s1"])
    expect(hasReconcileTimer("s1")).toBe(false)
  })

  test("cancelReconcileTimer prevents the callback from firing", async () => {
    const onReconcile = mock(() => {})
    startReconcileTimer("s1", onReconcile, SHORT_MS)
    expect(hasReconcileTimer("s1")).toBe(true)
    cancelReconcileTimer("s1")
    expect(hasReconcileTimer("s1")).toBe(false)
    await new Promise((r) => setTimeout(r, SHORT_MS + 20))
    expect(onReconcile).not.toHaveBeenCalled()
  })

  test("starting a new timer for the same session cancels the previous one", async () => {
    const first = mock(() => {})
    const second = mock(() => {})
    startReconcileTimer("s1", first, SHORT_MS)
    startReconcileTimer("s1", second, SHORT_MS)
    await new Promise((r) => setTimeout(r, SHORT_MS + 20))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  test("cancelAllReconcileTimers clears everything", async () => {
    const a = mock(() => {})
    const b = mock(() => {})
    startReconcileTimer("s1", a, SHORT_MS)
    startReconcileTimer("s2", b, SHORT_MS)
    expect(hasReconcileTimer("s1")).toBe(true)
    expect(hasReconcileTimer("s2")).toBe(true)
    cancelAllReconcileTimers()
    expect(hasReconcileTimer("s1")).toBe(false)
    expect(hasReconcileTimer("s2")).toBe(false)
    await new Promise((r) => setTimeout(r, SHORT_MS + 20))
    expect(a).not.toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
  })

  test("cancelling a non-existent timer is a no-op", () => {
    expect(() => cancelReconcileTimer("nonexistent")).not.toThrow()
    expect(hasReconcileTimer("nonexistent")).toBe(false)
  })

  test("timers for different sessions are independent", async () => {
    const a = mock(() => {})
    const b = mock(() => {})
    startReconcileTimer("s1", a, SHORT_MS)
    startReconcileTimer("s2", b, SHORT_MS * 3)
    await new Promise((r) => setTimeout(r, SHORT_MS + 20))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(hasReconcileTimer("s1")).toBe(false)
    expect(hasReconcileTimer("s2")).toBe(true)
    cancelAllReconcileTimers()
  })
})
