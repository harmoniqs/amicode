// amicode#1767 — the LOCAL session-status re-seed (the reconnect / gap edge on a
// machine WITHOUT fleet peers; pure — every input injected, so it is unit-testable
// without Solid).
//
// The engine keeps session status PER DIRECTORY, and a read that names no
// directory resolves to the engine's own working directory (a temp dir under the
// Amicode service runner) — it returns {} for every real session, so the old
// directory-less re-seed was a no-op and a session left stale-idle during an
// outage was never corrected. This re-seed instead reads /session/status once per
// distinct directory of the sessions the app has PINNED (every open tab's, the
// viewed one), and applies each answer through the store's recency-guarded
// reconcile. It never reads a directory that is not a pinned session's own, and
// with nothing pinned it reads nothing.
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

export type LocalStatus = SessionStatus

export type LocalReseedDeps = {
  /** The currently pinned session ids. */
  pinnedIds: () => readonly string[]
  /** A session's own directory from the cached session info (undefined = unknown). */
  directoryOf: (sessionID: string) => string | undefined
  /** Load the session info (so its directory is known); may reject. */
  resolve: (sessionID: string) => Promise<unknown>
  /** GET /session/status scoped to `directory`. */
  readStatus: (directory: string) => Promise<Record<string, LocalStatus>>
  /** The store's recency-guarded reconcile. */
  reconcile: (statuses: Record<string, LocalStatus>, opts: { fetchedAt: number }) => void
  now?: () => number
}

/** One local re-seed. Timestamped BEFORE any request (the recency guard refuses
 *  a downgrade of a busy mutated after the snapshot). Never throws; a failed
 *  directory does not block the others — the next edge retries. */
export async function runLocalReseed(deps: LocalReseedDeps): Promise<void> {
  const fetchedAt = (deps.now ?? Date.now)()
  const directories = new Set<string>()
  await Promise.all(
    deps.pinnedIds().map(async (sessionID) => {
      let directory = deps.directoryOf(sessionID)
      if (directory === undefined) {
        try {
          await deps.resolve(sessionID)
        } catch {
          return // unresolvable — never guess a directory
        }
        directory = deps.directoryOf(sessionID)
      }
      if (directory) directories.add(directory)
    }),
  )
  await Promise.all(
    [...directories].map(async (directory) => {
      try {
        deps.reconcile(await deps.readStatus(directory), { fetchedAt })
      } catch {
        // A failed directory is non-fatal — the next edge retries.
      }
    }),
  )
}
