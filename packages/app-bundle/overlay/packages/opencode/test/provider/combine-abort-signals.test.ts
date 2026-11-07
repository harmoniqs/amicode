import { expect, test, describe } from "bun:test"
import { getEventListeners } from "node:events"
import { combineAbortSignals } from "@/provider/provider"

// ============================================================================
// Harmoniqs overlay fix — the AbortSignal.any listener leak (provider.ts fetch
// wrapper). Upstream combined per-fetch signals with `AbortSignal.any(signals)`,
// which registers an internal abort listener on EVERY source signal. For the
// short-lived signals (chunk/header/timeout) that is harmless — they die with
// the fetch. But one source, `opts.signal`, is the LONG-LIVED session/turn
// abort signal reused across many sequential LLM fetches in one turn. Each
// fetch planted another un-removed listener on it; the composite was discarded
// but its listener on the durable signal only cleared on non-deterministic GC.
// Listeners accumulated → MaxListenersExceededWarning on the internal node,
// then a real unbounded leak over a long turn.
//
// combineAbortSignals is the deterministic replacement: it wires each source to
// one controller with listeners we OWN and REMOVE in dispose(), so a durable
// source returns to its baseline listener count after every fetch. dispose() is
// called when the fetch (and any SSE stream) is fully settled.
// ============================================================================

// Real, runtime-agnostic abort-listener count via node:events (works on Bun's
// AbortSignal EventTarget) — so the anti-leak assertion actually bites: a
// regression back to AbortSignal.any would leave listeners here and fail.
function listenerCount(sig: AbortSignal): number {
  return getEventListeners(sig, "abort").length
}

describe("combineAbortSignals — deterministic combiner that never leaks on a durable source", () => {
  test("with no sources returns null (nothing to combine)", () => {
    const { signal } = combineAbortSignals([])
    expect(signal).toBeNull()
  })

  test("with one source returns that source unchanged (no wrapping needed)", () => {
    const ctl = new AbortController()
    const { signal } = combineAbortSignals([ctl.signal])
    expect(signal).toBe(ctl.signal)
  })

  test("a durable source returns to baseline listener count after dispose() — the leak fix", () => {
    const durable = new AbortController().signal
    expect(listenerCount(durable)).toBe(0) // baseline
    // Simulate a long turn: many sequential fetches share the SAME durable signal.
    for (let i = 0; i < 50; i++) {
      const perFetch = new AbortController() // a short-lived timeout signal
      const { dispose } = combineAbortSignals([durable, perFetch.signal])
      dispose()
    }
    // The whole point: after 50 fetches the durable signal is back to baseline,
    // NOT holding ~50 listeners (which AbortSignal.any would have left behind).
    expect(listenerCount(durable)).toBe(0)
  })

  test("before dispose, exactly one listener is wired onto the durable source", () => {
    const durable = new AbortController().signal
    const { dispose } = combineAbortSignals([durable, new AbortController().signal])
    expect(listenerCount(durable)).toBe(1) // wired while the fetch is in flight
    dispose()
    expect(listenerCount(durable)).toBe(0) // and removed on settle
  })

  test("aborting a source before dispose still aborts the combined signal", () => {
    const a = new AbortController()
    const b = new AbortController()
    const { signal } = combineAbortSignals([a.signal, b.signal])
    expect(signal!.aborted).toBe(false)
    a.abort(new Error("boom"))
    expect(signal!.aborted).toBe(true)
  })

  test("an already-aborted source yields an already-aborted combined signal", () => {
    const pre = AbortSignal.abort(new Error("already"))
    const live = new AbortController().signal
    const { signal } = combineAbortSignals([pre, live])
    expect(signal!.aborted).toBe(true)
  })

  test("dispose() after the combined signal already aborted is a safe no-op", () => {
    const a = new AbortController()
    const { signal, dispose } = combineAbortSignals([a.signal, new AbortController().signal])
    a.abort()
    expect(signal!.aborted).toBe(true)
    expect(() => dispose()).not.toThrow()
    expect(() => dispose()).not.toThrow() // idempotent
  })
})
