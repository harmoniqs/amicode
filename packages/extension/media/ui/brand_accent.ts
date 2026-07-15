// Brand accent solver — the Harmoniqs yellow, theme-calculated.
//
// #FFF676 is the canonical brand accent (brand.css). At ~96% lightness it
// sings on dark themes (14.8:1 vs the editor bg) and vanishes on light ones
// (1.1:1 vs white). The rule that resolves this: yellow is a FILL, never an
// ink. So each webview computes the DEPLOYED accent from the active theme at
// boot and ships the brand lemon EXACTLY on every theme as a fill — what
// changes per-theme is the swatch's EDGE:
//   • dark  → the lemon separates itself; the edge is transparent.
//   • light → the lemon can't define its own edge, so a thin dark hairline
//             (the theme's own foreground) draws it. A dimmed-down yellow
//             can't do this job: it clears the page but not the lemon fill it
//             bounds (~2.7:1), so the edge reads mushy. The theme foreground
//             is guaranteed dark (it's readable body text on a light bg), so
//             it clears both the page and the fill by a wide margin.
// For the few thin lines that genuinely can't be fills (sparkline stroke), an
// `ink` role carries the lemon on dark and a neutral legible foreground on
// light. --color-on-accent is black — yellow is never text.
//
// Pure math up top (unit-tested in node); applyBrandAccent() is the DOM
// applier — sets the tokens at :root and recomputes on theme switches (VS Code
// mutates body attributes when the theme changes).

const BRAND_HEX = "#FFF676";
const DARK_FALLBACK_FG = "#1e1e1e"; // used when the theme foreground can't be read

type RGB = [number, number, number]; // 0..1

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
  "#" +
  rgb
    .map((c) =>
      Math.round(Math.min(1, Math.max(0, c)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase();

// -- WCAG contrast -----------------------------------------------------------

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// -- The solve ---------------------------------------------------------------

export interface BrandAccent {
  /** The swatch fill — true brand lemon on every theme. */
  fill: string;
  /** Text/icons on the fill — dark, contrast-picked (~19:1). Yellow is never ink. */
  onAccent: string;
  /** The swatch edge — a dark hairline on light themes (the fill can't define its
   *  own edge at 1.1:1 vs white); transparent on dark (the fill separates itself). */
  edge: string;
  /** Thin lines that genuinely can't be fills (sparkline stroke): the brand lemon
   *  on dark, a neutral legible foreground ink on light. */
  ink: string;
  /** True on light themes — the fill needs a drawn edge. */
  isLight: boolean;
}

/** Resolve the brand accent for a theme. `foreground` is the theme's own text
 *  color (--vscode-foreground); on light themes it becomes the swatch edge and
 *  the thin-line ink. */
export function solveBrandAccent(background: string, foreground?: string): BrandAccent {
  const bg = parseColor(background) ?? parseColor(DARK_FALLBACK_FG)!;
  const brand = parseColor(BRAND_HEX)!;
  const onAccent = contrast([0, 0, 0], brand) >= contrast([1, 1, 1], brand) ? "#000000" : "#FFFFFF";
  const isLight = relativeLuminance(bg) > 0.5;

  if (!isLight) {
    // Dark theme: the lemon sings on its own — no drawn edge, lemon ink.
    return { fill: BRAND_HEX, onAccent, edge: "transparent", ink: BRAND_HEX, isLight };
  }
  // Light theme: the edge/ink is the theme's own foreground — guaranteed dark,
  // so it clears both the page and the lemon fill it bounds.
  const fg = toHex(parseColor(foreground ?? "") ?? parseColor(DARK_FALLBACK_FG)!);
  return { fill: BRAND_HEX, onAccent, edge: fg, ink: fg, isLight };
}

// -- DOM applier -------------------------------------------------------------

/** Compute the accent from the live theme and pin it at :root; re-solve when
 *  VS Code swaps themes (body attributes mutate). Call once per webview boot. */
export function applyBrandAccent(): void {
  const apply = (): void => {
    const cs = getComputedStyle(document.body);
    const bg = cs.getPropertyValue("--vscode-editor-background");
    const fg = cs.getPropertyValue("--vscode-foreground");
    const { fill, onAccent, edge, ink } = solveBrandAccent(bg, fg);
    const root = document.documentElement.style;
    root.setProperty("--color-accent-fill", fill);
    root.setProperty("--color-on-accent", onAccent);
    root.setProperty("--color-accent-edge", edge);
    root.setProperty("--color-accent-ink", ink);
    root.setProperty("--color-accent", ink); // back-compat alias — strokes get legible ink
  };
  apply();
  new MutationObserver(apply).observe(document.body, { attributes: true });
}
