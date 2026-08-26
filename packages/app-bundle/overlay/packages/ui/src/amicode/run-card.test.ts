import { describe, expect, test } from "bun:test"
import { fidelityParts, parseRunCardsResponse, renderRunCardSvg, runCardFilename } from "./run-card"

const CARD = {
  slug: "cz-gate",
  problem: "CZ on Rydberg",
  platform: "rydberg",
  gate: "CZ",
  runId: "r20260707-010101Z-aaaa",
  lab: "default",
  fidelity: 0.99994,
  iterations: 47,
  elapsedMs: 130_000,
  finishedAt: 1_783_000_000_000,
  series: [
    { iter: 1, f: 0.5 },
    { iter: 2, f: 1e-4 },
  ],
  pulse: { dt: 0.5, values: [1, 2, 3, 4, 5, 6] },
  pulseMeta: { drives: 2, knots: 3 },
}

describe("fidelityParts", () => {
  test("splits the leading nines for the gold highlight", () => {
    expect(fidelityParts(0.99994)).toEqual({ pre: "0.", nines: "9999", rest: "4" })
    expect(fidelityParts(0.5)).toEqual({ pre: "0.", nines: "", rest: "50000" })
    expect(fidelityParts(1)).toEqual({ pre: "1.", nines: "", rest: "00000" })
  })
})

describe("renderRunCardSvg", () => {
  test("carries the headline, brand, curves and per-drive pulses", () => {
    const svg = renderRunCardSvg(CARD)
    expect(svg).toContain("CZ · rydberg")
    expect(svg).toContain("47 iterations")
    expect(svg).toContain("harmoniqs.ai")
    expect(svg).toContain("AMICODE")
    // 2 drives → 2 pulse paths (second at companion opacity)
    expect(svg.match(/stroke="#F2C94C" stroke-width="2\.5"/g)?.length).toBe(2)
    expect(svg).toContain('opacity="0.55"')
  })
  test("pulse panel reads first (left column), convergence second", () => {
    const svg = renderRunCardSvg(CARD)
    expect(svg.indexOf("FINAL PULSE")).toBeLessThan(svg.indexOf("CONVERGENCE"))
  })
  test("escapes hostile strings", () => {
    const svg = renderRunCardSvg({ ...CARD, problem: 'x"/><script>alert(1)</script>' })
    expect(svg).not.toContain("<script>")
  })
})

describe("parseRunCardsResponse", () => {
  test("maps the wire shape defensively", () => {
    const cards = parseRunCardsResponse({
      ok: true,
      cards: [
        {
          slug: "s",
          problem: "P",
          platform: null,
          gate: "X",
          run_id: "r1",
          lab: "default",
          fidelity: 0.9,
          iterations: 3,
          elapsed_ms: 10,
          finished_at: 5,
          series: [{ iter: 1, f: 0.5 }, { bad: true }],
          pulse: { dt: 0.1, values: [1, "x", 2] },
          pulse_meta: { drives: 1, knots: 2 },
        },
        { run_id: 42 }, // dropped
      ],
    })
    expect(cards).toHaveLength(1)
    expect(cards[0].series).toHaveLength(1)
    expect(cards[0].pulse?.values).toEqual([1, 2])
  })
  test("non-ok / garbage → empty", () => {
    expect(parseRunCardsResponse({ ok: false })).toEqual([])
    expect(parseRunCardsResponse("nope")).toEqual([])
  })
})

describe("runCardFilename", () => {
  test("safe, descriptive filename", () => {
    expect(runCardFilename(CARD)).toBe("amico-cz-rydberg-f09999.png")
  })
})
