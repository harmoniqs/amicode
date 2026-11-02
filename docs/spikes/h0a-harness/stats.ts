// Pure maths for the H0a harness: no I/O, so the criteria can be tested at their boundaries.

/** Nearest-rank percentile (p in (0,100]). Empty input is NaN so it can never satisfy a threshold. */
export function percentile(values: readonly number[], p: number) {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

export type MissSample = { t: number; miss: boolean }
export type WedgeEvent = { start: number; end: number; misses: number }

/**
 * Wedge = no answer within 2 s on two consecutive ticks (the watchdog's "HTTP-silent for two ticks").
 * An event starts at the first miss of a run of at least two and ends at the last miss of that run; a single miss, or
 * misses separated by an answered tick, are not wedges. An outage is one event however long it lasts.
 */
export function wedgeEvents(samples: readonly MissSample[]) {
  const ordered = [...samples].sort((a, b) => a.t - b.t)
  const events: WedgeEvent[] = []
  let run: MissSample[] = []
  const close = () => {
    if (run.length >= 2) events.push({ start: run[0]!.t, end: run.at(-1)!.t, misses: run.length })
    run = []
  }
  for (const sample of ordered) {
    if (sample.miss) run.push(sample)
    else close()
  }
  close()
  return { count: events.length, events }
}

/** Ordinary least squares. Fewer than two distinct x values has no slope: NaN, not 0. */
export function linfit(points: readonly { x: number; y: number }[]) {
  const n = points.length
  if (n < 2) return { slope: NaN, intercept: NaN }
  const mx = points.reduce((s, p) => s + p.x, 0) / n
  const my = points.reduce((s, p) => s + p.y, 0) / n
  const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0)
  if (sxx === 0) return { slope: NaN, intercept: NaN }
  const slope = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx
  return { slope, intercept: my - slope * mx }
}
