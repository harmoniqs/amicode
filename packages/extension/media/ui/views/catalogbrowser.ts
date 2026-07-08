// Pulse/run catalog browser (#48, UX3) — master-detail: a left list of
// pulses (name · tag · 6-char hash), sectioned QILC runs / Results, click a
// row → detail pane. Ships BOTH arrangements behind a Flat/Grouped toggle so
// Krishna's own open question (flat vs per-system/per-gate — he leaned flat:
// "iterations w/ flat structure give good history") can be A/B'd directly,
// rather than shipping only the arrangement we guessed he'd prefer. Flat is
// the default per his lean.
//
// Detail pane reuses the #47 catalogcard component wholesale for Results
// (metadata/plot/metrics already solved there); QILC runs get a lighter
// in-progress panel since they have no finished pulse/fidelity yet.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { button } from "../atoms/button";
import { pill } from "../atoms/pill";
import { metric } from "../components/metric";
import { catalogcard, type CatalogEntry, type CardPulse } from "../components/catalogcard";

defineStyle(
  "catalogbrowser",
  `
  .catalogbrowser { container-type: inline-size; height: 100%; }
  .cb-layout { display: flex; height: 100%; gap: var(--space-md); align-items: flex-start; }
  .cb-list { flex: 0 0 260px; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-md); }
  .cb-detail { flex: 1 1 auto; overflow-y: auto; min-width: 0; display: flex; flex-direction: column; gap: var(--space-sm); }
  .cb-section { display: flex; flex-direction: column; gap: var(--space-xs); }
  .cb-mode-toggle { display: flex; gap: var(--space-xs); }
  .cb-mode-toggle .btn.active { border-color: var(--color-accent); color: var(--color-accent); }
  .cb-group { display: flex; flex-direction: column; gap: var(--space-xs); }
  .cb-group-title { padding-left: var(--space-xs); }
  .cb-subgroup { display: flex; flex-direction: column; gap: var(--space-xs); padding-left: var(--space-md); }
  .cb-row { display: flex; align-items: center; gap: var(--space-sm); width: 100%;
            text-align: left; font: inherit; color: inherit; background: none;
            padding: var(--space-xs) var(--space-sm); border-radius: var(--border-radius);
            border: var(--border-width) solid transparent; cursor: pointer; }
  .cb-row:hover { border-color: var(--border-color); }
  .cb-row.selected { border-color: var(--color-accent); background: var(--bg-box); }
  .cb-hash { font-family: var(--text-mono); font-size: var(--text-small); color: var(--color-dim); margin-left: auto; }
  .cb-panel { border: var(--border-width) solid var(--border-color); border-radius: var(--border-radius);
              padding: var(--space-md); display: flex; align-items: center; gap: var(--space-md); }
  .cb-back { display: none; align-self: flex-start; }
  /* Narrow (docked) panel: collapse to single-pane master-detail — list OR
     detail, never both fighting for width (no horizontal scroll). */
  @container (max-width: 480px) {
    .cb-layout { flex-direction: column; }
    .cb-list.cb-hidden, .cb-detail.cb-hidden { display: none; }
    .cb-back { display: inline-flex; }
  }
`,
);

export interface QilcRunFixture {
  run_id: string;
  system?: string;
  gate?: string;
  iteration: number;
  tags?: string[];
  hash6: string;
}

export interface ResultFixture {
  entry: CatalogEntry;
  pulse?: CardPulse;
}

export interface CatalogBrowserData {
  qilcRuns: QilcRunFixture[];
  results: ResultFixture[];
}

export interface CatalogBrowserView {
  el: HTMLElement;
}

type Selection = { kind: "qilc"; item: QilcRunFixture } | { kind: "result"; item: ResultFixture };

export function createCatalogBrowserView(data: CatalogBrowserData): CatalogBrowserView {
  const el = document.createElement("div");
  el.className = "catalogbrowser";

  const layout = document.createElement("div");
  layout.className = "cb-layout";
  el.append(layout);

  const list = document.createElement("div");
  list.className = "cb-list";
  const detail = document.createElement("div");
  detail.className = "cb-detail";
  layout.append(list, detail);

  const back = button("← Back to list", () => {
    list.classList.remove("cb-hidden");
    detail.classList.add("cb-hidden");
  });
  back.el.classList.add("cb-back");

  const rowsByKey = new Map<string, HTMLButtonElement>();

  function renderDetail(sel: Selection): void {
    detail.replaceChildren(back.el);
    if (sel.kind === "result") {
      detail.append(catalogcard(sel.item.entry, { pulse: sel.item.pulse }).el);
      return;
    }
    // QILC run: lighter in-progress panel — no finished pulse to show yet.
    const wrap = document.createElement("div");
    wrap.className = "cb-panel";
    const status = pill("running", "iterating");
    const iter = metric("iteration", { variant: "counter" });
    iter.value(String(sel.item.iteration));
    wrap.append(status.el, iter.el, text("small dim", "Not yet promoted to a result.").el);
    detail.append(wrap);
  }

  function selectRow(key: string, sel: Selection): void {
    for (const r of rowsByKey.values()) r.classList.remove("selected");
    rowsByKey.get(key)?.classList.add("selected");
    renderDetail(sel);
    // Narrow-panel collapse: show detail, hide list (Back returns to it).
    list.classList.add("cb-hidden");
    detail.classList.remove("cb-hidden");
  }

  function makeRow(key: string, label: string, hash6: string, sel: Selection): HTMLButtonElement {
    const row = button(label, () => selectRow(key, sel));
    row.el.classList.add("cb-row");
    row.el.append(text("cb-hash", hash6).el);
    rowsByKey.set(key, row.el);
    return row.el;
  }

  interface GroupedRow {
    row: HTMLElement;
    system: string;
    gate: string;
  }

  const UNSPECIFIED = "unspecified";

  const qilcEntries: GroupedRow[] = data.qilcRuns.map((r) => ({
    row: makeRow(`qilc:${r.run_id}`, [r.tags?.[0], r.gate].filter(Boolean).join(" · ") || r.run_id, r.hash6, {
      kind: "qilc",
      item: r,
    }),
    system: r.system ?? UNSPECIFIED,
    gate: r.gate ?? UNSPECIFIED,
  }));
  const resultEntries: GroupedRow[] = data.results.map((r) => ({
    row: makeRow(
      `result:${r.entry.run_id}`,
      [r.entry.proposed?.tags?.[0], r.entry.gate].filter(Boolean).join(" · ") || r.entry.run_id,
      r.entry.proposed?.hash6 ?? "——————",
      { kind: "result", item: r },
    ),
    system: (typeof r.entry.params?.system === "string" ? r.entry.params.system : undefined) ?? UNSPECIFIED,
    gate: r.entry.gate ?? UNSPECIFIED,
  }));

  function groupBy(entries: GroupedRow[], key: "system" | "gate"): Map<string, GroupedRow[]> {
    const m = new Map<string, GroupedRow[]>();
    for (const e of entries) m.set(e[key], [...(m.get(e[key]) ?? []), e]);
    return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  function flatSection(title: string, entries: GroupedRow[]): HTMLElement {
    const s = document.createElement("div");
    s.className = "cb-section";
    s.append(text("label-k", title).el);
    s.append(...(entries.length ? entries.map((e) => e.row) : [text("small dim", "none yet").el]));
    return s;
  }

  // Per-system/gate arrangement (#48b) — the other half of Krishna's flat-vs-
  // nested A/B. Two-level grouping: system, then gate within it.
  function groupedSection(title: string, entries: GroupedRow[]): HTMLElement {
    const s = document.createElement("div");
    s.className = "cb-section";
    s.append(text("label-k", title).el);
    if (!entries.length) {
      s.append(text("small dim", "none yet").el);
      return s;
    }
    for (const [system, sysEntries] of groupBy(entries, "system")) {
      const g = document.createElement("div");
      g.className = "cb-group";
      g.append(text("small cb-group-title", system).el);
      for (const [gate, gateEntries] of groupBy(sysEntries, "gate")) {
        const sub = document.createElement("div");
        sub.className = "cb-subgroup";
        sub.append(text("small dim", gate).el, ...gateEntries.map((e) => e.row));
        g.append(sub);
      }
      s.append(g);
    }
    return s;
  }

  let mode: "flat" | "grouped" = "flat"; // Krishna's own lean — default, not just an option

  const flatBtn = button("Flat", () => setMode("flat"));
  const groupedBtn = button("By system · gate", () => setMode("grouped"));
  const toggle = document.createElement("div");
  toggle.className = "cb-mode-toggle";
  toggle.append(flatBtn.el, groupedBtn.el);

  function setMode(next: "flat" | "grouped"): void {
    mode = next;
    flatBtn.el.classList.toggle("active", mode === "flat");
    groupedBtn.el.classList.toggle("active", mode === "grouped");
    renderList();
  }

  function renderList(): void {
    const build = mode === "flat" ? flatSection : groupedSection;
    list.replaceChildren(toggle, build("QILC runs", qilcEntries), build("Results", resultEntries));
  }

  setMode("flat");
  detail.append(back.el, text("small dim", "Select a pulse from the list.").el);

  return { el };
}
