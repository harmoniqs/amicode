// Icon atoms. The mark is the Harmoniqs H-robot (ported from the fork's
// logo.tsx Robot — its pixel face IS the old "<0||0>" ket, drawn for real).
// Gently animated: a slow breathe on the whole mark + an occasional eye blink,
// both suppressed under prefers-reduced-motion (same language as the fork's
// AmicoSpinner).

import { defineStyle } from "../style";

defineStyle("mark", `
  .mark { display: inline-flex; align-items: center; }
  .mark svg { width: 26px; height: 23px; display: block; color: var(--vscode-foreground); }
  @media (prefers-reduced-motion: no-preference) {
    .mark svg { animation: mark-breathe 3.2s ease-in-out infinite; }
    .mark .mark-face { animation: mark-blink 6s step-end infinite; }
  }
  @keyframes mark-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.78; } }
  @keyframes mark-blink { 0%, 92%, 100% { opacity: 1; } 94%, 97% { opacity: 0.15; } }
`);

const SVG_NS = "http://www.w3.org/2000/svg";

/** The fork's Robot geometry (logo.tsx) — body rides currentColor (theme-
 *  aware); the face keeps its brand colors (dark panel + Harmoniqs yellow). */
const FACE_PIXELS: [number, number, number, number][] = [
  [17, 21, 2, 2], [15, 23, 2, 2], [13, 25, 2, 2], [15, 27, 2, 2], [17, 29, 2, 2],
  [21, 21, 6, 2], [21, 23, 2, 6], [25, 23, 2, 6], [21, 29, 6, 2],
  [29, 21, 2, 10], [33, 21, 2, 10],
  [37, 21, 6, 2], [37, 23, 2, 6], [41, 23, 2, 6], [37, 29, 6, 2],
  [45, 21, 2, 2], [47, 23, 2, 2], [49, 25, 2, 2], [47, 27, 2, 2], [45, 29, 2, 2],
];

export function mark(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "mark";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 56");
  svg.setAttribute("aria-label", "Amicode");

  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute("fill", "currentColor");
  body.setAttribute("d", "M2 2h16v14h28V2h16v52H46V40H18v14H2Z");
  svg.append(body);

  const panel = document.createElementNS(SVG_NS, "rect");
  panel.setAttribute("x", "9"); panel.setAttribute("y", "19");
  panel.setAttribute("width", "46"); panel.setAttribute("height", "18");
  panel.setAttribute("fill", "#0A0A0A");
  svg.append(panel);

  const face = document.createElementNS(SVG_NS, "g");
  face.setAttribute("class", "mark-face");
  face.setAttribute("fill", "#FFF676");
  for (const [x, y, w, h] of FACE_PIXELS) {
    const r = document.createElementNS(SVG_NS, "rect");
    r.setAttribute("x", String(x)); r.setAttribute("y", String(y));
    r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
    face.append(r);
  }
  const mouth = document.createElementNS(SVG_NS, "polygon");
  mouth.setAttribute("points", "28,33 36,33 34,36 30,36");
  face.append(mouth);
  svg.append(face);

  el.append(svg);
  return el;
}
