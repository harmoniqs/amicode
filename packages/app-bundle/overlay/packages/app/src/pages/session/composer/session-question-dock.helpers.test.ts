import { describe, expect, test } from "bun:test"
import { questionCustomRow, questionText, questionTextReady } from "./session-question-dock.helpers"

// The dock rendering contract (amicode#245): text cards carry no option rows
// and no pseudo-option; choice cards show the typed-custom-answer row only
// when the question allows it; a text card's submit waits for non-empty text.

describe("questionText", () => {
  test("a text-kind question renders as a text card", () => {
    expect(questionText({ kind: "text" })).toBe(true)
  })

  test("an absent or explicit choice kind renders as a choice card", () => {
    expect(questionText({})).toBe(false)
    expect(questionText({ kind: "choice" })).toBe(false)
    expect(questionText(undefined)).toBe(false)
  })
})

describe("questionCustomRow", () => {
  test("a text card never shows the pseudo-option", () => {
    expect(questionCustomRow({ kind: "text" })).toBe(false)
    expect(questionCustomRow({ kind: "text", custom: true })).toBe(false)
  })

  test("a choice question shows the pseudo-option by default", () => {
    expect(questionCustomRow({})).toBe(true)
    expect(questionCustomRow({ kind: "choice" })).toBe(true)
    expect(questionCustomRow({ custom: true })).toBe(true)
  })

  test("a choice question with custom disabled shows no pseudo-option", () => {
    expect(questionCustomRow({ custom: false })).toBe(false)
    expect(questionCustomRow({ kind: "choice", custom: false })).toBe(false)
  })
})

describe("questionTextReady", () => {
  test("submit is enabled only once the trimmed text is non-empty", () => {
    expect(questionTextReady("")).toBe(false)
    expect(questionTextReady("   \n  ")).toBe(false)
    expect(questionTextReady("JJ")).toBe(true)
    expect(questionTextReady("  JJ  ")).toBe(true)
  })
})
