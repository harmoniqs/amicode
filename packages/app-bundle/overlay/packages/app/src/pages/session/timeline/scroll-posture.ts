// Per-session scroll posture (harmoniqs/amicode#1251).
//
// The timeline remounts per session, so a reader who scrolled up in session A
// used to land at the bottom after visiting B and coming back. This module is
// the pure part of the fix: what to remember, how to remember it, and when to
// stop re-applying a restore. The DOM wiring lives in message-timeline.tsx.

/** Distance from the bottom (px) within which the reader counts as "at the bottom". */
export const POSTURE_BOTTOM_THRESHOLD = 10

/** Frames a restore keeps re-checking for late layout before giving up. */
export const RESTORE_MAX_ATTEMPTS = 4

/** Pixels of slack between the wanted and actual scrollTop that count as restored. */
export const RESTORE_TOLERANCE = 2

export type PostureUpdate = { kind: "save"; top: number } | { kind: "clear" }

/**
 * Decide what a scroll event means for the remembered posture. Only a reader
 * who has really left the bottom is remembered; following the bottom (or having
 * nothing to scroll) forgets any saved posture so the session reopens at the end.
 */
export function postureUpdate(input: {
  anchoredToBottom: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): PostureUpdate {
  if (input.anchoredToBottom) return { kind: "clear" }
  const max = input.scrollHeight - input.clientHeight
  if (max <= 1) return { kind: "clear" }
  if (max - input.scrollTop < POSTURE_BOTTOM_THRESHOLD) return { kind: "clear" }
  return { kind: "save", top: input.scrollTop }
}

export function createScrollPostureStore(limit = 32) {
  const entries = new Map<string, number>()
  return {
    save(key: string, top: number) {
      entries.delete(key)
      entries.set(key, top)
      while (entries.size > limit) entries.delete(entries.keys().next().value!)
    },
    get(key: string): number | undefined {
      return entries.get(key)
    },
    clear(key: string) {
      entries.delete(key)
    },
  }
}

/** Shared by every MessageTimeline instance; survives the per-session remount. */
export const scrollPostures = createScrollPostureStore()

/**
 * One tick of the bounded restore loop: late measurement/effects may pull the
 * scroll away from the restored position, so re-apply a few frames, then stop.
 * A user gesture always ends the restore immediately.
 */
export function restoreStep(input: {
  current: number
  target: number
  attempt: number
  gesture: boolean
}): "apply" | "done" {
  if (input.gesture) return "done"
  if (input.attempt >= RESTORE_MAX_ATTEMPTS) return "done"
  if (Math.abs(input.current - input.target) <= RESTORE_TOLERANCE) return "done"
  return "apply"
}
