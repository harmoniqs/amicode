// Button atom — a compact control button. Disabled state is a property here.

import { defineStyle } from "../style";

defineStyle("button", `
  .btn { font-family: var(--text-font); font-size: var(--text-small);
         color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
         background: var(--vscode-button-secondaryBackground, transparent);
         border: var(--border-width) solid var(--border-color);
         border-radius: var(--border-radius); padding: var(--space-xs) var(--space-sm);
         cursor: pointer; display: inline-flex; align-items: center; gap: var(--space-xs); }
  .btn:hover:not(:disabled) { border-color: var(--color-accent); }
  .btn:disabled { opacity: 0.4; cursor: default; }
`);

export interface ButtonAtom {
  el: HTMLButtonElement;
  enable(on: boolean): void;
}

export function button(label: string, onClick: () => void): ButtonAtom {
  const el = document.createElement("button");
  el.className = "btn";
  el.type = "button";
  el.textContent = label;
  el.addEventListener("click", () => { if (!el.disabled) onClick(); });
  return { el, enable: (on: boolean) => { el.disabled = !on; } };
}
