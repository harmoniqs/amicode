import { For, Show, createMemo } from "solid-js"
import type { createInspectorBridge } from "./inspector-bridge"

type Props = { bridge: ReturnType<typeof createInspectorBridge> }

// Minimal pulse sparkline — renders correctly at narrow column widths and responds
// to resize via viewBox (no fixed pixel width). Each drive is a polyline.
function PulseChart(props: { values?: number[][]; bounds?: [number, number][] }) {
  const paths = createMemo(() => {
    const v = props.values
    if (!v || v.length === 0 || v[0].length === 0) return []
    return v.map((drive, idx) => {
      const b = props.bounds?.[idx]
      const lo = b?.[0] ?? Math.min(...drive)
      const hi = b?.[1] ?? Math.max(...drive)
      const range = hi - lo || 1
      const pts = drive.map((val, i) => {
        const x = (i / (drive.length - 1)) * 100
        const y = 50 - ((val - lo) / range) * 40 - 5
        return `${x},${y}`
      })
      return { d: `M ${pts.join(" L ")}`, color: idx % 2 === 0 ? "var(--amico-accent, #eab308)" : "var(--amico-accent-2, #38bdf8)" }
    })
  })
  return (
    <svg viewBox="0 0 100 50" class="w-full h-[100px] bg-[var(--v2-background-bg-subtle)] rounded-md" preserveAspectRatio="none">
      <Show when={paths().length === 0}>
        <line x1="0" y1="25" x2="100" y2="25" stroke="var(--v2-border-border-base, #333)" stroke-width="0.5" vector-effect="non-scaling-stroke" stroke-dasharray="4 3" />
      </Show>
      <For each={paths()}>{(p) => <path d={p.d} fill="none" stroke={p.color} stroke-width={1.2} vector-effect="non-scaling-stroke" />}</For>
    </svg>
  )
}

export function RunInspector(props: Props) {
  const runs = () => Array.from(props.bridge.runs().entries())
  const active = createMemo(() => {
    const id = props.bridge.activeRunId()
    if (id && props.bridge.runs().has(id)) return { id, state: props.bridge.runs().get(id)! }
    const first = runs()[0]
    return first ? { id: first[0], state: first[1] } : undefined
  })
  const latestIter = createMemo(() => active()?.state.iterations.at(-1))
  const latestPulse = createMemo(() => active()?.state.pulses.at(-1))

  return (
    <div class="flex flex-col gap-3" data-component="run-inspector">
      {/* Run selector — only shown when multiple runs exist */}
      <Show when={runs().length > 1}>
        <div class="flex items-center justify-between">
          <select
            class="text-11-regular border border-border-weaker-base rounded px-1 py-0.5 bg-background-base max-w-[160px] truncate"
            value={active()?.id ?? ""}
            onChange={(e) => props.bridge.setActiveRunId(e.currentTarget.value)}
          >
            <For each={runs()}>{([id, s]) => <option value={id}>{s.label ?? id}</option>}</For>
          </select>
        </div>
      </Show>

      <Show when={!active()} fallback={
        <div class="flex flex-col gap-3">
          {/* Pulse metadata */}
          <Show when={active()!.state.pulseMeta}>
            {(meta) => (
              <div class="text-11-regular text-text-weak">
                {meta().drives} control channel{meta().drives > 1 ? "s" : ""} · {meta().knots} timesteps
                <Show when={meta().labels.length > 0}>
                  <span class="text-text-faint"> · {meta().labels.join(", ")}</span>
                </Show>
              </div>
            )}
          </Show>

          {/* Pulse chart — always visible once a run exists */}
          <PulseChart values={latestPulse()?.values} bounds={active()!.state.pulseMeta?.bounds} />

          {/* Metrics table — horizontally scrollable at narrow widths */}
          <div class="overflow-x-auto -mx-1 px-1">
            <table class="w-full text-11-regular" style="font-variant-numeric: tabular-nums">
              <thead>
                <tr class="text-text-faint text-left">
                  <th class="font-normal pr-2 whitespace-nowrap w-[48px]">Iter</th>
                  <th class="font-normal pr-2 whitespace-nowrap">Objective</th>
                  <th class="font-normal pr-2 whitespace-nowrap">Primal</th>
                  <th class="font-normal whitespace-nowrap">Dual</th>
                </tr>
              </thead>
              <tbody>
                <tr class="font-mono">
                  <td class="pr-2">{latestIter()?.iter ?? "—"}</td>
                  <td class="pr-2">{latestIter() ? latestIter()!.objective.toExponential(2) : "—"}</td>
                  <td class="pr-2">{latestIter() ? latestIter()!.inf_pr.toExponential(1) : "—"}</td>
                  <td>{latestIter() ? latestIter()!.inf_du.toExponential(1) : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Completion card */}
          <Show when={active()!.state.completion}>
            {(c) => (
              <div class="rounded-md border border-border-weaker-base p-2 text-11-regular">
                <div class="text-text-faint text-[10px] uppercase tracking-wide mb-0.5">Result</div>
                <div class="text-13-medium">F = {c().fidelity.toFixed(5)}</div>
                <div class="text-text-weak mt-0.5">
                  {c().status} · {c().iterations} iterations
                  <Show when={active()!.state.timing}> · {active()!.state.timing!.toFixed(1)}s</Show>
                </div>
              </div>
            )}
          </Show>

          {/* Running indicator */}
          <Show when={!active()!.state.completion && latestIter()}>
            <div class="text-11-regular text-text-weak">solving · iteration {latestIter()!.iter}</div>
          </Show>
        </div>
      }>
        <div class="text-12-regular text-text-weak py-8 text-center">No solve yet — launch one from the chat.</div>
      </Show>
    </div>
  )
}
