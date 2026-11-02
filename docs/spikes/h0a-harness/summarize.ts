// Applies the PRE-REGISTERED pass criteria (docs/spikes/2026-11-02-h0a-load.md, "Pass criteria") to a run directory.
// The thresholds below are copied from that note and must not be edited to fit a result.
//
// Hard rule: this never reports `pass` when an input is missing, empty or unreadable (verdict `invalid`), when the
// control is too noisy to judge latency, or when the driver itself was saturated (verdict `inconclusive`).
import fs from "node:fs"
import path from "node:path"
import { linfit, percentile, wedgeEvents } from "./stats.ts"

export const CRITERIA = {
  excess_p99_ms: 250, // host p99 - control p99 must be UNDER this
  host_p99_ms: 500, // and the host p99 itself under this
  control_p99_max_ms: 100, // above this the run is inconclusive for latency
  miss_ms: 2000, // no answer within this = a miss
  growth_bytes: 2e9, // RSS growth from end of warm-up to end of run under 2 GB (decimal)
  projected_bytes_24h: 8e9, // least-squares extrapolation at 24 h under 8 GB (decimal)
  turn_completion: 0.99,
  driver_p99_drift_ms: 50, // above this the DRIVER was saturated and the run is flagged
  probe_coverage: 0.9, // fewer probe ticks than this fraction of the window means the probe did not run
  nonok_fraction: 0.01, // more host answers than this that are not HTTP 200 and the latency number means nothing
  tick_ms: 250,
} as const

export type ProbeRow = { t: number; h: number | null; c: number | null; hs: number; cs: number }
export type SamplerRow = { t: number; rss: number; cpu_s: number; load1: number }
export type TurnRow = { session: string; start: number; end: number | null; outcome: "succeeded" | "failed" | "interrupted" | "lost"; via?: string }
export type LagRow = { t: number; d: number }
export type EventRow = { t: number; event: string; planned?: boolean }
export type RunConfig = { measure_from: number; measure_until: number; duration_s: number; warmup_s: number; sessions: number; [k: string]: unknown }
export type RunData = { config: RunConfig; probe: ProbeRow[]; sampler: SamplerRow[]; turns: TurnRow[]; lag: LagRow[]; events: EventRow[] }
export type Status = "pass" | "fail" | "inconclusive" | "invalid"
export type Verdict = { criterion: string; status: Status; detail: string; [k: string]: unknown }

const missed = (row: ProbeRow) => row.h === null || row.hs === 0 || row.h >= CRITERIA.miss_ms
const asLatency = (ms: number | null) => (ms === null ? CRITERIA.miss_ms : Math.min(ms, CRITERIA.miss_ms))
const round = (n: number, digits = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : n)

/** `minExtrapolationWindowS`: a window shorter than this cannot support the 24 h extrapolation (default 30 min); tests lower it. */
export function evaluate(data: RunData, options: { minExtrapolationWindowS?: number } = {}) {
  const minWindowS = options.minExtrapolationWindowS ?? 1800
  const from = data.config.measure_from
  const until = data.config.measure_until
  const inWindow = <T extends { t: number }>(rows: T[]) => rows.filter((row) => row.t >= from && row.t <= until)
  const probe = inWindow(data.probe)
  const warmupProbe = data.probe.filter((row) => row.t < from)
  const expectedTicks = (data.config.duration_s * 1000) / CRITERIA.tick_ms

  // ---- 1. latency
  const latency: Verdict = (() => {
    const base = { criterion: "latency" }
    if (probe.length < expectedTicks * CRITERIA.probe_coverage)
      return { ...base, status: "invalid" as const, detail: `probe recorded ${probe.length} ticks in the window; expected about ${expectedTicks} (need at least ${Math.ceil(expectedTicks * CRITERIA.probe_coverage)})`, samples: probe.length }
    const hostP99 = percentile(probe.map((row) => asLatency(row.h)), 99)
    const controlP99 = percentile(probe.map((row) => asLatency(row.c)), 99)
    const excess = hostP99 - controlP99
    const nonOk = probe.filter((row) => row.hs !== 200 && row.hs !== 0).length / probe.length
    const numbers = {
      samples: probe.length,
      host_p99_ms: round(hostP99),
      control_p99_ms: round(controlP99),
      excess_p99_ms: round(excess),
      host_p50_ms: round(percentile(probe.map((row) => asLatency(row.h)), 50)),
      control_p50_ms: round(percentile(probe.map((row) => asLatency(row.c)), 50)),
      host_max_ms: Math.max(...probe.map((row) => asLatency(row.h))),
      host_non200_fraction: round(nonOk, 4),
    }
    if (controlP99 > CRITERIA.control_p99_max_ms)
      return { ...base, ...numbers, status: "inconclusive" as const, detail: `control p99 ${round(controlP99)} ms > ${CRITERIA.control_p99_max_ms} ms: the machine was too noisy to judge; repeat in a quieter window` }
    if (nonOk > CRITERIA.nonok_fraction)
      return { ...base, ...numbers, status: "inconclusive" as const, detail: `${round(nonOk * 100)} % of host answers were not HTTP 200 (auth or routing error?); latency of an error response says nothing` }
    const pass = excess < CRITERIA.excess_p99_ms && hostP99 < CRITERIA.host_p99_ms
    return { ...base, ...numbers, status: pass ? ("pass" as const) : ("fail" as const), detail: `excess ${round(excess)} ms (< ${CRITERIA.excess_p99_ms}) and host p99 ${round(hostP99)} ms (< ${CRITERIA.host_p99_ms})` }
  })()

  // ---- 2. no wedge, no unplanned exit
  const wedge: Verdict = (() => {
    const ticks = (rows: ProbeRow[]) => rows.map((row) => ({ t: row.t, miss: missed(row) }))
    const found = wedgeEvents(ticks(probe))
    const warmup = wedgeEvents(ticks(warmupProbe))
    const hostExits = data.events.filter((e) => e.event === "host_exit" && e.planned !== true)
    const pass = found.count === 0 && hostExits.length === 0
    return {
      criterion: "no_wedge",
      status: probe.length === 0 ? ("invalid" as const) : pass ? ("pass" as const) : ("fail" as const),
      wedges: found.count,
      wedge_events: found.events,
      warmup_wedges: warmup.count,
      unplanned_host_exits: hostExits.length,
      missed_ticks: probe.filter(missed).length,
      detail: `${found.count} wedge event(s) in the window, ${hostExits.length} unplanned host exit(s); ${warmup.count} wedge(s) during warm-up (excluded)`,
    }
  })()

  // ---- 3. memory
  const memory: Verdict = (() => {
    const rows = inWindow(data.sampler).sort((a, b) => a.t - b.t)
    if (rows.length < 2) return { criterion: "memory", status: "invalid" as const, detail: `${rows.length} RSS sample(s) in the window; need at least 2` }
    const fit = linfit(rows.map((row) => ({ x: (row.t - from) / 1000, y: row.rss })))
    const growth = rows.at(-1)!.rss - rows[0]!.rss
    // Projected RSS at 24 h after the end of warm-up: the fitted value at x = 0 plus the slope over 86 400 s.
    const projected = fit.intercept + fit.slope * 86_400
    const windowS = (rows.at(-1)!.t - rows[0]!.t) / 1000
    const growthOk = growth < CRITERIA.growth_bytes
    const projectedOk = projected < CRITERIA.projected_bytes_24h
    const reliable = windowS >= minWindowS
    // Too short a window cannot support the 24 h extrapolation: it can still FAIL on growth, but it cannot pass.
    const status: Status = !Number.isFinite(projected) ? "invalid" : !growthOk ? "fail" : !reliable ? "inconclusive" : projectedOk ? "pass" : "fail"
    return {
      criterion: "memory",
      status,
      samples: rows.length,
      window_s: windowS,
      rss_start_bytes: rows[0]!.rss,
      rss_end_bytes: rows.at(-1)!.rss,
      rss_max_bytes: Math.max(...rows.map((r) => r.rss)),
      growth_bytes: growth,
      slope_bytes_per_hour: fit.slope * 3600,
      projected_rss_24h_bytes: projected,
      extrapolation_reliable: reliable,
      detail: `growth ${round(growth / 1e6)} MB (< ${CRITERIA.growth_bytes / 1e6}); least-squares projection at 24 h ${round(projected / 1e9, 2)} GB (< ${CRITERIA.projected_bytes_24h / 1e9})${reliable ? "" : `; window ${round(windowS)} s is under ${minWindowS} s: the extrapolation is not assessed, so this cannot pass`}`,
    }
  })()

  // ---- 4. turn correctness
  const turns: Verdict = (() => {
    const started = data.turns.filter((turn) => turn.start >= from && turn.start <= until)
    if (started.length === 0) return { criterion: "turns", status: "invalid" as const, detail: "no turn started inside the measurement window" }
    const count = (outcome: TurnRow["outcome"]) => started.filter((turn) => turn.outcome === outcome).length
    const succeeded = count("succeeded")
    const lost = count("lost")
    const rate = succeeded / started.length
    const pass = rate >= CRITERIA.turn_completion && lost === 0
    return {
      criterion: "turns",
      status: pass ? ("pass" as const) : ("fail" as const),
      started: started.length,
      succeeded,
      failed: count("failed"),
      interrupted: count("interrupted"),
      lost,
      completion_rate: round(rate, 4),
      ended_via_poll: started.filter((turn) => turn.via === "poll").length,
      detail: `${succeeded}/${started.length} completed (>= ${CRITERIA.turn_completion * 100} %); ${lost} silently lost (must be 0)`,
    }
  })()

  // ---- driver saturation and harness health (not host criteria; they decide whether the run is believable)
  const drift = inWindow(data.lag).map((row) => row.d)
  const driverP99 = percentile(drift, 99)
  const driverSaturated = !(driverP99 <= CRITERIA.driver_p99_drift_ms) // NaN (no lag samples) counts as saturated: unknown is not fine
  const harnessExits = data.events.filter((e) => e.event.endsWith("_exit") && e.event !== "host_exit" && e.planned !== true)

  const criteria = [latency, wedge, memory, turns]
  const statuses = criteria.map((c) => c.status)
  // A criterion that definitively failed (a wedge, an unplanned host exit, a lost turn) fails the run even when another
  // input is unusable: missing data can hide a pass but can never manufacture one, and it must not hide a failure either.
  const verdict: Status = statuses.includes("fail")
    ? "fail"
    : statuses.includes("invalid")
      ? "invalid"
      : statuses.includes("inconclusive") || driverSaturated || harnessExits.length > 0
        ? "inconclusive"
        : "pass"
  const sampled = inWindow(data.sampler)

  return {
    verdict,
    criteria,
    driver_saturated: driverSaturated,
    driver_p99_drift_ms: round(driverP99),
    driver_p99_drift_limit_ms: CRITERIA.driver_p99_drift_ms,
    harness_unplanned_exits: harnessExits.map((e) => e.event),
    host_cpu_seconds: sampled.length >= 2 ? round(sampled.at(-1)!.cpu_s - sampled[0]!.cpu_s, 2) : null,
    load1: sampled.length ? { mean: round(sampled.reduce((a, r) => a + r.load1, 0) / sampled.length, 2), max: Math.max(...sampled.map((r) => r.load1)) } : null,
  }
}

const REQUIRED = ["run.json", "probe.ndjson", "sampler.ndjson", "turns.ndjson", "driver-lag.ndjson", "events.ndjson"] as const

/** Read a run directory. Anything missing, empty or unparseable becomes a problem, and a problem means `invalid`. */
export function loadRun(dir: string) {
  const problems: string[] = []
  const read = <T>(name: string, ndjson: boolean): T[] => {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) {
      problems.push(`${name}: missing`)
      return []
    }
    const text = fs.readFileSync(file, "utf8")
    if (text.trim() === "") {
      problems.push(`${name}: empty`)
      return []
    }
    if (!ndjson) {
      try {
        return [JSON.parse(text) as T]
      } catch {
        problems.push(`${name}: not valid JSON`)
        return []
      }
    }
    const lines = text.split("\n").filter((line) => line.trim() !== "")
    const rows: T[] = []
    for (const [i, line] of lines.entries()) {
      try {
        rows.push(JSON.parse(line) as T)
      } catch {
        // A writer killed mid-line leaves one truncated last line; anything earlier is real corruption.
        if (i !== lines.length - 1) problems.push(`${name}: line ${i + 1} is not valid JSON`)
      }
    }
    return rows
  }
  const config = read<RunConfig>("run.json", false)[0]
  const rest = REQUIRED.slice(1)
  const [probe, sampler, turns, lag, events] = rest.map((name) => read<never>(name, true))
  const data: RunData | undefined = config && { config, probe: probe as ProbeRow[], sampler: sampler as SamplerRow[], turns: turns as TurnRow[], lag: lag as LagRow[], events: events as EventRow[] }
  return { data, problems }
}

export function summarizeRun(dir: string, options: Parameters<typeof evaluate>[1] = {}) {
  const { data, problems } = fs.existsSync(dir) ? loadRun(dir) : { data: undefined, problems: [`${dir}: run directory does not exist`] }
  if (!data || problems.length > 0)
    return { verdict: "invalid" as const, problems, criteria: [] as Verdict[], note: "inputs missing or empty: no pass can be reported" }
  const optional = (name: string) => {
    const file = path.join(dir, name)
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown) : undefined
  }
  return { ...evaluate(data, options), problems, config: data.config, model_stats: optional("model-stats.json"), driver_stats: optional("driver-stats.json") }
}

if (import.meta.main) {
  const dir = process.argv[2]
  if (!dir) {
    console.error("usage: bun summarize.ts <run-dir>")
    process.exit(64)
  }
  const summary = summarizeRun(dir)
  if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n")
  console.log(JSON.stringify({ verdict: summary.verdict, problems: summary.problems, criteria: summary.criteria.map((c) => ({ criterion: c.criterion, status: c.status, detail: c.detail })) }, null, 2))
  process.exit({ pass: 0, fail: 1, inconclusive: 2, invalid: 3 }[summary.verdict])
}
