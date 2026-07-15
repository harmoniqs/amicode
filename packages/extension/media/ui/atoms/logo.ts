// Logo atom — the Amico mark, fed by the two canonical SVG files.
//
//   variant "full" (default) → media/amico.svg          (detailed mark)
//   variant "reduced"        → media/amico_reduced.svg  (outer bracket only,
//                                                         legible at small sizes)
//
// Both files are imported as raw text (esbuild loader {".svg":"text"}, see
// esbuild.config.mjs + the vitest transform) and carry fill="currentColor" on
// their <svg> root — so the mark's color is driven by the host element's CSS
// `color`, which defaults to `var(--vscode-foreground)` and therefore tracks
// the active VS Code theme. Pass `fill` to override (any CSS color, e.g. a
// brand token or another --vscode-* variable).
//
// The .svg files are the single source of truth for the geometry — no path
// data is duplicated as a TS literal (which is exactly what silently drifted
// before: a hardcoded copy here went stale when amico.svg was redesigned).

import { defineStyle } from "../style";
import fullSvg from "../../amico.svg";
import reducedSvg from "../../amico_reduced.svg";

defineStyle(
  "logo",
  `
  .logo { display: inline-flex; align-items: center; color: var(--vscode-foreground); }
  .logo svg { width: 18px; height: 18px; display: block; }
`,
);

export type LogoVariant = "full" | "reduced";

export interface LogoOptions {
  /** Which mark to render. Defaults to "full" (amico.svg). */
  variant?: LogoVariant;
  /**
   * CSS color for the mark. Omit to inherit `var(--vscode-foreground)` (tracks
   * the VS Code theme); pass any CSS color to override.
   */
  fill?: string;
}

// Strip a leading <?xml …?> declaration — amico.svg (exported from a design
// tool) carries one; injecting it into innerHTML leaves a stray bogus-comment
// node. amico_reduced.svg has none, so this is a no-op there.
const clean = (svg: string) => svg.replace(/^\s*<\?xml[^>]*\?>\s*/, "");

const SVG: Record<LogoVariant, string> = { full: clean(fullSvg), reduced: clean(reducedSvg) };

export function logo(opts: LogoOptions = {}): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "logo";
  el.innerHTML = SVG[opts.variant ?? "full"]; // static, bundle-time-embedded markup — no user data
  if (opts.fill) el.style.color = opts.fill; // else CSS default: var(--vscode-foreground)
  return el;
}
