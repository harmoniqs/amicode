// Pulseplot component (#66) — client-side render of the live pulse from raw
// data, matching plot_pulse's stacked layout: one panel per drive, step
// (stairs) rendering — faithful to zero-order hold — bounds band with dashed
// limits, per-drive labels, shared time axis labeled on the bottom panel only.
//
// Hand-rolled SVG (series are tens of points; >512 knots per drive decimated
// by stride — min/max-preserving decimation is the GA refinement). Colors ride
// the fixed-order categorical series tokens in brand.css; identity is carried
// by a colored chip beside the label, text stays in text tokens.

import { defineStyle } from "../style";
import { text } from "../atoms/text";

defineStyle("pulseplot", `
  .pulseplot { display: flex; flex-direction: column; gap: var(--space-xs);
               flex: 1 1 240px; min-width: 0; min-height: 240px;
               background: var(--bg-plot);
               border: var(--border-width) solid var(--border-color);
               border-radius: var(--border-radius); padding: var(--space-sm); }
  .pulseplot .pp-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .pulseplot .pp-head { display: flex; align-items: center; gap: var(--space-sm); }
  .pulseplot .pp-chip { width: var(--square-dot); height: var(--square-dot); border-radius: 2px; }
  .pulseplot svg { flex: 1; width: 100%; min-height: 0; display: block; }
  .pulseplot .pp-step { fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .pulseplot .pp-limit { stroke: var(--color-dim); stroke-width: 1; stroke-dasharray: 4 3;
                         vector-effect: non-scaling-stroke; }
  .pulseplot .pp-zero { stroke: var(--plot-grid); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .pulseplot .pp-band { fill: var(--plot-band); }
  .pulseplot .pp-axis { display: flex; justify-content: space-between; align-items: baseline; }
  .pulseplot.pp-empty .pp-panel, .pulseplot.pp-empty .pp-axis { display: none; }
  .pulseplot .pp-hint { place-self: center; margin: auto; opacity: 0.55; font-style: italic; }
  .pulseplot:not(.pp-empty) .pp-hint { display: none; }
`);

const MAX_KNOTS = 512;   // above this, stride-decimate before rendering
const W = 1000;          // viewBox coordinate space (preserveAspectRatio=none)
const H = 100;
const PAD = 0.08;        // y-domain padding around the bounds band

export interface PulsePlotMeta { drives: number; knots: number; labels: string[]; bounds: [number, number][] }
export interface PulsePlotRecord { iter: number; dt: number; values: number[][] }

interface Panel {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  step: SVGPathElement;
  band: SVGRectElement;
  limits: [SVGLineElement, SVGLineElement];
  zero: SVGLineElement;
  bounds: [number, number];
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS("http://www.w3.org/2000/svg", tag);

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
  el.append(hint.el);

  const axis = document.createElement("div");
  axis.className = "pp-axis";
  const t0Label = text("label-k", "0");
  const xLabel = text("label-k", "Time");
  const tEndLabel = text("label-k", "");
  axis.append(t0Label.el, xLabel.el, tEndLabel.el);

  let panels: Panel[] = [];
  let currentMeta: PulsePlotMeta | undefined;

  function meta(m: PulsePlotMeta): void {
    currentMeta = m;
    for (const p of panels) p.el.remove();
    axis.remove();
    panels = m.labels.map((label, i) => {
      const panel = document.createElement("div");
      panel.className = "pp-panel";

      const head = document.createElement("div");
      head.className = "pp-head";
      const chip = document.createElement("span");
      chip.className = "pp-chip";
      chip.style.background = `var(--series-${(i % 4) + 1})`;
      head.append(chip, text("label-k", label).el);

      const svg = svgEl("svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("preserveAspectRatio", "none");

      const [lo, hi] = m.bounds[i];
      const y = yScale(lo, hi);
      const band = svgEl("rect");
      band.setAttribute("class", "pp-band");
      band.setAttribute("x", "0"); band.setAttribute("width", String(W));
      band.setAttribute("y", String(y(hi)));
      band.setAttribute("height", String(y(lo) - y(hi)));

      const mkLine = (cls: string, v: number): SVGLineElement => {
        const line = svgEl("line");
        line.setAttribute("class", cls);
        line.setAttribute("x1", "0"); line.setAttribute("x2", String(W));
        line.setAttribute("y1", String(y(v))); line.setAttribute("y2", String(y(v)));
        return line;
      };
      const limits: [SVGLineElement, SVGLineElement] = [mkLine("pp-limit", hi), mkLine("pp-limit", lo)];
      const zero = mkLine("pp-zero", 0);

      const step = svgEl("path");
      step.setAttribute("class", "pp-step");
      step.setAttribute("stroke", `var(--series-${(i % 4) + 1})`);

      svg.append(band, zero, limits[0], limits[1], step);
      panel.append(head, svg);
      el.append(panel);
      return { el: panel, svg, step, band, limits, zero, bounds: m.bounds[i] };
    });
    el.append(axis);   // shared time axis, bottom panel only
  }

  function update(r: PulsePlotRecord): void {
    if (!currentMeta || r.values.length !== panels.length) return;
    el.classList.remove("pp-empty");
    const duration = r.dt * currentMeta.knots;
    tEndLabel.set(formatT(duration));
    r.values.forEach((drive, i) => {
      const p = panels[i];
      const y = yScale(p.bounds[0], p.bounds[1]);
      p.step.setAttribute("d", stairsPath(decimate(drive), duration, y));
    });
  }

  function clear(): void {
    el.classList.add("pp-empty");
    for (const p of panels) p.step.removeAttribute("d");
    tEndLabel.set("");
  }

  function waiting(hintText: string): void {
    hint.set(hintText);
    clear();
  }

  return { el, meta, update, clear, waiting };
}

/** y-scale: bounds band → viewBox with PAD headroom; non-finite clamps to edge. */
function yScale(lo: number, hi: number): (v: number) => number {
  const pad = PAD * (hi - lo || 1);
  const min = lo - pad, max = hi + pad;
  return (v) => {
    const t = Number.isFinite(v) ? (v - min) / (max - min) : v > 0 ? 1 : 0;
    return H - Math.min(1, Math.max(0, t)) * H;
  };
}

/** Zero-order-hold stairs: each value held for its knot interval. */
function stairsPath(values: number[], duration: number, y: (v: number) => number): string {
  if (values.length === 0 || duration <= 0) return "";
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
