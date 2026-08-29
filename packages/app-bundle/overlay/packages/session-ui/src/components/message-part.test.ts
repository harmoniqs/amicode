import { describe, expect, test } from "bun:test"
import { readPartText, settledChunkBoundary, splitSettledChunks } from "./message-part-text"

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

describe("splitSettledChunks", () => {

  test("no boundary while a single paragraph streams", () => {
    const text = "The first paragraph is still being"
    expect(settledChunkBoundary(text)).toBe(0)
    expect(splitSettledChunks(text)).toEqual({ chunks: [], tail: text })
  })

  test("a paragraph settles once the next one has started", () => {
    const text = "First paragraph.\n\nSecond is being writ"
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["First paragraph.\n\n"])
    expect(tail).toBe("Second is being writ")
  })

  test("multiple settled paragraphs split at every boundary", () => {
    const text = "One.\n\nTwo.\n\nThree is being writ"
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["One.\n\n", "Two.\n\n"])
    expect(tail).toBe("Three is being writ")
  })

  test("a blank line inside a code fence is not a boundary", () => {
    const text = "Intro.\n\n```py\na = 1\n\nb = 2\n```\n\nAfter the fence starts"
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["Intro.\n\n", "```py\na = 1\n\nb = 2\n```\n\n"])
    expect(tail).toBe("After the fence starts")
  })

  test("splits before a list's first item, never between its items", () => {
    const text = "Steps:\n\n1. one\n\n2. two\n\n> quoted\n\nNext paragraph beg"
    const { chunks, tail } = splitSettledChunks(text)
    expect(chunks).toEqual(["Steps:\n\n", "1. one\n\n2. two\n\n> quoted\n\n"])
    expect(tail).toBe("Next paragraph beg")
  })

  test("trailing blank lines do not settle the tail", () => {
    const text = "Done paragraph.\n\n"
    expect(settledChunkBoundary(text)).toBe(0)
  })
})
