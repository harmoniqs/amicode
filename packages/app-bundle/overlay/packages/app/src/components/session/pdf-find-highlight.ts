/**
 * pdf-find-highlight — CSS Custom Highlight API painter for PDF find (S1).
 *
 * Paints matches via CSS.highlights under the "amicode-pdf-find*" names —
 * upstream's file-find owns "opencode-find*" and deletes them globally, so
 * those names are off-limits. The DOM (text layer, canvas) is NEVER touched.
 *
 * The PDF page is always white, so the colors are fixed and theme-
 * independent: all-matches a translucent yellow, the current match a
 * stronger orange. A small <style> with the ::highlight pseudo rules is
 * injected once per document; the registry entries are per-set.
 *
 * Feature-detects CSS.highlights and no-ops gracefully when absent.
 *
 * @module
 */

const ALL_NAME = "amicode-pdf-find"
const CURRENT_NAME = "amicode-pdf-find-current"
const STYLE_ATTR = "data-amicode-pdf-find-style"

const HIGHLIGHT_CSS = `
::highlight(${ALL_NAME}) {
  background-color: rgba(255, 200, 0, 0.35);
  color: inherit;
}
::highlight(${CURRENT_NAME}) {
  background-color: rgba(255, 140, 0, 0.55);
  color: inherit;
}
`

type HighlightLike = new (...ranges: Range[]) => object
type HighlightRegistryLike = { set: (name: string, h: object) => void; delete: (name: string) => void }

function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightLike } | null {
  const g = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: HighlightLike
  }
  const registry = g.CSS?.highlights
  const Highlight = g.Highlight
  if (!registry || typeof Highlight !== "function") return null
  return { registry, Highlight }
}

/** Inject the ::highlight rules once per document. Cheap to re-call. */
function ensureStyle() {
  if (typeof document === "undefined") return
  if (document.head?.querySelector(`style[${STYLE_ATTR}]`)) return
  const style = document.createElement("style")
  style.setAttribute(STYLE_ATTR, "")
  style.textContent = HIGHLIGHT_CSS
  document.head?.appendChild(style)
}

/**
 * Paint `ranges` (document order), with `currentIndex` singled out under the
 * current-match highlight. No-ops when the API is unavailable.
 */
export function paintPdfFindHighlights(ranges: Range[], currentIndex: number): boolean {
  const api = highlightApi()
  if (!api) return false
  ensureStyle()
  api.registry.delete(ALL_NAME)
  api.registry.delete(CURRENT_NAME)
  const current = ranges[currentIndex]
  if (current) api.registry.set(CURRENT_NAME, new api.Highlight(current))
  const rest = ranges.filter((_, i) => i !== currentIndex)
  if (rest.length > 0) api.registry.set(ALL_NAME, new api.Highlight(...rest))
  return true
}

/** Remove both highlights. */
export function clearPdfFindHighlights(): void {
  const api = highlightApi()
  if (!api) return
  api.registry.delete(ALL_NAME)
  api.registry.delete(CURRENT_NAME)
}

/** True when the CSS Custom Highlight API is usable in this environment. */
export function pdfFindHighlightsSupported(): boolean {
  return highlightApi() !== null
}
