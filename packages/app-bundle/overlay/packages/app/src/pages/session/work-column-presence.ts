// Presence state for the Work Column's collapse/restore animation (#1610).
// The column is kept mounted while its width animates to 0 (closing) or from 0
// (opening), then unmounted (or expanded) once the transition settles. Pure
// reducer: the Solid wiring (timers, frames) lives in session.tsx.

export const WORK_COLUMN_TRANSITION_MS = 200
export const WORK_COLUMN_TRANSITION_EASING = "cubic-bezier(0.22,1,0.36,1)"

export type WorkColumnPhase = "unmounted" | "opening" | "open" | "closing"
export type WorkColumnEvent = "show" | "hide" | "settled"

export function reduceWorkColumnPhase(phase: WorkColumnPhase, event: WorkColumnEvent): WorkColumnPhase {
  switch (phase) {
    case "unmounted":
      return event === "show" ? "opening" : phase
    case "opening":
      if (event === "hide") return "closing"
      if (event === "settled") return "open"
      return phase
    case "open":
      return event === "hide" ? "closing" : phase
    case "closing":
      if (event === "show") return "opening"
      if (event === "settled") return "unmounted"
      return phase
  }
}

/** The column stays in the DOM for every phase except fully collapsed. */
export function workColumnMounted(phase: WorkColumnPhase): boolean {
  return phase !== "unmounted"
}

/** Only the settled open state renders at the full column width; opening
 * starts at 0 so the width transition has a start point, closing ends at 0. */
export function workColumnExpanded(phase: WorkColumnPhase): boolean {
  return phase === "open"
}

export function workColumnTransitioning(phase: WorkColumnPhase): boolean {
  return phase === "opening" || phase === "closing"
}
