// Icon atoms. The mark is the Harmoniqs H-robot SILHOUETTE — same glyph +
// animation language as the fork's AmicoSpinner (spinner.tsx): the screen slit
// is knocked out via fill-rule evenodd, NO face pixels (illegible at small
// sizes — the full-face Mark is for large canvases only), currentColor so it
// rides the theme, gentle pulse-opacity, static under prefers-reduced-motion.

import { defineStyle } from "../style";

defineStyle(
  "mark",
  `
  .mark { display: inline-flex; align-items: center; }
  .mark svg { width: 20px; height: 17.5px; display: block; color: var(--vscode-foreground); }
  @media (prefers-reduced-motion: no-preference) {
    .mark svg { animation: mark-pulse 1.2s ease-in-out infinite both; }
  }
  @keyframes mark-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
`,
);

const SVG_NS = "http://www.w3.org/2000/svg";

export function mark(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "mark";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 56");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-label", "Amicode");
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("fill-rule", "evenodd");
  body.setAttribute("d", "M2 2h16v14h28V2h16v52H46V40H18v14H2Z M9 19h46v18H9Z");
  svg.append(body);
  el.append(svg);
  return el;
}
