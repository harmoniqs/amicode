import { Show } from "solid-js"
import type { RunVerdict } from "./problem"

// AMICODE Run hero (ring-2 verdict-first redesign): the fidelity + status
// verdict that replaces the raw field dump. The data (fidelity/status/
// iteration) comes from GET /amicode/run-status — already polled for the rail's
// run chip — so the dialog now leads with the one fact it used to omit. Thin;
// the verdict model is computed by the pure runVerdict() in ./problem.ts. The
// full field table still lives one "Show all fields" disclosure below. Styling
// in ./amicode.css.

const STATUS_LABEL: Record<string, string> = {
  finished: "finished",
  solving: "solving…",
  stalled: "stalled",
  stopped: "stopped",
  aborted: "aborted",
  failed: "failed",
  recorded: "recorded",
}
// tone → status-badge color, mapped to theme semantics in css (ok/warn/critical).
const STATUS_TONE: Record<string, string> = {
  finished: "ok",
  solving: "active",
  stalled: "warn",
  stopped: "muted",
  aborted: "muted",
  failed: "critical",
  recorded: "muted",
}

export function RunVerdictView(props: { verdict: RunVerdict }) {
  const v = () => props.verdict
  return (
    <div class="amc-run" data-component="amicode-run-view">
      <div class="amc-ev-sec">Result</div>
      <div class="amc-run-head">
        <Show when={v().fidelity !== null}>
          <span class="amc-run-fid" data-slot="amicode-run-fidelity">
            <span class="amc-run-fk">F</span> = {v().fidelity}
          </span>
        </Show>
        <span class="amc-run-status" data-slot="amicode-run-status" data-tone={STATUS_TONE[v().status] ?? "muted"}>
          {STATUS_LABEL[v().status] ?? v().status}
        </span>
      </div>
      <Show when={v().iteration !== null}>
        <div class="amc-term">
          <div class="amc-term-head">
            <span class="amc-term-name">iterations</span>
          </div>
          <div class="amc-term-val" data-slot="amicode-run-iters">{v().iteration}</div>
        </div>
      </Show>
    </div>
  )
}
