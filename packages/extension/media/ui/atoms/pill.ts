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
          display: inline-flex; align-items: center; gap: var(--space-sm); }
  .pill::before { content: ""; width: var(--square-dot); height: var(--square-dot);
                  border-radius: 50%; background: currentColor; }
  .pill.no-dot::before { content: none; }
  .pill.idle    { color: var(--color-dim); }
  .pill.running { color: var(--color-run); }
  .pill.running::before { animation: pill-pulse 1.1s ease-in-out infinite; }
  .pill.done    { color: var(--color-ok); }
  .pill.failed  { color: var(--color-fail); }
  @keyframes pill-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.35; transform: scale(0.7); } }
`,
);

export type PillState = "idle" | "running" | "done" | "failed";

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
