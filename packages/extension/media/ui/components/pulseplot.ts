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
// Type-aware rendering (meta interp=): stairs faithful to the zero-order hold,
// a polyline through linear-spline knots, a smooth curve through cubic knots
// (path math in pulsepath.ts). Bounds are the constraint envelope: a filled
// band (when a plot's drives share one) + dashed limit lines (dashing is
// reserved for thresholds; the grid/zero rule stays solid). Text stays in text
// tokens; a colored chip carries identity.
//
// Hand-rolled SVG (series are tens of points; >512 knots per drive decimated by
// stride). preserveAspectRatio=none stretches the plot to the box, so NO <text>
// lives in the SVG — axis/scale labels are HTML siblings (they must not distort).
//
// OVERLAY interaction: a crosshair snaps to the nearest knot and a readout
// lists every drive's value there (hover or arrow keys — same detail on both);
// legend keys emphasize a drive on hover/focus and toggle it dim on click.
// Toggling never removes: the scale, legend, and color assignments hold still.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { pulsePath, knotFrac, fracToKnot, plotDuration } from "./pulsepath";
import type { PulseInterp } from "../../../src/run_dir_reader";

defineStyle(
  "pulseplot",
  `
  .pulseplot { display: flex; flex-direction: column; gap: var(--space-sm);
               flex: 1 1 240px; min-width: 0; min-height: 200px;
               background: var(--bg-plot);
               border: var(--border-width) solid var(--border-color);
               border-radius: var(--border-radius); padding: var(--space-sm); }
  /* Overlay legend — categorical identity for the overlaid drives. Keys are
     BUTTONS: hover/focus emphasizes that drive, click toggles it dim. */
  .pulseplot .pp-legend { display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); }
  .pulseplot .pp-key { display: flex; align-items: center; gap: var(--space-xs); }
  .pulseplot button.pp-key { background: none; border: none; padding: 2px var(--space-xs);
                             font: inherit; color: inherit; cursor: pointer;
                             border-radius: var(--border-radius); }
  .pulseplot button.pp-key:hover {
    background: color-mix(in srgb, var(--vscode-foreground, #ccc) 8%, transparent); }
  .pulseplot .pp-key[aria-pressed="false"] { opacity: 0.45; }
  .pulseplot .pp-key[aria-pressed="false"] .label-k { text-decoration: line-through; }
  .pulseplot .pp-chip { width: var(--square-dot); height: var(--square-dot);
                        border-radius: 2px; flex: none; }
  /* Overlay holder — a real flex item, so the plot region fills the panel's
     height instead of collapsing to the SVG's intrinsic size (pp-multi already
     did this; the overlay's anonymous holder didn't). */
  .pulseplot .pp-overlay { flex: 1; min-height: 0; display: flex; flex-direction: column;
                           gap: var(--space-sm); }
  /* Overlay plot region — relative so the amplitude labels can flank the SVG. */
  .pulseplot .pp-plot { position: relative; flex: 1; min-height: 0; }
  .pulseplot .pp-plot > svg { width: 100%; height: 100%; min-height: 0; display: block; }
  .pulseplot .pp-key:focus-visible,
  .pulseplot .pp-plot:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--color-accent-ink));
                                      outline-offset: 1px; }
  /* Hover/keyboard readout — a crosshair snaps to the nearest knot; the readout
     lists EVERY drive at that time (the pointer never has to hit a 2px line). */
  .pulseplot .pp-cursor { stroke: var(--color-dim); stroke-width: 1;
                          vector-effect: non-scaling-stroke; }
  /* One flat strip pinned to the plot's top edge (a tall row-per-series card
     would overflow a short bottom panel and occlude the data). It flips
     left/right so it stays out of the crosshair's half. */
  .pulseplot .pp-readout { position: absolute; top: var(--space-xs); pointer-events: none;
                           max-width: calc(100% - var(--space-md));
                           background: var(--vscode-editorWidget-background, var(--bg-plot));
                           border: var(--border-width) solid var(--border-color);
                           border-radius: var(--border-radius);
                           box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.25));
                           padding: 2px var(--space-sm);
                           display: flex; flex-wrap: wrap; align-items: center;
                           gap: 2px var(--space-md);
                           font-size: var(--text-small); z-index: 1; }
  .pulseplot .pp-ro-row { display: flex; align-items: center; gap: var(--space-xs); }
  /* Tooltip rows key their series with a short LINE of the series color (a
     filled box at this density is data-weight ink doing a label's job). */
  .pulseplot .pp-ro-key { width: 10px; height: 2px; border-radius: 1px; flex: none; }
  .pulseplot .pp-ro-v { font-family: var(--text-mono); }
  @media (prefers-reduced-motion: no-preference) {
    .pulseplot .pp-step { transition: opacity 0.15s ease-out; }
    .pulseplot.pp-busy .pp-hint { animation: pp-breathe 2.2s ease-in-out infinite; }
  }
  @keyframes pp-breathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 0.25; } }
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
  /** Render mode; absent (an old emitter / stored meta) draws as zoh stairs. */
  interp?: PulseInterp;
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
  /** Empty-state with a hint — idle / warming / no-pulse-data messaging.
   *  `busy` adds a gentle breathing animation (reduced-motion gated) for
   *  states where work is happening off-screen (Julia warming up). */
  waiting(hint: string, busy?: boolean): void;
}

/** Overlay-mode interaction handles — rebuilt per meta(), undefined in
 *  small-multiples mode (position + per-strip labels disambiguate there). */
interface OverlayRefs {
  plot: HTMLElement;
  svg: SVGSVGElement;
  cursor: SVGLineElement;
  readout: HTMLDivElement;
  timeValue: HTMLSpanElement;
  rows: { row: HTMLDivElement; value: HTMLSpanElement }[];
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
  let mode: PulseInterp = "zoh";

  // Interaction state (overlay mode). The record cache keeps the DECIMATED
  // values — the crosshair snaps to rendered knots, so readout and path agree.
  let overlay: OverlayRefs | undefined;
  let lastValues: number[][] | undefined;
  let lastStride = 1;
  let lastDt = 0;
  let cursorIdx = -1;
  let seriesOff: boolean[] = [];

  el.append(hint.el, axis);

  function reset(): void {
    if (body) body.remove();
    body = undefined;
    series = [];
    overlay = undefined;
    lastValues = undefined;
    lastStride = 1;
    cursorIdx = -1;
    seriesOff = [];
  }

  function meta(m: PulsePlotMeta): void {
    currentMeta = m;
    mode = m.interp ?? "zoh";
    reset();
    if (m.labels.length === 0) return; // nothing to plot; hint stays

    body = m.drives <= SERIES_COLORS ? buildOverlay(m) : buildMultiples(m);
    el.insertBefore(body, axis); // keep the shared time axis last
  }

  /** OVERLAY: one shared amplitude axis for every drive. */
  function buildOverlay(m: PulsePlotMeta): HTMLElement {
    const holder = document.createElement("div");
    holder.className = "pp-overlay";

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

    seriesOff = m.labels.map(() => false);
    series = m.labels.map((label, i) => {
      legend.append(legendKey(label, i));
      const step = mkStep(i);
      svg.append(step);
      return { step, y };
    });

    // Crosshair hairline sits above the steps; hidden until hover/keyboard.
    const cursor = svgEl("line");
    cursor.setAttribute("class", "pp-cursor");
    cursor.setAttribute("y1", "0");
    cursor.setAttribute("y2", String(H));
    cursor.style.display = "none";
    svg.append(cursor);

    // Readout: time first, then one row per drive — values lead, labels follow.
    const readout = document.createElement("div");
    readout.className = "pp-readout";
    readout.style.display = "none";
    readout.setAttribute("aria-live", "polite");
    const timeRow = document.createElement("div");
    timeRow.className = "pp-ro-row";
    const timeValue = text("pp-ro-v", "");
    timeRow.append(text("label-k", "t").el, timeValue.el);
    readout.append(timeRow);
    const rows = m.labels.map((label, i) => {
      const row = document.createElement("div");
      row.className = "pp-ro-row";
      const key = document.createElement("span");
      key.className = "pp-ro-key";
      key.style.background = seriesVar(i);
      const value = text("pp-ro-v", "");
      row.append(key, text("label-k", label).el, value.el);
      readout.append(row);
      return { row, value: value.el };
    });

    // The whole plot is the hit target; keyboard gets the same readout as hover.
    plot.tabIndex = 0;
    plot.setAttribute("role", "group");
    plot.addEventListener("pointermove", (e) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      moveCursor((e.clientX - rect.left) / rect.width);
    });
    plot.addEventListener("pointerleave", () => hideCursor());
    plot.addEventListener("blur", () => hideCursor());
    plot.addEventListener("keydown", (e) => {
      const n = lastValues?.[0]?.length ?? 0;
      if (n === 0) return;
      const start = cursorIdx >= 0 ? cursorIdx : n >> 1;
      const jump: Record<string, number> = { ArrowLeft: start - 1, ArrowRight: start + 1, Home: 0, End: n - 1 };
      if (e.key === "Escape") {
        hideCursor();
      } else if (e.key in jump) {
        showCursor(Math.min(n - 1, Math.max(0, jump[e.key])));
      } else {
        return;
      }
      e.preventDefault();
    });

    overlay = { plot, svg, cursor, readout, timeValue: timeValue.el, rows };

    const yHi = text("label-k pp-ylab hi", formatAmp(hi));
    const yLo = text("label-k pp-ylab lo", formatAmp(lo));
    plot.append(svg, yHi.el, yLo.el, readout);
    holder.append(legend, plot);
    return holder;
  }

  /** Hover/focus emphasizes one drive; a toggled-off drive stays at a trace
   *  opacity (never removed — the scale, the legend, and every drive's color
   *  assignment are unchanged by toggling). */
  function applySeriesEmphasis(focus?: number): void {
    series.forEach((s, i) => {
      const off = seriesOff[i];
      const faded = focus !== undefined && focus !== i;
      s.step.style.opacity = off ? "0.12" : faded ? "0.25" : "1";
    });
  }

  function moveCursor(frac: number): void {
    const n = lastValues?.[0]?.length ?? 0;
    if (!overlay || n === 0) return;
    showCursor(fracToKnot(frac, n, mode));
  }

  function showCursor(k: number): void {
    const values = lastValues;
    if (!overlay || !values || values.length === 0) return;
    const n = values[0].length;
    if (n === 0) return;
    cursorIdx = k;
    const fracMid = knotFrac(k, n, mode);
    overlay.cursor.setAttribute("x1", String(fracMid * W));
    overlay.cursor.setAttribute("x2", String(fracMid * W));
    overlay.cursor.style.display = "";
    overlay.timeValue.textContent = formatT(k * lastStride * lastDt);
    overlay.rows.forEach((r, i) => {
      r.value.textContent = formatAmp(values[i]?.[k] ?? NaN);
      r.row.style.opacity = seriesOff[i] ? "0.45" : "";
    });
    // Flip the readout across the crosshair so it never clips at an edge.
    const width = overlay.svg.getBoundingClientRect().width;
    const px = fracMid * width;
    if (fracMid <= 0.55) {
      overlay.readout.style.left = `${Math.round(px + 10)}px`;
      overlay.readout.style.right = "auto";
    } else {
      overlay.readout.style.right = `${Math.round(width - px + 10)}px`;
      overlay.readout.style.left = "auto";
    }
    overlay.readout.style.display = "";
  }

  function hideCursor(): void {
    cursorIdx = -1;
    if (!overlay) return;
    overlay.cursor.style.display = "none";
    overlay.readout.style.display = "none";
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
  const legendKey = (label: string, i: number): HTMLButtonElement => {
    const key = document.createElement("button");
    key.type = "button";
    key.className = "pp-key";
    key.setAttribute("aria-pressed", "true");
    key.title = `Toggle ${label}`;
    key.append(chip(i), text("label-k", label).el);
    key.addEventListener("click", () => {
      seriesOff[i] = !seriesOff[i];
      key.setAttribute("aria-pressed", String(!seriesOff[i]));
      applySeriesEmphasis();
      if (cursorIdx >= 0) showCursor(cursorIdx); // readout mirrors the toggle
    });
    key.addEventListener("mouseenter", () => applySeriesEmphasis(i));
    key.addEventListener("focus", () => applySeriesEmphasis(i));
    key.addEventListener("mouseleave", () => applySeriesEmphasis());
    key.addEventListener("blur", () => applySeriesEmphasis());
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
    el.classList.remove("pp-empty", "pp-busy");
    const tEnd = formatT(plotDuration(r.dt, currentMeta.knots, mode));
    tEndLabel.set(tEnd);
    lastDt = r.dt;
    // stride mirrors decimate(): the readout's k-th knot must be the k-th RENDERED knot
    lastStride = r.values[0] ? Math.max(1, Math.ceil(r.values[0].length / MAX_KNOTS)) : 1;
    lastValues = r.values.map(decimate);
    r.values.forEach((_, i) => {
      series[i].step.setAttribute("d", pulsePath(lastValues![i], series[i].y, W, mode));
    });
    if (overlay) {
      overlay.plot.setAttribute(
        "aria-label",
        `Pulse plot — ${currentMeta.drives} drives over ${tEnd} time units, iteration ${r.iter}. Arrow keys read values.`,
      );
      if (cursorIdx >= 0) showCursor(Math.min(cursorIdx, lastValues[0].length - 1)); // live-refresh an open readout
    }
  }

  function clear(): void {
    el.classList.add("pp-empty");
    for (const s of series) s.step.removeAttribute("d");
    tEndLabel.set("");
    lastValues = undefined;
    hideCursor();
  }

  function waiting(hintText: string, busy = false): void {
    hint.set(hintText);
    clear();
    el.classList.toggle("pp-busy", busy);
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

function decimate(values: number[]): number[] {
  if (values.length <= MAX_KNOTS) return values;
  const stride = Math.ceil(values.length / MAX_KNOTS);
  const out: number[] = [];
  for (let k = 0; k < values.length; k += stride) out.push(values[k]);
  return out;
}

function formatT(t: number): string {
  return t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t.toFixed(2);
}

/** Compact amplitude label for the y-scale ends (trims trailing zeros). */
function formatAmp(v: number): string {
  if (!Number.isFinite(v)) return "";
  return String(Number(v.toPrecision(3)));
}
