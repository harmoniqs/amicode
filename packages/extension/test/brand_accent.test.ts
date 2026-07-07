import { describe, it, expect } from "vitest";
import { parseColor, srgbToOklch, oklchToSrgb, contrast, solveBrandAccent } from "../media/ui/brand_accent";

// Theme-calculated Harmoniqs yellow: brand-exact wherever the theme allows
// (dark), contrast-solved to the closest-to-brand gold where it doesn't
// (light). Yellow is never text: on-accent is picked by contrast on the fill.

describe("solveBrandAccent — the theme-calculated Harmoniqs yellow", () => {
  it("dark themes ship the canonical hex EXACTLY", () => {
    for (const bg of ["#1e1e1e", "#000000", "rgb(30, 30, 30)"]) {
      const r = solveBrandAccent(bg);
      expect(r.accent).toBe("#FFF676");
      expect(r.brandExact).toBe(true);
    }
  });

  it("light themes get a contrast-solved gold LINE: ≥3:1, brand hue held, lightness reduced", () => {
    const r = solveBrandAccent("#ffffff");
    expect(r.brandExact).toBe(false);
    const solved = parseColor(r.accent)!;
    expect(contrast(solved, parseColor("#ffffff")!)).toBeGreaterThanOrEqual(2.98); // binary-search tolerance
    const brand = srgbToOklch(parseColor("#FFF676")!);
    const got = srgbToOklch(solved);
    expect(Math.abs(got.h - brand.h)).toBeLessThan(8); // hue is the brand carrier
    expect(got.L).toBeLessThan(brand.L);
  });

  it("the FILL stays brand lemon on every theme — text readability beats fill-vs-bg contrast", () => {
    for (const bg of ["#1e1e1e", "#ffffff", "#f3f3f3"]) {
      const r = solveBrandAccent(bg);
      expect(r.accentFill).toBe("#FFF676");
      // black text on the lemon fill is always high-contrast (~19:1)
      expect(contrast(parseColor(r.onAccent)!, parseColor(r.accentFill)!)).toBeGreaterThan(4.5);
    }
  });

  it("on-accent text is picked by contrast on the fill (black on the lemon)", () => {
    expect(solveBrandAccent("#1e1e1e").onAccent).toBe("#000000");
    expect(solveBrandAccent("#ffffff").onAccent).toBe("#000000");
  });

  it("mid-gray themes that already clear 3:1 stay brand-exact", () => {
    expect(solveBrandAccent("#808080").brandExact).toBe(true);
  });

  it("parses the color formats getComputedStyle actually returns", () => {
    expect(parseColor("#FFF676")).toBeDefined();
    expect(parseColor("rgb(255, 246, 118)")).toBeDefined();
    expect(parseColor("rgba(255, 246, 118, 1)")).toBeDefined();
    expect(parseColor("")).toBeUndefined();
    // garbage input falls back inside solveBrandAccent rather than throwing
    expect(() => solveBrandAccent("not-a-color")).not.toThrow();
  });

  it("OKLCH round-trips the brand hex within a hair", () => {
    const rgb = parseColor("#FFF676")!;
    const back = oklchToSrgb(srgbToOklch(rgb));
    back.forEach((c, i) => expect(Math.abs(c - rgb[i])).toBeLessThan(0.005));
  });
});
