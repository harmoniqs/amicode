/**
 * preview-view-state — pure helpers for Preview document view-state (#1250).
 *
 * A Preview document owns its selection and renderer scroll (ADR-0013). This
 * module holds the browser-free logic so it is unit-testable without a real
 * CodeMirror layout: clamping a saved selection to the current document.
 *
 * The editor component (preview-editor.tsx) captures and restores this state;
 * the layout context scopes it by project + session + path (#1249's key), so
 * nothing here is global or session-aware — it is pure data.
 *
 * @module
 */

/** Editor view-state for one Preview document. Ranges are CM6 offsets. */
export type PreviewEditorViewState = {
  anchor: number
  head: number
  scrollTop: number
  scrollLeft: number
}

/** PDF view-state for one Preview document. */
export type PreviewPdfViewState = {
  page: number
  scrollTop: number
}

/** Combined per-document view-state; a document is an editor OR a PDF. */
export type PreviewViewState = {
  editor?: PreviewEditorViewState
  pdf?: PreviewPdfViewState
}

/**
 * Which CM6 update flags should trigger a view-state capture.
 *
 * DELIBERATELY EXCLUDES `geometryChanged`. `captureViewState` snapshots
 * `scrollDOM.scrollTop` — a layout-forcing read. `geometryChanged` fires
 * DURING CM6's measure cycle, so capturing there forces a synchronous reflow
 * mid-measure, which CM6 sees as a new geometry change and re-measures →
 * a measure-loop that freezes the webview on a tiny `.tex` open (then OOM-
 * crashes VS Code). Selection and document changes are safe triggers; genuine
 * user scrolls are captured by the scroller's `scroll` event listener, not
 * here — so dropping `geometryChanged` loses no real state.
 */
export function shouldCaptureOnUpdate(update: {
  selectionSet: boolean
  docChanged: boolean
  geometryChanged: boolean
}): boolean {
  return update.selectionSet || update.docChanged
}

const clampOffset = (offset: number, docLength: number) =>
  Math.max(0, Math.min(Math.trunc(offset), docLength))

/**
 * Clamp a saved selection to the current document length, preserving the range
 * (and its direction). A shrunk document collapses ends that fell past its end
 * rather than throwing. Restoring the full {anchor, head} — not a collapsed
 * cursor — is the correctness fix over the parked prototype.
 */
export function clampEditorSelection(
  state: PreviewEditorViewState,
  docLength: number,
): { anchor: number; head: number } {
  return {
    anchor: clampOffset(state.anchor, docLength),
    head: clampOffset(state.head, docLength),
  }
}
