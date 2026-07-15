// Button atom — a compact control button. Disabled state is a property here.

import { defineStyle } from "../style";

defineStyle(
  "button",
  `
  .btn { font-family: var(--text-font); font-size: var(--text-small);
         color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
         background: var(--vscode-button-secondaryBackground, transparent);
         border: var(--border-width) solid var(--border-color);
         border-radius: var(--border-radius); padding: var(--space-xs) var(--space-sm);
         cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-xs); }
  .btn:hover:not(:disabled) { border-color: var(--color-accent);
                              background: color-mix(in srgb, var(--color-accent) 8%, transparent); }
  .btn:active:not(:disabled) { background: color-mix(in srgb, var(--color-accent) 16%, transparent); }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder, var(--color-accent)); outline-offset: 1px; }
  .btn:disabled { opacity: 0.4; cursor: default; }
  @media (prefers-reduced-motion: no-preference) {
    .btn { transition: border-color 0.15s ease-out, background 0.15s ease-out; }
  }
`,
);

export interface ButtonAtom {
  el: HTMLButtonElement;
  enable(on: boolean): void;
}

export function button(label: string, onClick: () => void): ButtonAtom {
  const el = document.createElement("button");
  el.className = "btn";
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", () => {
    if (!el.disabled) onClick();
  });
  return {
    el,
    enable: (on: boolean) => {
      el.disabled = !on;
    },
  };
}
