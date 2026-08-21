// packages/ui/src/amicode/wave-geometry.test.ts
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import {
  WAVE_BOX,
  WAVE_AMP,
  WAVE_LEAD_STROKE,
  WAVE_PERIOD_MS,
  MODE_HOLD_MS,
  MODE_WAVELENGTHS,
  MODE_PATHS,
  MODE_VISIBLE_FRACTION,
  MODE_VISIBLE_PCT,
  MODE_OFF_PCT,
  companionDelayMs,
  modeCadenceMs,
  modeDelaysMs,
  visibleModesAt,
  samplePoints,
} from "./wave-geometry"

describe("quadrature", () => {
  test("companion delay is exactly a quarter period, derived from the period", () => {
    expect(companionDelayMs()).toBe(-WAVE_PERIOD_MS / 4)
    expect(companionDelayMs(2000)).toBe(-500)
  })
})

describe("harmonic climb", () => {
  test("cadence is hold x mode count", () => {
    expect(modeCadenceMs()).toBe(MODE_HOLD_MS * MODE_WAVELENGTHS.length)
    expect(modeCadenceMs(1000, 4)).toBe(4000)
  })

  test("delays DESCEND in magnitude so the visible sequence ASCENDS", () => {
    // Regression: -1*step / -2*step silently plays 1 -> 3 -> 2.
    expect(modeDelaysMs()).toEqual([0, -4600, -2300])
  })

  test("exactly one mode is visible at any instant, and the order is 1,2,3", () => {
    const cadence = modeCadenceMs()
    const seen: number[] = []
    // sample the middle of each hold window, avoiding exact boundaries
    for (let t = MODE_HOLD_MS / 2; t < cadence; t += MODE_HOLD_MS) {
      const vis = visibleModesAt(t)
      expect(vis).toHaveLength(1)
      seen.push(vis[0])
    }
    expect(seen).toEqual([0, 1, 2])
  })

  test("never zero or two modes visible across a dense sweep of two cadences", () => {
    const cadence = modeCadenceMs()
    for (let t = 0; t < cadence * 2; t += 37) {
      expect(visibleModesAt(t)).toHaveLength(1)
    }
  })

  test("window boundaries tile exactly — one mode at every seam", () => {
    for (const t of [0, 2300, 4600, 6900]) {
      expect(visibleModesAt(t)).toHaveLength(1)
    }
  })

  test("the keyframe fraction matches the hold/cadence ratio exactly", () => {
    expect(MODE_VISIBLE_FRACTION).toBeCloseTo(MODE_HOLD_MS / modeCadenceMs(), 10)
    expect(MODE_VISIBLE_PCT).toBe("33.3333%")
  })

  test("MODE_HOLD_MS is an exact multiple of WAVE_PERIOD_MS — every swap lands at stand-progress zero", () => {
    // 2300 = 2 x 1150, so a mode swap always coincides with all curves at full swing — the
    // cleanest possible cut. Nothing else defends this: changing the period to 1000 would
    // make swaps land mid-swing and visibly jump, with every other test still green.
    expect(MODE_HOLD_MS % WAVE_PERIOD_MS).toBe(0)
  })
})

describe("geometry", () => {
  test("the axis is centred in the box", () => {
    expect(WAVE_BOX.h / 2).toBe(WAVE_BOX.mid)
  })

  test("one path per mode, mode n has n full wavelengths across the box", () => {
    expect(MODE_PATHS).toHaveLength(MODE_WAVELENGTHS.length)
    MODE_WAVELENGTHS.forEach((lambda, i) => {
      expect(WAVE_BOX.w / lambda).toBe(i + 1)
    })
  })

  test("every sampled point stays inside the box once stroke width is accounted for", () => {
    const half = WAVE_LEAD_STROKE / 2
    for (const lambda of MODE_WAVELENGTHS) {
      for (const [x, y] of samplePoints(lambda)) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(WAVE_BOX.w)
        expect(y - half).toBeGreaterThanOrEqual(0)
        expect(y + half).toBeLessThanOrEqual(WAVE_BOX.h)
      }
    }
  })

  test("amplitude is actually used — extremes reach within 0.1px of the design bound", () => {
    const ys = samplePoints(MODE_WAVELENGTHS[0]).map(([, y]) => y)
    expect(Math.min(...ys)).toBeCloseTo(WAVE_BOX.mid - WAVE_AMP, 1)
    expect(Math.max(...ys)).toBeCloseTo(WAVE_BOX.mid + WAVE_AMP, 1)
  })

  test("the ~0.95px stroke margin survives — not just box containment", () => {
    const ys = samplePoints(MODE_WAVELENGTHS[0]).map(([, y]) => y)
    const margin = Math.min(...ys) - WAVE_LEAD_STROKE / 2
    expect(margin).toBeGreaterThanOrEqual(0.9)
  })

  test("every mode has a node at both ends of the box", () => {
    for (const lambda of MODE_WAVELENGTHS) {
      const pts = samplePoints(lambda)
      expect(pts[0]).toEqual([0, WAVE_BOX.mid])
      expect(pts.at(-1)).toEqual([WAVE_BOX.w, WAVE_BOX.mid])
    }
  })

  // Path data's character set is only `,.0123456789LM`, so an id/url() assertion here can
  // never fail — it would only prove the test file typo-checks itself. The real id-collision
  // risk (several wave instances mounting at once, SVG ids being document-global) lives at
  // the component layer (Task 2), not in this pure geometry, so it is not covered here.
  test("paths are well-formed", () => {
    for (const d of MODE_PATHS) {
      expect(d.startsWith("M")).toBe(true)
    }
  })
})

describe("CSS/TS drift guard", () => {
  test("the amc-wave-mode ON breakpoint still matches MODE_VISIBLE_PCT", () => {
    // @keyframes selectors cannot use custom properties, so this literal is duplicated in
    // amicode.css by necessity. A loose toContain() over a wide slice is not enough — it
    // still passes if the ON edge is mutated to e.g. "0%, 50%" (mode curves permanently
    // overlaid), because the original percentage string can still appear elsewhere in the
    // slice. Bind the match to the rule's own selector+brace instead.
    const css = readFileSync(new URL("./amicode.css", import.meta.url), "utf8")
    const start = css.indexOf("@keyframes amc-wave-mode")
    expect(start).toBeGreaterThan(-1)
    const block = css.slice(start, css.indexOf("}", css.indexOf("{", start) + 1) + 1)
    expect(block).toMatch(new RegExp(`0%,\\s*${MODE_VISIBLE_PCT.replace(".", "\\.")}\\s*\\{`))
  })

  test("the amc-wave-mode OFF breakpoint still matches MODE_OFF_PCT", () => {
    // The OFF edge is the one that actually decides whether two modes ever render
    // superimposed — a guard that only checks the ON edge would pass with the OFF edge
    // dragged to e.g. "40%", which shows two wavelengths superimposed for ~460ms of every
    // transition. Same bounded-match technique, applied to the second rule.
    const css = readFileSync(new URL("./amicode.css", import.meta.url), "utf8")
    const start = css.indexOf("@keyframes amc-wave-mode")
    expect(start).toBeGreaterThan(-1)
    const onEnd = css.indexOf("}", css.indexOf("{", start) + 1) + 1
    const block = css.slice(onEnd, css.indexOf("}", css.indexOf("{", onEnd) + 1) + 1)
    expect(block).toMatch(new RegExp(`${MODE_OFF_PCT.replace(".", "\\.")},\\s*100%\\s*\\{`))
  })
})

describe("module/component naming", () => {
  test("no same-stem .ts/.tsx pair in this directory — bun resolves such imports to the .tsx", () => {
    const dir = new URL(".", import.meta.url)
    const names = readdirSync(dir)
    const stem = (f: string) => f.replace(/\.(tsx?|test\.ts)$/, "")
    const ts = new Set(names.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map(stem))
    const collisions = names.filter((f) => f.endsWith(".tsx") && ts.has(stem(f)))
    expect(collisions).toEqual([])
  })
})
