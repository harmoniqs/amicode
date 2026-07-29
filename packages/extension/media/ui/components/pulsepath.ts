// Pure SVG path geometry for the pulse plot (#66) — DOM-free so the render
// math is unit-testable (pulseplot.ts owns the DOM/SVG shell).
//
// Interp semantics (AMICODE_PULSE_META interp=):
//   zoh    — each value HELD for its knot interval: stairs over n intervals,
//            x(k) = k/n. Duration = n·dt.
//   linear — values are spline knots, straight segments between them:
//            x(k) = k/(n-1). Duration = (n-1)·dt.
//   cubic  — same knot grid, smooth curve THROUGH the knots. The record
//            carries values only (no derivatives/coefficients), so this is a
//            Catmull-Rom approximation of the solver's spline — close through
//            the knots, not coefficient-faithful. Faithful cubic needs the
//            line format extended with knot derivatives (flagged to the
//            cloud-delivery side; see #66 discussion).

import type { PulseInterp } from "../../../src/run_dir_reader";

const round = (v: number): number => Math.round(v * 100) / 100;

/** Zero-order-hold stairs: each value held for its knot interval, spanning the
 *  full width (drives share the time axis, so x is normalized by knot count). */
export function stairsPath(values: number[], y: (v: number) => number, w: number): string {
  if (values.length === 0) return "";
  const x = (k: number) => (k / values.length) * w;
  let d = `M0,${round(y(values[0]))}`;
  for (let k = 0; k < values.length; k++) {
    d += `H${round(x(k + 1))}`;
    if (k + 1 < values.length) d += `V${round(y(values[k + 1]))}`;
  }
  return d;
}

/** Linear spline: a polyline through the knots, endpoints at the plot edges. */
export function polylinePath(values: number[], y: (v: number) => number, w: number): string {
  if (values.length === 0) return "";
  if (values.length === 1) return `M0,${round(y(values[0]))}H${round(w)}`; // one knot — hold it
  const x = (k: number) => (k / (values.length - 1)) * w;
  let d = `M0,${round(y(values[0]))}`;
  for (let k = 1; k < values.length; k++) d += `L${round(x(k))},${round(y(values[k]))}`;
  return d;
}

/** Cubic through the knots: uniform Catmull-Rom converted to cubic Béziers
 *  (end neighbors clamped). Passes exactly through every knot. */
export function cubicPath(values: number[], y: (v: number) => number, w: number): string {
  const n = values.length;
  if (n < 3) return polylinePath(values, y, w); // a 2-knot "curve" IS its chord
  const x = (k: number) => (k / (n - 1)) * w;
  const p = (k: number) => values[Math.min(n - 1, Math.max(0, k))];
  let d = `M0,${round(y(values[0]))}`;
  for (let k = 0; k < n - 1; k++) {
    const c1x = x(k) + (x(k + 1) - x(k)) / 3;
    const c2x = x(k + 1) - (x(k + 1) - x(k)) / 3;
    const c1y = p(k) + (p(k + 1) - p(k - 1)) / 6;
    const c2y = p(k + 1) - (p(k + 2) - p(k)) / 6;
    d += `C${round(c1x)},${round(y(c1y))} ${round(c2x)},${round(y(c2y))} ${round(x(k + 1))},${round(y(p(k + 1)))}`;
  }
  return d;
}

/** The mode dispatch update() draws through. Unknown modes already coerced to
 *  zoh at parse — this default is belt-and-braces for direct callers. */
export function pulsePath(values: number[], y: (v: number) => number, w: number, interp: PulseInterp): string {
  if (interp === "linear") return polylinePath(values, y, w);
  if (interp === "cubic") return cubicPath(values, y, w);
  return stairsPath(values, y, w);
}

/** Where rendered knot k sits on the time axis, as a 0..1 fraction: interval
 *  MIDPOINT under zoh (the crosshair marks the hold), the knot itself under
 *  the spline modes. */
export function knotFrac(k: number, n: number, interp: PulseInterp): number {
  if (interp === "zoh") return (k + 0.5) / n;
  return n <= 1 ? 0.5 : k / (n - 1);
}

/** Inverse of knotFrac for pointer hit-testing: which knot a 0..1 x-fraction
 *  selects. Clamped to [0, n-1]. */
export function fracToKnot(frac: number, n: number, interp: PulseInterp): number {
  const k = interp === "zoh" ? Math.floor(frac * n) : Math.round(frac * (n - 1));
  return Math.min(n - 1, Math.max(0, k));
}

/** Total plotted duration: n held intervals under zoh, n-1 spans between
 *  knots under the spline modes. */
export function plotDuration(dt: number, knots: number, interp: PulseInterp): number {
  return dt * (interp === "zoh" ? knots : Math.max(1, knots - 1));
}
