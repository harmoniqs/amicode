// Text atom — a span that owns its text content.

import { defineStyle } from "../style";

defineStyle(
  "text",
  `
  .mono { font-family: var(--text-mono); }
  .dim { color: var(--color-dim); }
  .small { font-size: var(--text-small); }
  .label-k { font-size: var(--text-label); text-transform: uppercase;
             letter-spacing: 0.6px; font-weight: 600; color: var(--color-dim); }
`,
);

export interface TextAtom {
  el: HTMLSpanElement;
  set(text: string): void;
}

export function text(className = "", initial = ""): TextAtom {
  const el = document.createElement("span");
  if (className) el.className = className;
  el.textContent = initial;
  return {
    el,
    set(t) {
      el.textContent = t;
    },
  };
}
