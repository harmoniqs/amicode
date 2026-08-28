/**
 * chunkBoundaries — split settled markdown text into visual card boundaries.
 *
 * Returns an array of character offsets where the text should be split into
 * separate visual chunks (bordered cards). The boundaries are monotonically
 * increasing and represent positions AFTER which a new chunk begins.
 *
 * Rules:
 * 1. Split on blank lines (double newline) between content blocks
 * 2. Never split inside a list (consecutive list items stay together)
 * 3. Never split between two adjacent list blocks (list-to-list guard)
 * 4. Label heuristic: if the last non-blank line before a split is <40 chars
 *    and ends with ":", suppress the split (keeps labels with their content)
 * 5. Never produce empty chunks (skip splits that would leave only whitespace)
 * 6. Monotonicity: once a boundary is emitted, it never un-emits (streaming safe)
 */
export function chunkBoundaries(text: string): number[] {
  if (!text.trim()) return []

  const boundaries: number[] = []

  // Collapse runs of blank lines into distinct split candidates.
  // A "split region" is one or more consecutive blank lines between content.
  // We emit at most one boundary per region: at the afterOffset of the LAST
  // blank line in the run (so the offset points to the first content char).
  const splitRegions = findSplitRegions(text)

  if (splitRegions.length === 0) return []

  for (const split of splitRegions) {
    const before = text.slice(0, split.contentEnd)
    const after = text.slice(split.afterOffset)

    // Rule 5: no empty chunks — skip if either side would be whitespace-only
    if (!before.trim() || !after.trim()) continue

    // Rule 7: heading-at-start — if all content before the split is a single heading,
    // keep it together with its body (headings introduce, they don't stand alone)
    if (isHeadingOnly(before)) continue

    // Rule 2 & 3: list coherence
    const beforeLines = before.split("\n")
    const afterLines = after.split("\n")
    const lastNonBlankBefore = findLastNonBlank(beforeLines)
    const firstNonBlankAfter = findFirstNonBlank(afterLines)

    if (lastNonBlankBefore === undefined || firstNonBlankAfter === undefined) continue

    const beforeIsList = isListLine(lastNonBlankBefore)
    const afterIsList = isListLine(firstNonBlankAfter)

    // List-to-list guard: don't split between two list blocks
    if (beforeIsList && afterIsList) continue

    // Rule 4: label heuristic — short line ending with ":" suppresses the split
    if (isLabelLine(lastNonBlankBefore)) continue

    boundaries.push(split.afterOffset)
  }

  return boundaries
}

/** Find distinct split regions: collapsed runs of blank lines */
function findSplitRegions(text: string): { contentEnd: number; afterOffset: number }[] {
  const regions: { contentEnd: number; afterOffset: number }[] = []
  // Match one or more blank lines (sequences of \n with only whitespace between)
  const blankRunPattern = /(\n[ \t]*){2,}/g
  let match: RegExpExecArray | null
  while ((match = blankRunPattern.exec(text)) !== null) {
    regions.push({
      contentEnd: match.index, // end of content before the blank run
      afterOffset: match.index + match[0].length, // first content char after
    })
  }
  return regions
}

/** True if the text is ONLY a heading line (possibly with leading whitespace) */
function isHeadingOnly(text: string): boolean {
  const trimmed = text.trim()
  // Must be a single line that's a markdown heading
  if (trimmed.includes("\n")) return false
  return /^#{1,6}\s/.test(trimmed)
}

/** Check if a line is a list item (unordered or ordered) */
function isListLine(line: string): boolean {
  const trimmed = line.trimStart()
  // Unordered: starts with -, *, +
  if (/^[-*+]\s/.test(trimmed)) return true
  // Ordered: starts with number followed by . or )
  if (/^\d+[.)]\s/.test(trimmed)) return true
  // Checkbox list
  if (/^[-*+]\s\[[ x]\]/i.test(trimmed)) return true
  return false
}

/** Check if a line is a label (< 40 chars and ends with ":") */
function isLabelLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length < 40 && /:\s*$/.test(trimmed)
}

/** Find the last non-blank line in an array */
function findLastNonBlank(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) return lines[i]
  }
  return undefined
}

/** Find the first non-blank line in an array */
function findFirstNonBlank(lines: string[]): string | undefined {
  for (const line of lines) {
    if (line.trim()) return line
  }
  return undefined
}

/**
 * Split text at the given boundaries into chunks.
 * Convenience function for consumers that want the string[] result.
 */
export function splitAtBoundaries(text: string, boundaries: number[]): string[] {
  if (boundaries.length === 0) return [text]
  const chunks: string[] = []
  let start = 0
  for (const b of boundaries) {
    chunks.push(text.slice(start, b))
    start = b
  }
  chunks.push(text.slice(start))
  // Filter out empty/whitespace-only chunks
  return chunks.filter((c) => c.trim())
}
