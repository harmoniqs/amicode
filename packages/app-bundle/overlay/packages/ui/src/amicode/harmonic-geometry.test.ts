// packages/ui/src/amicode/harmonic-geometry.test.ts
import { describe, expect, test } from "bun:test"
import {
  HARMONIC_SIZE,
  HARMONIC_SAMPLES,
  SPHERE_HOLD_MS,
  MORPH_MS,
  SHAPE_HOLD_MS,
  PULSE_MS,
  PULSE_COUNT,
  CYCLE_MS,
  MODE_COUNT,
  HARMONIC_PATHS,
  CIRCLE_PATH,
  CIRCLE_DONUT_PATH,
  PULSE_PATHS,
  PULSE_DONUT_PATHS,
  PULSE_SEQUENCE,
  PULSE_MODES,
  PULSE_ROTATIONS,
  SMIL,
  harmonicRadius,
  harmonicPath,
  buildSmil,
  smilBeginOffset,
} from "./harmonic-geometry"

describe("constants", () => {
  test("HARMONIC_SIZE is 13px", () => {
    expect(HARMONIC_SIZE).toBe(13)
  })

  test("HARMONIC_SAMPLES is 64", () => {
    expect(HARMONIC_SAMPLES).toBe(64)
  })

  test("MODE_COUNT is 11 — circle + 10 genuine shapes", () => {
    expect(MODE_COUNT).toBe(11)
  })
})

describe("pulse timing", () => {
  test("one pulse = sphere-hold + morph-out + shape-hold + morph-back", () => {
    expect(PULSE_MS).toBe(SPHERE_HOLD_MS + MORPH_MS + SHAPE_HOLD_MS + MORPH_MS)
  })

  test("pulse is 1200ms", () => {
    expect(PULSE_MS).toBe(1200)
  })

  test("full cycle is 8 pulses = 9.6s", () => {
    expect(CYCLE_MS).toBe(PULSE_MS * PULSE_COUNT)
    expect(CYCLE_MS).toBe(9600)
  })
})

describe("harmonicRadius", () => {
  test("mode 0 (circle) — constant radius at all angles", () => {
    const radii = Array.from({ length: 64 }, (_, i) => harmonicRadius(0, (i / 64) * 2 * Math.PI))
    for (const r of radii) expect(r).toBeCloseTo(1, 6)
  })

  test("mode 1 (pill) — 2 lobes, maxima at 0 and pi", () => {
    expect(harmonicRadius(1, 0)).toBeGreaterThan(harmonicRadius(1, Math.PI / 2))
    expect(harmonicRadius(1, 0)).toBeCloseTo(harmonicRadius(1, Math.PI), 4)
  })

  test("mode 3 (clover) — 4-fold symmetry", () => {
    const r0 = harmonicRadius(3, 0)
    const r90 = harmonicRadius(3, Math.PI / 2)
    expect(r0).toBeCloseTo(r90, 4)
    expect(r0).toBeGreaterThan(harmonicRadius(3, Math.PI / 4))
  })

  test("mode 5 (rosette) — 6-fold symmetry", () => {
    const r0 = harmonicRadius(5, 0)
    const r60 = harmonicRadius(5, Math.PI / 3)
    expect(r0).toBeCloseTo(r60, 4)
    expect(r0).toBeGreaterThan(harmonicRadius(5, Math.PI / 6))
  })

  test("mode 7 (star-8) — 8-fold symmetry", () => {
    const r0 = harmonicRadius(7, 0)
    const r45 = harmonicRadius(7, Math.PI / 4)
    expect(r0).toBeCloseTo(r45, 4)
    expect(r0).toBeGreaterThan(harmonicRadius(7, Math.PI / 8))
  })

  test("mode 8 (star-10) — 10-fold symmetry", () => {
    const r0 = harmonicRadius(8, 0)
    const r36 = harmonicRadius(8, Math.PI / 5)
    expect(r0).toBeCloseTo(r36, 4)
    expect(r0).toBeGreaterThan(harmonicRadius(8, Math.PI / 10))
  })

  test("mode 10 (star-12) — 12-fold symmetry", () => {
    const r0 = harmonicRadius(10, 0)
    const r30 = harmonicRadius(10, Math.PI / 6)
    expect(r0).toBeCloseTo(r30, 4)
    expect(r0).toBeGreaterThan(harmonicRadius(10, Math.PI / 12))
  })

  test("Legendre shapes (2, 4, 6, 9) have bilateral symmetry but NOT uniform lobes", () => {
    // P_l^0 shapes have mirror symmetry θ↔-θ but different-sized lobes
    for (const mode of [2, 4, 6, 9]) {
      // Mirror symmetry
      expect(harmonicRadius(mode, Math.PI / 3)).toBeCloseTo(
        harmonicRadius(mode, -Math.PI / 3), 6)
      // Horizontal lobes (θ=0) differ from vertical (θ=π/2)
      expect(harmonicRadius(mode, 0)).not.toBeCloseTo(
        harmonicRadius(mode, Math.PI / 2), 1)
    }
  })

  test("all modes have radii in (0, 1] — never zero, never exceeds unit", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      for (let i = 0; i < 256; i++) {
        const theta = (i / 256) * 2 * Math.PI
        const r = harmonicRadius(mode, theta)
        expect(r).toBeGreaterThan(0)
        expect(r).toBeLessThanOrEqual(1.0001)
      }
    }
  })
})

describe("harmonicPath", () => {
  test("produces closed SVG paths (M...Z) for all modes", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      const path = harmonicPath(mode)
      expect(path.startsWith("M")).toBe(true)
      expect(path.endsWith("Z")).toBe(true)
    }
  })

  test("all modes produce paths with HARMONIC_SAMPLES - 1 L commands", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      expect((harmonicPath(mode).match(/L/g) || []).length).toBe(HARMONIC_SAMPLES - 1)
    }
  })

  test("identical command structure across modes — required for SMIL", () => {
    const structures = Array.from({ length: MODE_COUNT }, (_, mode) =>
      harmonicPath(mode).replace(/[-\d.,\s]/g, ""),
    )
    for (const s of structures) expect(s).toBe(structures[0])
  })

  test("all coordinates stay within the viewBox", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      const coords = harmonicPath(mode).match(/-?[\d.]+/g)!.map(Number)
      for (const c of coords) {
        expect(c).toBeGreaterThanOrEqual(-0.01)
        expect(c).toBeLessThanOrEqual(HARMONIC_SIZE + 0.01)
      }
    }
  })

  test("rotation shifts coordinates without changing structure", () => {
    const p0 = harmonicPath(3, 0)
    const p45 = harmonicPath(3, 45)
    expect(p45.replace(/[-\d.,\s]/g, "")).toBe(p0.replace(/[-\d.,\s]/g, ""))
    expect(p45).not.toBe(p0)
  })

  test("circle is invariant under rotation", () => {
    expect(harmonicPath(0, 0)).toBe(harmonicPath(0, 45))
  })
})

describe("pulse sequence", () => {
  test("has 8 entries", () => {
    expect(PULSE_SEQUENCE).toHaveLength(8)
    expect(PULSE_SEQUENCE).toHaveLength(PULSE_COUNT)
  })

  test("modes: pill, pinched, double-pinch, clover, rosette, star-8, star-10, star-12", () => {
    expect([...PULSE_MODES]).toEqual([1, 2, 6, 3, 5, 7, 8, 10])
  })

  test("only the clover (mode 3) is rotated 45°", () => {
    for (let i = 0; i < PULSE_SEQUENCE.length; i++) {
      const expected = PULSE_SEQUENCE[i].mode === 3 ? 45 : 0
      expect(PULSE_SEQUENCE[i].rotation).toBe(expected)
    }
  })

  test("consecutive shapes are never identical", () => {
    for (let i = 1; i < PULSE_SEQUENCE.length; i++) {
      expect(PULSE_SEQUENCE[i].mode).not.toBe(PULSE_SEQUENCE[i - 1].mode)
    }
  })

  test("no mode repeats in the sequence", () => {
    const modes = PULSE_SEQUENCE.map(p => p.mode)
    expect(new Set(modes).size).toBe(modes.length)
  })

  test("PULSE_PATHS matches the sequence", () => {
    expect(PULSE_PATHS).toHaveLength(PULSE_COUNT)
    for (let i = 0; i < PULSE_COUNT; i++) {
      const { mode, rotation } = PULSE_SEQUENCE[i]
      expect(PULSE_PATHS[i]).toBe(harmonicPath(mode, rotation))
    }
  })
})

describe("SMIL keyframes", () => {
  test("values has PULSE_COUNT*4 + 1 entries", () => {
    expect(SMIL.values.split(";").length).toBe(PULSE_COUNT * 4 + 1)
  })

  test("keyTimes has same count as values", () => {
    expect(SMIL.keyTimes.split(";").length).toBe(SMIL.values.split(";").length)
  })

  test("keyTimes: 0 → ... → 1, monotonically non-decreasing", () => {
    const times = SMIL.keyTimes.split(";").map(Number)
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBe(1)
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    }
  })

  test("dur matches CYCLE_MS", () => {
    expect(SMIL.dur).toBe(`${CYCLE_MS}ms`)
  })

  test("first and last values are circle donut (seamless loop)", () => {
    const vals = SMIL.values.split(";")
    expect(vals[0]).toBe(CIRCLE_DONUT_PATH)
    expect(vals[vals.length - 1]).toBe(CIRCLE_DONUT_PATH)
  })

  test("all value paths have identical SMIL-compatible structure", () => {
    const vals = SMIL.values.split(";")
    const structure = vals[0].replace(/[-\d.,\s]/g, "")
    for (const v of vals) {
      expect(v.replace(/[-\d.,\s]/g, "")).toBe(structure)
    }
  })
})

describe("smilBeginOffset (phase-lock)", () => {
  test("returns a negative ms string matching -(now % CYCLE_MS)", () => {
    const before = Date.now()
    const result = smilBeginOffset()
    const after = Date.now()
    // Must be a string of the form "-<digits>ms"
    expect(result).toMatch(/^-\d+ms$/)
    // The numeric value should be within [before % CYCLE_MS, after % CYCLE_MS] ± 50ms
    const offsetMs = parseInt(result.slice(1, -2), 10) // strip leading "-" and trailing "ms"
    const expectedLow = before % CYCLE_MS
    const expectedHigh = after % CYCLE_MS
    // Handle the wraparound case where the modulus crosses the cycle boundary
    if (expectedHigh >= expectedLow) {
      expect(offsetMs).toBeGreaterThanOrEqual(expectedLow - 50)
      expect(offsetMs).toBeLessThanOrEqual(expectedHigh + 50)
    } else {
      // Wraparound: either offsetMs is near the end of the cycle or near the start
      const inRange =
        (offsetMs >= expectedLow - 50) || (offsetMs <= expectedHigh + 50)
      expect(inRange).toBe(true)
    }
  })

  test("offset is always less than CYCLE_MS", () => {
    for (let i = 0; i < 10; i++) {
      const result = smilBeginOffset()
      const offsetMs = parseInt(result.slice(1, -2), 10)
      expect(offsetMs).toBeLessThan(CYCLE_MS)
      expect(offsetMs).toBeGreaterThanOrEqual(0)
    }
  })
})
