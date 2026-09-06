// D2/H4 (spec spec-20260905-045114-session-device-lifecycle), issue #817 —
// the REVISED placement (amendment, 2026-09-05): the list-currency token is
// DERIVED BY THE CLIENT over the projection it fetches — (count, max
// time_updated, sum of time_updated) over the rows the list returns, plus
// the server-reported version as the stamp. No server field needed: any
// write that changes the rendered projection — same-tick touches, archive
// churn, out-of-band SQL — changes the token by construction, because it is
// recomputed from the fetched rows on every list response.
//
// Pure and dependency-free (type imports only) so it unit-tests headless.

export type CurrencyProjection = {
  readonly count: number
  readonly maxUpdated: number
  readonly sumUpdated: number
}

type DatedRow = { time?: { updated?: number; created?: number } }

export function projectionOf(rows: readonly DatedRow[]): CurrencyProjection {
  let maxUpdated = 0
  let sumUpdated = 0
  for (const row of rows) {
    const updated = row.time?.updated ?? row.time?.created ?? 0
    if (updated > maxUpdated) maxUpdated = updated
    sumUpdated += updated
  }
  return { count: rows.length, maxUpdated, sumUpdated }
}

/** The token the client derives over a fetched list projection. `serverVersion`
 *  is the hub's self-reported version (the health endpoint); a hub that does
 *  not report one stamps "unavailable" — the token still advances on every
 *  projection change, it just cannot detect hub-build drift. */
export function deriveCurrencyToken(rows: readonly DatedRow[], serverVersion: string | undefined): string {
  const p = projectionOf(rows)
  return `v1.${p.count}.${p.maxUpdated}.${p.sumUpdated}.${serverVersion ?? "unavailable"}`
}
