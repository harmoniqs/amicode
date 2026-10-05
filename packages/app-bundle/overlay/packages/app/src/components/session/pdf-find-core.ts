/**
 * pdf-find-core — Pure find machinery for PDF panes (S1 of Cmd+F in Preview).
 *
 * Walks the pdf.js text layer ([data-pdf-text-layer] — styled by attribute,
 * NOT the `.textLayer` class) under a PDF pane root and builds a normalized
 * searchable string plus an offset map back into DOM (textNode, offset)
 * pairs. `findMatches` scans that string and returns Ranges in document
 * order, each tagged with its page number.
 *
 * Normalization:
 *  - NFKC (the text layer is already NFKC-normalized by pdf.js's
 *    streamTextContent, so ligatures are plain letters — this is a belt for
 *    the suspenders).
 *  - Whitespace runs collapse to a single space.
 *  - A <br> sibling is a line break → emits a space.
 *  - A line ending in "-" joins the next line WITHOUT the hyphen, so
 *    "transport" matches a hyphenated "trans-\nport". The removed hyphen's
 *    span characters become zero-width stops in the map so offsets after the
 *    break still land on real text.
 *
 * No UI, no CSS Custom Highlight API — painting lives in
 * pdf-find-highlight.ts. Pure functions so the whole module is unit-testable
 * away from the viewer.
 *
 * @module
 */

/** One step of the offset map: `count` normalized characters come from
 *  (node, offset..offset+count). Steps never straddle a node boundary. */
export interface PdfIndexStep {
  node: Text
  offset: number
  count: number
  page: number
}

export interface PdfIndex {
  /** The normalized searchable string. */
  text: string
  steps: PdfIndexStep[]
  /** True when at least one real (non-whitespace) text node was found.
   *  False → the caller reports "No searchable text in this PDF". */
  hasText: boolean
}

export interface PdfMatch {
  /** 1-based page number of the span the match STARTS in. */
  page: number
  /** Normalized-string offsets [start, end). */
  start: number
  end: number
  /** DOM endpoints — enough to build a Range. */
  startNode: Text
  startOffset: number
  endNode: Text
  endOffset: number
  /** Rect of the range in viewport coordinates at build time (cache — the
   *  caller re-measures live before scrolling). */
  rect: { top: number; left: number; bottom: number; right: number }
  range: Range
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------

/**
 * Build the searchable index for the PDF rendered under `root` (the
 * PdfCanvasView wrapper div). Safe to call before the text layer renders —
 * returns an empty index (hasText: false), and the caller may rebuild later.
 */
export function buildPdfIndex(root: HTMLElement): PdfIndex {
  const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-pdf-text-layer]"))

  // Raw item stream: text nodes (each carrying its page) interleaved with
  // line-break markers. A page boundary is a break too — pages never join
  // into one continuous line. The text layer's spans are absolutely
  // positioned, so DOM order inside each page container is the pdf.js
  // content order.
  type Item = { kind: "text"; node: Text; page: number } | { kind: "break" }
  const items: Item[] = []
  layers.forEach((layer, layerIndex) => {
    if (layerIndex > 0) items.push({ kind: "break" })
    const page = layerIndex + 1
    // Walk ALL nodes (elements + text) so <br> siblings register as breaks.
    // A <br> is a line end; text nodes contribute their characters. We walk
    // elements rather than reading text-node nextSibling because happy-dom
    // (the test DOM) doesn't implement sibling pointers on Text.
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_ALL)
    let node = walker.nextNode()
    while (node) {
      if (node.nodeName === "BR") {
        items.push({ kind: "break" })
      } else if (node instanceof Text && node.data.length > 0) {
        items.push({ kind: "text", node, page })
      }
      node = walker.nextNode()
    }
  })

  // Raw char stream + per-char source. Breaks carry no source (null).
  const raw: string[] = []
  const rawSource: Array<{ node: Text; offset: number; page: number } | null> = []
  for (const item of items) {
    if (item.kind === "break") {
      raw.push(" ")
      rawSource.push(null)
      continue
    }
    // NFKC per text node (ligatures arrive pre-split by pdf.js's
    // streamTextContent — this is a belt for the suspenders).
    const normalized = item.node.data.normalize("NFKC")
    for (let i = 0; i < normalized.length; i++) {
      raw.push(normalized[i])
      rawSource.push({ node: item.node, offset: i, page: item.page })
    }
  }

  // Whitespace runs collapse to a single space kept in the run's first
  // slot, mapped to ITS OWN source (the whitespace char in the text node,
  // or — for a break — the char that precedes the break). Leading and
  // trailing runs are dropped. A break-space whose preceding char is a
  // hyphen is a line-wrap hyphen ("trans-\nport") — drop BOTH so
  // "transport" matches; the removed hyphen keeps its slot but contributes
  // no character, and a real range never needs to land on it because the
  // break it paired with is gone too.
  const n = raw.length
  const out: string[] = new Array(n).fill("")
  const outSource: Array<{ node: Text; offset: number; page: number } | null> = new Array(n).fill(null)

  // The source a break maps to: the char before it. For the first char of
  // the stream there is none — the run is leading and gets dropped anyway.
  const breakFallback = (slot: number) => (slot > 0 ? rawSource[slot - 1] : null)

  let i = 0
  // Drop leading whitespace runs entirely.
  while (i < n && /\s/.test(raw[i])) i++
  let hasText = false
  while (i < n) {
    if (/\s/.test(raw[i])) {
      // Find the end of the run.
      let j = i
      while (j < n && /\s/.test(raw[j])) j++
      if (j >= n) break // trailing run — dropped
      // Hyphen-wrap check: the char before the run is a hyphen AND the run
      // contains at least one break (a null-sourced slot — real PDFs wrap
      // at line ends; a plain "word- word" space is NOT a wrap).
      const prevIsHyphen = raw[i - 1] === "-"
      const runHasBreak = rawSource.slice(i, j).some((s) => s === null)
      if (prevIsHyphen && runHasBreak) {
        // Drop the hyphen and the whole run — no space between the joined
        // halves.
        out[i - 1] = ""
        outSource[i - 1] = null
      } else {
        // Collapse the run to one space in its first slot. The space maps
        // to its own source — a break-space maps to the char before the
        // break (breakFallback), a real whitespace char to itself.
        out[i] = " "
        outSource[i] = rawSource[i] ?? breakFallback(i)
      }
      i = j
      continue
    }
    out[i] = raw[i]
    outSource[i] = rawSource[i]
    if (raw[i].trim().length > 0) hasText = true
    i++
  }

  // Assemble the normalized text + run-length steps.
  let text = ""
  const steps: PdfIndexStep[] = []
  for (let k = 0; k < n; k++) {
    const ch = out[k]
    if (!ch) continue
    text += ch
    const src = outSource[k]
    if (!src) continue
    const last = steps[steps.length - 1]
    if (last && last.node === src.node && last.offset + last.count === src.offset && last.page === src.page) {
      last.count++
    } else {
      steps.push({ node: src.node, offset: src.offset, count: 1, page: src.page })
    }
  }

  return { text, steps, hasText }
}

// ---------------------------------------------------------------------------
// Offset mapping
// ---------------------------------------------------------------------------

/** Map a normalized-string offset to a DOM (textNode, offset) boundary. */
function locate(steps: PdfIndexStep[], offset: number): { node: Text; offset: number } | null {
  let base = 0
  for (const step of steps) {
    const end = base + step.count
    if (offset < end) return { node: step.node, offset: step.offset + (offset - base) }
    if (offset === end) {
      // A step boundary — return this step's end. Either side is a valid
      // Range boundary; end-of-step plays best with client rects.
      return { node: step.node, offset: step.offset + step.count }
    }
    base = end
  }
  const last = steps[steps.length - 1]
  return last ? { node: last.node, offset: last.offset + last.count } : null
}

/** Page of the span a normalized offset starts in (for the match counter
 *  and per-page tagging). */
function pageAt(steps: PdfIndexStep[], offset: number): number {
  let base = 0
  for (const step of steps) {
    const end = base + step.count
    if (offset < end) return step.page
    base = end
  }
  return steps[steps.length - 1]?.page ?? 1
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface PdfFindOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
}

/**
 * Find all matches of `query` in the index. Case-insensitive by default
 * (S1); wholeWord is part of the signature but unused until S2. Returns
 * matches in document order. Empty query → empty list.
 */
export function findMatches(index: PdfIndex, query: string, opts: PdfFindOptions = {}): PdfMatch[] {
  const needleRaw = query.normalize("NFKC")
  if (!needleRaw) return []
  const haystack = opts.caseSensitive ? index.text : index.text.toLowerCase()
  const needle = opts.caseSensitive ? needleRaw : needleRaw.toLowerCase()
  if (!needle) return []

  const matches: PdfMatch[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const start = locate(index.steps, at)
    const end = locate(index.steps, at + needle.length)
    if (start && end) {
      const range = document.createRange()
      try {
        range.setStart(start.node, start.offset)
        range.setEnd(end.node, end.offset)
      } catch {
        at = haystack.indexOf(needle, at + needle.length)
        continue
      }
      const bounds = range.getBoundingClientRect()
      matches.push({
        page: pageAt(index.steps, at),
        start: at,
        end: at + needle.length,
        startNode: start.node,
        startOffset: start.offset,
        endNode: end.node,
        endOffset: end.offset,
        rect: { top: bounds.top, left: bounds.left, bottom: bounds.bottom, right: bounds.right },
        range,
      })
    }
    at = haystack.indexOf(needle, at + needle.length)
  }
  return matches
}
