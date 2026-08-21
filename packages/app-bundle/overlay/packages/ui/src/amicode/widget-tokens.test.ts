import { describe, expect, test } from "bun:test"
import { densityFor, densityForViewport, resolveTokens } from "./widget-tokens"

describe("densityFor", () => {
  test("boundaries match COMPACT_CSS (≤880 compact, ≤760 tight)", () => {
    expect(densityFor(881)).toBe("normal")
    expect(densityFor(880)).toBe("compact")
    expect(densityFor(761)).toBe("compact")
    expect(densityFor(760)).toBe("tight")
    expect(densityFor(500)).toBe("tight")
  })
})

describe("densityForViewport (spec T3.4 width axis)", () => {
  test("width tiers: ≤820 compact, ≤600 tight", () => {
    expect(densityForViewport(821, 1000)).toBe("normal")
    expect(densityForViewport(820, 1000)).toBe("compact")
    expect(densityForViewport(601, 1000)).toBe("compact")
    expect(densityForViewport(600, 1000)).toBe("tight")
  })
  test("effective density is the max of both axes", () => {
    expect(densityForViewport(1200, 880)).toBe("compact") // height wins
    expect(densityForViewport(600, 1000)).toBe("tight") // width wins
    expect(densityForViewport(820, 760)).toBe("tight") // tighter axis wins
  })
})

describe("resolveTokens", () => {
  test("maps resolved v2 values and falls back when empty", () => {
    const tokens = resolveTokens((name) => (name === "--v2-text-text-base" ? " #fff " : ""), "normal")
    expect(tokens["--amc-text"]).toBe("#fff")
    expect(tokens["--amc-bg"]).toBe("#0B0E15") // fallback
    expect(tokens["--amc-accent"]).toBe("#FFF676")
    expect(tokens["--amc-accent-fill"]).toBe("#FFF676")
    expect(tokens["--amc-accent-ink"]).toBe("#111214")
    expect(tokens["--amc-font-mono"]).toContain("monospace")
    expect(Object.keys(tokens)).toHaveLength(17) // 13 colors + 2 fonts + 2 pads
  })
  test("padding tokens follow density", () => {
    expect(resolveTokens(() => "", "normal")["--amc-pad"]).toBe("14px 16px")
    expect(resolveTokens(() => "", "tight")["--amc-pad"]).toBe("8px 12px")
  })
})
