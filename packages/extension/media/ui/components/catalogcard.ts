// Catalog entry card (#47, UX2) — the atom of the catalog. Krishna's p5
// sketch, top to bottom: chip header → pulse plot (with a quiet plot-attached
// action row — the resume hand-off, unlabeled by design) → metadata /
// pulse-data / high-level-metrics panels → model catalog (sibling chips).
//
// Data contract: `entry` is schema-true (catalog-entry.schema.json fields
// verbatim); `entry.proposed` is the clearly-separated extension block whose
// fields render with the "proposed" treatment (they are the feedback artifact
// for the Krishna field-selection questions — Jack's lane to resolve);
// `pulse` is the optional hydrated block sharing pulseplot's meta/values
// shapes (models a CatalogStore hydrating pulse_path on open).

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { metric } from "./metric";
import { chip, type ChipFields } from "./chip";
import { pulseplot, type PulsePlotMeta, type PulsePlotRecord } from "./pulseplot";

defineStyle(
  "catalogcard",
  `
  .catalogcard { display: flex; flex-direction: column; gap: var(--space-md);
                 padding: var(--space-lg); min-width: 0;
                 background: var(--bg-box);
                 border: var(--border-width) solid var(--border-color);
                 border-radius: var(--border-radius); }
  .catalogcard .cc-head { display: flex; align-items: center; gap: var(--space-md); flex-wrap: wrap; }
  .catalogcard .cc-plot { min-height: 200px; display: flex; }
  .catalogcard .cc-panels { display: grid; gap: var(--space-sm);
                            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .catalogcard .cc-panel { border: var(--border-width) solid var(--border-color);
                           border-radius: var(--border-radius);
                           padding: var(--space-sm) var(--space-md);
                           display: flex; flex-direction: column; gap: var(--space-xs); }
  .catalogcard .cc-kv { display: flex; justify-content: space-between; gap: var(--space-md);
                        font-size: var(--text-small); min-width: 0; }
  .catalogcard .cc-kv .v { font-family: var(--text-mono); overflow: hidden;
                           text-overflow: ellipsis; white-space: nowrap; }
  .catalogcard .proposed { border-bottom: 1px dashed var(--color-dim); opacity: 0.75; }
  .catalogcard .metric.proposed { border-style: dashed; border-bottom: var(--border-width) dashed var(--border-color-hero); opacity: 0.8; }
  .catalogcard .cc-metrics { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
  .catalogcard .cc-metrics .metric { flex: 1 1 120px; min-width: 0; }
  .catalogcard .cc-siblings { display: flex; gap: var(--space-sm); overflow-x: auto;
                              padding-bottom: var(--space-xs); }
  .catalogcard .cc-actions { display: flex; gap: var(--space-sm); margin-left: auto; }
  .catalogcard .cc-actions button { font-family: var(--text-font); font-size: var(--text-small);
                                    padding: var(--space-xs) var(--space-md); cursor: pointer;
                                    border: 1px solid var(--vscode-button-border, transparent);
                                    border-radius: 2px;
                                    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                                    background: var(--vscode-button-secondaryBackground, var(--bg-box)); }
  .catalogcard .cc-actions button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--bg-box)); }
`,
);

/** Schema-true catalog-entry fields (catalog-entry.schema.json v1). */
export interface CatalogEntry {
  schema_version: string;
  run_id: string;
  lab_id: string;
  fidelity: number;
  pulse_path: string;
  gate?: string;
  created_at?: string;
  params?: Record<string, unknown>;
  /** NOT in the schema — proposed extensions, rendered visibly marked. */
  proposed?: {
    tags?: string[];
    index?: number;
    iterations?: number;
    wall_seconds?: number;
    /** User-assigned system name — human identity over machine family. */
    system_name?: string;
  };
}

export interface CardPulse {
  meta: PulsePlotMeta;
  record: PulsePlotRecord;
}

export interface CatalogCard {
  el: HTMLDivElement;
}

/** The pulse actions — the save → tune → warm-start → promote ladder.
 *  Tune: refine THIS pulse (resume the chat interview with this run as
 *  context). Warm-Start: seed a NEW solve from this pulse's trajectory.
 *  Promote: send the pulse toward hardware (Intonato path; stub until then).
 *  Vocabulary note for the field-selection round: "promote" also means
 *  promote-to-catalog elsewhere (the prompt that opens this card). */
export const PULSE_ACTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "tune", label: "Tune" },
  { id: "warmstart", label: "Warm-Start" },
  { id: "promote", label: "Promote" },
];

export interface CatalogCardOpts {
  pulse?: CardPulse;
  siblings?: ChipFields[];
  /** Wired by the host; the row renders only when provided. */
  onAction?: (id: string) => void;
}

export function catalogcard(entry: CatalogEntry, opts: CatalogCardOpts = {}): CatalogCard {
  const el = document.createElement("div");
  el.className = "catalogcard";

  // 1 — chip header
  const head = document.createElement("div");
  head.className = "cc-head";
  // User-named system wins the identity slot (proposed-marked via `tag`
  // styling in the chip); the derived family is the fallback.
  const named = entry.proposed?.system_name;
  head.append(
    chip({ gate: entry.gate, system: named ?? systemDescriptor(entry.params), ...entry.proposed }).el,
    text("mono small dim", entry.run_id).el,
  );
  // Pulse actions live in the header, right-justified — with the identity,
  // acting on the pulse it names. VS Code button styling, uniform secondary.
  if (opts.onAction) {
    const actions = document.createElement("div");
    actions.className = "cc-actions";
    for (const a of PULSE_ACTIONS) {
      const b = document.createElement("button");
      b.textContent = a.label;
      b.addEventListener("click", () => opts.onAction!(a.id));
      actions.append(b);
    }
    head.append(actions);
  }
  el.append(head);

  // 2 — pulse plot (hydrated; degrades to pulseplot's empty state)
  const plotHost = document.createElement("div");
  plotHost.className = "cc-plot";
  const plot = pulseplot("Pulse not hydrated — entry carries pulse_path only.");
  if (opts.pulse) {
    plot.meta(opts.pulse.meta);
    plot.update(opts.pulse.record);
  }
  plotHost.append(plot.el);
  el.append(plotHost);

  // 3 — panels: metadata · pulse data · high-level metrics
  const panels = document.createElement("div");
  panels.className = "cc-panels";
  panels.append(
    panel("metadata", [
      kv("run", entry.run_id),
      kv("system", systemDescriptor(entry.params) ?? "—"),
      kv("gate", entry.gate ?? "—"),
      // the user-assigned name (chip identity) vs the derived family above
      ...(entry.proposed?.system_name ? [kv("name", entry.proposed.system_name, true)] : []),
      ...(entry.proposed?.tags?.length ? [kv("tags", entry.proposed.tags.join(", "), true)] : []),
      kv("created", entry.created_at ?? "—"),
      // solver telemetry — provenance, not pulse quality (proposed fields)
      ...(entry.proposed?.iterations !== undefined ? [kv("iterations", String(entry.proposed.iterations), true)] : []),
      ...(entry.proposed?.wall_seconds !== undefined
        ? [kv("wall", `${entry.proposed.wall_seconds.toFixed(0)}s`, true)]
        : []),
    ]),
    panel("pulse data", [
      kv("pulse", entry.pulse_path.split("/").slice(-2).join("/")),
      ...Object.entries(entry.params ?? {}).map(([k, v]) => kv(k, String(v))),
    ]),
    metricsPanel(entry, opts.pulse),
  );
  el.append(panels);

  // 4 — model catalog: sibling chips
  if (opts.siblings?.length) {
    el.append(text("label-k", "model catalog").el);
    const sibs = document.createElement("div");
    sibs.className = "cc-siblings";
    for (const s of opts.siblings) sibs.append(chip(s).el);
    el.append(sibs);
  }

  return { el };
}

/** Hamiltonian-based identity for the chip: the system FAMILY only
 *  (params.system, e.g. "transmon"). Level counts are modeling resolution,
 *  not identity — the same device simulated at 3 vs 4 levels is one system —
 *  so they stay in the pulse-data panel's params rows, not the chip. The
 *  real structured Hamiltonian-identity key (family + subsystem topology +
 *  parameters) is a Phase-3 CatalogStore schema decision. */
function systemDescriptor(params?: Record<string, unknown>): string | undefined {
  const sys = params?.system;
  return typeof sys === "string" ? sys : undefined;
}

function panel(title: string, rows: HTMLElement[]): HTMLDivElement {
  const p = document.createElement("div");
  p.className = "cc-panel";
  p.append(text("label-k", title).el, ...rows);
  return p;
}

function kv(k: string, v: string, proposed = false): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cc-kv";
  row.append(text("dim", k).el, text(proposed ? "v proposed" : "v", v).el);
  return row;
}

function metricsPanel(entry: CatalogEntry, pulse?: CardPulse): HTMLDivElement {
  const p = document.createElement("div");
  p.className = "cc-panel";
  p.append(text("label-k", "high-level metrics").el);

  // All four wear the same hero metric styling; provisional ones (definition
  // or data source still a domain-owner decision) get a dashed border.
  const heroCard = (label: string, value: string, proposed = false): HTMLDivElement => {
    const m = metric(label, { variant: "hero" });
    m.value(value);
    if (proposed) m.el.classList.add("proposed");
    return m.el;
  };

  const row = document.createElement("div");
  row.className = "cc-metrics";
  p.append(row);

  row.append(heroCard("fidelity", entry.fidelity.toFixed(5)));

  // Gate time — real: params.T (template units are ns).
  const T = entry.params?.T;
  if (typeof T === "number") row.append(heroCard("gate time", `${T} ns`));

  // Spectral bandwidth — computed from the hydrated knots: the frequency
  // containing 95% of the pulse's AC power (DC/mean removed; ZOH samples at
  // 1/dt). Definitional choices (threshold, DC handling, per-drive max) are
  // domain-owner calls → proposed-marked, definition in the label. Units GHz
  // for the template's ns time base.
  const bw = spectralBandwidth(pulse);
  if (bw !== undefined) row.append(heroCard("bandwidth (95% pwr)", `${bw.toPrecision(3)} GHz`, true));

  // Robustness — fidelity sensitivity to parameter error. Needs perturbed
  // rollouts recorded at solve time; NOT derivable from saved artifacts, so
  // it renders as an empty proposed card (intent, not an invented number).
  row.append(heroCard("robustness", "—", true));

  return p;
}

/** 95%-power occupied bandwidth, max across drives: smallest f such that the
 *  cumulative one-sided power spectrum (DC removed) reaches 95% of total.
 *  Plain O(N²) DFT — knots are ≤ a few hundred points. Undefined without
 *  pulse data, a usable dt, or any AC power. */
function spectralBandwidth(pulse?: CardPulse): number | undefined {
  if (!pulse || !(pulse.record.dt > 0)) return undefined;
  const dt = pulse.record.dt;
  let worst: number | undefined;
  for (const drive of pulse.record.values) {
    const n = drive.length;
    if (n < 2 || drive.some((v) => !Number.isFinite(v))) continue;
    const mean = drive.reduce((a, b) => a + b, 0) / n;
    const x = drive.map((v) => v - mean);
    const half = Math.floor(n / 2);
    const power: number[] = [];
    for (let k = 1; k <= half; k++) {
      // one-sided, DC excluded
      let re = 0,
        im = 0;
      for (let t = 0; t < n; t++) {
        const ph = (-2 * Math.PI * k * t) / n;
        re += x[t] * Math.cos(ph);
        im += x[t] * Math.sin(ph);
      }
      power.push(re * re + im * im);
    }
    const total = power.reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    let cum = 0;
    for (let k = 0; k < power.length; k++) {
      cum += power[k];
      if (cum >= 0.95 * total) {
        const f = (k + 1) / (n * dt); // bin k+1 → frequency
        if (worst === undefined || f > worst) worst = f;
        break;
      }
    }
  }
  return worst;
}
