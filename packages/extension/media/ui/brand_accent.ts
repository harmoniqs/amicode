// Brand accent solver — the Harmoniqs yellow, theme-calculated.
//
// #FFF676 is the canonical brand accent (brand.css). At ~96% lightness it
// sings on dark themes and vanishes on light ones, so each webview computes
// the DEPLOYED accent from the active theme at boot: hold the brand's OKLCH
// hue + chroma, and if contrast against the theme's editor background already
// meets target, ship the brand hex EXACTLY (dark themes — decision: brand-
// exact wherever physics allows); otherwise walk lightness down to the
// closest-to-brand value that passes (light themes get a deeper gold).
// --color-on-accent is picked black/white by contrast on the computed fill —
// yellow itself is never text (fills + borders only).
//
// Pure math up top (unit-tested in node); applyBrandAccent() is the DOM
// applier — sets --color-accent/--color-on-accent at :root and recomputes on
// theme switches (VS Code mutates body attributes when the theme changes).

const BRAND_HEX = "#FFF676";
const CONTRAST_TARGET = 3.0;   // WCAG non-text UI component minimum

type RGB = [number, number, number];   // 0..1

export function parseColor(s: string): RGB | undefined {
  const t = s.trim();
  const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (hex) {
    const h = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
  }
  const rgb = t.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgb) return [+rgb[1] / 255, +rgb[2] / 255, +rgb[3] / 255] as RGB;
  return undefined;
}

const toHex = (rgb: RGB): string =>
  "#" + rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase();

// -- OKLCH (Björn Ottosson's OKLab) -----------------------------------------

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function srgbToOklch([r, g, b]: RGB): { L: number; C: number; h: number } {
  const [lr, lg, lb] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI };
}

export function oklchToSrgb({ L, C, h }: { L: number; C: number; h: number }): RGB {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ] as RGB;
}

/** In-gamut conversion: reduce chroma until every channel lands in sRGB. */
function oklchToSrgbClamped(c: { L: number; C: number; h: number }): RGB {
  let C = c.C;
  for (let i = 0; i < 20; i++) {
    const rgb = oklchToSrgb({ ...c, C });
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return rgb;
    C *= 0.85;
  }
  return oklchToSrgb({ ...c, C: 0 });
}

// -- WCAG contrast -----------------------------------------------------------

export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// -- The solve ---------------------------------------------------------------

export interface BrandAccent {
  /** Lines: borders, focus rings, ☑ marks — solved to ≥3:1 vs the theme bg. */
  accent: string;
  /** Fills: button backgrounds — stays the brand lemon on EVERY theme (black
   *  text on #FFF676 is ~19:1); on light themes the component's boundary
   *  comes from a border in `accent`, never from darkening the fill (a
   *  3:1-darkened gold passes WCAG math but reads muddy under text). */
  accentFill: string;
  /** Text on accentFill, contrast-picked. */
  onAccent: string;
  /** True when the LINE accent shipped as the unmodified brand hex (dark themes). */
  brandExact: boolean;
}

export function solveBrandAccent(background: string): BrandAccent {
  const bg = parseColor(background) ?? parseColor("#1e1e1e")!;
  const brand = parseColor(BRAND_HEX)!;
  const onAccent =
    contrast([0, 0, 0], brand) >= contrast([1, 1, 1], brand) ? "#000000" : "#FFFFFF";

  if (contrast(brand, bg) >= CONTRAST_TARGET) {
    return { accent: BRAND_HEX, accentFill: BRAND_HEX, onAccent, brandExact: true };
  }
  // Light theme: hold brand hue+chroma, binary-search the HIGHEST lightness
  // that still meets target — the closest-to-brand gold that survives. This
  // is the LINE color only; the fill stays brand.
  const { C, h, L: brandL } = srgbToOklch(brand);
  let lo = 0.15, hi = brandL;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(oklchToSrgbClamped({ L: mid, C, h }), bg) >= CONTRAST_TARGET) lo = mid;
    else hi = mid;
  }
  const rgb = oklchToSrgbClamped({ L: lo, C, h });
  return { accent: toHex(rgb), accentFill: BRAND_HEX, onAccent, brandExact: false };
}

// -- DOM applier -------------------------------------------------------------

/** Compute the accent from the live theme and pin it at :root; re-solve when
 *  VS Code swaps themes (body attributes mutate). Call once per webview boot. */
export function applyBrandAccent(): void {
  const apply = (): void => {
    const bg = getComputedStyle(document.body).getPropertyValue("--vscode-editor-background");
    const { accent, accentFill, onAccent } = solveBrandAccent(bg);
    document.documentElement.style.setProperty("--color-accent", accent);
    document.documentElement.style.setProperty("--color-accent-fill", accentFill);
    document.documentElement.style.setProperty("--color-on-accent", onAccent);
  };
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true });
}
