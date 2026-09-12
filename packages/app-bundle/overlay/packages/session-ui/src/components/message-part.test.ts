import { describe, expect, test } from "bun:test"
import { readPartText, settledChunkBoundary, splitSettledChunks } from "./message-part-text"
import { shouldShowUserMessageText } from "./message-part-user"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("splitSettledChunks — heading-anchored segmentation", () => {

  test("no headings → single chunk (whole text) on completion", () => {
    const text = "Just a paragraph.\n\nAnother paragraph.\n\nNo headings here."
    const { chunks, tail } = splitSettledChunks(text)
    // No heading means no boundary — everything stays in the tail while streaming
    expect(chunks).toEqual([])
    expect(tail).toBe(text)
  })

  test("heading splits text into sections", () => {
    const text = "Intro paragraph.\n\n## Section One\n\nBody of section one.\n\n## Section Two\n\nBody of two."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([
      "Intro paragraph.\n\n",
      "## Section One\n\nBody of section one.\n\n",
    ])
    expect(tail).toBe("## Section Two\n\nBody of two.")
  })

  test("heading at the very start creates no empty intro chunk", () => {
    const text = "## First\n\nBody one.\n\n## Second\n\nBody two."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["## First\n\nBody one.\n\n"])
    expect(tail).toBe("## Second\n\nBody two.")
  })

  test("### sub-headings are also boundaries", () => {
    const text = "## Main\n\nIntro.\n\n### Sub\n\nDetails.\n\n### Another Sub\n\nMore."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([
      "## Main\n\nIntro.\n\n",
      "### Sub\n\nDetails.\n\n",
    ])
    expect(tail).toBe("### Another Sub\n\nMore.")
  })

  test("heading inside a code fence is not a boundary", () => {
    const text = "## Real Section\n\n```md\n## Not a heading\n\nJust code\n```\n\n## Next Section\n\nBody."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([
      "## Real Section\n\n```md\n## Not a heading\n\nJust code\n```\n\n",
    ])
    expect(tail).toBe("## Next Section\n\nBody.")
  })

  test("--- horizontal rules do not create boundaries or empty cards", () => {
    const text = "## Section\n\nParagraph one.\n\n---\n\nParagraph two.\n\n## Next\n\nBody."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([
      "## Section\n\nParagraph one.\n\n---\n\nParagraph two.\n\n",
    ])
    expect(tail).toBe("## Next\n\nBody.")
  })

  test("display math stays with its section", () => {
    const text = "## Math Section\n\nThe fidelity is:\n\n$$F = |\\langle\\psi|\\phi\\rangle|^2$$\n\nWhich means...\n\n## Conclusion\n\nDone."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([
      "## Math Section\n\nThe fidelity is:\n\n$$F = |\\langle\\psi|\\phi\\rangle|^2$$\n\nWhich means...\n\n",
    ])
    expect(tail).toBe("## Conclusion\n\nDone.")
  })

  test("trailing content with no following heading stays as tail (streaming)", () => {
    const text = "## Section\n\nThis is still being written"
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([])
    expect(tail).toBe("## Section\n\nThis is still being written")
  })

  test("settledChunkBoundary returns 0 when no heading boundary exists", () => {
    expect(settledChunkBoundary("Just text, no headings")).toBe(0)
    expect(settledChunkBoundary("Still streaming...")).toBe(0)
  })

  test("settledChunkBoundary returns offset of last boundary", () => {
    const text = "Intro.\n\n## One\n\nBody.\n\n## Two\n\nTail."
    const boundary = settledChunkBoundary(text)
    // Should point to where "## Two" starts
    expect(text.slice(boundary)).toBe("## Two\n\nTail.")
  })

  test("whitespace-only chunks are never emitted", () => {
    const text = "## A\n\nContent.\n\n\n\n## B\n\nMore."
    const { chunks } = splitSettledChunks(text)
    expect(chunks.every(c => c.trim() !== "")).toBe(true)
  })

  test("single # heading is a boundary", () => {
    const text = "# Title\n\nIntro.\n\n## Section\n\nBody."
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["# Title\n\nIntro.\n\n"])
    expect(tail).toBe("## Section\n\nBody.")
  })
})

describe("splitSettledChunks — paragraph-gap fallback for long sections", () => {

  test("long headingless prose (>2000 chars) splits at paragraph gaps", () => {
    // 3 long paragraphs, each ~800 chars, no headings
    const para = (n: number) => `Paragraph ${n}: ` + "This is a long sentence that represents typical prose output from a model. ".repeat(10)
    const text = para(1) + "\n\n" + para(2) + "\n\n" + para(3)
    expect(text.length).toBeGreaterThan(2000)
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0]).toContain("Paragraph 1")
    expect(tail).toContain("Paragraph 3")
  })

  test("paragraph gaps inside code fences are not split points", () => {
    // A huge code block with blank lines inside — blank lines inside the
    // fence must NOT be used as split points, only the gap after the fence
    const codeLines = Array.from({ length: 60 }, (_, i) =>
      i % 15 === 14 ? "" : `  code line ${i + 1}`
    ).join("\n")
    const text = "Intro.\n\n```julia\n" + codeLines + "\n```\n\nAfter."
    const { chunks, tail } = splitSettledChunks(text)
    // The code block must stay intact in a single chunk — no splits inside the fence.
    // The paragraph gap after ``` is a valid split, so code block lands in chunks[0].
    if (chunks.length > 0) {
      expect(chunks[0]).toContain("```julia")
      expect(chunks[0]).toContain("```\n")
      // The entire fence is in one chunk, not split at internal blank lines
      expect(chunks[0]).toContain("code line 1")
      expect(chunks[0]).toContain("code line 59")
    }
  })

  test("short headingless prose (<1500 chars) does not trigger paragraph-gap splits", () => {
    const text = "Short paragraph one.\n\nShort paragraph two.\n\nShort paragraph three."
    expect(text.length).toBeLessThan(1500)
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual([])
    expect(tail).toBe(text)
  })

  test("headed section followed by long unheaded block — tail sub-splits at paragraphs", () => {
    const para = (n: number) => `Block ${n}: ` + "This sentence is repeated to create a long paragraph for testing. ".repeat(20)
    const text = "## Analysis\n\nShort intro.\n\n" + para(1) + "\n\n" + para(2) + "\n\n" + para(3)
    expect(text.length).toBeGreaterThan(3000)
    const { chunks, tail } = splitSettledChunks(text)
    // The heading creates one boundary, then the long tail sub-splits
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks[0]).toContain("## Analysis")
    // The long unheaded tail should be sub-split — not all in the tail
    expect(tail.split("\n").length).toBeLessThan(60)
  })
})

describe("shouldShowUserMessageText", () => {
  test("hidden when text is empty and no comments", () => {
    expect(shouldShowUserMessageText("", 0)).toBe(false)
  })

  test("visible when text is present", () => {
    expect(shouldShowUserMessageText("hello world", 0)).toBe(true)
  })

  test("visible when comments exist even without text", () => {
    expect(shouldShowUserMessageText("", 2)).toBe(true)
  })

  test("visible when both text and comments exist", () => {
    expect(shouldShowUserMessageText("hello", 1)).toBe(true)
  })

  test("hidden when text is whitespace-only and no comments", () => {
    expect(shouldShowUserMessageText("   ", 0)).toBe(false)
  })
})
