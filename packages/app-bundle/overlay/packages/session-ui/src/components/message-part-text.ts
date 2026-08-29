export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

/* Streaming prose lands in whole CHUNKS (Kate 2026-08-25: no typing reveal,
   but no waiting for the entire reply either). A chunk boundary is a blank
   line that is
     · OUTSIDE a code fence — splitting inside one corrupts the markdown, and
     · not immediately before a list item, blockquote, or indented line —
       splitting those restarts ordered-list numbering and swells the gap
       between fragments that render as separate lists.
   Text past the last boundary is still being composed and stays withheld
   until the next boundary or completion. */

const FENCE = /^\s{0,3}(```|~~~)/
const CONTINUATION = /^\s{0,3}([-*+]\s|\d{1,3}[.)]\s|>)|^\s{4,}\S/

/** Every settled chunk boundary of a streaming text, in order. Each value is
 *  the char index where the NEXT chunk begins. Monotonic as the text grows.
 *  A boundary is invalid when the next line CONTINUES a construct the
 *  previous line already started (list item after list item, quote after
 *  quote): splitting there restarts ordered-list numbering across fragments.
 *  A construct's FIRST line after a paragraph is a fine place to split. */
function chunkBoundaries(text: string): number[] {
  const lines = text.split("\n")
  const boundaries: number[] = []
  let inFence = false
  let offset = 0
  let prevNonBlank: string | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) inFence = !inFence
    offset += line.length + 1
    if (line.trim() !== "") prevNonBlank = line
    if (inFence || line.trim() !== "") continue
    // blank line: the boundary candidate sits at the next non-blank line
    let j = i + 1
    let candidate = offset
    while (j < lines.length && lines[j].trim() === "") {
      candidate += lines[j].length + 1
      j++
    }
    if (j >= lines.length) break // trailing blanks — the tail is still composing
    if (
      CONTINUATION.test(lines[j]) &&
      prevNonBlank !== undefined &&
      CONTINUATION.test(prevNonBlank)
    )
      continue
    boundaries.push(candidate)
    offset = candidate
    i = j - 1
  }
  return boundaries
}

/** Index just past the last settled chunk boundary (0 if nothing settled). */
export function settledChunkBoundary(text: string): number {
  const boundaries = chunkBoundaries(text)
  return boundaries.length > 0 ? boundaries[boundaries.length - 1] : 0
}

/** The settled prefix split into renderable chunks, plus the withheld tail. */
export function splitSettledChunks(text: string): { chunks: string[]; tail: string } {
  const boundaries = chunkBoundaries(text)
  const chunks: string[] = []
  let start = 0
  for (const boundary of boundaries) {
    const chunk = text.slice(start, boundary)
    if (chunk.trim() !== "") chunks.push(chunk)
    start = boundary
  }
  return { chunks, tail: text.slice(start) }
}
