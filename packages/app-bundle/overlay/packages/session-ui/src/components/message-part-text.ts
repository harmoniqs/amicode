export function readPartText(accum: Record<string, string> | undefined, part: { id: string; text?: string }): string {
  return (accum?.[part.id] ?? part.text ?? "").trim()
}

/* Streaming prose lands in whole SECTIONS (heading-anchored segmentation).
   A chunk boundary fires at every markdown heading (`# `, `## `, `### `, etc.)
   that is OUTSIDE a code fence. Each section = heading + everything until the
   next heading of any rank. The intro (text before the first heading) is its
   own section. Text past the last boundary is still being composed and stays
   withheld until the next heading appears or the message completes.

   This replaces the old blank-line splitting which produced orphan heading
   cards, empty cards from `---`, and isolated math blocks. */

const FENCE = /^\s{0,3}(```|~~~)/
const HEADING = /^#{1,6}\s/

/** Max characters in a section before paragraph-gap fallback kicks in. */
const MAX_SECTION_CHARS = 1500

/** Every settled chunk boundary of a streaming text, in order. Each value is
 *  the char index where the heading line begins. A boundary fires at each
 *  heading outside a code fence, EXCEPT the first heading when it's at the
 *  very start of the text (that heading opens the first section, not a split
 *  point). The last section is always the tail (still composing).
 *
 *  Paragraph-gap fallback: if any section between heading boundaries exceeds
 *  MAX_SECTION_CHARS, sub-split at double-newline paragraph breaks within it
 *  (respecting code fences). */
function chunkBoundaries(text: string): number[] {
  const lines = text.split("\n")
  const headingBoundaries: number[] = []
  let inFence = false
  let offset = 0
  let foundFirstContent = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence && HEADING.test(line) && foundFirstContent) {
      headingBoundaries.push(offset)
    }
    if (line.trim() !== "") foundFirstContent = true
    offset += line.length + 1
  }

  // Paragraph-gap fallback: sub-split oversized sections
  const sectionStarts = [0, ...headingBoundaries]
  const boundaries: number[] = []

  for (let s = 0; s < sectionStarts.length; s++) {
    const sectionStart = sectionStarts[s]
    const sectionEnd = s + 1 < sectionStarts.length ? sectionStarts[s + 1] : text.length

    if (sectionEnd - sectionStart <= MAX_SECTION_CHARS) {
      if (s > 0) boundaries.push(sectionStart)
      continue
    }

    // Sub-split at paragraph gaps (double newlines) outside code fences.
    const section = text.slice(sectionStart, sectionEnd)
    const sectionLines = section.split("\n")
    let fenced = false
    let charsSinceLastSplit = 0
    let localOffset = 0

    for (let i = 0; i < sectionLines.length; i++) {
      const line = sectionLines[i]
      if (FENCE.test(line)) fenced = !fenced
      charsSinceLastSplit += line.length + 1

      // Detect paragraph gap: empty line followed by non-empty content
      if (!fenced && line.trim() === "" && i > 0 && i + 1 < sectionLines.length && sectionLines[i + 1].trim() !== "") {
        if (charsSinceLastSplit > MAX_SECTION_CHARS) {
          const gapOffset = localOffset + line.length + 1
          boundaries.push(sectionStart + gapOffset)
          charsSinceLastSplit = 0
        }
      }

      localOffset += line.length + 1
    }

    if (s > 0 && (boundaries.length === 0 || boundaries[boundaries.length - 1] !== sectionStart)) {
      boundaries.push(sectionStart)
    }
  }

  return boundaries.sort((a, b) => a - b)
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
