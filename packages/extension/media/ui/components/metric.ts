// Metric component — one labeled number card. hero = the number that matters.

import { defineStyle } from "../style";
import { text } from "../atoms/text";

defineStyle(
  "metric",
  `
  .metric { background: var(--bg-box);
            border: var(--border-width) solid var(--border-color);
            border-radius: var(--border-radius); padding: var(--space-sm) var(--space-md);
            display: flex; flex-direction: column; gap: var(--space-xs); }
  .metric .v { font-family: var(--text-mono); font-size: var(--text-value); }
  /* counter = a compact integer (iteration): no growth, tight. */
  .metric-counter { flex: 0 0 auto; }
  /* hero = the number that matters: larger value. (The old accent border +
     7% wash washed out on light themes, so the brand moment moved to the
     opt-in flag below.) */
  .metric-hero .v { font-size: var(--text-hero); font-weight: 600;
                    font-variant-numeric: tabular-nums; }
  /* flag = the singular brand hero (the Run Inspector's fidelity): a solid
     lemon square appears on the label once the value lands. It's a FILL with a
     1px edge — a dark hairline on light, transparent on dark — so the true
     brand lemon reads on both themes. Yellow is never used as text here. */
  .metric-flagged .label-k { display: inline-flex; align-items: center; gap: var(--space-xs); }
  .metric-flagged:not(.metric-pending) .label-k::before {
    content: ""; flex: 0 0 auto; width: var(--square-dot); height: var(--square-dot);
    border-radius: 2px; background: var(--color-accent-fill);
    border: var(--border-width) solid var(--color-accent-edge); }
  /* pending = no number yet (the "–" placeholder): the value recedes so empty
     cards don't compete with live ones; full ink returns with the first value. */
  .metric-pending .v { color: var(--color-dim); font-weight: 400; }
`,
);

export type MetricVariant = "counter" | "small" | "hero";

export interface Metric {
  el: HTMLDivElement;
  value(v: string): void;
  label(l: string): void;
  clear(): void;
}

export function metric(labelText: string, opts: { variant?: MetricVariant; flag?: boolean } = {}): Metric {
  const el = document.createElement("div");
  el.className = `metric metric-${opts.variant ?? "small"} metric-pending${opts.flag ? " metric-flagged" : ""}`;
  const l = text("label-k", labelText);
  const v = text("v", "–");
  el.append(l.el, v.el);
  return {
    el,
    value: (t) => {
      v.set(t);
      el.classList.remove("metric-pending");
    },
    label: (t) => l.set(t),
    clear: () => {
      v.set("–");
      el.classList.add("metric-pending");
    },
  };
}
