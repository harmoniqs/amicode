// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Instead of capping the chat panel at a fraction of the window
// (which forces the review pane to grow with the monitor), reserve a fixed
// minimum for the review pane and let the chat panel take everything else.
export const SESSION_PANEL_WIDTH_MIN = 450
export const REVIEW_PANE_WIDTH_MIN = 480
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 800

export function sessionPanelWidthMax(input: { available: number; split: boolean }) {
  const pane = input.split ? REVIEW_PANE_WIDTH_MIN_SPLIT : REVIEW_PANE_WIDTH_MIN
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - pane)
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: { width: number; available: number | undefined; split: boolean }) {
  if (input.available === undefined) return input.width
  return Math.min(input.width, sessionPanelWidthMax({ available: input.available, split: input.split }))
}

// amicode#105: the Work Column owns a bounded width of its own. The pre-fix
// philosophy (above) let the review pane take everything the chat left behind
// — a wide monitor squished the chat into the left margin. Now the column is
// fixed-width (default 320 — DEFAULT_PANEL_COLUMN_WIDTH — user-resizable
// within these bounds) and the CHAT is the flex remainder.
export const WORK_COLUMN_WIDTH_MIN = 330

/** The column may never take more than 60% of the measured row. */
export function workColumnWidthMax(available: number) {
  return Math.max(WORK_COLUMN_WIDTH_MIN, Math.floor(available * 0.6))
}

/** `available` is undefined until the layout row is first measured; render the
 * stored width untouched until then (same first-frame rule as the chat). */
export function clampWorkColumnWidth(input: { width: number; available: number | undefined }) {
  if (input.available === undefined) return input.width
  return Math.min(Math.max(input.width, WORK_COLUMN_WIDTH_MIN), workColumnWidthMax(input.available))
}

/** In v2 with the work column visible, the chat is the flex remainder (no
 * fixed pixel width). Classic layout keeps the historical fixed chat width. */
export function sessionChatTakesRemainder(input: { newDesign: boolean; columnVisible: boolean }): boolean {
  return input.newDesign && input.columnVisible
}
