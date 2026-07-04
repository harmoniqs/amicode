// Pure timing helpers for the Run Inspector elapsed/rate/ETA strip. No I/O, no
// DOM — unit-tested in node. The caller supplies file contents / timestamps.

/** Parse `max_iter = N` from a solve script's text (for ETA). Undefined if absent. */
export function parseMaxIter(scriptText: string): number | undefined {
  const m = /^\s*max_iter\s*=\s*(\d+)/m.exec(scriptText);
  return m ? Number(m[1]) : undefined;
}

/** Seconds remaining ≈ (maxIter − iter) / rate. Undefined without a max or a
 *  positive rate (so the caller omits the ETA term rather than showing garbage). */
export function computeEta(o: { iter: number; maxIter?: number; ratePerSec: number }): number | undefined {
  if (!o.maxIter || o.ratePerSec <= 0) return undefined;
  return Math.max(0, o.maxIter - o.iter) / o.ratePerSec;
}

/** Compact m/s formatting: 9 → "9s", 134 → "2m14s". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** Iterations/sec from a window of iteration arrival timestamps (ms). Undefined
 *  with fewer than two samples or a zero span. */
export function ratePerSec(timestampsMs: number[]): number | undefined {
  if (timestampsMs.length < 2) return undefined;
  const span = timestampsMs[timestampsMs.length - 1] - timestampsMs[0];
  if (span <= 0) return undefined;
  return ((timestampsMs.length - 1) / span) * 1000;
}
