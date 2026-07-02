// Inspector view — pure composition of atoms/components + layout selectors.
// Owns the message protocol (runlabel / iteration / warming / completed /
// refresh / ping) shared with run_inspector.ts.

import { defineStyle } from "../style";
import { mark } from "../atoms/icon";
import { pill } from "../atoms/pill";
import { text } from "../atoms/text";
import { metric } from "../components/metric";
import { preview } from "../components/preview";

defineStyle("inspector-view", `
  body { margin: 0; height: 100vh; font-family: var(--text-font);
         font-size: var(--text-body); color: var(--vscode-foreground); }
  .brand { font-weight: 600; }
`);

const IDLE_HINT = "No solve in progress — fire one from the Amicode chat, or run “Replay demo run”.";
const WARMING_HINT = "Julia warming up — compiling the solver + plotter (~1–2 min). Frames will stream here.";

export interface InspectorView {
  el: HTMLElement;
  onMessage(msg: unknown): void;
}

export function createInspectorView(post: (msg: unknown) => void): InspectorView {
  const status = pill("idle");
  const runLabel = text("mono small dim");
  const frames = preview(IDLE_HINT);
  const hero = metric("objective", { hero: true });
  const iteration = metric("iteration");
  const feasibility = metric("feasibility");
  const optimality = metric("optimality");
  const metrics = [hero, iteration, feasibility, optimality];

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
  el.className = "stack pad-lg scroll-y";
  el.style.height = "100vh";
  el.append(topbar, frames.el, grid);

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
        case "iteration": {
          hero.label("objective");
          hero.value((msg.f_val as number).toExponential(4));
          iteration.value(String(msg.iter));
          feasibility.value((msg.eq_viol as number).toExponential(2));
          optimality.value((msg.kkt_error as number).toExponential(2));
          status.set("running", "running");
          break;
        }
        case "warming": {
          // A NEW run started but has no frame yet — clear the previous run's
          // plot + stats so the old iter-N image doesn't linger while the new
          // solve compiles/warms up.
          frames.waiting(WARMING_HINT);
          for (const m of metrics) m.clear();
          hero.label("objective");
          status.set("running", "warming up");
          break;
        }
        case "completed": {
          // Authoritative terminal state from the watcher (FINISHED on disk).
          const ok = msg.status === "completed";
          status.set(ok ? "done" : "failed", ok ? "converged" : String(msg.status));
          // Promote the hero card to the final fidelity — the number that matters.
          if (ok && typeof msg.fidelity === "number") {
            hero.label("fidelity");
            hero.value((msg.fidelity as number).toFixed(5));
          }
          break;
        }
        case "refresh": {
          frames.show(msg.url, () => iteration.value(String(msg.iter)));
          status.set("running", "running");   // a new frame means a live solve; completion arrives via "completed"
          break;
        }
      }
    },
  };
}
