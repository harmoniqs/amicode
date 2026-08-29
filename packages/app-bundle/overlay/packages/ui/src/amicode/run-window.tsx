import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { fetchAmicodeRunSeries, openAmicodeEntity } from "./ui-bridge"
import { heroPaths, objectivePath } from "./run-plot"
import {
  type RunSeries,
  type RunSeriesView,
  elapsedLabel,
  headlineMetric,
  humanTail,
  parseRunSeriesResponse,
} from "./run-series"

export { parseRunSeriesResponse, type RunSeries, type RunSeriesView } from "./run-series"

// AMICODE (spec C): compact in-chat run window rendered where amicode_solve
// launched a run (run_dir known). Pulse-first: the latest pulse trace owns the
// plot (the pulse IS the artifact); convergence shrinks to a header sparkline
// next to the F chip; the log tail streams human solver lines only (AMICODE_*
// protocol dumps filtered). Data from GET /amicode/run-series via the ui
// bridge; polls while solving; click opens the full Run entity. Transport lives
// in the app (rail registers fetchRunSeries) so this stays self-contained but
// context-free — no-op until the rail is mounted, exactly like the entity view.

const POLL_MS = 2500
const PLOT_W = 100
const PLOT_H = 34
const SPARK_W = 40
const SPARK_H = 14

function statusColor(status: string): string {
  if (status === "finished") return "var(--v2-state-fg-success)"
  if (status === "failed" || status === "aborted") return "var(--v2-state-fg-danger)"
  if (status === "stalled") return "var(--v2-state-fg-warning)" // wedged (OOM?) — not blue: must not read as live
  if (status === "stopped") return "var(--v2-text-text-muted)" // deliberate user stop — calm, not alarming, not live
  return "var(--v2-text-text-accent)" // solving
}

function Plot(props: { d: string[] | undefined }) {
  return (
    <Show
      when={props.d && props.d.length > 0 ? props.d : undefined}
      fallback={
        <div style={{ height: `${PLOT_H}px`, display: "flex", "align-items": "center" }}>
          <span style={{ "font-size": "10px", color: "var(--v2-text-text-faint)" }}>gathering iterations…</span>
        </div>
      }
    >
      {(paths) => (
        <svg
          width="100%"
          height={PLOT_H}
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
        >
          <For each={paths()}>
            {(d, i) => (
              <path
                d={d}
                fill="none"
                stroke="var(--v2-icon-icon-accent)"
                stroke-width="1.5"
                stroke-linejoin="round"
                vector-effect="non-scaling-stroke"
                opacity={i() === 0 ? 1 : 0.55} // second/third drive quadratures read as companions
              />
            )}
          </For>
        </svg>
      )}
    </Show>
  )
}

function Chip(props: { label: string; value: string; color?: string }) {
  return (
    <span style={{ display: "inline-flex", "align-items": "baseline", gap: "4px", "flex-shrink": "0" }}>
      <span style={{ color: "var(--v2-text-text-muted)" }}>{props.label}</span>
      <span
        style={{
          color: props.color ?? "var(--v2-text-text-base)",
          "font-family": "var(--font-family-mono, ui-monospace, monospace)",
        }}
      >
        {props.value}
      </span>
    </span>
  )
}

type RunWindowState = { view: RunSeriesView | undefined }

export function RunWindow(props: { run: string; lab?: string }) {
  const [state, setState] = createStore<RunWindowState>({ view: undefined })
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }

  const load = async () => {
    const pending = fetchAmicodeRunSeries(props.run, props.lab)
    if (!pending) return // no transport registered yet → keep last good
    const raw = await pending.catch(() => undefined)
    if (raw === undefined) return
    setState(reconcile({ view: parseRunSeriesResponse(raw) }))
  }

  onMount(() => void load())
  createEffect(() => {
    const v = state.view
    // Poll through "stalled" too: a stalled run can resume (or get force-
    // finalized) and the window must converge instead of freezing forever.
    const live = v?.ok === true && (v.run.status === "solving" || v.run.status === "stalled")
    if (live && timer === undefined) timer = setInterval(() => void load(), POLL_MS)
    if (!live) stop()
  })
  onCleanup(stop)

  const run = createMemo<RunSeries | undefined>(() => {
    const v = state.view
    return v?.ok ? v.run : undefined
  })
  const plotPath = createMemo<string[] | undefined>(() => {
    const r = run()
    if (!r) return undefined
    const paths = heroPaths(r, PLOT_W, PLOT_H)
    return paths.length > 0 ? paths : undefined
  })
  // convergence shrinks to a header chip: glanceable progress, pulse owns the canvas
  const sparkPath = createMemo<string | undefined>(() => {
    const r = run()
    if (!r) return undefined
    return objectivePath(
      r.series.map((p) => p.f),
      SPARK_W,
      SPARK_H,
    )
  })
  const tailLines = createMemo<string[]>(() => humanTail(run()?.tail ?? []).slice(-4))

  return (
    <div
      data-component="amicode-run-window"
      data-run={props.run}
      onClick={() => openAmicodeEntity("run")}
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        "min-width": "0",
        padding: "8px 12px",
        "font-size": "12px",
        "line-height": "16px",
        cursor: "pointer",
      }}
    >
      {/* header: Run · status · iter · metric · spark · elapsed. No Amico mark:
          the wordmark went first (identity lives in the rail —
          spec-20260712-amico-third-actor) and the H-mark followed it on every
          amicode surface (Kate 2026-08-23). This panel is unmistakably Amico's
          without a stamp, and the glyph only repeated what "Run" already says. */}
      <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", "min-width": "0" }}>
        <span style={{ "font-weight": "600", color: "var(--v2-text-text-base)" }}>Run</span>
        <Show
          when={run()}
          fallback={
            <span style={{ color: "var(--v2-text-text-muted)" }}>
              {state.view?.ok === false ? "unavailable" : "loading…"}
            </span>
          }
        >
          {(r) => (
            <>
              <span style={{ "font-weight": "600", color: statusColor(r().status), "flex-shrink": "0" }}>
                {r().status}
              </span>
              <Show when={r().iteration !== null}>
                <Chip label="iter" value={String(r().iteration)} />
              </Show>
              {(() => {
                const m = headlineMetric(r())
                return <Chip label={m.label} value={m.value} />
              })()}
              <Show when={sparkPath()}>
                {(d) => (
                  <svg
                    width={SPARK_W}
                    height={SPARK_H}
                    viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
                    style={{ "flex-shrink": "0" }}
                  >
                    <path
                      d={d()}
                      fill="none"
                      stroke="var(--v2-icon-icon-accent)"
                      stroke-width="1"
                      stroke-linejoin="round"
                      opacity="0.8"
                    />
                  </svg>
                )}
              </Show>
              <Show when={elapsedLabel(r().elapsedMs)}>{(t) => <Chip label="" value={t()} />}</Show>
            </>
          )}
        </Show>
      </div>

      {/* plot */}
      <Plot d={plotPath()} />

      {/* log tail — human solver lines only (AMICODE_* protocol dumps filtered) */}
      <Show when={tailLines().length > 0}>
        <div
          style={{
            "font-family": "var(--font-family-mono, ui-monospace, monospace)",
            "font-size": "10px",
            "line-height": "14px",
            color: "var(--v2-text-text-muted)",
            "max-height": "58px",
            overflow: "hidden",
            "white-space": "pre-wrap",
            "word-break": "break-all",
          }}
        >
          <For each={tailLines()}>{(line) => <div>{line}</div>}</For>
        </div>
      </Show>
    </div>
  )
}
