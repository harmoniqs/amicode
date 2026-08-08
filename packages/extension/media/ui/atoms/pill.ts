// Pill atom — a status indicator. State is a class applied here, in TS.
// Variations: the default carries a status dot (live run states — the dot
// pulses while running); `dot: false` yields a plain badge (labels like
// "recommended" that describe a THING, not a process).

import { defineStyle } from "../style";

defineStyle(
  "pill",
  `
  .pill { font-size: var(--text-small); font-weight: 600; letter-spacing: 0.5px;
          text-transform: uppercase; padding: var(--space-xs) var(--space-md);
          border-radius: var(--border-radius-round);
          border: var(--border-width) solid currentColor;
          background: color-mix(in srgb, currentColor 10%, transparent);
          display: inline-flex; align-items: center; gap: var(--space-sm); }
  .pill::before { content: ""; width: var(--square-dot); height: var(--square-dot);
                  border-radius: 50%; background: currentColor; }
  .pill.no-dot::before { content: none; }
  .pill.idle    { color: var(--color-dim); }
  .pill.running { color: var(--color-run); }
  @media (prefers-reduced-motion: no-preference) {
    .pill.running::before { animation: pill-pulse 1.1s ease-in-out infinite; }
  }
  .pill.done    { color: var(--color-ok); }
  .pill.failed  { color: var(--color-fail); }
  /* cloud — WHERE the run executes, not how it is going. The one badge here that
   * is a filled brand swatch: "this is the paid tier, running in Harmoniqs
   * Cloud" is the strongest claim the topbar makes, and the lemon fill is how
   * this product says "special". Obeys the brand rule in brand.css — yellow is a
   * FILL, never an ink — so the label is --color-on-accent (black, 18.7:1) and
   * the edge is the theme-solved hairline rather than the lemon trying to bound
   * itself against a light background. */
  .pill.cloud { color: var(--color-on-accent); background: var(--color-accent-fill);
                border-color: var(--color-accent-edge); }
  /* The status dot becomes a cloud glyph. Declared AFTER .no-dot so a caller
   * passing dot:false cannot silently erase it (equal specificity, later wins). */
  .pill.cloud::before { content: "☁"; width: auto; height: auto; background: none;
                        border-radius: 0; font-size: 1.15em; line-height: 1; }
  @keyframes pill-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
`,
);

/** Process states, plus `cloud` — a BADGE state describing a property of the run
 *  (where it executes) rather than how it is progressing. */
export type PillState = "idle" | "running" | "done" | "failed" | "cloud";

export interface PillOptions {
  /** Status dot before the label (default true). Badges pass false. */
  dot?: boolean;
}

export interface PillAtom {
  el: HTMLSpanElement;
  set(state: PillState, label: string): void;
}

export function pill(state: PillState = "idle", label: string = state, opts: PillOptions = {}): PillAtom {
  const el = document.createElement("span");
  const variant = opts.dot === false ? " no-dot" : "";
  const set = (s: PillState, l: string) => {
    el.className = "pill " + s + variant;
    el.textContent = l;
  };
  set(state, label);
  return { el, set };
}
