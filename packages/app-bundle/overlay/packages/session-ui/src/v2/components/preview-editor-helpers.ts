// #1414: pure helpers for preview-editor.tsx, extracted so the scroll-restore
// math and the initial-visibility decision are unit-tested away from the
// CodeMirror / SolidJS wiring.

/**
 * Which line to re-anchor the viewport to after an external content reload: the
 * first visible line, clamped to the new document's line count (both 1-based).
 */
export function clampVisibleLine(firstVisibleLine: number, newLineCount: number): number {
  return Math.min(Math.max(1, Math.floor(firstVisibleLine)), Math.max(1, newLineCount))
}

/**
 * The scrollTop that puts the anchored line's block back at the same in-viewport
 * offset it had before the reload (`offset = oldScrollTop - oldBlockTop`), never
 * negative.
 */
export function anchoredScrollTop(lineBlockTop: number, viewportOffset: number): number {
  return Math.max(0, lineBlockTop + viewportOffset)
}

/**
 * Initial `hidden` for a retained-pool editor. An editor mounted while INACTIVE
 * must start hidden so its capture listeners don't persist a collapsed
 * scrollTop=0 before it is ever shown; an editor with no active-gate is visible.
 */
export function initialHidden(active?: () => boolean): boolean {
  return active ? !active() : false
}
