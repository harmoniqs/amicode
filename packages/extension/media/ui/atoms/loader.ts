// Loader atom — an indeterminate spinner for in-flight agent work. Rides the
// VS Code progress token so it recolors with the theme; identity is carried
// by the aria-label, never visible text (the design call: loader in lieu of
// "Amico is thinking…" copy).

import { defineStyle } from "../style";

defineStyle("loader", `
  .loader { display: inline-flex; align-items: center; gap: var(--space-sm); }
  .loader .ld-spin { width: 14px; height: 14px; border-radius: 50%; flex: none;
    border: 2px solid var(--border-color);
    border-top-color: var(--vscode-progressBar-background, var(--color-run));
    animation: ld-rotate 0.9s linear infinite; }
  @keyframes ld-rotate { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .loader .ld-spin { animation-duration: 2.4s; }
  }
`);

export interface Loader {
  el: HTMLSpanElement;
  /** Show/hide without layout churn — callers keep one instance mounted. */
  set(visible: boolean): void;
}

export function loader(label = "working"): Loader {
  const el = document.createElement("span");
  el.className = "loader";
  const spin = document.createElement("span");
  spin.className = "ld-spin";
  spin.setAttribute("role", "progressbar");
  spin.setAttribute("aria-label", label);
  el.append(spin);
  return { el, set(visible) { el.style.display = visible ? "" : "none"; } };
}
