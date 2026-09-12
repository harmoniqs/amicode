// AMICODE: pure SVG path geometry shared by the in-chat run window (hero plot
// + header sparkline) and the home "Now solving" sparkline. JSX-free per the
// fork convention: thin untestable shells, tested pure cores.

export function scaledPath(ys: number[], min: number, max: number, w: number, h: number): string {
  const span = max - min || 1
  const step = w / (ys.length - 1)
  return ys
    .map((y, i) => {
      const px = (i * step).toFixed(2)
      const py = (h - 2 - ((y - min) / span) * (h - 4)).toFixed(2)
      return `${i === 0 ? "M" : "L"}${px},${py}`
    })
    .join(" ")
}

export function linePath(ys: number[], w: number, h: number): string | undefined {
  if (ys.length < 2) return undefined
  return scaledPath(ys, Math.min(...ys), Math.max(...ys), w, h)
}

/** Descending log-objective curve (the classic convergence plot). */
export function objectivePath(values: number[], w: number, h: number): string | undefined {
  if (values.length < 2) return undefined
  return linePath(
    values.map((f) => Math.log10(Math.max(f, 1e-12))),
    w,
    h,
  )
}

/** One path per drive, sharing a min/max scale so amplitudes stay comparable.
 *  The wire ships drives flattened back-to-back; pulse_meta says how to slice. */
export function drivePaths(values: number[], drives: number, w: number, h: number): string[] {
  const n = Math.max(1, drives)
  const knots = Math.floor(values.length / n)
  if (knots < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  return Array.from({ length: n }, (_, d) => scaledPath(values.slice(d * knots, (d + 1) * knots), min, max, w, h))
}

/** Pulse-first hero selection: the pulse is the artifact, so it owns the plot
 *  when a snapshot exists; young runs fall back to the convergence curve;
 *  empty runs return [] (caller renders "gathering iterations…"). */
export function heroPaths(
  run: {
    series: { iter: number; f: number }[]
    pulse: { values: number[] } | null
    pulseMeta: { drives: number } | null
  },
  w: number,
  h: number,
): string[] {
  const pulse = run.pulse?.values ?? []
  if (pulse.length >= 2) {
    const paths = drivePaths(pulse, run.pulseMeta?.drives ?? 1, w, h)
    if (paths.length > 0) return paths
  }
  const d = objectivePath(
    run.series.map((p) => p.f),
    w,
    h,
  )
  return d ? [d] : []
}
