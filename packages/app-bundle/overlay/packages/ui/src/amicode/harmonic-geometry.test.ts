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
  SMIL,
  harmonicRadius,
  harmonicPath,
  randomPulseSequence,
  buildSmil,
} from "./harmonic-geometry"

describe("constants", () => {
  test("HARMONIC_SIZE is 13px — fits inside the 24px content gutter", () => {
    expect(HARMONIC_SIZE).toBe(13)
  })

  test("HARMONIC_SAMPLES is 64 — enough for smooth curves at 13px", () => {
    expect(HARMONIC_SAMPLES).toBe(64)
  })

  test("MODE_COUNT is 8 — circle + 7 shapes (dumbbell kept but constrained)", () => {
    expect(MODE_COUNT).toBe(8)
  })
})

describe("pulse timing", () => {
  test("one pulse is sphere-hold + morph-out + shape-hold + morph-back", () => {
    expect(PULSE_MS).toBe(SPHERE_HOLD_MS + MORPH_MS + SHAPE_HOLD_MS + MORPH_MS)
  })

  test("pulse timing is ~1.2s (snappy, energetic)", () => {
    expect(PULSE_MS).toBe(1200)
  })

  test("full cycle is 10 pulses = 12s", () => {
    expect(CYCLE_MS).toBe(PULSE_MS * PULSE_COUNT)
    expect(CYCLE_MS).toBe(12000)
  })

  test("timing breakdown: 350 + 175 + 500 + 175 = 1200", () => {
    expect(SPHERE_HOLD_MS).toBe(350)
    expect(MORPH_MS).toBe(175)
    expect(SHAPE_HOLD_MS).toBe(500)
  })
})

describe("harmonicRadius", () => {
  test("mode 0 is a circle — constant radius at all angles", () => {
    const radii = Array.from({ length: 64 }, (_, i) => harmonicRadius(0, (i / 64) * 2 * Math.PI))
    const first = radii[0]
    for (const r of radii) {
      expect(r).toBeCloseTo(first, 6)
    }
  })

  test("mode 1 (dumbbell) has maxima at 0 and pi, minima at pi/2 and 3pi/2", () => {
    const top = harmonicRadius(1, 0)
    const bottom = harmonicRadius(1, Math.PI)
    const side = harmonicRadius(1, Math.PI / 2)
    expect(top).toBeCloseTo(bottom, 4)
    expect(top).toBeGreaterThan(side)
  })

  test("mode 2 (pinched) has distinct shape from mode 1", () => {
    const r2_side = harmonicRadius(2, Math.PI / 2)
    const r1_side = harmonicRadius(1, Math.PI / 2)
    expect(r2_side).not.toBeCloseTo(r1_side, 2)
  })

  test("mode 3 (clover) has four-fold symmetry", () => {
    // |cos(2θ)| has lobes at 0, π/2, π, 3π/2 and nodes at π/4, 3π/4, etc.
    const r0 = harmonicRadius(3, 0)
    const r90 = harmonicRadius(3, Math.PI / 2)
    const r180 = harmonicRadius(3, Math.PI)
    const r270 = harmonicRadius(3, 3 * Math.PI / 2)
    // Four-fold symmetry: all cardinal directions equal
    expect(r0).toBeCloseTo(r90, 4)
    expect(r90).toBeCloseTo(r180, 4)
    expect(r180).toBeCloseTo(r270, 4)
    // Nodes at 45° are smaller than lobes at 0°
    const node = harmonicRadius(3, Math.PI / 4)
    expect(r0).toBeGreaterThan(node)
  })

  test("mode 4 (rosette) has six-fold symmetry", () => {
    // |cos(3θ)| has 6 lobes at 0, 60°, 120°, 180°, 240°, 300°
    const r0 = harmonicRadius(4, 0)
    const r60 = harmonicRadius(4, Math.PI / 3)
    const r120 = harmonicRadius(4, 2 * Math.PI / 3)
    expect(r0).toBeCloseTo(r60, 4)
    expect(r60).toBeCloseTo(r120, 4)
    // Nodes at 30°
    const node = harmonicRadius(4, Math.PI / 6)
    expect(r0).toBeGreaterThan(node)
  })

  test("mode 6 (star-8) has eight-fold symmetry", () => {
    // |cos(4θ)| has 8 lobes at 0, 45°, 90°, 135°, etc.
    const r0 = harmonicRadius(6, 0)
    const r45 = harmonicRadius(6, Math.PI / 4)
    const r90 = harmonicRadius(6, Math.PI / 2)
    expect(r0).toBeCloseTo(r45, 4)
    expect(r45).toBeCloseTo(r90, 4)
    // Nodes at 22.5°
    const node = harmonicRadius(6, Math.PI / 8)
    expect(r0).toBeGreaterThan(node)
  })

  test("mode 7 (double pinch) has two-fold symmetry with multiple lobes", () => {
    // |P_4^0(cosθ)| — symmetric about both axes, with 4 lobes along polar axis
    const r0 = harmonicRadius(7, 0)
    const rPi = harmonicRadius(7, Math.PI)
    const r90 = harmonicRadius(7, Math.PI / 2)
    expect(r0).toBeCloseTo(rPi, 4)
    expect(r90).toBeGreaterThan(0.2)
    const rNode = harmonicRadius(7, Math.PI * 30.6 / 180)
    expect(r0).toBeGreaterThan(rNode)
    expect(r90).toBeGreaterThan(rNode)
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
  test("produces a closed SVG path starting with M and ending with Z", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      const path = harmonicPath(mode)
      expect(path.startsWith("M")).toBe(true)
      expect(path.endsWith("Z")).toBe(true)
    }
  })

  test("all modes produce paths with HARMONIC_SAMPLES - 1 L commands", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      const path = harmonicPath(mode)
      expect((path.match(/L/g) || []).length).toBe(HARMONIC_SAMPLES - 1)
    }
  })

  test("identical command structure across modes — required for SMIL interpolation", () => {
    const structures = Array.from({ length: MODE_COUNT }, (_, mode) =>
      harmonicPath(mode).replace(/[-\d.,\s]/g, ""),
    )
    for (const struct of structures) {
      expect(struct).toBe(structures[0])
    }
  })

  test("all coordinates stay within the viewBox (0, 0, SIZE, SIZE)", () => {
    for (let mode = 0; mode < MODE_COUNT; mode++) {
      const coords = harmonicPath(mode).match(/-?[\d.]+/g)!.map(Number)
      for (const c of coords) {
        expect(c).toBeGreaterThanOrEqual(-0.01)
        expect(c).toBeLessThanOrEqual(HARMONIC_SIZE + 0.01)
      }
    }
  })

  test("rotation shifts the shape without changing structure", () => {
    const p0 = harmonicPath(1, 0)
    const p90 = harmonicPath(1, 90)
    // Same structure (command letters)
    expect(p90.replace(/[-\d.,\s]/g, "")).toBe(p0.replace(/[-\d.,\s]/g, ""))
    // But different coordinates (the dumbbell is rotated)
    expect(p90).not.toBe(p0)
  })

  test("rotation by 0° gives the same path as no rotation", () => {
    expect(harmonicPath(1, 0)).toBe(harmonicPath(1))
  })

  test("circle is invariant under rotation (mode 0)", () => {
    expect(harmonicPath(0, 0)).toBe(harmonicPath(0, 45))
    expect(harmonicPath(0, 0)).toBe(harmonicPath(0, 90))
  })
})

describe("pulse sequence", () => {
  test("has PULSE_COUNT entries", () => {
    expect(PULSE_SEQUENCE).toHaveLength(PULSE_COUNT)
  })

  test("uses modes 1–6 only (never circle as a pulse shape)", () => {
    for (const { mode } of PULSE_SEQUENCE) {
      expect(mode).toBeGreaterThanOrEqual(1)
      expect(mode).toBeLessThan(MODE_COUNT)
    }
  })

  test("skinny shapes (modes 1, 2, 7) are never at 90° or 270° — avoids vertical elongation", () => {
    for (const { mode, rotation } of PULSE_SEQUENCE) {
      if (mode === 1 || mode === 2 || mode === 7) {
        expect(rotation).not.toBe(90)
        expect(rotation).not.toBe(270)
      }
    }
  })

  test("consecutive shapes have maximum visual contrast (no two identical)", () => {
    for (let i = 1; i < PULSE_SEQUENCE.length; i++) {
      const prev = PULSE_SEQUENCE[i - 1]
      const curr = PULSE_SEQUENCE[i]
      const same = prev.mode === curr.mode && prev.rotation === curr.rotation
      expect(same).toBe(false)
    }
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
  test("values has PULSE_COUNT*4 + 1 entries (holds + morphs + close)", () => {
    const count = SMIL.values.split(";").length
    expect(count).toBe(PULSE_COUNT * 4 + 1)
  })

  test("keyTimes has same count as values", () => {
    const valCount = SMIL.values.split(";").length
    const timeCount = SMIL.keyTimes.split(";").length
    expect(timeCount).toBe(valCount)
  })

  test("keyTimes starts at 0 and ends at 1", () => {
    const times = SMIL.keyTimes.split(";").map(Number)
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBe(1)
  })

  test("keyTimes are monotonically non-decreasing", () => {
    const times = SMIL.keyTimes.split(";").map(Number)
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    }
  })

  test("dur matches CYCLE_MS", () => {
    expect(SMIL.dur).toBe(`${CYCLE_MS}ms`)
  })

  test("first and last values are both circle donut (seamless loop)", () => {
    const vals = SMIL.values.split(";")
    expect(vals[0]).toBe(CIRCLE_DONUT_PATH)
    expect(vals[vals.length - 1]).toBe(CIRCLE_DONUT_PATH)
  })

  test("every other pair of values is (circle donut, circle donut) for sphere holds", () => {
    // Pattern: C,C,S,S,C,C,S,S,...,C
    // Positions 0,1 are circle (first sphere hold)
    // Positions 4,5 are circle (second sphere hold)
    // etc.
    const vals = SMIL.values.split(";")
    for (let pulse = 0; pulse < PULSE_COUNT; pulse++) {
      const base = pulse * 4
      expect(vals[base]).toBe(CIRCLE_DONUT_PATH)
      expect(vals[base + 1]).toBe(CIRCLE_DONUT_PATH)
    }
  })

  test("shape values match PULSE_DONUT_PATHS at the right positions", () => {
    const vals = SMIL.values.split(";")
    for (let pulse = 0; pulse < PULSE_COUNT; pulse++) {
      const base = pulse * 4
      // Positions base+2 and base+3 are the shape
      expect(vals[base + 2]).toBe(PULSE_DONUT_PATHS[pulse])
      expect(vals[base + 3]).toBe(PULSE_DONUT_PATHS[pulse])
    }
  })

  test("all value paths have identical SMIL-compatible structure", () => {
    const vals = SMIL.values.split(";")
    const structure = vals[0].replace(/[-\d.,\s]/g, "")
    for (const v of vals) {
      expect(v.replace(/[-\d.,\s]/g, "")).toBe(structure)
    }
  })
})

describe("randomPulseSequence + buildSmil", () => {
  test("randomPulseSequence returns PULSE_COUNT entries matching PULSE_MODES", () => {
    const seq = randomPulseSequence()
    expect(seq).toHaveLength(PULSE_MODES.length)
    for (let i = 0; i < seq.length; i++) {
      expect(seq[i].mode).toBe(PULSE_MODES[i])
    }
  })

  test("skinny modes (1, 2, 7) never get 90° or 270° in random sequences", () => {
    for (let run = 0; run < 50; run++) {
      const seq = randomPulseSequence()
      for (const { mode, rotation } of seq) {
        if (mode === 1 || mode === 2 || mode === 7) {
          expect(rotation).not.toBe(90)
          expect(rotation).not.toBe(270)
        }
      }
    }
  })

  test("random sequences produce different angles across runs", () => {
    const seqs = Array.from({ length: 20 }, () => randomPulseSequence())
    const signatures = seqs.map((s) => s.map((p) => p.rotation).join(","))
    // With 6–8 angle choices per slot, getting 20 identical signatures is ~impossible
    const unique = new Set(signatures)
    expect(unique.size).toBeGreaterThan(1)
  })

  test("buildSmil produces valid SMIL for a random sequence", () => {
    const seq = randomPulseSequence()
    const smil = buildSmil(seq)
    const vals = smil.values.split(";")
    const times = smil.keyTimes.split(";").map(Number)
    // Correct count
    expect(vals.length).toBe(seq.length * 4 + 1)
    expect(times.length).toBe(vals.length)
    // Bounds
    expect(times[0]).toBe(0)
    expect(times[times.length - 1]).toBe(1)
    // Monotonic
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1])
    }
    // First and last are circle donut
    expect(vals[0]).toBe(CIRCLE_DONUT_PATH)
    expect(vals[vals.length - 1]).toBe(CIRCLE_DONUT_PATH)
  })

  test("all angles are from 45° increment set", () => {
    const valid = new Set([0, 45, 90, 135, 180, 225, 270, 315])
    for (let run = 0; run < 20; run++) {
      for (const { rotation } of randomPulseSequence()) {
        expect(valid.has(rotation)).toBe(true)
      }
    }
  })
})
