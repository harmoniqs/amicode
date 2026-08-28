/**
 * Custom RAF-based smooth scroll — 180ms ease-out, cancels on user gesture.
 *
 * Replaces browser-native `scrollBehavior: 'smooth'` which is 500ms+ and
 * browser-dependent. This gives us snappy, consistent control.
 *
 * Contract:
 * - scrollToEnd() starts or retargets an animation toward scrollHeight - clientHeight
 * - cancel() stops mid-animation (called on user scroll gesture)
 * - isAnimating() — true while a scroll animation is in flight
 * - Under prefers-reduced-motion, scrollToEnd() is instant (no RAF)
 */

export interface SmoothScrollerOptions {
  getElement: () => HTMLElement | null | undefined
  /** Animation duration in ms (default 180) */
  duration?: number
  /** Override for testability */
  requestAnimationFrame?: typeof globalThis.requestAnimationFrame
  cancelAnimationFrame?: typeof globalThis.cancelAnimationFrame
  /** When true, all scrolls are instant (prefers-reduced-motion) */
  reducedMotion?: boolean
}

export interface SmoothScroller {
  scrollToEnd(): void
  cancel(): void
  isAnimating(): boolean
}

/** Ease-out cubic: decelerating to zero velocity */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

export function createSmoothScroller(options: SmoothScrollerOptions): SmoothScroller {
  const {
    getElement,
    duration = 180,
    requestAnimationFrame: raf = globalThis.requestAnimationFrame,
    cancelAnimationFrame: cancelRaf = globalThis.cancelAnimationFrame,
    reducedMotion = false,
  } = options

  let animating = false
  let frameId: number | undefined
  let startTime: number | undefined
  let startScroll: number | undefined

  function getTarget(el: HTMLElement): number {
    return el.scrollHeight - el.clientHeight
  }

  function cancel() {
    if (frameId !== undefined) {
      cancelRaf(frameId)
      frameId = undefined
    }
    animating = false
    startTime = undefined
    startScroll = undefined
  }

  function scrollToEnd() {
    const el = getElement()
    if (!el) return

    const target = getTarget(el)
    const current = el.scrollTop

    // Already at bottom (within 1px tolerance)
    if (Math.abs(target - current) < 1) {
      cancel()
      return
    }

    // Instant mode for reduced motion
    if (reducedMotion) {
      el.scrollTop = target
      return
    }

    // If already animating, just update target (retarget) — the loop reads
    // getTarget() each frame, so we don't need to restart
    if (animating) return

    animating = true
    startScroll = current
    startTime = undefined

    function step(time: number) {
      if (!animating) return
      const el = getElement()
      if (!el) { cancel(); return }

      if (startTime === undefined) startTime = time
      const elapsed = time - startTime
      const progress = Math.min(elapsed / duration, 1)
      const easedProgress = easeOut(progress)

      const target = getTarget(el)
      const distance = target - startScroll!
      el.scrollTop = startScroll! + distance * easedProgress

      if (progress >= 1) {
        el.scrollTop = target
        animating = false
        frameId = undefined
        startTime = undefined
        startScroll = undefined
      } else {
        frameId = raf(step)
      }
    }

    frameId = raf(step)
  }

  function isAnimating() {
    return animating
  }

  return { scrollToEnd, cancel, isAnimating }
}
