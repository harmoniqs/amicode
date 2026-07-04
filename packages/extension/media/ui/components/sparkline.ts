// Sparkline — a tiny log-y line of the objective trend on the hero. The ring
// buffer is a pure export (unit-tested in node); the SVG render needs a DOM.

import { defineStyle } from "../style";

defineStyle("sparkline", `
  .sparkline { display: block; margin-top: var(--space-xs); }
`);

const SVGNS = "http://www.w3.org/2000/svg";

/** Bounded ring buffer, newest last. Pure — no DOM. */
export function makeSparkBuffer(capacity: number) {
  const buf: number[] = [];
  return {
    push(v: number) { buf.push(v); if (buf.length > capacity) buf.shift(); },
    values(): number[] { return buf.slice(); },
    reset() { buf.length = 0; },
  };
}

export interface Sparkline {
  el: SVGSVGElement;
  update(v: number): void;
  reset(): void;
}

export function sparkline(capacity = 60): Sparkline {
  const buf = makeSparkBuffer(capacity);
  const W = 120, H = 26, PAD = 2;
  const svg = document.createElementNS(SVGNS, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.classList.add("sparkline");
  const poly = document.createElementNS(SVGNS, "polyline");
  poly.setAttribute("fill", "none");
  poly.setAttribute("stroke", "var(--color-accent)");
  poly.setAttribute("stroke-width", "1.5");
  svg.append(poly);

  const render = () => {
    // Only positive, finite objectives on a log axis; largest at top so a
    // converging (descending) objective reads as a descending line.
    const vs = buf.values().filter((v) => v > 0 && Number.isFinite(v));
    if (vs.length < 2) { poly.setAttribute("points", ""); return; }
    const logs = vs.map((v) => Math.log10(v));
    const lo = Math.min(...logs), hi = Math.max(...logs), span = hi - lo || 1;
    const pts = logs.map((l, i) => {
      const x = PAD + (i / (logs.length - 1)) * (W - 2 * PAD);
      const y = PAD + (1 - (l - lo) / span) * (H - 2 * PAD);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    poly.setAttribute("points", pts.join(" "));
  };

  return {
    el: svg,
    update(v: number) { buf.push(v); render(); },
    reset() { buf.reset(); render(); },
  };
}
