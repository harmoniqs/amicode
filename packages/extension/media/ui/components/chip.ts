// Chip component (#47) — the catalog entry's compact handle, per the p5
// sketch: gate · system · tag · #index. Identity is HAMILTONIAN-based (a
// pulse's validity is a property of the system it was optimized against);
// the lab is provenance and lives in the card's metadata panel, not here.
// Fields the catalog-entry schema doesn't carry yet (tag, index) render with
// the "proposed" treatment — visually present, visibly not-yet-real (the
// card is the feedback artifact for exactly that field selection).

import { defineStyle } from "../style";
import { text } from "../atoms/text";

defineStyle("chip", `
  .chip { display: inline-flex; align-items: center; gap: var(--space-sm);
          padding: var(--space-xs) var(--space-md);
          border: var(--border-width) solid var(--border-color);
          border-radius: var(--border-radius-round);
          background: var(--bg-box); font-size: var(--text-small);
          white-space: nowrap; }
  .chip .chip-gate { font-weight: 600; }
  .chip .chip-sep { color: var(--color-dim); opacity: 0.6; }
  .chip .proposed { border-bottom: 1px dashed var(--color-dim); opacity: 0.75; }
`);

export interface ChipFields {
  gate?: string;
  /** System descriptor (e.g. "transmon·3lvl") — Hamiltonian-based identity. */
  system?: string;
  /** User-added tags — not in the catalog-entry schema, proposed (marked).
   *  The quick-digest handles for hyperparameter sweeps ("high-R", "fast"). */
  tags?: string[];
  /** Not in the catalog-entry schema — proposed (marked). */
  index?: number;
}

export interface Chip {
  el: HTMLSpanElement;
}

export function chip(f: ChipFields): Chip {
  const el = document.createElement("span");
  el.className = "chip";
  const sep = (): HTMLSpanElement => text("chip-sep", "·").el;

  el.append(text("chip-gate mono", f.gate ?? "?").el);
  if (f.system) el.append(sep(), text("dim", f.system).el);
  for (const t of f.tags ?? []) el.append(sep(), text("proposed", t).el);
  if (f.index !== undefined) el.append(sep(), text("proposed mono", `#${String(f.index).padStart(4, "0")}`).el);
  return { el };
}
