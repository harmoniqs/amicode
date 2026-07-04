// Metric component — one labeled number card. hero = the number that matters.

import { defineStyle } from "../style";
import { text } from "../atoms/text";

defineStyle("metric", `
  .metric { background: var(--bg-box);
            border: var(--border-width) solid var(--border-color);
            border-radius: var(--border-radius); padding: var(--space-sm) var(--space-md);
            display: flex; flex-direction: column; gap: var(--space-xs); }
  .metric .v { font-family: var(--text-mono); font-size: var(--text-value); }
  /* counter = a compact integer (iteration): no growth, tight. */
  .metric-counter { flex: 0 0 auto; }
  /* hero = the number that matters: accent border, larger value. */
  .metric-hero { border-color: var(--border-color-hero); }
  .metric-hero .v { font-size: var(--text-hero); font-weight: 600; }
`);

export type MetricVariant = "counter" | "small" | "hero";

export interface Metric {
  el: HTMLDivElement;
  value(v: string): void;
  label(l: string): void;
  clear(): void;
}

export function metric(labelText: string, opts: { variant?: MetricVariant } = {}): Metric {
  const el = document.createElement("div");
  el.className = `metric metric-${opts.variant ?? "small"}`;
  const l = text("label-k", labelText);
  const v = text("v", "–");
  el.append(l.el, v.el);
  return {
    el,
    value: (t) => v.set(t),
    label: (t) => l.set(t),
    clear: () => v.set("–"),
  };
}
