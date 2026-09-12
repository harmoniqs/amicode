// Smooth scroll helper for the timeline (#631).
// Pure easing function — testable without DOM. The RAF loop that drives it
// lives in message-timeline.tsx; this module is the math.

/** Ease-out cubic: fast start, gentle settle. `1 - (1 - t)^3` */
export function smoothScrollInterpolate(startY: number, targetY: number, elapsed: number, duration: number): number {
  if (elapsed >= duration) return targetY
  const t = Math.min(elapsed / duration, 1)
  const eased = 1 - (1 - t) ** 3
  return startY + (targetY - startY) * eased
}

/** Duration for smooth-follow scrolls (ms). Kept short so the timeline feels
 *  responsive — native smooth-behavior is 500ms+ and browser-dependent. */
export const SMOOTH_SCROLL_DURATION = 180
