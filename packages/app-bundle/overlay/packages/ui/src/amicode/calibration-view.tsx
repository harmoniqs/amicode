import { Show } from "solid-js"
import type { CalibrationVerdict } from "./problem"

// AMICODE Calibration hero (ring-2 verdict-first redesign). No calibration
// entity or schema exists in Phase 0 (per amico-catalog: `calibrated` lands in
// a later phase); this renders the PROPOSED freshness verdict when a
// calibration entity with a timestamp/source arrives (design-leads-schema-
// follows). Until then calibrationVerdict() returns null → the dialog shows the
// raw field table / empty state instead. Styling in ./amicode.css.

export function CalibrationView(props: { verdict: CalibrationVerdict }) {
  const v = () => props.verdict
  return (
    <div class="amc-calib" data-component="amicode-calibration-view">
      <Show when={v().freshness || v().ageLabel}>
        <div class="amc-verdict-pills">
          <Show when={v().freshness}>
            {(f) => (
              <span
                class="amc-vpill"
                data-slot="amicode-calibration-freshness"
                data-tone={f() === "fresh" ? "ok" : "warn"}
              >
                {f()}
              </span>
            )}
          </Show>
          <Show when={v().ageLabel}>
            {(a) => (
              <span class="amc-vmeta" data-slot="amicode-calibration-age">
                calibrated {a()}
              </span>
            )}
          </Show>
        </div>
      </Show>
      <Show when={v().source}>
        {(src) => (
          <>
            <div class="amc-ev-sec">Source</div>
            <div class="amc-calib-source" data-slot="amicode-calibration-source">
              <div class="amc-term">
                <div class="amc-term-head">
                  <span class="amc-term-name">source</span>
                </div>
                <div class="amc-term-val">{src()}</div>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
