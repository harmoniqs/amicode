// Hamiltonian panel (#46, UX1) — the model Hamiltonian assembling itself in
// front of the physicist as they toggle terms on the multi-select physics
// question. Rendered as REAL math via KaTeX (bundled locally — the webview
// CSP forbids CDNs; css + fonts ship from media/vendor/katex). Term → math
// mapping lives in hamiltonian_terms.ts (pure).

import katex from "katex";
import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { hamiltonianLines, LHS_LATEX } from "./hamiltonian_terms";

defineStyle("hamiltonian", `
  .hm-panel { display: flex; flex-direction: column; gap: var(--space-xs);
              background: var(--bg-plot);
              border: var(--border-width) dashed var(--border-color);
              border-radius: var(--border-radius);
              padding: var(--space-md) var(--space-lg); max-width: 720px; }
  .hm-panel .hm-title { font-size: var(--text-label); text-transform: uppercase;
                        letter-spacing: 0.6px; color: var(--color-dim); }
  .hm-panel .hm-line { padding-left: var(--space-lg); }
  .hm-panel .hm-line.first { padding-left: 0; }
  .hm-panel .hm-line.lindblad { opacity: 0.75; }
  .hm-panel .hm-line .katex { font-size: 1.05em; }
  .hm-panel .hm-note { font-size: var(--text-small); color: var(--color-dim);
                       margin-left: var(--space-lg); }
`);

export interface HamiltonianPanel {
  el: HTMLDivElement;
  /** Re-render for the currently selected term labels. */
  set(selected: string[]): void;
}

export function hamiltonianPanel(): HamiltonianPanel {
  const el = document.createElement("div");
  el.className = "hm-panel";
  const body = document.createElement("div");
  el.append(text("hm-title", "model Hamiltonian").el, body);

  function set(selected: string[]): void {
    body.replaceChildren();
    hamiltonianLines(selected).forEach((l, i) => {
      // First line carries the LHS; its leading "+" folds into the "=".
      const latex = i === 0 ? LHS_LATEX + l.latex.replace(/^\+\\,?/, "") : l.latex;
      const line = document.createElement("div");
      line.className = "hm-line" + (i === 0 ? " first" : "") + (l.lindblad ? " lindblad" : "");
      line.innerHTML = katex.renderToString(latex, { throwOnError: false, output: "html" });
      body.append(line);
      if (l.note) body.append(text("hm-note", l.note).el);
    });
  }

  set([]);
  return { el, set };
}
