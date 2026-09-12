// AMICODE (spec C): pure parse/guard for GET /amicode/run-series. JSX-free so
// it's unit-testable and shared by the home "Now solving" card and the in-chat
// run window. The server ships the raw objective f (fixed-phase infidelity);
// F = 1 - f is derived on the client — one convention, one place. The final
// `fidelity` (free-phase, authoritative) is separate and can differ from 1 - f.

export type RunPoint = { iter: number; f: number }
export type RunSeries = {
  runId: string
  lab: string
  status: string // "solving" | "finished" | "failed" | …
  iteration: number | null
  fidelity: number | null // authoritative final fidelity; null while solving
  bestF: number | null // best objective so far (min f over the run)
  lastF: number | null
  elapsedMs: number | null
  series: RunPoint[]
  pulse: { iter: number; dt: number; values: number[] } | null
  pulseMeta: { drives: number; knots: number; labels: string[] } | null
  tail: string[]
}
export type RunSeriesView = { ok: true; run: RunSeries } | { ok: false; error: string }

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function parseRunSeriesResponse(raw: unknown): RunSeriesView {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "malformed response" }
  const obj = raw as Record<string, any>
  if (obj.ok !== true || typeof obj.run !== "object" || obj.run === null)
    return { ok: false, error: typeof obj.error === "string" ? obj.error : "unavailable" }
  const r = obj.run as Record<string, any>
  const series: RunPoint[] = Array.isArray(r.series)
    ? r.series
        .filter((p: any) => p && Number.isFinite(p.iter) && Number.isFinite(p.f))
        .map((p: any) => ({ iter: p.iter as number, f: p.f as number }))
    : []
  const pulse =
    r.pulse && Array.isArray(r.pulse.values)
      ? {
          iter: num(r.pulse.iter) ?? 0,
          dt: num(r.pulse.dt) ?? 0,
          values: (r.pulse.values as any[]).filter((v) => Number.isFinite(v)) as number[],
        }
      : null
  const pulseMeta =
    r.pulse_meta && Number.isFinite(r.pulse_meta.drives)
      ? {
          drives: r.pulse_meta.drives as number,
          knots: num(r.pulse_meta.knots) ?? 0,
          labels: Array.isArray(r.pulse_meta.labels) ? (r.pulse_meta.labels as any[]).map(String) : [],
        }
      : null
  return {
    ok: true,
    run: {
      runId: typeof r.run_id === "string" ? r.run_id : "",
      lab: typeof r.lab === "string" ? r.lab : "",
      status: typeof r.status === "string" ? r.status : "solving",
      iteration: num(r.iteration),
      fidelity: num(r.fidelity),
      bestF: num(r.best_f),
      lastF: num(r.last_f),
      elapsedMs: num(r.elapsed_ms),
      series,
      pulse,
      pulseMeta,
      tail: Array.isArray(r.tail) ? (r.tail as any[]).map(String) : [],
    },
  }
}

/** Human elapsed: 12s / 3m 04s / 1h 12m. */
export function elapsedLabel(ms: number | null): string | undefined {
  if (ms === null || ms < 0) return undefined
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** Human-facing tail: drop AMICODE_* protocol lines (pulse/iter dumps the run
 *  window must never show raw); solver output passes through untouched. The
 *  server keeps shipping the raw tail — this is a presentation filter. */
export function humanTail(lines: string[]): string[] {
  return lines.filter((line) => !line.trimStart().startsWith("AMICODE_"))
}

/** Headline metric: authoritative fidelity if finished, else F = 1 - f once the
 *  objective is a valid infidelity (< 1), else the raw objective early on. */
export function headlineMetric(run: RunSeries): { label: string; value: string } {
  if (run.fidelity !== null) return { label: "F", value: run.fidelity.toFixed(5) }
  const f = run.lastF ?? run.bestF
  if (f === null) return { label: "F", value: "—" }
  if (f < 1) return { label: "F", value: (1 - f).toFixed(5) }
  return { label: "f", value: f.toExponential(2) }
}
