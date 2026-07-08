// Onboarding + pulse-design storyboard (#46) — a static, clickable frame
// sequence previewing the interview: system setup (platform / hamiltonian /
// config) and pulse design (initiate interview → decision tree → a tagged
// pulse). NOT a chat renderer: v1 renders every real question through
// AskUserQuestion (spec-20260614-231647-amicode-interview-ux) — this exists to
// get feedback on question set/order/defaults, so every frame says so. Options
// shown are the DEFAULT state only and are not individually interactive; a
// working question-tree renderer would relitigate the settled v1 decision.

import { defineStyle } from "../style";
import { text } from "../atoms/text";
import { button } from "../atoms/button";
import { chip } from "../components/chip";

defineStyle(
  "storyboard",
  `
  .storyboard { display: flex; flex-direction: column; gap: var(--space-lg); padding: var(--space-lg); max-width: 480px; }
  .storyboard .title { font-weight: 600; font-size: var(--text-value); }
  .storyboard .rendered-note { font-style: italic; }
  .storyboard .group { display: flex; flex-direction: column; gap: var(--space-sm); }
  .storyboard .opt-row { display: flex; align-items: center; gap: var(--space-sm);
                          padding: var(--space-xs) var(--space-sm); border-radius: var(--border-radius);
                          border: var(--border-width) solid var(--border-color); }
  .storyboard .opt-row.default { border-color: var(--color-accent); }
  .storyboard .opt-mark { width: var(--square-dot); height: var(--square-dot); border-radius: 50%;
                           border: var(--border-width) solid currentColor; flex: 0 0 auto; color: var(--color-dim); }
  .storyboard .opt-row.default .opt-mark { background: var(--color-accent); border-color: var(--color-accent); }
  .storyboard .nav { display: flex; align-items: center; justify-content: space-between; gap: var(--space-md); }
  .storyboard .dots { display: flex; gap: var(--space-xs); }
  .storyboard .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--border-color); }
  .storyboard .dot.current { background: var(--color-accent); }
`,
);

export type Section = "System setup" | "Pulse design";

export interface StoryboardGroup {
  prompt: string;
  options: string[];
  /** Checkbox-style group (config keep-track-of list) vs single-select (radio). */
  multi?: boolean;
  defaultIndex?: number;
  defaultChecked?: number[];
}

export interface StoryboardFrame {
  section: Section;
  title: string;
  groups?: StoryboardGroup[];
  /** Frame 6 only: preview the resulting tagged pulse via the #47 chip component. */
  chipPreview?: boolean;
}

// Grounded in Krishna's UX interview (2026-06-30, p3+p5): system setup =
// platform / hamiltonian / config; pulse design = initiate interview →
// decision tree → tagged pulse. Content is Jack's lane to steer — this is a
// first pass for the storyboard shell, not a locked question set.
export const FRAMES: StoryboardFrame[] = [
  {
    section: "System setup",
    title: "Platform",
    groups: [
      {
        prompt: "Which hardware platform is this pulse for?",
        options: ["Transmon", "Fluxonium", "Neutral atoms", "Trapped ions"],
        defaultIndex: 0,
      },
    ],
  },
  {
    section: "System setup",
    title: "Hamiltonian",
    groups: [
      {
        prompt: "Confirm the system Hamiltonian (from lab.toml)",
        options: [
          "3 levels · ω=5.0 GHz · δ=0.2 GHz · drive_max=0.2 GHz — accept",
          "Edit these values",
        ],
        defaultIndex: 0,
      },
    ],
  },
  {
    section: "System setup",
    title: "Config",
    groups: [
      {
        prompt: "What should Amicode keep track of for you?",
        options: ["Best pulse per gate", "Full run history", "Device calibration notes", "Nothing — session only"],
        multi: true,
        defaultChecked: [0, 1],
      },
    ],
  },
  {
    section: "Pulse design",
    title: "Initiate interview",
    groups: [
      {
        prompt: "What are we optimizing?",
        options: ["A specific gate (e.g. CZ, X, H)", "A custom objective"],
        defaultIndex: 0,
      },
    ],
  },
  {
    section: "Pulse design",
    title: "Decision tree",
    groups: [
      { prompt: "Optimize for:", options: ["Fidelity", "Speed", "Robustness"], defaultIndex: 0 },
      { prompt: "Initial guess:", options: ["Cold start", "Warm-start from catalog"], defaultIndex: 1 },
    ],
  },
  {
    section: "Pulse design",
    title: "Tagged pulse",
    chipPreview: true,
  },
];

export interface StoryboardView {
  el: HTMLElement;
}

function renderGroup(g: StoryboardGroup): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "group";
  wrap.append(text("label-k", g.prompt).el);
  g.options.forEach((opt, i) => {
    const row = document.createElement("div");
    const isDefault = g.multi ? (g.defaultChecked ?? []).includes(i) : g.defaultIndex === i;
    row.className = "opt-row" + (isDefault ? " default" : "");
    const mark = document.createElement("span");
    mark.className = "opt-mark";
    row.append(mark, text("small", opt).el);
    wrap.append(row);
  });
  return wrap;
}

export function createStoryboardView(frames: StoryboardFrame[] = FRAMES): StoryboardView {
  const el = document.createElement("div");
  el.className = "storyboard";

  const sectionLabel = text("label-k");
  const titleLabel = text("title");
  const stepLabel = text("mono small dim");
  const renderedNote = text(
    "small dim rendered-note",
    "Rendered by AskUserQuestion in v1 — this frame previews content only.",
  );
  const body = document.createElement("div");
  body.className = "group";

  const dots = document.createElement("div");
  dots.className = "dots";
  const dotEls = frames.map(() => {
    const d = document.createElement("span");
    d.className = "dot";
    dots.append(d);
    return d;
  });

  let idx = 0;

  function render(): void {
    const f = frames[idx];
    sectionLabel.set(f.section);
    titleLabel.set(f.title);
    stepLabel.set(`Step ${idx + 1} of ${frames.length}`);
    body.replaceChildren();
    for (const g of f.groups ?? []) body.append(renderGroup(g));
    if (f.chipPreview) {
      const wrap = document.createElement("div");
      wrap.className = "group";
      wrap.append(chip({ gate: "CZ", system: "transmon·3lvl", tags: ["smooth"], index: 1 }).el);
      wrap.append(text("small dim", "Saved to the catalog automatically (#47).").el);
      body.append(wrap);
    }
    dotEls.forEach((d, i) => d.classList.toggle("current", i === idx));
    prevBtn.enable(idx > 0);
    nextBtn.enable(idx < frames.length - 1);
  }

  const prevBtn = button("← Prev", () => {
    if (idx > 0) {
      idx--;
      render();
    }
  });
  const nextBtn = button("Next →", () => {
    if (idx < frames.length - 1) {
      idx++;
      render();
    }
  });

  const nav = document.createElement("div");
  nav.className = "nav";
  nav.append(prevBtn.el, dots, nextBtn.el);

  const sectionRow = document.createElement("div");
  sectionRow.append(sectionLabel.el);
  const titleRow = document.createElement("div");
  titleRow.append(titleLabel.el);

  el.append(sectionRow, titleRow, stepLabel.el, renderedNote.el, body, nav);
  render();
  return { el };
}
