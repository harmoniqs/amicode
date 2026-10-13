// #1778 — per-turn summary patches on demand. The engine sends a live summary's
// diffs with file, status and counts but no patch body (patches stay in
// storage); the per-turn diff view fetches the turn's stored diffs only when a
// patch-less file is expanded. Plain TypeScript (no reactivity) so the
// behavior is testable directly; session-turn.tsx drives it from its expand
// state.

/** A diff as a summary carries it — the patch body is optional on the wire. */
export type SummaryDiffLike = {
  file?: string
  patch?: string
  before?: string
  after?: string
  additions?: number
  deletions?: number
  status?: string
}

/** Fetch a turn's stored summary diffs (with patch bodies), e.g. from `GET /session/:id/message/:messageID`. */
export type SummaryDiffSource = (input: {
  sessionID: string
  messageID: string
}) => Promise<readonly SummaryDiffLike[] | undefined>

export type SummaryPatchRequest = {
  sessionID: string
  messageID: string
  /** The expanded file. */
  file: string
  /** The turn's summary diffs as currently shown — a changed summary is fetched afresh. */
  summary: readonly SummaryDiffLike[]
}

/** Whether a diff can render without a fetch: it carries a patch, or before/after contents. */
export function hasBody(diff: SummaryDiffLike) {
  return typeof diff.patch === "string" || typeof diff.before === "string" || typeof diff.after === "string"
}

const signature = (summary: readonly SummaryDiffLike[]) =>
  JSON.stringify(summary.map((diff) => [diff.file, diff.status, diff.additions, diff.deletions]))

/**
 * One loader per data provider. A turn's stored diffs are fetched at most once
 * per summary (every file of the turn, and concurrent expands, share it); a
 * failed fetch is forgotten so the next expand retries it.
 */
export function createSummaryPatchLoader(source: SummaryDiffSource | undefined) {
  const turns = new Map<string, Promise<readonly SummaryDiffLike[] | undefined>>()
  const limit = 32

  const fetchTurn = (input: SummaryPatchRequest) => {
    const key = `${input.sessionID}\0${input.messageID}\0${signature(input.summary)}`
    const hit = turns.get(key)
    if (hit) return hit
    const pending = Promise.resolve()
      .then(() => source?.({ sessionID: input.sessionID, messageID: input.messageID }))
      .catch(() => {
        turns.delete(key)
        return undefined
      })
    turns.set(key, pending)
    while (turns.size > limit) turns.delete(turns.keys().next().value!)
    return pending
  }

  return {
    /** The expanded file's patch body, or `undefined` when it cannot be had. */
    async patch(input: SummaryPatchRequest): Promise<string | undefined> {
      if (!source) return undefined
      const diffs = await fetchTurn(input)
      const match = diffs?.findLast((diff) => diff.file === input.file)
      return typeof match?.patch === "string" ? match.patch : undefined
    },
  }
}

export type SummaryPatchLoader = ReturnType<typeof createSummaryPatchLoader>
