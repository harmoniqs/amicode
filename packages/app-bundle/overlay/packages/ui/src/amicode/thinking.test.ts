import { describe, expect, test } from "bun:test"
import { THINKING_WORDS, wordAt, formatElapsed, formatTokens, turnTokens } from "./thinking"

describe("thinking words", () => {
  test("non-empty; no trailing ellipsis (the component appends it)", () => {
    expect(THINKING_WORDS.length).toBeGreaterThan(0)
    for (const w of THINKING_WORDS) expect(w.endsWith("…")).toBe(false)
  })

  test("wordAt cycles and wraps, including negative ticks", () => {
    const n = THINKING_WORDS.length
    expect(wordAt(0)).toBe(THINKING_WORDS[0])
    expect(wordAt(n)).toBe(THINKING_WORDS[0])
    expect(wordAt(n + 1)).toBe(THINKING_WORDS[1])
    expect(wordAt(-1)).toBe(THINKING_WORDS[n - 1])
  })
})

describe("formatElapsed", () => {
  test("sub-minute", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(999)).toBe("0s")
    expect(formatElapsed(12_000)).toBe("12s")
    expect(formatElapsed(-500)).toBe("0s")
  })

  test("minutes with zero-padded seconds", () => {
    expect(formatElapsed(63_000)).toBe("1m 03s")
    expect(formatElapsed(725_000)).toBe("12m 05s")
  })
})

describe("turnTokens", () => {
  test("sums output + reasoning across messages; ignores input/cache/missing", () => {
    expect(turnTokens([])).toBe(0)
    expect(turnTokens([{ tokens: { output: 100, reasoning: 20 } }])).toBe(120)
    expect(
      turnTokens([
        { tokens: { output: 100, reasoning: 20 } },
        { tokens: { output: 5 } },
        { tokens: null },
        {},
      ]),
    ).toBe(125)
  })
})

describe("formatTokens", () => {
  test("scales k / M with one decimal until 100", () => {
    expect(formatTokens(42)).toBe("42")
    expect(formatTokens(2_400)).toBe("2.4k")
    expect(formatTokens(120_000)).toBe("120k")
    expect(formatTokens(1_200_000)).toBe("1.2M")
    expect(formatTokens(-5)).toBe("0")
  })
})
