import { describe, expect, test } from "bun:test"
import { Decoration } from "@codemirror/view"
import {
  tokensToDecorations,
  shikiHighlightExtension,
  shikiDecorationField,
  type ShikiTokenizeResult,
} from "./shiki-highlight-plugin"

describe("shiki-highlight-plugin", () => {
  describe("tokensToDecorations", () => {
    test("converts Shiki tokens to CM6 decorations with inline color styles", () => {
      const result: ShikiTokenizeResult = {
        type: "tokenize-result",
        id: 1,
        lines: [
          {
            tokens: [
              { offset: 0, length: 5, color: "#569CD6" },   // "const"
              { offset: 5, length: 1, color: "" },            // " " (no color)
              { offset: 6, length: 1, color: "#9CDCFE" },    // "x"
            ],
          },
        ],
      }
      const docText = "const x = 1"
      const decos = tokensToDecorations(result, docText)
      expect(decos).not.toBe(Decoration.none)

      // Iterate the decoration set to check individual marks
      const marks: Array<{ from: number; to: number }> = []
      const cursor = decos.iter()
      while (cursor.value) {
        marks.push({ from: cursor.from, to: cursor.to })
        cursor.next()
      }
      // "const" (0-5) and "x" (6-7) — empty color is skipped
      expect(marks).toEqual([
        { from: 0, to: 5 },
        { from: 6, to: 7 },
      ])
    })

    test("handles multi-line tokens", () => {
      const result: ShikiTokenizeResult = {
        type: "tokenize-result",
        id: 1,
        lines: [
          { tokens: [{ offset: 0, length: 3, color: "#FF0000" }] },  // "foo"
          { tokens: [{ offset: 0, length: 3, color: "#00FF00" }] },  // "bar"
        ],
      }
      const docText = "foo\nbar"
      const decos = tokensToDecorations(result, docText)

      const marks: Array<{ from: number; to: number }> = []
      const cursor = decos.iter()
      while (cursor.value) {
        marks.push({ from: cursor.from, to: cursor.to })
        cursor.next()
      }
      // "foo" is at 0-3, "bar" is at 4-7 (after the newline)
      expect(marks).toEqual([
        { from: 0, to: 3 },
        { from: 4, to: 7 },
      ])
    })

    test("returns Decoration.none for empty token results", () => {
      const result: ShikiTokenizeResult = {
        type: "tokenize-result",
        id: 1,
        lines: [],
      }
      expect(tokensToDecorations(result, "hello")).toBe(Decoration.none)
    })

    test("applies fontStyle attributes", () => {
      const result: ShikiTokenizeResult = {
        type: "tokenize-result",
        id: 1,
        lines: [
          {
            tokens: [
              { offset: 0, length: 7, color: "#888", fontStyle: 1 },  // italic
              { offset: 8, length: 4, color: "#999", fontStyle: 2 },  // bold
              { offset: 13, length: 4, color: "#AAA", fontStyle: 4 }, // underline
            ],
          },
        ],
      }
      const docText = "comment bold_var underline"
      const decos = tokensToDecorations(result, docText)

      const marks: Array<{ from: number; to: number }> = []
      const cursor = decos.iter()
      while (cursor.value) {
        marks.push({ from: cursor.from, to: cursor.to })
        cursor.next()
      }
      expect(marks.length).toBe(3)
    })
  })

  describe("shikiHighlightExtension", () => {
    test("returns an array with the StateField and ViewPlugin", () => {
      const exts = shikiHighlightExtension("ts")
      expect(Array.isArray(exts)).toBe(true)
      expect(exts.length).toBe(2)
    })
  })

  describe("shikiDecorationField", () => {
    test("is exported and defined", () => {
      expect(shikiDecorationField).toBeDefined()
    })
  })
})
