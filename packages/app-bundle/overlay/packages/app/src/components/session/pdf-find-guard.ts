/**
 * pdf-find-guard — boot-time shield for Cmd+F on Preview PDF panes.
 *
 * Upstream's file-find (session-ui/pierre/file-find.ts) installs a
 * window-capture keydown listener the first time a `File` (diff/tool card)
 * component mounts anywhere in the app. That listener calls
 * preventDefault + stopPropagation on Cmd+F for non-editable targets,
 * stealing the key from our Preview PDF panes. Its one escape hatch: it
 * skips events where `event.defaultPrevented` is already true.
 *
 * This module installs a window-capture keydown listener at boot — before
 * any `File` can mount — that, when the event target is inside a
 * find-capable Preview PDF pane (a [data-preview-scroll] container under a
 * [data-preview-host] whose file is a PDF), calls `event.preventDefault()`
 * ONLY. Never stopPropagation: the command registry listens on
 * document-capture and must still see the key to open the pane's find pill.
 *
 * @module
 */

/** True when the event target is inside a find-capable Preview PDF pane.
 *  Editable fields (the find input, page input, zoom input) are NOT find
 *  targets — their Cmd+F reaches the pane via the registry's own fallback,
 *  and we never want to preventDefault a key an editable might own. */
export function isPdfFindTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLElement) {
    if (target.isContentEditable) return false
    if (target.closest("[contenteditable='true']")) return false
    if (target.closest(".cm-editor")) return false
    if (target.closest("input, textarea, select")) return false
  }
  const scroll = target.closest("[data-preview-scroll]")
  if (!scroll) return false
  const host = scroll.closest("[data-preview-host]")
  const path = host?.getAttribute("data-preview-host") ?? ""
  return path.toLowerCase().endsWith(".pdf")
}

export function installPdfFindGuard(win: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (!(event.metaKey || event.ctrlKey)) return
    if (event.key.toLowerCase() !== "f") return
    if (!isPdfFindTarget(event.target)) return
    // preventDefault ONLY — file-find skips defaultPrevented events, and the
    // command registry (document-capture) still fires to open the pill.
    event.preventDefault()
  }
  win.addEventListener("keydown", onKeyDown, true)
  return () => win.removeEventListener("keydown", onKeyDown, true)
}
