// synctex.ts — Minimal SyncTeX forward search parser (#730).
//
// Parses the text-format SyncTeX output (decompressed from .synctex.gz)
// and implements forward search: given a source file and line number,
// returns the page number and approximate vertical position in the PDF.
//
// This is a minimal implementation — SyncTeX records are complex and
// this parser handles only the most common patterns (h-records with
// input/line/position). If it proves unreliable, the entire slice is
// droppable per the issue spec.

// ── Types ───────────────────────────────────────────────────────────────────

export interface SyncTeXData {
  inputs: Map<number, string> // input ID → filename
  records: SyncTeXRecord[]
}

export interface SyncTeXRecord {
  page: number
  inputId: number
  line: number
  h: number // horizontal position (sp units)
  v: number // vertical position (sp units)
}

export interface ForwardSearchResult {
  page: number
  y: number // approximate vertical position in points
}

// ── Parser ──────────────────────────────────────────────────────────────────

/** SyncTeX uses "scaled points" — 1 sp = 1/65536 pt. */
const SP_TO_PT = 1 / 65536

/**
 * Parse SyncTeX text content into a lookup structure.
 * Returns null if the content is not recognizable SyncTeX.
 */
export function parseSyncTeX(content: string): SyncTeXData | null {
  if (!content || !content.includes("SyncTeX")) return null

  const inputs = new Map<number, string>()
  const records: SyncTeXRecord[] = []
  let currentPage = 0

  const lines = content.split("\n")

  for (const line of lines) {
    // Input declaration: Input:<id>:<filename>
    const inputMatch = line.match(/^Input:(\d+):(.+)/)
    if (inputMatch) {
      inputs.set(parseInt(inputMatch[1], 10), inputMatch[2].replace(/^\.\//, ""))
      continue
    }

    // Page start: {<page>
    const pageMatch = line.match(/^\{(\d+)/)
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10)
      continue
    }

    // h-record: h<input>,<line>:<h>:<v> (horizontal position record)
    const hMatch = line.match(/^h(\d+),(\d+):(-?\d+):(-?\d+)/)
    if (hMatch) {
      records.push({
        page: currentPage,
        inputId: parseInt(hMatch[1], 10),
        line: parseInt(hMatch[2], 10),
        h: parseInt(hMatch[3], 10),
        v: parseInt(hMatch[4], 10),
      })
    }
  }

  if (inputs.size === 0 && records.length === 0) return null

  return { inputs, records }
}

// ── Forward search ──────────────────────────────────────────────────────────

/**
 * Forward search: given a source file and cursor line, find the page and
 * approximate vertical position in the PDF.
 *
 * Returns the closest match, or null if no match is found.
 */
export function forwardSearch(
  data: SyncTeXData | null,
  sourceFile: string,
  sourceLine: number,
): ForwardSearchResult | null {
  if (!data) return null

  // Find the input ID for the source file
  let inputId: number | null = null
  for (const [id, path] of data.inputs) {
    if (path === sourceFile || path.endsWith(`/${sourceFile}`) || path.endsWith(`\\${sourceFile}`)) {
      inputId = id
      break
    }
  }
  if (inputId === null) return null

  // Find the closest record for this input and line
  let bestRecord: SyncTeXRecord | null = null
  let bestDistance = Infinity

  for (const record of data.records) {
    if (record.inputId !== inputId) continue
    const distance = Math.abs(record.line - sourceLine)
    if (distance < bestDistance) {
      bestDistance = distance
      bestRecord = record
    }
  }

  if (!bestRecord) return null

  return {
    page: bestRecord.page,
    y: bestRecord.v * SP_TO_PT,
  }
}
