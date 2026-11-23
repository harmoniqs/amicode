// Per-session chat scroll posture (harmoniqs/amicode#1251).
//
// MessageTimeline remounts per session, so a reader who scrolled up in session A
// used to land at the bottom after visiting B and coming back. This module holds
// the part of the fix that does not need the DOM: what to remember, and the
// bounded loop that re-applies a restored position while late layout settles.
// The wiring lives in message-timeline.tsx and session.tsx.

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

/** Distance from the bottom (px) within which the reader counts as "at the bottom".
 *  Matches createAutoScroll's default bottomThreshold. */
export const POSTURE_BOTTOM_THRESHOLD = 10

export function createScrollPostureStore() {
  const entries = new Map<string, number>()
  return {
    /** Save the reader's scrollTop if they have left the bottom; forget it otherwise. */
    record(key: string, el: ScrollMetrics) {
      const max = el.scrollHeight - el.clientHeight
      if (max <= 1 || max - el.scrollTop < POSTURE_BOTTOM_THRESHOLD) entries.delete(key)
      else entries.set(key, el.scrollTop)
    },
    get(key: string): number | undefined {
      return entries.get(key)
    },
    clear(key: string) {
      entries.delete(key)
    },
  }
}

/** Shared by every MessageTimeline instance and the session page; survives the per-session remount. */
export const scrollPostures = createScrollPostureStore()

/** Frames a restore keeps defending the saved position while late measurement settles. */
export const RESTORE_SETTLE_FRAMES = 6

/** Pixels of slack between the wanted and actual scrollTop that count as restored. */
export const RESTORE_TOLERANCE = 2

/**
 * Apply `target` now, then re-apply it each frame for a bounded window if late
 * layout (row measurement, resize anchoring) moves the chat away. A real user
 * scroll ends it at once. `done` fires once when the window ends or the user
 * takes over; the returned cancel stops it silently (unmount).
 */
export function restoreScrollPosture(opts: {
  target: number
  read: () => number | undefined
  apply: (top: number) => void
  interrupted: () => boolean
  schedule: (fn: () => void) => () => void
  done: () => void
  frames?: number
}): () => void {
  const budget = opts.frames ?? RESTORE_SETTLE_FRAMES
  let frame = 0
  let cancelFrame: (() => void) | undefined
  const tick = () => {
    cancelFrame = undefined
    if (opts.interrupted()) return opts.done()
    const current = opts.read()
    if (current === undefined) return opts.done()
    if (Math.abs(current - opts.target) > RESTORE_TOLERANCE) opts.apply(opts.target)
    if (frame++ >= budget) return opts.done()
    cancelFrame = opts.schedule(tick)
  }
  tick()
  return () => cancelFrame?.()
}
