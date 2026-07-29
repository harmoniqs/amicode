import { describe, it, expect } from "vitest";
import {
  stairsPath,
  polylinePath,
  cubicPath,
  pulsePath,
  knotFrac,
  fracToKnot,
  plotDuration,
} from "../media/ui/components/pulsepath";

// Identity y-scale keeps expected coordinates readable; w=100 keeps x round.
const y = (v: number) => v;

describe("pulsepath — type-aware render geometry (#66 interp=)", () => {
  it("zoh: stairs hold each value over its knot interval", () => {
    expect(stairsPath([1, 2], y, 100)).toBe("M0,1H50V2H100");
    expect(stairsPath([], y, 100)).toBe("");
  });

  it("linear: polyline through the knots, endpoints at the plot edges", () => {
    expect(polylinePath([0, 1, 2], y, 100)).toBe("M0,0L50,1L100,2");
    expect(polylinePath([], y, 100)).toBe("");
  });

  it("linear: a single knot renders as a hold (no zero-length polyline)", () => {
    expect(polylinePath([0.5], y, 100)).toBe("M0,0.5H100");
  });

  it("cubic: passes exactly through every knot (Bézier segment endpoints)", () => {
    const d = cubicPath([0, 1, 0], y, 100);
    expect(d.startsWith("M0,0")).toBe(true);
    expect(d).toContain("50,1"); // middle knot
    expect(d.endsWith("100,0")).toBe(true); // last knot
    expect(d.match(/C/g)).toHaveLength(2); // one curve segment per knot span
  });

  it("cubic: fewer than 3 knots degrades to the polyline (a 2-knot curve IS its chord)", () => {
    expect(cubicPath([0, 1], y, 100)).toBe(polylinePath([0, 1], y, 100));
  });

  it("pulsePath dispatches on interp and defaults unknown-shaped input to stairs", () => {
    expect(pulsePath([1, 2], y, 100, "zoh")).toBe(stairsPath([1, 2], y, 100));
    expect(pulsePath([1, 2], y, 100, "linear")).toBe(polylinePath([1, 2], y, 100));
    expect(pulsePath([0, 1, 0], y, 100, "cubic")).toBe(cubicPath([0, 1, 0], y, 100));
  });

  it("crosshair mapping: interval midpoints under zoh, the knots themselves under splines", () => {
    expect(knotFrac(0, 4, "zoh")).toBeCloseTo(0.125);
    expect(knotFrac(0, 4, "linear")).toBe(0);
    expect(knotFrac(3, 4, "linear")).toBe(1);
    expect(knotFrac(0, 1, "cubic")).toBe(0.5); // single knot centers
  });

  it("hit-testing inverts the mapping and clamps at the edges", () => {
    expect(fracToKnot(0.6, 4, "zoh")).toBe(2); // floor(2.4)
    expect(fracToKnot(0.6, 4, "linear")).toBe(2); // round(1.8)
    expect(fracToKnot(1, 4, "zoh")).toBe(3); // clamp past the last interval
    expect(fracToKnot(0, 4, "linear")).toBe(0);
  });

  it("duration: n held intervals under zoh, n-1 knot spans under splines", () => {
    expect(plotDuration(0.2, 50, "zoh")).toBeCloseTo(10);
    expect(plotDuration(0.2, 50, "linear")).toBeCloseTo(9.8);
    expect(plotDuration(0.2, 1, "cubic")).toBeCloseTo(0.2); // degenerate single knot
  });
});
