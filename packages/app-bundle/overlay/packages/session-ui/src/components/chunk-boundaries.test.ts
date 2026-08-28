import { describe, expect, test } from "bun:test"
import { chunkBoundaries } from "./chunk-boundaries"

describe("chunkBoundaries", () => {
  describe("basic splitting", () => {
    test("returns no boundaries for a single paragraph", () => {
      const text = "Hello world, this is a simple paragraph."
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("splits on double newline between paragraphs", () => {
      const text = "First paragraph.\n\nSecond paragraph."
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
      // boundary points to start of second chunk; slice before it includes trailing whitespace
      expect(text.slice(0, boundaries[0]).trim()).toBe("First paragraph.")
      expect(text.slice(boundaries[0])).toBe("Second paragraph.")
    })

    test("returns empty for empty text", () => {
      expect(chunkBoundaries("")).toEqual([])
    })

    test("returns empty for whitespace-only text", () => {
      expect(chunkBoundaries("   \n\n   ")).toEqual([])
    })
  })

  describe("list coherence (existing guard)", () => {
    test("consecutive list items stay in one chunk", () => {
      const text = "- item one\n- item two\n- item three"
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("consecutive numbered list items stay in one chunk", () => {
      const text = "1. first\n2. second\n3. third"
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("list block preceded by blank line splits from prior prose", () => {
      const text = "Some intro text.\n\n- item one\n- item two"
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
      expect(text.slice(0, boundaries[0]).trim()).toBe("Some intro text.")
    })

    test("two separate lists split from each other", () => {
      const text = "- item a\n- item b\n\n- item c\n- item d"
      // list-to-list guard: do NOT split between two list blocks
      expect(chunkBoundaries(text)).toEqual([])
    })
  })

  describe("label heuristic (<40 chars ending with colon)", () => {
    test("short label followed by list stays in one card", () => {
      const text = "Key Decisions:\n\n- Use sticky overlay\n- Track per-row"
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("short label followed by paragraph stays in one card", () => {
      const text = "Summary:\n\nThe optimization converged in 137 iterations."
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("long line ending with colon DOES split (>=40 chars)", () => {
      const text = "This is a long sentence that explains things in detail:\n\n- item one"
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
    })

    test("short label with content in between", () => {
      const text = "Files:\n\n| File | Changes |\n|------|---------|"
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("label heuristic doesn't trigger on mid-sentence colons", () => {
      // "Note: this is important" is 24 chars and ends with a colon...
      // but it's a complete sentence, not a label. The length check + colon
      // at END of line catches it. The text after the blank line should split.
      const text = "Note: this is important.\n\nA separate thought here."
      // "Note: this is important." is < 40 chars and ends with "." not ":"
      // so this SHOULD split normally
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
    })

    test("actual label pattern — text ending in colon at line end", () => {
      const text = "Acceptance Criteria:\n\n- [ ] First criterion\n- [ ] Second"
      expect(chunkBoundaries(text)).toEqual([])
    })
  })

  describe("blockquote coherence", () => {
    test("consecutive blockquotes stay in one chunk", () => {
      const text = "> line one\n> line two\n> line three"
      expect(chunkBoundaries(text)).toEqual([])
    })

    test("blockquote followed by paragraph splits", () => {
      const text = "> a quote\n\nSome prose after."
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
    })
  })

  describe("no empty chunks", () => {
    test("multiple blank lines don't produce empty chunks", () => {
      const text = "Hello.\n\n\n\nWorld."
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBe(1)
      expect(text.slice(0, boundaries[0]).trim()).toBe("Hello.")
      expect(text.slice(boundaries[0]).trim()).toBe("World.")
    })

    test("trailing blank lines don't produce an empty tail chunk", () => {
      const text = "Content here.\n\n"
      expect(chunkBoundaries(text)).toEqual([])
    })
  })

  describe("monotonicity (streaming contract)", () => {
    test("boundaries are monotonically increasing", () => {
      const text = "First.\n\nSecond.\n\nThird."
      const boundaries = chunkBoundaries(text)
      for (let i = 1; i < boundaries.length; i++) {
        expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1])
      }
    })

    test("extending text only appends boundaries, never removes", () => {
      const partial = "First.\n\nSecond."
      const full = "First.\n\nSecond.\n\nThird."
      const partialBoundaries = chunkBoundaries(partial)
      const fullBoundaries = chunkBoundaries(full)
      // All boundaries from partial must appear in full
      for (const b of partialBoundaries) {
        expect(fullBoundaries).toContain(b)
      }
    })
  })

  describe("heading splits", () => {
    test("heading after prose creates a boundary", () => {
      const text = "Some intro.\n\n## Section One\n\nContent here."
      const boundaries = chunkBoundaries(text)
      expect(boundaries.length).toBeGreaterThanOrEqual(1)
      expect(text.slice(0, boundaries[0]).trim()).toBe("Some intro.")
    })

    test("heading as first element creates no leading boundary", () => {
      const text = "## Title\n\nSome content."
      // No split needed — heading + content is one chunk
      expect(chunkBoundaries(text)).toEqual([])
    })
  })
})
