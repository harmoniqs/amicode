import { describe, it, expect } from "vitest";
import { parseColor, relativeLuminance, contrast, solveBrandAccent } from "../media/ui/brand_accent";

// Theme-calculated Harmoniqs yellow. The rule: yellow is a FILL, never an ink.
// The lemon fill ships brand-exact on every theme; what changes per-theme is
// the EDGE — transparent on dark (the lemon separates itself), a dark hairline
// (the theme foreground) on light (the lemon can't define its own edge). A
// thin-line `ink` role carries lemon on dark / neutral foreground on light.

const BRAND = "#FFF676";
const C = (a: string, b: string) => contrast(parseColor(a)!, parseColor(b)!);

describe("solveBrandAccent — the theme-calculated Harmoniqs yellow", () => {
  it("the FILL is the brand lemon on every theme, with dark on-accent text (~19:1)", () => {
    for (const bg of ["#1e1e1e", "#000000", "#ffffff", "#f3f3f3", "rgb(30, 30, 30)"]) {
      const r = solveBrandAccent(bg);
      expect(r.fill).toBe(BRAND);
      expect(r.onAccent).toBe("#000000");
      expect(C(r.onAccent, r.fill)).toBeGreaterThan(4.5); // black on lemon ≈ 18.7:1
    }
  });

  it("dark themes draw NO edge — the lemon fill separates itself; ink stays lemon", () => {
    for (const bg of ["#1e1e1e", "#000000", "rgb(30, 30, 30)"]) {
      const r = solveBrandAccent(bg, "#cccccc");
      expect(r.isLight).toBe(false);
      expect(r.edge).toBe("transparent");
      expect(r.ink).toBe(BRAND);
      // sanity: the lemon really does clear the non-text UI target on dark
      expect(C(r.fill, bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("light themes draw a dark hairline that clears BOTH the page and the lemon fill", () => {
    // the mushy-edge failure this fixes: the old dimmed gold #A09829 cleared
    // white (2.99:1) but NOT the lemon fill it bounded (2.66:1).
    for (const [bg, fg] of [
      ["#ffffff", "#3b3b3b"],
      ["#f3f3f3", "#616161"],
      ["#faf9f4", "#1f1f1f"],
    ]) {
      const r = solveBrandAccent(bg, fg);
      expect(r.isLight).toBe(true);
      expect(r.edge).not.toBe("transparent");
      expect(C(r.edge, bg)).toBeGreaterThanOrEqual(3); // vs the page behind it
      expect(C(r.edge, r.fill)).toBeGreaterThanOrEqual(3); // vs the fill it bounds
    }
  });

  it("light themes carry a neutral, legible thin-line ink — the muddy gold is retired", () => {
    const r = solveBrandAccent("#ffffff", "#3b3b3b");
    expect(r.ink).toBe(r.edge); // both are the theme foreground
    expect(r.ink).not.toBe(BRAND); // never the invisible lemon on a light bg
    expect(C(r.ink, "#ffffff")).toBeGreaterThanOrEqual(3);
  });

  it("light/dark is decided by background luminance (threshold 0.5)", () => {
    expect(relativeLuminance(parseColor("#ffffff")!)).toBeGreaterThan(0.5);
    expect(relativeLuminance(parseColor("#1e1e1e")!)).toBeLessThan(0.5);
    expect(solveBrandAccent("#ffffff").isLight).toBe(true);
    expect(solveBrandAccent("#1e1e1e").isLight).toBe(false);
  });

  it("falls back to a dark hairline when the theme foreground can't be read", () => {
    const r = solveBrandAccent("#ffffff"); // no foreground passed
    expect(r.isLight).toBe(true);
    expect(C(r.edge, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(C(r.edge, r.fill)).toBeGreaterThanOrEqual(3);
  });

  it("parses the color formats getComputedStyle actually returns", () => {
    expect(parseColor("#FFF676")).toBeDefined();
    expect(parseColor("rgb(255, 246, 118)")).toBeDefined();
    expect(parseColor("rgba(255, 246, 118, 1)")).toBeDefined();
    expect(parseColor("")).toBeUndefined();
    // garbage input falls back inside solveBrandAccent rather than throwing
    expect(() => solveBrandAccent("not-a-color")).not.toThrow();
    expect(() => solveBrandAccent("#ffffff", "not-a-color")).not.toThrow();
  });
});
