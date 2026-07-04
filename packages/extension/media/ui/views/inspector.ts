// Inspector view — pure composition of atoms/components + layout selectors.
// Owns the message protocol (runlabel / iteration / warming / completed /
// pulsemeta / pulse / ping) shared with run_inspector.ts.
//
// The live pulse renders NATIVELY from pulse data (#66) — the per-iter PNGs
// remain run-dir/archival artifacts but are no longer displayed. A run whose
// log carries no pulse lines shows a hint instead of a plot.

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

defineStyle("inspector-view", `
  body { margin: 0; height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground); }
  .brand { font-weight: 600; }
`);

const IDLE_HINT = "No solve in progress — fire one from the Amicode chat, or run “Replay demo run”.";
const WARMING_HINT = "Julia warming up — compiling the solver (~1–2 min). The pulse will stream here.";
const NO_DATA_HINT = "This run carries no pulse data — re-run with the current solve template to see the live pulse.";

export interface InspectorView {
  el: HTMLElement;
  onMessage(msg: unknown): void;
}

export function createInspectorView(post: (msg: unknown) => void): InspectorView {
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

  /** Whether the current run has delivered pulse data — decides the
   *  completed-without-data hint. Reset on warming (a NEW run started). */
  let gotPulse = false;

  const brand = document.createElement("div");
  brand.className = "row gap-sm brand";
  brand.append(mark(), text("", "Run Inspector").el);

  const topbar = document.createElement("div");
  topbar.className = "row wrap";
  status.el.classList.add("push-end");
  topbar.append(brand, runLabel.el, status.el);

  const grid = document.createElement("div");
  grid.className = "metric-row";
  grid.append(...metrics.map((m) => m.el));

  // Control row — Stop / Save pulse / Open run dir. Each posts to the extension
  // (run_inspector.ts routes {type:"control", action} to the matching command).
  const stopBtn = button("■ Stop", () => post({ type: "control", action: "stop" }));
  const saveBtn = button("↓ Save pulse", () => post({ type: "control", action: "save" }));
  const openBtn = button("↗ Open run dir", () => post({ type: "control", action: "open" }));
  const controls = document.createElement("div");
  controls.className = "row gap-sm wrap push-end";
  controls.append(stopBtn.el, saveBtn.el, openBtn.el);

  let controlStatus: ControlStatus = "idle";
  let hasData = false;
  const applyControls = () => {
    const e = controlEnablement(controlStatus, hasData);
    stopBtn.enable(e.stop); saveBtn.enable(e.save); openBtn.enable(e.open);
  };
  applyControls();

  // Elapsed / rate / ETA strip. Ticks 1 Hz while running from run.toml
  // created_at; freezes at result.toml wall_seconds on finish.
  const timing = text("mono small dim");
  let createdAtMs: number | undefined;
  let maxIter: number | undefined;
  let latestIter = 0;
  const iterStamps: number[] = [];   // arrival times → rate
  let tick: ReturnType<typeof setInterval> | undefined;
  const clearTick = () => { if (tick) { clearInterval(tick); tick = undefined; } };
  const renderTiming = () => {
    if (createdAtMs === undefined) { timing.set(""); return; }
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
  el.className = "stack pad-lg scroll-y";
  el.style.height = "100vh";
  el.append(topbar, pulse.el, grid, footer);

  return {
    el,
    onMessage(msg: any): void {
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "ping": {
          post({ type: "pong", seq: msg.seq, t0: msg.t0 });
          break;
        }
        case "runlabel": {
          runLabel.set(String(msg.text ?? ""));
          break;
        }
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
          controlStatus = "running"; hasData = true; applyControls();
          latestIter = msg.iter as number;
          iterStamps.push(Date.now());
          if (iterStamps.length > 12) iterStamps.shift();
          renderTiming();
          spark.update(msg.f_val as number);
          break;
        }
        case "warming": {
          // A NEW run started but has no data yet — clear the previous run's
          // plot + stats so the old pulse doesn't linger while the new solve
          // compiles/warms up.
          gotPulse = false;
          pulse.waiting(WARMING_HINT);
          for (const m of metrics) m.clear();
          hero.label("objective");
          status.set("running", "warming up");
          controlStatus = "warming"; hasData = false; applyControls();
          iterStamps.length = 0; latestIter = 0;   // new run — reset rate history
          spark.reset();
          break;
        }
        case "completed": {
          // Authoritative terminal state from the watcher (FINISHED on disk).
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
          if (!gotPulse) pulse.waiting(NO_DATA_HINT);   // old runs / non-emitting scripts
          controlStatus = (ok ? "completed" : stopped ? "stopped" : "failed"); applyControls();
          break;
        }
        case "pulsemeta": {
          pulse.meta({ drives: msg.drives, knots: msg.knots, labels: msg.labels, bounds: msg.bounds });
          break;
        }
        case "pulse": {
          // Plot-only: never touches the status pill (a throttled record can
          // legally land after "completed"; the badge must not regress).
          gotPulse = true;
          hasData = true; applyControls();
          pulse.update({ iter: msg.iter, dt: msg.dt, values: msg.values });
          break;
        }
      }
    },
  };
}
