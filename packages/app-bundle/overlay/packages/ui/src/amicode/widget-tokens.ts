// AMICODE (widget kernel): the --amc-* token seam. Host CSS vars (--v2-*)
// cannot cross an iframe boundary, so the host resolves its computed values
// into a stable token map that widgets style against — widget code never
// touches fork-internal theme names. Density replaces COMPACT_CSS: widgets
// restyle themselves from the signal instead of the host reaching into tile
// internals. Pure, unit-tested.

export type Density = "normal" | "compact" | "tight"

/** COMPACT_CSS thresholds (home-cards): ≤880 compact, ≤760 tight. */
export function densityFor(webviewHeightPx: number): Density {
  if (webviewHeightPx <= 760) return "tight"
  if (webviewHeightPx <= 880) return "compact"
  return "normal"
}

const DENSITY_RANK: Record<Density, number> = { normal: 0, compact: 1, tight: 2 }

/** Panel-first (spec T3.4): width is the scarce axis when Amicode lives as
 *  half an editor. Effective density = max(height tier, width tier);
 *  width ≤820 → compact, ≤600 → tight. */
export function densityForViewport(widthPx: number, heightPx: number): Density {
  const byWidth: Density = widthPx <= 600 ? "tight" : widthPx <= 820 ? "compact" : "normal"
  const byHeight = densityFor(heightPx)
  return DENSITY_RANK[byWidth] >= DENSITY_RANK[byHeight] ? byWidth : byHeight
}

// Last-resort stacks only. The real faces come through SOURCES below, from the
// host's --font-family-* tokens, so widgets render in the brand faces (DM Sans /
// JuliaMono) rather than the system default.
const SANS = "'DM Sans', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
const MONO = "JuliaMono, ui-monospace, SFMono-Regular, Menlo, monospace"

/** --v2-* source per token, with a dark-theme literal fallback for vars that
 *  resolve empty (run-card palette). */
const SOURCES: [amc: string, v2: string, fallback: string][] = [
  ["--amc-bg", "--v2-background-bg-base", "#0B0E15"],
  ["--amc-layer", "--v2-background-bg-layer-01", "#111624"],
  ["--amc-layer2", "--v2-background-bg-layer-02", "#1A2133"],
  ["--amc-border", "--v2-border-border-base", "#2A3245"],
  ["--amc-text", "--v2-text-text-base", "#E9ECF4"],
  ["--amc-text-muted", "--v2-text-text-muted", "#8B94A9"],
  ["--amc-text-faint", "--v2-text-text-faint", "#6A7286"],
  // Accent FOREGROUND (links, chevrons, borders, glyphs): neutral on light /
  // yellow on dark, tracking the host's icon-accent. Yellow is illegible as a
  // foreground on white, so this is neutral there — see the design-system skill.
  ["--amc-accent", "--v2-icon-icon-accent", "#FFE614"],
  // Accent solid FILL (CTA / chip background): the brand hue #FFE614 in BOTH
  // schemes, sourced from design-polish's --accent. Pair only with --amc-accent-ink.
  ["--amc-accent-fill", "--accent", "#FFE614"],
  // Ink ON a yellow fill: always near-black, never --amc-bg (which is white on light).
  ["--amc-accent-ink", "--accent-ink", "#000000"],
  // Widgets render in an iframe, so the ink-edge rule ("every yellow fill takes a
  // 1px ink border") could not be expressed inside them at all — the CTA improvised
  // a 14%-ink edge that composited to 1.46:1 on the light card ground.
  ["--amc-accent-edge", "--accent-edge-ink", "#000000"],
  ["--amc-success", "--v2-state-fg-success", "#5BC873"],
  ["--amc-warning", "--v2-state-fg-warning", "#E5B454"],
  ["--amc-danger", "--v2-state-fg-danger", "#E56A6A"],
  // Geometry crosses the seam too — widgets are vanilla DOM and cannot read
  // --radius-* directly, so a literal here would pin the dashboard to the old
  // corner radius no matter what the brand sheet says.
  ["--amc-radius", "--radius-lg", "4px"],
  ["--amc-radius-sm", "--radius-md", "4px"],
  // Faces, likewise — otherwise the dashboard renders in the system sans.
  ["--amc-font-sans", "--font-family-text", SANS],
  ["--amc-font-mono", "--font-family-mono", MONO],
]

const PADDING: Record<Density, { pad: string; padTile: string }> = {
  normal: { pad: "14px 16px", padTile: "10px 12px" },
  compact: { pad: "10px 14px", padTile: "10px 12px" },
  tight: { pad: "8px 12px", padTile: "8px 10px" },
}

/** Resolve the full token map. getVar = (v2Name) => computed value ("" when
 *  unset); the caller wires it to getComputedStyle(appRoot).getPropertyValue. */
export function resolveTokens(getVar: (name: string) => string, density: Density): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [amc, v2, fallback] of SOURCES) {
    const v = getVar(v2).trim()
    out[amc] = v !== "" ? v : fallback
  }
  out["--amc-pad"] = PADDING[density].pad
  out["--amc-pad-tile"] = PADDING[density].padTile
  return out
}
