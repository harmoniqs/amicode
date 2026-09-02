// Pure (no DOM / no Kobalte) exports from the thought-rail module.
// Extracted so tests can import these without triggering the SSR error that
// Kobalte's client-only tooltip causes in a test environment.

/** Where a row's dot centre sits when nothing measures it: 11px — the centre
 *  of a 22px first text line starting at the row's top, which is what prose
 *  and rail-label rows produce. */
export const DEFAULT_DOT_CENTRE = 11

/** Deterministic dot centre per group type — the vertical centre of the first
 *  text line for each content species, measured once and tabulated. Used as the
 *  initial value for dotCentre (the ResizeObserver measurement refines it once
 *  the DOM settles, but the initial value prevents a frame of misalignment). */
export function dotCentreForGroup(groupType: string): number {
  if (groupType === "prose" || groupType === "part") return DEFAULT_DOT_CENTRE
  if (groupType === "single_tool" || groupType === "shell" || groupType === "edit" || groupType === "context") return DEFAULT_DOT_CENTRE
  if (groupType === "tool_group") return DEFAULT_DOT_CENTRE
  if (groupType === "thinking") return DEFAULT_DOT_CENTRE
  return DEFAULT_DOT_CENTRE
}

/**
 * Rule 6 — lone COMPLETED steps render nothing (one dot is decoration). A
 * RUNNING turn rails from its very first step, though — the live dot is the
 * timeline's only "working" mark. The lone live dot draws no line — every line
 * must end at a dot at both ends, so a single dot has no dangling half — and a
 * one-step completion still reads as "dot fills".
 */
export function shouldRenderRail(_input: {
  previousAssistantPart: boolean
  lastAssistantPart: boolean
  turnRunning: boolean
}) {
  // The Thinking row is always the first rail node, so every AssistantPart
  // always has at least one other node above it — the rail always renders.
  return true
}
