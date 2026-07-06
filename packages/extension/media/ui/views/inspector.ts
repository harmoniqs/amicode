// Inspector view — per-run panes (1.3) over the post-#67 native pulse protocol.
// Owns the runId-keyed message protocol shared with run_inspector.ts:
//   runlabel · iteration · warming · completed · pulsemeta · pulse   (+ activate/ping)
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
import { metric } from "../components/metric";
import { pulseplot } from "../components/pulseplot";

defineStyle("inspector-view", `
  body { margin: 0; height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground); }
  .brand { font-weight: 600; }
  /* Panes carry .stack (display:flex from layout.css). Use two-class selectors so
     these win over .stack on specificity — not on stylesheet order. */
  .pane:not(.active) { display: none; }
  .pane.active { display: flex; }
`);

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
}

function createPanel(): Panel {
  const status = pill("idle");
  const runLabel = text("mono small dim");
  const pulse = pulseplot(IDLE_HINT);
  const hero = metric("objective", { hero: true });
  const iteration = metric("iteration");
  const feasibility = metric("feasibility");
  const optimality = metric("optimality");
  const metrics = [hero, iteration, feasibility, optimality];
  let gotPulse = false;   // per-pane: decides the completed-without-data hint

  const brand = document.createElement("div");
  brand.className = "row gap-sm brand";
  brand.append(mark(), text("", "Run Inspector").el);

  const topbar = document.createElement("div");
  topbar.className = "row wrap";
  status.el.classList.add("push-end");
  topbar.append(brand, runLabel.el, status.el);

  const grid = document.createElement("div");
  grid.className = "grid-fit";
  grid.append(...metrics.map((m) => m.el));

  const el = document.createElement("div");
  el.className = "pane stack pad-lg scroll-y";
  el.style.height = "100vh";
  el.append(topbar, pulse.el, grid);

  return {
    el,
    apply(msg: Record<string, unknown>): void {
      switch (msg.type) {
        case "runlabel":
          runLabel.set(String(msg.text ?? ""));
          break;
        case "iteration":
          hero.label("objective");
          hero.value((msg.f_val as number).toExponential(4));
          iteration.value(String(msg.iter));
          feasibility.value((msg.eq_viol as number).toExponential(2));
          optimality.value((msg.kkt_error as number).toExponential(2));
          status.set("running", "running");
          break;
        case "warming":
          gotPulse = false;
          pulse.waiting(WARMING_HINT);
          for (const m of metrics) m.clear();
          hero.label("objective");
          status.set("running", "warming up");
          break;
        case "completed": {
          const ok = msg.status === "completed";
          status.set(ok ? "done" : "failed", ok ? "converged" : String(msg.status));
          if (ok && typeof msg.fidelity === "number") {
            hero.label("fidelity");
            hero.value((msg.fidelity as number).toFixed(5));
          }
          if (!gotPulse) pulse.waiting(NO_DATA_HINT);
          break;
        }
        case "pulsemeta":
          pulse.meta({ drives: msg.drives as number, knots: msg.knots as number, labels: msg.labels as string[], bounds: msg.bounds as [number, number][] });
          break;
        case "pulse":
          // Plot-only (never the badge): a throttled record can land after
          // "completed", and for a background run must not touch the visible pane.
          gotPulse = true;
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
      p = createPanel();
      panels.set(runId, p);
      el.append(p.el);
    }
    return p;
  };

  const activate = (runId: string): void => {
    active = runId;
    empty.el.style.display = "none";
    for (const [id, p] of panels) p.el.classList.toggle("active", id === runId);
    if (!panels.has(runId)) panelFor(runId).el.classList.add("active");   // pane may arrive before data
  };

  return {
    el,
    onMessage(msg: any): void {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") { post({ type: "pong", seq: msg.seq, t0: msg.t0 }); return; }
      if (msg.type === "activate") { if (typeof msg.runId === "string") activate(msg.runId); return; }
      // Every other message is runId-keyed → route to that run's pane. A message
      // with no runId (legacy/none) falls back to the active pane.
      const runId = typeof msg.runId === "string" ? msg.runId : active;
      if (!runId) return;
      panelFor(runId).apply(msg as Record<string, unknown>);
    },
  };
}
