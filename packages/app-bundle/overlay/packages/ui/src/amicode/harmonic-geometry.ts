// packages/ui/src/amicode/harmonic-geometry.ts
// AMICODE: pure geometry + timing for the spherical-harmonic morphing dot (harmonic-dot.tsx).
// Mirrors the wave-geometry.ts pattern: DOM-free, unit-tested, module-level precomputation.
//
// Rhythm: sphere → harmonic → sphere → harmonic → ... (the sphere is "home base").
// Each pulse is ~1.2s: sphere-hold (350ms) → morph-out (175ms) → shape-hold (500ms)
// → morph-back (175ms). Ten pulses make one full cycle (12s).
//
// The sequence is strictly ascending by quantum numbers (l, m): l=2→4, m=0→l
// within each level, using only genuine spherical harmonic cross-sections.
// This gives a natural build-up from simple pills to complex stars as it loops.
//
// All paths share the same command structure (64 points, M + 63 L + Z) so SVG
// SMIL <animate attributeName="d"> can interpolate natively between them.

/** CSS size of the morphing dot when in the running state (px). */
export const HARMONIC_SIZE = 13

/** Number of angular samples per shape — shared across all modes for SMIL compat. */
export const HARMONIC_SAMPLES = 64

// --- Timing constants (pulse rhythm) ---

/** How long the sphere rests between pulses (ms). */
export const SPHERE_HOLD_MS = 350

/** Duration of the morph transition sphere↔shape (ms). */
export const MORPH_MS = 175

/** How long each harmonic shape is held at full excitation (ms). */
export const SHAPE_HOLD_MS = 500

/** One full pulse: sphere-hold + morph-out + shape-hold + morph-back (ms). */
export const PULSE_MS = SPHERE_HOLD_MS + MORPH_MS + SHAPE_HOLD_MS + MORPH_MS

/** Number of pulses in one full cycle. */
export const PULSE_COUNT = 8

/** Total cycle duration (ms). */
export const CYCLE_MS = PULSE_MS * PULSE_COUNT

// --- Modes ---

/** Number of distinct harmonic modes (circle + 10 genuine shapes). */
export const MODE_COUNT = 11

/**
 * Compute the normalized radius [0, 1] for a given mode at angle theta.
 *
 * Each mode is a genuine spherical harmonic cross-section — either an
 * azimuthal cut |cos(mφ)| (lobe count = 2m) or a polar Legendre |P_l^0(cosθ)|.
 * Every mode is topologically distinct at 13px: different lobe count or
 * different symmetry-breaking pattern.
 *
 *   Mode 0: circle        — Y_0^0 (home base, not in pulse sequence)
 *   Mode 1: pill          — |cosθ| (m=1, 2 lobes)
 *   Mode 2: pinched       — |P_2^0(cosθ)| (2 big + 2 equatorial bumps)
 *   Mode 3: clover        — |cos2θ| (m=2, 4 lobes)
 *   Mode 4: peanut        — |P_3^0(cosθ)| (2 big + 4 side bumps)
 *   Mode 5: rosette       — |cos3θ| (m=3, 6 lobes)
 *   Mode 6: double-pinch  — |P_4^0(cosθ)| (complex multi-node)
 *   Mode 7: star-8        — |cos4θ| (m=4, 8 lobes)
 *   Mode 8: star-10       — |cos5θ| (m=5, 10 lobes)
 *   Mode 9: hedgehog      — |P_5^0(cosθ)| (2 big + 8 fine bumps)
 *   Mode 10: star-12     — |cos6θ| (m=6, 12 lobes)
 *
 * A base offset (min radius) prevents cusps — at 13px a cusp would be a
 * single-pixel spike, unreadable. Higher lobe counts use a higher base
 * so the features remain visible at small pixel radius.
 */
export function harmonicRadius(mode: number, theta: number): number {
  switch (mode) {
    case 0:
      return 1.0
    case 1: {
      // m=1 pill: cos²θ, 2 lobes — the simplest non-circle
      const cos = Math.cos(theta)
      return 0.15 + 0.85 * cos * cos
    }
    case 2: {
      // P_2^0: |3cos²θ - 1|/2 — 2 big lobes + 2 equatorial bumps
      const cos = Math.cos(theta)
      const raw = Math.abs(3 * cos * cos - 1) / 2
      return 0.15 + 0.85 * raw
    }
    case 3: {
      // m=2 clover: |cos(2θ)|, 4 symmetric lobes
      const raw = Math.abs(Math.cos(2 * theta))
      return 0.15 + 0.85 * raw
    }
    case 4: {
      // P_3^0: |(5cos³θ - 3cosθ)/2| — 2 big lobes + 4 side bumps
      const cos = Math.cos(theta)
      const raw = Math.abs(5 * cos * cos * cos - 3 * cos) / 2
      return 0.15 + 0.85 * raw
    }
    case 5: {
      // m=3 rosette: |cos(3θ)|, 6 lobes
      const raw = Math.abs(Math.cos(3 * theta))
      return 0.2 + 0.8 * raw
    }
    case 6: {
      // P_4^0: |(35cos⁴θ - 30cos²θ + 3)/8| — complex multi-node
      const cos = Math.cos(theta)
      const cos2 = cos * cos
      const raw = Math.abs(35 * cos2 * cos2 - 30 * cos2 + 3) / 8
      return 0.15 + 0.85 * raw
    }
    case 7: {
      // m=4 star-8: |cos(4θ)|, 8 lobes
      const raw = Math.abs(Math.cos(4 * theta))
      return 0.25 + 0.75 * raw
    }
    case 8: {
      // m=5 star-10: |cos(5θ)|, 10 lobes
      const raw = Math.abs(Math.cos(5 * theta))
      return 0.3 + 0.7 * raw
    }
    case 9: {
      // P_5^0: |(63cos⁵θ - 70cos³θ + 15cosθ)/8| — 2 big + 8 fine bumps
      const cos = Math.cos(theta)
      const cos2 = cos * cos
      const cos3 = cos2 * cos
      const raw = Math.abs(63 * cos2 * cos3 - 70 * cos3 + 15 * cos) / 8
      return 0.2 + 0.8 * raw
    }
    case 10: {
      // m=6 star-12: |cos(6θ)|, 12 lobes
      const raw = Math.abs(Math.cos(6 * theta))
      return 0.35 + 0.65 * raw
    }
    default:
      return 1.0
  }
}

/**
 * Generate a closed SVG path for a harmonic mode, optionally rotated.
 * The path fits inside a HARMONIC_SIZE × HARMONIC_SIZE viewBox,
 * centred at (HARMONIC_SIZE/2, HARMONIC_SIZE/2).
 *
 * @param mode — which harmonic shape (0=circle, 1=dumbbell, 2=pinched, 3=clover)
 * @param rotationDeg — rotation angle in degrees (applied as offset to sampling angle)
 * @param samples — number of angular samples (must be consistent for SMIL)
 */
export function harmonicPath(mode: number, rotationDeg: number = 0, samples: number = HARMONIC_SAMPLES): string {
  const cx = HARMONIC_SIZE / 2
  const cy = HARMONIC_SIZE / 2
  // Leave 0.5px margin for anti-aliasing / border
  const maxR = (HARMONIC_SIZE - 1) / 2
  const rotationRad = (rotationDeg * Math.PI) / 180

  const round = (n: number) => Math.round(n * 100) / 100

  const parts: string[] = []
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * 2 * Math.PI
    // Sample the harmonic at the rotated angle, but plot at the original angle
    const r = harmonicRadius(mode, theta - rotationRad) * maxR
    const x = round(cx + r * Math.cos(theta))
    const y = round(cy + r * Math.sin(theta))
    parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`)
  }
  parts.push("Z")
  return parts.join("")
}

/**
 * Generate a donut SVG path: outer harmonic shape (CW) + inner circle (CCW).
 * Used with fill-rule="evenodd" to punch a hole — a single filled path that
 * renders as a ring, no stroke needed.
 *
 * When innerR=0, the inner sub-path collapses to a point at centre (solid shape).
 * SMIL interpolates between donut paths point-by-point, so the ring smoothly
 * closes/opens as the outer shape morphs.
 *
 * @param mode — which harmonic shape for the outer contour
 * @param rotationDeg — rotation for the outer contour
 * @param innerR — radius of the inner hole (0 = no hole = solid)
 */
export function harmonicDonutPath(mode: number, rotationDeg: number = 0, innerR: number = INNER_R, samples: number = HARMONIC_SAMPLES): string {
  const cx = HARMONIC_SIZE / 2
  const cy = HARMONIC_SIZE / 2
  const maxR = (HARMONIC_SIZE - 1) / 2
  const rotationRad = (rotationDeg * Math.PI) / 180
  const round = (n: number) => Math.round(n * 100) / 100

  // Outer contour — clockwise
  const parts: string[] = []
  for (let i = 0; i < samples; i++) {
    const theta = (i / samples) * 2 * Math.PI
    const r = harmonicRadius(mode, theta - rotationRad) * maxR
    const x = round(cx + r * Math.cos(theta))
    const y = round(cy + r * Math.sin(theta))
    parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`)
  }
  parts.push("Z")

  // Inner contour — counter-clockwise (punches the hole via evenodd)
  // When innerR=0, all points collapse to centre = no visible hole.
  for (let i = 0; i < samples; i++) {
    const theta = ((samples - i) / samples) * 2 * Math.PI // reversed direction
    const x = round(cx + innerR * Math.cos(theta))
    const y = round(cy + innerR * Math.sin(theta))
    parts.push(i === 0 ? `M${x},${y}` : `L${x},${y}`)
  }
  parts.push("Z")

  return parts.join("")
}

/**
 * The pulse mode sequence: 8 visually distinct genuine spherical harmonics.
 * Azimuthal |cos(mθ)| lobe ladder interleaved with 2 zonal Legendres.
 */
export const PULSE_MODES: readonly number[] = [
  1,  // pill          — 2 lobes
  2,  // pinched       — P_2^0, 2 big + 2 bumps
  6,  // double-pinch  — P_4^0, complex
  3,  // clover        — 4 lobes
  5,  // rosette       — 6 lobes
  7,  // star-8        — 8 lobes
  8,  // star-10       — 10 lobes
  10, // star-12       — 12 lobes
]

/**
 * Fixed rotation angle per pulse slot (degrees).
 * Only the clover (4-lobe) rotates 45° so fins form an X.
 */
export const PULSE_ROTATIONS: readonly number[] = [
  0,  // pill
  0,  // pinched
  0,  // double-pinch
  45, // clover — X not +
  0,  // rosette
  0,  // star-8
  0,  // star-10
  0,  // star-12
]

/** The canonical deterministic pulse sequence — mode + fixed rotation per slot.
 *  Used by HarmonicDot directly (no randomization). */
export const PULSE_SEQUENCE: ReadonlyArray<{ mode: number; rotation: number }> =
  PULSE_MODES.map((mode, i) => ({ mode, rotation: PULSE_ROTATIONS[i] }))

/** Inner disc radius that creates the ring hole (px in viewBox units).
 *  maxR is 6, so ring thickness = 6 - INNER_R ≈ 1.5px. */
export const INNER_R = 4.5

/** Pre-computed circle path (the "home" shape). */
export const CIRCLE_PATH = harmonicPath(0)

/** Pre-computed donut circle path (the ring — sphere with inner hole). */
export const CIRCLE_DONUT_PATH = harmonicDonutPath(0, 0, INNER_R)

/**
 * Build SMIL keyframe attributes for a given pulse sequence.
 *
 * Uses donut paths (fill-rule evenodd): the sphere state is a ring (outer circle
 * + inner hole), harmonic states are solid (inner collapsed to centre). SMIL
 * interpolates between them point-by-point — the ring smoothly closes as the
 * shape blooms, reopens when returning to sphere.
 */
export function buildSmil(sequence: ReadonlyArray<{ mode: number; rotation: number }>): {
  values: string
  keyTimes: string
  /** Background masking circle radius: INNER_R during sphere, 0 during harmonic. */
  innerRadius: string
  dur: string
} {
  // Harmonic donut paths with inner hole at r=0 (solid)
  const solidPaths = sequence.map(({ mode, rotation }) => harmonicDonutPath(mode, rotation, 0))
  const values: string[] = []
  const radii: number[] = []
  const times: number[] = []
  const total = PULSE_MS * sequence.length

  let t = 0
  for (let i = 0; i < sequence.length; i++) {
    // Sphere hold start — ring (full inner hole)
    values.push(CIRCLE_DONUT_PATH)
    radii.push(INNER_R)
    times.push(t / total)
    t += SPHERE_HOLD_MS

    // Sphere hold end — morph-out begins
    values.push(CIRCLE_DONUT_PATH)
    radii.push(INNER_R)
    times.push(t / total)
    t += MORPH_MS

    // Shape arrived — solid (inner hole collapsed)
    values.push(solidPaths[i])
    radii.push(0)
    times.push(t / total)
    t += SHAPE_HOLD_MS

    // Shape hold end — morph-back begins
    values.push(solidPaths[i])
    radii.push(0)
    times.push(t / total)
    t += MORPH_MS
  }

  // Final: back to ring
  values.push(CIRCLE_DONUT_PATH)
  radii.push(INNER_R)
  times.push(1)

  return {
    values: values.join(";"),
    keyTimes: times.map((v) => Math.round(v * 10000) / 10000).join(";"),
    innerRadius: radii.join(";"),
    dur: `${total}ms`,
  }
}

// --- Pre-computed exports ---

/** Pre-computed paths for the deterministic pulse sequence. */
export const PULSE_PATHS: readonly string[] = PULSE_SEQUENCE.map(
  ({ mode, rotation }) => harmonicPath(mode, rotation),
)

/** Pre-computed donut paths (solid, inner r=0) for the deterministic pulse sequence. */
export const PULSE_DONUT_PATHS: readonly string[] = PULSE_SEQUENCE.map(
  ({ mode, rotation }) => harmonicDonutPath(mode, rotation, 0),
)

/** Pre-computed base paths for all raw modes (no rotation). */
export const HARMONIC_PATHS: readonly string[] = Array.from(
  { length: MODE_COUNT },
  (_, mode) => harmonicPath(mode),
)

/** Pre-computed SMIL for the canonical pulse sequence. */
export const SMIL = buildSmil(PULSE_SEQUENCE)

/** @deprecated use SMIL.dur or CYCLE_MS */
export const MORPH_CADENCE_MS = CYCLE_MS

/** @deprecated use SMIL.keyTimes */
export function smilKeyTimes(): string {
  return SMIL.keyTimes
}

/**
 * Compute a SMIL `begin` offset that phase-locks the animation to a global
 * modular clock. Every mount of HarmonicDot calls this once; the returned
 * string (e.g. "-4200ms") makes the browser start the SMIL timeline as if
 * it had been running since wall-clock t=0 mod CYCLE_MS. Two dots mounting
 * at different times agree on the current shape because they share the same
 * epoch.
 */
export function smilBeginOffset(): string {
  return `-${Date.now() % CYCLE_MS}ms`
}
