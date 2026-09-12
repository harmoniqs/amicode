import { For, Show, createMemo } from "solid-js"
import {
  type ProblemView,
  type RunStatusView,
  calibrationVerdict,
  deviceVerdict,
  editPromptText,
  entityRows,
  fieldGroup,
  formulationProjection,
  historyRows,
  humanizeKey,
  runVerdict,
  systemProjection,
} from "./problem"
import { SystemComposite } from "./system-view"
import { FormulationView } from "./formulation-view"
import { RunVerdictView } from "./run-view"
import { DeviceView } from "./device-view"
import { CalibrationView } from "./calibration-view"

// AMICODE ring-2 entity view (spec B): dialog BODY opened from a rail chip or
// diff receipt — current fields (pretty table + per-field "Edit in chat"
// draft handoff), event history for this entity ("which turn changed this"),
// and tier treatment on Run entities. READ-ONLY + edit-in-chat only: all
// writes route through the agent's tools (ring 0), so entity state and
// conversation never fork. Presentation-only over ./problem.ts helpers; the
// app owns fetching and wraps this in its Dialog.
//
// Redesign: raw wire keys lead with a human label (params.drive_max → "Drive
// max") and keep the technical name underneath; nested groups get a subhead;
// the field you arrived from (anchorSeq's diff) is marked; the ✎ affordance is
// always faintly present, not hover-only; and a footer states the read-only /
// edit-in-chat contract so the absence of Save buttons reads as intent. Styling
// is in ./amicode.css; data-slot hooks are preserved for the e2e suite.

// (System Hamiltonian LaTeX now lives in ./system-view.tsx's SystemComposite.)
// (Event history removed 2026-07-23 — the change-log was meta-noise, not the
// decision-relevant physics; entity views surface current state only.)

// Per-kind raw-field-table suppressions: linkage/metadata that's noise in the
// dialog (the Run's system_ref/formulation_ref/tier/note — Kate 2026-07-24; the
// Run modal leads with the verdict + derived problem size instead).
const HIDDEN_FIELDS: Record<string, Set<string>> = {
  run: new Set(["system_ref", "formulation_ref", "tier", "note"]),
}

export function AmicodeEntityView(props: {
  view: ProblemView | undefined // undefined → loading skeleton
  kind: string
  runStatus?: RunStatusView[] // live run-status (for the Run verdict); ignored otherwise
  anchorSeq?: number
  onDraftPrompt: (text: string) => void
  onRetry: () => void
  retryLabel: string
  editLabel: string
}) {
  const entity = createMemo(() => props.view?.entities[props.kind] ?? {})
  const rows = createMemo(() => {
    const hidden = HIDDEN_FIELDS[props.kind]
    const all = entityRows(entity())
    if (!hidden) return all
    return all.filter((r) => !hidden.has(r.key) && !hidden.has(r.key.split(".").pop() ?? r.key))
  })
  const history = createMemo(() => (props.view ? historyRows(props.view.events, props.kind) : []))
  const anchored = createMemo(() =>
    props.anchorSeq !== undefined && history().some((event) => event.seq === props.anchorSeq)
      ? props.anchorSeq
      : undefined,
  )
  const changedKeys = createMemo(() => {
    const seq = anchored()
    const set = new Set<string>()
    if (seq === undefined) return set
    const event = history().find((candidate) => candidate.seq === seq)
    if (event?.diff)
      for (const key of Object.keys(event.diff)) {
        set.add(key)
        const bare = key.split(".").pop()
        if (bare) set.add(bare)
      }
    return set
  })
  const isChanged = (key: string) => {
    const set = changedKeys()
    return set.has(key) || set.has(key.split(".").pop() ?? key)
  }
  // Rows with a group-header flag when a nested group first appears (entityRows
  // flattens each object's children contiguously, so a group is one run).
  const fieldRows = createMemo(() => {
    let prevGroup: string | undefined
    return rows().map((row) => {
      const group = fieldGroup(row.key)
      const showGroupHeader = group !== undefined && group !== prevGroup
      prevGroup = group
      return {
        key: row.key,
        value: row.value,
        name: humanizeKey(row.key),
        groupLabel: group ? humanizeKey(group) : undefined,
        showGroupHeader,
      }
    })
  })
  const verdict = createMemo(() =>
    props.kind === "run" && props.view ? runVerdict(props.runStatus ?? [], props.view.runs) : null,
  )
  const deviceV = createMemo(() => (props.kind === "device_session" ? deviceVerdict(entity()) : null))
  const calibV = createMemo(() => (props.kind === "calibration" ? calibrationVerdict(entity(), Date.now()) : null))
  // Run modal only: derived problem-size metrics — Hilbert dimension (∏ levels
  // from the system), knot points N (from the formulation solve), and the state-
  // trajectory variable count (N × 2d² for a gate, N × 2d for a ket). All exact,
  // derived from the sibling system/formulation entities.
  const runSize = createMemo(() => {
    if (props.kind !== "run") return undefined
    const sysE = props.view?.entities.system
    const fmlE = props.view?.entities.formulation
    if (!sysE && !fmlE) return undefined
    const sp = sysE ? systemProjection(sysE) : undefined
    const fp = fmlE ? formulationProjection(fmlE) : undefined
    const comps = sp?.components ?? []
    const dim = comps.length
      ? comps.reduce((acc, c) => acc * (typeof c.levels === "number" && c.levels > 0 ? c.levels : 1), 1)
      : undefined
    const solveN = fp?.solve?.N
    const N = typeof solveN === "number" ? solveN : undefined
    const ket = fp?.trajectory_type === "ket" || fp?.trajectory_type === "multiket"
    const stateDim = dim !== undefined ? (ket ? 2 * dim : 2 * dim * dim) : undefined
    const vars = N !== undefined && stateDim !== undefined ? N * stateDim : undefined
    if (dim === undefined && N === undefined) return undefined
    return { dim, N, vars }
  })
  // A hero renders only when the kind has one AND it has content to show
  // (run/device/calibration return null when there's nothing worth surfacing,
  // so the raw field table takes over instead of showing an empty hero).
  const hasHero = createMemo(() => {
    switch (props.kind) {
      case "system":
      case "formulation":
        return true
      case "run":
        return verdict() !== null
      case "device_session":
        return deviceV() !== null
      case "calibration":
        return calibV() !== null
      default:
        return false
    }
  })
  return (
    <div class="flex flex-col" data-component="amicode-entity-view" data-kind={props.kind}>
      <Show
        when={props.view}
        fallback={
          <div aria-hidden>
            <div class="amc-sk w40" />
            <div class="amc-sk" />
            <div class="amc-sk" />
            <div class="amc-sk w60" />
          </div>
        }
      >
        {(view) => (
          <Show
            when={view().ok}
            fallback={
              <div class="amc-ev-error">
                <span class="dot" />
                <span class="msg">{view().error}</span>
                <button type="button" class="amc-ev-retry" data-slot="amicode-entity-retry" onClick={props.onRetry}>
                  {props.retryLabel}
                </button>
              </div>
            }
          >
            <Show when={props.kind === "system"}>
              <SystemComposite entity={entity()} />
            </Show>
            <Show when={props.kind === "formulation"}>
              <FormulationView entity={entity()} />
            </Show>
            <Show when={props.kind === "run" && verdict()}>{(v) => <RunVerdictView verdict={v()} />}</Show>
            <Show when={props.kind === "run" && runSize()}>
              {(s) => (
                <>
                  <div class="amc-ev-sec">Problem size</div>
                  <Show when={s().dim !== undefined}>
                    <div class="amc-term">
                      <div class="amc-term-head">
                        <span class="amc-term-name">hilbert dimension</span>
                      </div>
                      <div class="amc-term-val" data-slot="amicode-run-hilbert">{s().dim}</div>
                    </div>
                  </Show>
                  <Show when={s().N !== undefined}>
                    <div class="amc-term">
                      <div class="amc-term-head">
                        <span class="amc-term-name">knot points</span>
                      </div>
                      <div class="amc-term-val">{s().N}</div>
                    </div>
                  </Show>
                  <Show when={s().vars !== undefined}>
                    <div class="amc-term">
                      <div class="amc-term-head">
                        <span class="amc-term-name">state variables</span>
                      </div>
                      <div class="amc-term-val" data-slot="amicode-run-vars">{s().vars}</div>
                    </div>
                  </Show>
                </>
              )}
            </Show>
            <Show when={props.kind === "device_session" && deviceV()}>{(v) => <DeviceView verdict={v()} />}</Show>
            <Show when={props.kind === "calibration" && calibV()}>{(v) => <CalibrationView verdict={v()} />}</Show>

            {/* Raw field table only for kinds WITHOUT a hero (so their dialog
                isn't empty). Hero kinds surface their content directly — the
                "Show all fields" disclosure was removed (Kate 2026-07-23). */}
            <Show when={!hasHero() && fieldRows().length > 0}>
              <div class="amc-ev-sec">Details</div>
              <div class="flex flex-col" data-slot="amicode-entity-fields">
                <For each={fieldRows()}>
                  {(row) => (
                    <>
                      <Show when={row.showGroupHeader}>
                        <div class="amc-ev-group">{row.groupLabel}</div>
                      </Show>
                      <div class="amc-field">
                        <span class="amc-fk">
                          <span class="name">{row.name}</span>
                          <span class="raw">{row.key}</span>
                        </span>
                        <span class="amc-fv" classList={{ changed: isChanged(row.key) }}>
                          {row.value}
                        </span>
                        <button
                          type="button"
                          class="amc-edit"
                          data-slot="amicode-entity-edit"
                          title={props.editLabel}
                          aria-label={`${props.editLabel}: ${row.name}`}
                          onClick={() => props.onDraftPrompt(editPromptText(props.kind, row.key, row.value))}
                        >
                          <span aria-hidden="true">✎</span>
                          <span class="amc-edit-label">{props.editLabel}</span>
                        </button>
                      </div>
                    </>
                  )}
                </For>
              </div>
            </Show>

          </Show>
        )}
      </Show>
    </div>
  )
}
