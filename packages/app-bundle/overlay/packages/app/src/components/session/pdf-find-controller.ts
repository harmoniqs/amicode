/**
 * pdf-find-controller — per-pane find state for a Preview PDF pane (S1).
 *
 * One controller per PreviewFileView instance. Owns the reactive state
 * { open, query, matches, currentIndex, hasText } and the wiring between the
 * find pill, the CSS Custom Highlight painter, and the pane's scroll
 * container.
 *
 * The searchable index is built LAZILY on first open (the PDF text layer is
 * main-thread pdf.js work — don't pay it for panes that never search) and
 * rebuilt whenever the pane content signal changes (recompile, tab restore)
 * — the caller wires `rebuild` to the base64 prop.
 *
 * Scroll-to-match never uses scrollIntoView (it would scroll ancestors —
 * the workspace grid, the side panel). It computes the current match's rect
 * relative to the pane's own [data-preview-scroll] container and sets only
 * that container's scrollTop/scrollLeft, landing the match ~50px below the
 * floating controls.
 *
 * @module
 */

import { createSignal } from "solid-js"
import { buildPdfIndex, findMatches, type PdfIndex, type PdfMatch } from "./pdf-find-core"
import { clearPdfFindHighlights, paintPdfFindHighlights } from "./pdf-find-highlight"

const QUERY_DEBOUNCE_MS = 150
/** Top margin so the match sits below the floating controls pill. */
const SCROLL_TOP_MARGIN_PX = 50

export interface PdfFindController {
  open: () => boolean
  query: () => string
  matches: () => PdfMatch[]
  currentIndex: () => number
  /** True once an index build found real text; false → the pill shows the
   *  "No searchable text in this PDF" message instead of a counter. */
  hasText: () => boolean
  count: () => number
  openFind: () => void
  close: () => void
  setQuery: (value: string) => void
  next: () => void
  prev: () => void
  clearHighlights: () => void
  /** Drop the cached index (content changed) and re-run the active query. */
  rebuild: () => void
  dispose: () => void
}

export function createPdfFindController(opts: {
  /** The PdfCanvasView wrapper div — the index root. */
  pdfRoot: () => HTMLElement | undefined
  /** The pane's own scroll container ([data-preview-scroll]). */
  scrollContainer: () => HTMLElement | undefined
}): PdfFindController {
  const [open, setOpen] = createSignal(false)
  const [query, setQuerySignal] = createSignal("")
  const [matches, setMatches] = createSignal<PdfMatch[]>([])
  const [currentIndex, setCurrentIndex] = createSignal(0)
  const [hasText, setHasText] = createSignal(true)

  let index: PdfIndex | null = null
  let debounce: ReturnType<typeof setTimeout> | undefined

  const ensureIndex = (): PdfIndex => {
    if (index) return index
    const root = opts.pdfRoot()
    index = root ? buildPdfIndex(root) : { text: "", steps: [], hasText: false }
    setHasText(index.hasText)
    return index
  }

  const paint = () => {
    paintPdfFindHighlights(
      matches().map((m) => m.range),
      currentIndex(),
    )
  }

  const scrollToCurrent = () => {
    const match = matches()[currentIndex()]
    const scroll = opts.scrollContainer()
    if (!match || !scroll) return
    // Re-measure live — the cached rect is from build time and the user may
    // have scrolled or zoomed since.
    const rect = match.range.getBoundingClientRect()
    const host = scroll.getBoundingClientRect()
    // Vertical: land the match just below the floating controls.
    const targetTop = scroll.scrollTop + (rect.top - host.top) - SCROLL_TOP_MARGIN_PX
    // Horizontal: only scroll when the match is outside the visible band —
    // never recenter a match the user can already see.
    const matchLeft = rect.left - host.left
    const matchRight = rect.right - host.right
    let targetLeft = scroll.scrollLeft
    if (matchLeft < 0) {
      targetLeft = scroll.scrollLeft + matchLeft - 8
    } else if (matchRight > 0) {
      targetLeft = scroll.scrollLeft + matchRight + 8
    }
    scroll.scrollTop = Math.max(0, targetTop)
    scroll.scrollLeft = Math.max(0, targetLeft)
  }

  const run = (args?: { reset?: boolean; scroll?: boolean }) => {
    const value = query().trim()
    if (!value) {
      setMatches([])
      setCurrentIndex(0)
      clearPdfFindHighlights()
      return
    }
    const idx = ensureIndex()
    if (!idx.hasText) {
      setMatches([])
      setCurrentIndex(0)
      clearPdfFindHighlights()
      return
    }
    const found = findMatches(idx, value, { caseSensitive: false, wholeWord: false })
    setMatches(found)
    const desired = args?.reset ? 0 : currentIndex()
    setCurrentIndex(found.length ? Math.min(desired, found.length - 1) : 0)
    paint()
    if (args?.scroll && found.length > 0) scrollToCurrent()
  }

  const step = (dir: 1 | -1) => {
    const found = matches()
    if (!open() || found.length === 0) return
    setCurrentIndex((currentIndex() + dir + found.length) % found.length)
    paint()
    scrollToCurrent()
  }

  return {
    open,
    query,
    matches,
    currentIndex,
    hasText,
    count: () => matches().length,

    openFind: () => {
      if (open()) return
      setOpen(true)
      ensureIndex()
      run({ reset: true, scroll: true })
    },

    close: () => {
      setOpen(false)
      setQuerySignal("")
      setMatches([])
      setCurrentIndex(0)
      clearPdfFindHighlights()
    },

    setQuery: (value: string) => {
      setQuerySignal(value)
      setCurrentIndex(0)
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        debounce = undefined
        run({ reset: true, scroll: true })
      }, QUERY_DEBOUNCE_MS)
    },

    next: () => step(1),
    prev: () => step(-1),

    clearHighlights: () => clearPdfFindHighlights(),

    rebuild: () => {
      index = null
      setHasText(true)
      if (!open()) return
      run({ reset: true, scroll: false })
    },

    dispose: () => {
      if (debounce) clearTimeout(debounce)
      clearPdfFindHighlights()
    },
  }
}
