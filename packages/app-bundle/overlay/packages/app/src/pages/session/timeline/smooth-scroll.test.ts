import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import { createSmoothScroller, type SmoothScrollerOptions } from "./smooth-scroll"

// Mock RAF for deterministic testing
let rafCallbacks: ((time: number) => void)[] = []
let rafId = 0
const mockRaf = (cb: (time: number) => void) => {
  rafCallbacks.push(cb)
  return ++rafId
}
const mockCancelRaf = (_id: number) => {
  // In tests we just clear all — sufficient for our use
}

function flushRaf(time: number) {
  const cbs = [...rafCallbacks]
  rafCallbacks = []
  for (const cb of cbs) cb(time)
}

describe("createSmoothScroller", () => {
  let element: { scrollTop: number; scrollHeight: number; clientHeight: number }

  beforeEach(() => {
    rafCallbacks = []
    rafId = 0
    element = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 }
  })

  test("scrolls to bottom in ~180ms using ease-out", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
    })

    element.scrollTop = 500
    scroller.scrollToEnd()

    // First frame establishes startTime (no movement yet)
    flushRaf(0)
    expect(element.scrollTop).toBe(500)

    // Mid-animation — should have moved
    flushRaf(90)
    expect(element.scrollTop).toBeGreaterThan(500)
    expect(element.scrollTop).toBeLessThan(800)

    // After full duration — should be at the end
    flushRaf(180)
    expect(element.scrollTop).toBe(800) // scrollHeight - clientHeight
  })

  test("cancel() stops the animation", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
    })

    element.scrollTop = 0
    scroller.scrollToEnd()
    flushRaf(0) // start
    const posAfterStart = element.scrollTop

    scroller.cancel()
    flushRaf(90) // should do nothing — cancelled

    expect(element.scrollTop).toBe(posAfterStart)
  })

  test("isAnimating() returns true while scrolling", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
    })

    expect(scroller.isAnimating()).toBe(false)
    scroller.scrollToEnd()
    expect(scroller.isAnimating()).toBe(true)

    // First frame — still animating
    flushRaf(0)
    expect(scroller.isAnimating()).toBe(true)

    // Complete
    flushRaf(180)
    expect(scroller.isAnimating()).toBe(false)
  })

  test("calling scrollToEnd during animation updates target without restarting", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
    })

    element.scrollTop = 0
    scroller.scrollToEnd()
    flushRaf(0)

    // Content grows — target changes
    element.scrollHeight = 1200
    scroller.scrollToEnd()

    flushRaf(180) // complete
    expect(element.scrollTop).toBe(1000) // new scrollHeight - clientHeight
  })

  test("does nothing if already at bottom", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
    })

    element.scrollTop = 800 // already at bottom
    scroller.scrollToEnd()
    expect(scroller.isAnimating()).toBe(false)
  })

  test("instant mode sets scrollTop directly (for reduced-motion)", () => {
    const scroller = createSmoothScroller({
      getElement: () => element as any,
      duration: 180,
      requestAnimationFrame: mockRaf as any,
      cancelAnimationFrame: mockCancelRaf,
      reducedMotion: true,
    })

    element.scrollTop = 0
    scroller.scrollToEnd()
    expect(element.scrollTop).toBe(800) // instant
    expect(scroller.isAnimating()).toBe(false)
  })
})
