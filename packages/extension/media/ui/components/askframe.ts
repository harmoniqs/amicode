// Askframe component (#46, UX1) — renders one live interview question:
// header chip (stage id), persona lead-in, question text, option rows
// (default pilled "recommended"), and an Other slot. The question SHAPE
// stays AskUserQuestion-compatible (header/question/options/custom) so the
// interview protocol and any future renderer share one contract.
//
// LAYOUT CONTRACT (fork-transcript ready): these components ultimately render
// inside the opencode-fork transcript — an infinite VERTICAL scroll. Options
// therefore stack vertically as full-width rows (never a horizontal card
// grid), and nothing in here assumes a fixed viewport height or column count.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { pill } from "../atoms/pill";

defineStyle("askframe", `
  .askframe { display: flex; flex-direction: column; gap: var(--space-md);
              background: var(--bg-box);
              border: var(--border-width) solid var(--border-color);
              border-radius: var(--border-radius); padding: var(--space-lg);
              max-width: 720px; }
  .askframe .af-header { display: flex; align-items: center; gap: var(--space-sm); }
  .askframe .af-chip { font-size: var(--text-label); text-transform: uppercase;
                       letter-spacing: 0.6px; font-weight: 600;
                       padding: 2px var(--space-sm); border-radius: var(--border-radius);
                       background: var(--vscode-badge-background, var(--bg-plot));
                       color: var(--vscode-badge-foreground, var(--vscode-foreground)); }
  .askframe .af-persona { color: var(--color-dim); font-style: italic; }
  .askframe .af-question { font-size: var(--text-value); font-weight: 600; }
  .askframe .af-options { display: flex; flex-direction: column; gap: var(--space-sm); }
  .askframe .af-option { display: flex; flex-direction: column; gap: var(--space-xs);
                         width: 100%; box-sizing: border-box;
                         padding: var(--space-sm) var(--space-md); cursor: pointer;
                         border: var(--border-width) solid var(--border-color);
                         border-radius: var(--border-radius);
                         background: var(--vscode-button-secondaryBackground, var(--bg-plot));
                         color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); }
  .askframe .af-option:hover { background: color-mix(in srgb, var(--color-accent-fill, var(--color-accent)) 12%,
                                           var(--vscode-button-secondaryBackground, var(--bg-plot))); }
  .askframe .af-option:active { background: color-mix(in srgb, var(--color-accent-fill, var(--color-accent)) 24%,
                                            var(--vscode-button-secondaryBackground, var(--bg-plot))); }
  .askframe .af-option .af-labelrow { display: flex; align-items: center;
                                      gap: var(--space-sm); }
  .askframe .af-option .af-label { font-weight: 600; font-size: var(--text-small); }
  .askframe .af-option .af-desc { font-size: var(--text-small); color: var(--color-dim); }
  .askframe .af-option.other { border-style: dashed; opacity: 0.85; }
  .askframe .af-options.af-multi .af-option:not(.other) .af-label::before { content: "☐ "; font-weight: 400; }
  .askframe .af-options.af-multi .af-option.selected .af-label::before { content: "☑ "; color: var(--color-accent); }
  .askframe .af-option.selected { border-color: var(--color-accent); }
  .askframe .af-confirm { display: flex; }
  .askframe .af-confirm button {
    font-family: var(--text-font); font-size: var(--text-small);
    padding: var(--space-xs) var(--space-md); cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c); }
  .askframe .af-confirm button:disabled { opacity: 0.5; cursor: not-allowed; }
  .askframe.proposed { border-style: dashed; }
  .askframe.proposed .af-chip::after { content: " · proposed"; opacity: 0.8; }
  .askframe .af-annotation { border-top: var(--border-width) dashed var(--border-color);
                             padding-top: var(--space-sm); font-size: var(--text-small);
                             color: var(--color-dim); }
  .askframe .af-annotation::before { content: "📝 "; }
`);

export interface AskOption {
  label: string;
  description?: string;
  default?: boolean;
  /** Branch key reported to onChoose. Defaults to the label. */
  value?: string;
}

export interface AskFrameSpec {
  /** Header chip, e.g. "system setup · 1/4". */
  stage: string;
  /** Amico's one-line persona lead-in (spec: lightweight anchor). */
  persona?: string;
  question: string;
  options: AskOption[];
  /** Storyboard annotation: provenance, divergences, feedback prompts. */
  annotation?: string;
  /** Amendment frame — not in the draft tree; rendered dashed/marked. */
  proposed?: boolean;
  /** Render the free-form Other slot (AskUserQuestion always offers it). */
  other?: boolean;
  /** Multi-select: options toggle, a confirm button submits the set (the
   *  physics question — the live Hamiltonian assembles from the selection). */
  multiple?: boolean;
}

export interface AskFrame {
  el: HTMLDivElement;
}

/** Single-select calls onChoose with the option value on click; multi-select
 *  calls it with the selected label SET on confirm. onToggle fires on every
 *  multi-select toggle so a live view (the Hamiltonian panel) can track it. */
export function askframe(spec: AskFrameSpec, onChoose: (value: string | string[]) => void, onToggle?: (selected: string[]) => void): AskFrame {
  const el = document.createElement("div");
  el.className = spec.proposed ? "askframe proposed" : "askframe";

  const header = document.createElement("div");
  header.className = "af-header";
  const chipEl = document.createElement("span");
  chipEl.className = "af-chip";
  chipEl.textContent = spec.stage;
  header.append(chipEl);
  el.append(header);

  if (spec.persona) el.append(text("af-persona", spec.persona).el);
  el.append(text("af-question", spec.question).el);

  const opts = document.createElement("div");
  opts.className = spec.multiple ? "af-options af-multi" : "af-options";
  const selected = new Set<string>();
  for (const o of spec.options) {
    const card = document.createElement("div");
    card.className = o.default ? "af-option default" : "af-option";
    const labelRow = document.createElement("div");
    labelRow.className = "af-labelrow";
    labelRow.append(text("af-label", o.label).el);
    if (o.default) labelRow.append(pill("done", "recommended", { dot: false }).el);
    card.append(labelRow);
    if (o.description) card.append(text("af-desc", o.description).el);
    const value = o.value ?? o.label;
    if (spec.multiple) {
      // Recommended default starts selected — toggling is refinement, not
      // building the set from zero.
      if (o.default) { selected.add(value); card.classList.add("selected"); }
      card.addEventListener("click", () => {
        card.classList.toggle("selected") ? selected.add(value) : selected.delete(value);
        confirm.disabled = selected.size === 0;
        confirm.textContent = `use these (${selected.size})`;
        onToggle?.([...selected]);
      });
    } else {
      card.addEventListener("click", () => onChoose(value));
    }
    opts.append(card);
  }
  if (spec.other ?? true) {
    const card = document.createElement("div");
    card.className = "af-option other";
    card.append(text("af-label", "Other…").el, text("af-desc", "free-form answer").el);
    card.addEventListener("click", () => onChoose("__other"));
    opts.append(card);
  }
  el.append(opts);

  const confirm = document.createElement("button");
  if (spec.multiple) {
    confirm.textContent = `use these (${selected.size})`;
    confirm.disabled = selected.size === 0;
    confirm.addEventListener("click", () => onChoose([...selected]));
    const row = document.createElement("div");
    row.className = "af-confirm";
    row.append(confirm);
    el.append(row);
  }

  if (spec.annotation) el.append(text("af-annotation", spec.annotation).el);
  return { el };
}
