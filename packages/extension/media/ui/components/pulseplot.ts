// Pulseplot component (#66) — client-side render of the live pulse from raw
// data. ADAPTS to any run shape (any drive count):
//
//   drives <= 6  →  OVERLAY. Every drive shares ONE graph (one time axis, one
//                   amplitude axis); identity rides the fixed-order categorical
//                   series color (brand.css has 6) + a legend. Reads the controls'
//                   relative shape at a glance and spends the vertical budget once.
//   drives >  6  →  SMALL MULTIPLES. One strip per drive, shared time axis. Past
//                   the 6-color limit, color can no longer carry identity alone,
//                   so we facet (the dataviz-sanctioned fallback) — position +
//                   per-strip label disambiguate, and color may repeat harmlessly.
//
// Step (stairs) rendering — faithful to the zero-order hold. Bounds are the
// constraint envelope: a filled band (when a plot's drives share one) + dashed
// limit lines (dashing is reserved for thresholds; the grid/zero rule stays
// solid). Text stays in text tokens; a colored chip carries identity.
//
// Hand-rolled SVG (series are tens of points; >512 knots per drive decimated by
// stride). preserveAspectRatio=none stretches the plot to the box, so NO <text>
// lives in the SVG — axis/scale labels are HTML siblings (they must not distort).

import { defineStyle } from "../style";
import { text } from "../atoms/text";

defineStyle(
  "pulseplot",
  `
  .pulseplot { display: flex; flex-direction: column; gap: var(--space-sm);
               flex: 1 1 240px; min-width: 0; min-height: 200px;
               background: var(--bg-plot);
               border: var(--border-width) solid var(--border-color);
               border-radius: var(--border-radius); padding: var(--space-sm); }
  /* Overlay legend — categorical identity for the overlaid drives. */
  .pulseplot .pp-legend { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); }
  .pulseplot .pp-key { display: flex; align-items: center; gap: var(--space-xs); }
  .pulseplot .pp-chip { width: var(--square-dot); height: var(--square-dot);
                        border-radius: 2px; flex: none; }
  /* Overlay plot region — relative so the amplitude labels can flank the SVG. */
  .pulseplot .pp-plot { position: relative; flex: 1; min-height: 0; }
  .pulseplot .pp-plot > svg { width: 100%; height: 100%; min-height: 0; display: block; }
  .pulseplot .pp-ylab { position: absolute; left: 0; padding: 0 var(--space-xs); pointer-events: none; }
  .pulseplot .pp-ylab.hi { top: 0; }
  .pulseplot .pp-ylab.lo { bottom: 0; }
  /* Small-multiples column — even strips that stay >= 34px tall, scrolling only
     when a very-many-drive run can't fit the box. */
  .pulseplot .pp-multi { flex: 1; min-height: 0; overflow-y: auto;
                         display: flex; flex-direction: column; gap: var(--space-xs); }
  .pulseplot .pp-panel { flex: 1 1 0; min-height: 34px; display: flex; flex-direction: column; }
  .pulseplot .pp-head { display: flex; align-items: center; gap: var(--space-sm); }
  .pulseplot .pp-panel svg { flex: 1; width: 100%; min-height: 0; display: block; }
  .pulseplot .pp-step { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .pulseplot .pp-limit { stroke: var(--color-dim); stroke-width: 1; stroke-dasharray: 4 3;
                         vector-effect: non-scaling-stroke; }
  .pulseplot .pp-zero { stroke: var(--plot-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .pulseplot .pp-band { fill: var(--plot-band); }
  .pulseplot .pp-axis { display: flex; justify-content: space-between; align-items: baseline; }
  .pulseplot.pp-empty .pp-legend, .pulseplot.pp-empty .pp-plot,
  .pulseplot.pp-empty .pp-multi, .pulseplot.pp-empty .pp-axis { display: none; }
  .pulseplot .pp-hint { place-self: center; margin: auto; opacity: 0.55; font-style: italic; }
  .pulseplot:not(.pp-empty) .pp-hint { display: none; }
`,
);

const MAX_KNOTS = 512; // above this, stride-decimate before rendering
const SERIES_COLORS = 6; // brand.css categorical tokens → overlay ceiling
const W = 1000; // viewBox coordinate space (preserveAspectRatio=none)
const H = 100;
const PAD = 0.08; // y-domain padding around the bounds envelope

export interface PulsePlotMeta {
  drives: number;
  knots: number;
  labels: string[];
  bounds: [number, number][];
}
export interface PulsePlotRecord {
  iter: number;
  dt: number;
  values: number[][];
}

/** One rendered drive: its step path + the y-scale it draws against (shared in
 *  overlay, per-strip in small multiples). update() is mode-agnostic over these. */
interface Series {
  step: SVGPathElement;
  y: (v: number) => number;
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS("http://www.w3.org/2000/svg", tag);

const seriesVar = (i: number): string => `var(--series-${(i % SERIES_COLORS) + 1})`;

export interface PulsePlot {
  el: HTMLDivElement;
  meta(m: PulsePlotMeta): void;
  update(r: PulsePlotRecord): void;
  clear(): void;
  /** Empty-state with a hint — idle / warming / no-pulse-data messaging. */
  waiting(hint: string): void;
}

export function pulseplot(idleHint = "No pulse data yet."): PulsePlot {
  const el = document.createElement("div");
  el.className = "pulseplot pp-empty";
  const hint = text("pp-hint", idleHint);

  // Shared time axis (bottom) — reused by both layouts.
  const axis = document.createElement("div");
  axis.className = "pp-axis";
  const t0Label = text("label-k", "0");
  const xLabel = text("label-k", "Time");
  const tEndLabel = text("label-k", "");
  axis.append(t0Label.el, xLabel.el, tEndLabel.el);

  // Layout containers are (re)built per meta; a `body` holder is swapped between
  // the overlay plot and the small-multiples column so clearing is one remove.
  let body: HTMLElement | undefined;
  let series: Series[] = [];
  let currentMeta: PulsePlotMeta | undefined;

  el.append(hint.el, axis);

  function reset(): void {
    if (body) body.remove();
    body = undefined;
    series = [];
  }

  function meta(m: PulsePlotMeta): void {
    currentMeta = m;
    reset();
    if (m.labels.length === 0) return; // nothing to plot; hint stays

    body = m.drives <= SERIES_COLORS ? buildOverlay(m) : buildMultiples(m);
    el.insertBefore(body, axis); // keep the shared time axis last
  }

  /** OVERLAY: one shared amplitude axis for every drive. */
  function buildOverlay(m: PulsePlotMeta): HTMLElement {
    const holder = document.createElement("div");

    const legend = document.createElement("div");
    legend.className = "pp-legend";

    const plot = document.createElement("div");
    plot.className = "pp-plot";
    const svg = mkSvg();

    // Domain = union of all bounds, padded → the one scale every drive uses.
    const lo = Math.min(...m.bounds.map((b) => b[0]));
    const hi = Math.max(...m.bounds.map((b) => b[1]));
    const y = yScale(lo, hi);

    // A single band only when every drive shares one envelope; else dashed
    // limits alone carry the (differing) constraints.
    const same = m.bounds.every((b) => b[0] === m.bounds[0][0] && b[1] === m.bounds[0][1]);
    if (same) svg.append(band(y(hi), y(lo) - y(hi)));
    if (lo < 0 && hi > 0) svg.append(hLine("pp-zero", y(0)));
    for (const v of distinctEdges(m.bounds)) svg.append(hLine("pp-limit", y(v)));

    series = m.labels.map((label, i) => {
      legend.append(legendKey(label, i));
      const step = mkStep(i);
      svg.append(step);
      return { step, y };
    });

    const yHi = text("label-k pp-ylab hi", formatAmp(hi));
    const yLo = text("label-k pp-ylab lo", formatAmp(lo));
    plot.append(svg, yHi.el, yLo.el);
    holder.append(legend, plot);
    return holder;
  }

  /** SMALL MULTIPLES: one strip per drive, each on its own bounds. */
  function buildMultiples(m: PulsePlotMeta): HTMLElement {
    const col = document.createElement("div");
    col.className = "pp-multi";
    series = m.labels.map((label, i) => {
      const [lo, hi] = m.bounds[i];
      const y = yScale(lo, hi);
      const panel = document.createElement("div");
      panel.className = "pp-panel";
      const head = document.createElement("div");
      head.className = "pp-head";
      head.append(chip(i), text("label-k", label).el);
      const svg = mkSvg();
      svg.append(band(y(hi), y(lo) - y(hi)));
      if (lo < 0 && hi > 0) svg.append(hLine("pp-zero", y(0)));
      svg.append(hLine("pp-limit", y(hi)), hLine("pp-limit", y(lo)));
      const step = mkStep(i);
      svg.append(step);
      panel.append(head, svg);
      col.append(panel);
      return { step, y };
    });
    return col;
  }

  // -- small DOM/SVG builders shared by both layouts --
  const mkSvg = (): SVGSVGElement => {
    const svg = svgEl("svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    return svg;
  };
  const mkStep = (i: number): SVGPathElement => {
    const step = svgEl("path");
    step.setAttribute("class", "pp-step");
    step.setAttribute("stroke", seriesVar(i));
    return step;
  };
  const chip = (i: number): HTMLSpanElement => {
    const c = document.createElement("span");
    c.className = "pp-chip";
    c.style.background = seriesVar(i);
    return c;
  };
  const legendKey = (label: string, i: number): HTMLDivElement => {
    const key = document.createElement("div");
    key.className = "pp-key";
    key.append(chip(i), text("label-k", label).el);
    return key;
  };
  const band = (y: number, h: number): SVGRectElement => {
    const r = svgEl("rect");
    r.setAttribute("class", "pp-band");
    r.setAttribute("x", "0");
    r.setAttribute("width", String(W));
    r.setAttribute("y", String(y));
    r.setAttribute("height", String(Math.max(0, h)));
    return r;
  };

  function update(r: PulsePlotRecord): void {
    if (!currentMeta || r.values.length !== series.length || series.length === 0) return;
    el.classList.remove("pp-empty");
    tEndLabel.set(formatT(r.dt * currentMeta.knots));
    r.values.forEach((drive, i) => {
      series[i].step.setAttribute("d", stairsPath(decimate(drive), series[i].y));
    });
  }

  function clear(): void {
    el.classList.add("pp-empty");
    for (const s of series) s.step.removeAttribute("d");
    tEndLabel.set("");
  }

  function waiting(hintText: string): void {
    hint.set(hintText);
    clear();
  }

  return { el, meta, update, clear, waiting };
}

/** A horizontal full-width rule at viewBox-y `y`. */
function hLine(cls: string, y: number): SVGLineElement {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("class", cls);
  line.setAttribute("x1", "0");
  line.setAttribute("x2", String(W));
  line.setAttribute("y1", String(y));
  line.setAttribute("y2", String(y));
  return line;
}

/** Distinct bound edges (lo/hi across all drives), ascending → dashed limits. */
function distinctEdges(bounds: [number, number][]): number[] {
  return Array.from(new Set(bounds.flat())).sort((a, b) => a - b);
}

/** y-scale: domain → viewBox with PAD headroom; non-finite clamps to edge. */
function yScale(lo: number, hi: number): (v: number) => number {
  const pad = PAD * (hi - lo || 1);
  const min = lo - pad,
    max = hi + pad;
  return (v) => {
    const t = Number.isFinite(v) ? (v - min) / (max - min) : v > 0 ? 1 : 0;
    return H - Math.min(1, Math.max(0, t)) * H;
  };
}

/** Zero-order-hold stairs: each value held for its knot interval, spanning the
 *  full width (drives share the time axis, so x is normalized by knot count). */
function stairsPath(values: number[], y: (v: number) => number): string {
  if (values.length === 0) return "";
  const x = (k: number) => (k / values.length) * W;
  let d = `M0,${round(y(values[0]))}`;
  for (let k = 0; k < values.length; k++) {
    d += `H${round(x(k + 1))}`;
    if (k + 1 < values.length) d += `V${round(y(values[k + 1]))}`;
  }
  return d;
}

function decimate(values: number[]): number[] {
  if (values.length <= MAX_KNOTS) return values;
  const stride = Math.ceil(values.length / MAX_KNOTS);
  const out: number[] = [];
  for (let k = 0; k < values.length; k += stride) out.push(values[k]);
  return out;
}

const round = (v: number): number => Math.round(v * 100) / 100;

function formatT(t: number): string {
  return t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t.toFixed(2);
}

/** Compact amplitude label for the y-scale ends (trims trailing zeros). */
function formatAmp(v: number): string {
  if (!Number.isFinite(v)) return "";
  return String(Number(v.toPrecision(3)));
}
