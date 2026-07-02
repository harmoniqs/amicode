// Icon atoms. The mark is the <0||0> brand ket — intentionally not native.

import { defineStyle } from "../style";

defineStyle("mark", `
  .mark { font-family: var(--text-mono);
          letter-spacing: 1px; font-weight: 700;
          border: var(--border-width) solid var(--border-color);
          border-radius: var(--border-radius); padding: 1px 7px; }
`);

export function mark(): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "mark";
  el.textContent = "<0||0>";
  return el;
}
