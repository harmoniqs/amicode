// Inspector view — per-run panes (1.3) over the post-#67 native pulse protocol.
// Owns the runId-keyed message protocol shared with run_inspector.ts:
//   runlabel · tags · iteration · warming · completed · pulsemeta · pulse   (+ activate/ping)
// every message carries `runId`; the view keeps ONE `panel` per runId and shows
// the ACTIVE one (host sends `activate`). A late/throttled message for a
// background run updates ITS pane only — never the visible pane's badge/plot
// (no cross-talk; #67's plot-only-pulse property preserved per pane).
//
// The live pulse renders NATIVELY from pulse data (#66); per-iter PNGs remain
// archival. Pane MARKUP is the design lane (UX4 #49) — this is the plumbing
// reshape (freeze 2: the runId-keyed protocol, not the DOM).

import { defineStyle } from "../style";
import { mark } from "../atoms/icon";
import { pill } from "../atoms/pill";
import { text } from "../atoms/text";
import { button } from "../atoms/button";
import { metric } from "../components/metric";
import { pulseplot } from "../components/pulseplot";
import { sparkline } from "../components/sparkline";
import { controlEnablement, type ControlStatus } from "../control-state";
import { formatElapsed, computeEta, ratePerSec } from "../../../src/run_timing";

defineStyle(
  "inspector-view",
  `
  body { margin: 0; height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground); }
  .brand { font-weight: 600; }
  /* Panes carry .stack (display:flex from layout.css). Use two-class selectors so
     these win over .stack on specificity — not on stylesheet order. */
  .pane:not(.active) { display: none; }
  .pane.active { display: flex; }
  /* Tags aren't in any run schema yet (Krishna's field-selection question) —
     the dashed underline is the project's established "proposed" treatment
     (chip.ts, catalogcard.ts use the same visual language). */
  .tag { border-bottom: 1px dashed var(--color-dim); opacity: 0.85; }
  .tags:empty { display: none; }
`,
);

const IDLE_HINT = "No solve in progress — fire one from the Amicode chat, or run “Replay demo run”.";
const WARMING_HINT = "Julia warming up — compiling the solver (~1–2 min). The pulse will stream here.";
const NO_DATA_HINT = "This run carries no pulse data — re-run with the current solve template to see the live pulse.";

export interface InspectorView {
  el: HTMLElement;
  onMessage(msg: unknown): void;
}

/** One run's pane — the β single-run view, now instanced per runId. No
 *  single-run globals: everything (status, plot, metrics, gotPulse) is closed
 *  over here, so N panes never share state. */
interface Panel {
  el: HTMLElement;
  apply(msg: Record<string, unknown>): void;
  /** Hidden panes pause their 1 Hz timing ticker (review/audit #8) — the strip
   *  re-renders and resumes on activation. */
  setActive(active: boolean): void;
}

function createPanel(post: (msg: unknown) => void, runId?: string): Panel {
  const status = pill("idle");
  const runLabel = text("mono small dim");
  const pulse = pulseplot(IDLE_HINT);
  // Layout order (left→right): ITER counter · OBJECTIVE hero · FEAS · OPT.
  const iteration = metric("iteration", { variant: "counter" });
  const hero = metric("objective", { variant: "hero" });
  const feasibility = metric("feasibility", { variant: "small" });
  const optimality = metric("optimality", { variant: "small" });
  const metrics = [iteration, hero, feasibility, optimality];

  // Convergence sparkline lives inside the hero, under the objective value.
  const spark = sparkline();
  hero.el.append(spark.el);

  let gotPulse = false; // per-pane: decides the completed-without-data hint

  const brand = document.createElement("div");
  brand.className = "row gap-sm brand";
  brand.append(mark(), text("", "Run Inspector").el);

  // "run" caption so the label reads as an identity, not stray metadata — the
  // label itself is currently just the runId (setRunLabel(runId, runId) on the
  // host); a friendlier value is a later data-model question, not this PR's.
  const runLabelRow = document.createElement("div");
  runLabelRow.className = "row gap-xs";
  runLabelRow.append(text("label-k", "run").el, runLabel.el);

  const topbar = document.createElement("div");
  topbar.className = "row wrap";
  status.el.classList.add("push-end");
  topbar.append(brand, runLabelRow, status.el);

  // Pulse tags (#49, UX4 — Krishna p1/p2). Not in any run schema yet, so they
  // render with the project's established "proposed" dashed treatment
  // (chip.ts, catalogcard.ts) — visibly present, visibly not-yet-real.
  const tagsRow = document.createElement("div");
  tagsRow.className = "row gap-xs tags";
  function renderTags(tags: string[]): void {
    tagsRow.replaceChildren(...tags.map((t) => text("tag small", t).el));
  }

  const grid = document.createElement("div");
  grid.className = "metric-row";
  grid.append(...metrics.map((m) => m.el));

  // Control row — Stop / Save pulse / Open run dir. Each posts to the extension
  // (run_inspector.ts routes {type:"control", action} to the matching command).
  const stopBtn = button("■ Stop", () => post({ type: "control", action: "stop", runId }));
  const saveBtn = button("↓ Save pulse", () => post({ type: "control", action: "save", runId }));
  const openBtn = button("↗ Open run dir", () => post({ type: "control", action: "open", runId }));
  const controls = document.createElement("div");
  controls.className = "row gap-sm wrap push-end";
  controls.append(stopBtn.el, saveBtn.el, openBtn.el);

  let controlStatus: ControlStatus = "idle";
  let hasData = false;
  const applyControls = () => {
    const e = controlEnablement(controlStatus, hasData);
    stopBtn.enable(e.stop);
    saveBtn.enable(e.save);
    openBtn.enable(e.open);
  };
  applyControls();

  // Elapsed / rate / ETA strip. Ticks 1 Hz while running from run.toml
  // created_at; freezes at result.toml wall_seconds on finish.
  const timing = text("mono small dim");
  let createdAtMs: number | undefined;
  let maxIter: number | undefined;
  let latestIter = 0;
  const iterStamps: number[] = []; // arrival times → rate
  let tick: ReturnType<typeof setInterval> | undefined;
  const clearTick = () => {
    if (tick) {
      clearInterval(tick);
      tick = undefined;
    }
  };
  const renderTiming = () => {
    if (createdAtMs === undefined) {
      timing.set("");
      return;
    }
    const parts = [`elapsed ${formatElapsed((Date.now() - createdAtMs) / 1000)}`];
    const r = ratePerSec(iterStamps);
    if (r !== undefined) {
      parts.push(`${r.toFixed(1)} it/s`);
      const eta = computeEta({ iter: latestIter, maxIter, ratePerSec: r });
      if (eta !== undefined) parts.push(`ETA ~${formatElapsed(eta)}`);
    }
    timing.set(parts.join(" · "));
  };

  const footer = document.createElement("div");
  footer.className = "row wrap";
  footer.append(timing.el, controls);

  const el = document.createElement("div");
  el.className = "pane stack pad-lg scroll-y";
  el.style.height = "100vh";
  el.append(topbar, tagsRow, pulse.el, grid, footer);

  return {
    el,
    setActive(active: boolean): void {
      if (!active) {
        clearTick();
        return;
      }
      if (createdAtMs !== undefined) {
        renderTiming();
        if (!tick) tick = setInterval(renderTiming, 1000);
      }
    },
    apply(msg: Record<string, unknown>): void {
      switch (msg.type) {
        case "runlabel":
          runLabel.set(String(msg.text ?? ""));
          break;
        case "tags":
          renderTags(Array.isArray(msg.tags) ? (msg.tags as string[]) : []);
          break;
        case "timing": {
          if (msg.terminal) {
            clearTick();
            createdAtMs = undefined;
            if (typeof msg.wallSeconds === "number") timing.set(`elapsed ${formatElapsed(msg.wallSeconds)}`);
            break;
          }
          if (typeof msg.createdAtMs === "number") createdAtMs = msg.createdAtMs;
          if (typeof msg.maxIter === "number") maxIter = msg.maxIter;
          renderTiming();
          if (!tick) tick = setInterval(renderTiming, 1000);
          break;
        }
        case "iteration": {
          hero.label("objective");
          hero.value((msg.f_val as number).toExponential(4));
          iteration.value(String(msg.iter));
          feasibility.value((msg.eq_viol as number).toExponential(2));
          optimality.value((msg.kkt_error as number).toExponential(2));
          status.set("running", "running");
          controlStatus = "running";
          hasData = true;
          applyControls();
          latestIter = msg.iter as number;
          iterStamps.push(Date.now());
          if (iterStamps.length > 12) iterStamps.shift();
          renderTiming();
          spark.update(msg.f_val as number);
          break;
        }
        case "warming":
          gotPulse = false;
          pulse.waiting(WARMING_HINT);
          for (const m of metrics) m.clear();
          hero.label("objective");
          status.set("running", "warming up");
          controlStatus = "warming";
          hasData = false;
          applyControls();
          iterStamps.length = 0;
          latestIter = 0; // new run — reset rate history
          spark.reset();
          break;
        case "completed": {
          const ok = msg.status === "completed";
          const stopped = msg.status === "stopped";
          // stopped = graceful user stop (neutral, dim); completed = success;
          // anything else = failure.
          status.set(ok ? "done" : stopped ? "idle" : "failed", ok ? "converged" : String(msg.status));
          // Promote the hero card to the final fidelity — the number that matters.
          if (ok && typeof msg.fidelity === "number") {
            hero.label("fidelity");
            hero.value((msg.fidelity as number).toFixed(5));
          }
          if (!gotPulse) pulse.waiting(NO_DATA_HINT); // old runs / non-emitting scripts
          controlStatus = ok ? "completed" : stopped ? "stopped" : "failed";
          applyControls();
          break;
        }
        case "pulsemeta":
          pulse.meta({
            drives: msg.drives as number,
            knots: msg.knots as number,
            labels: msg.labels as string[],
            bounds: msg.bounds as [number, number][],
          });
          break;
        case "pulse":
          // Plot-only (never the badge): a throttled record can land after
          // "completed", and for a background run must not touch the visible pane.
          gotPulse = true;
          hasData = true;
          applyControls();
          pulse.update({ iter: msg.iter as number, dt: msg.dt as number, values: msg.values as number[][] });
          break;
      }
    },
  };
}

export function createInspectorView(post: (msg: unknown) => void): InspectorView {
  const panels = new Map<string, Panel>();
  let active: string | undefined;

  // Shell holds the panes; an empty-state hint shows until the first run.
  const empty = text("dim", IDLE_HINT);
  empty.el.className = "pad-lg dim";

  const el = document.createElement("div");
  el.style.height = "100vh";
  el.append(empty.el);

  const panelFor = (runId: string): Panel => {
    let p = panels.get(runId);
    if (!p) {
      p = createPanel(post, runId);
      panels.set(runId, p);
      el.append(p.el);
    }
    return p;
  };

  const activate = (runId: string): void => {
    active = runId;
    empty.el.style.display = "none";
    for (const [id, p] of panels) {
      p.el.classList.toggle("active", id === runId);
      p.setActive(id === runId);
    }
    if (!panels.has(runId)) panelFor(runId).el.classList.add("active"); // pane may arrive before data
  };

  return {
    el,
    onMessage(msg: any): void {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") {
        post({ type: "pong", seq: msg.seq, t0: msg.t0 });
        return;
      }
      if (msg.type === "activate") {
        if (typeof msg.runId === "string") activate(msg.runId);
        return;
      }
      // Every other message is runId-keyed → route to that run's pane. A message
      // with no runId (legacy/none) falls back to the active pane.
      const runId = typeof msg.runId === "string" ? msg.runId : active;
      if (!runId) return;
      panelFor(runId).apply(msg as Record<string, unknown>);
    },
  };
}
