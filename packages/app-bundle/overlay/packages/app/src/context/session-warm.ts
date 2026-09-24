export const BULK_WARM_MESSAGES = 20
export const OPEN_TAB_WARM_MESSAGES = 60
export const WARM_CONCURRENCY = 3

type WarmChain = () => Promise<void>
type WarmTask = { id: string; chain: WarmChain }

/** Returns the shared HTTP-origin pool key, or isolates an unparseable/non-origin
 * server URL so it cannot abort a bulk warm pass for later connections. */
export function sessionWarmSchedulerKey(serverURL: string, pageURL = globalThis.location?.href) {
  try {
    const origin = new URL(serverURL, pageURL).origin
    return origin === "null" ? serverURL : origin
  } catch {
    return serverURL
  }
}

type WarmPool = {
  active: number
  queue: Array<{ chain: WarmChain; resolve: () => void }>
  pending: Map<string, Promise<void>>
}

/** Shares the browser's background budget across every server context that
 * reaches the same HTTP origin. Foreground loads retain the other half of a
 * six-request browser pool. */
export function createSessionWarmScheduler() {
  const pools = new Map<string, WarmPool>()

  const drain = (origin: string, pool: WarmPool) => {
    while (pool.active < WARM_CONCURRENCY) {
      const next = pool.queue.shift()
      if (!next) return
      pool.active += 1
      void (async () => {
        try {
          await next.chain()
        } catch {
          /* one failed background chain must not stall the queue */
        } finally {
          pool.active -= 1
          next.resolve()
          drain(origin, pool)
        }
      })()
    }
  }

  return {
    warm(origin: string, chains: Array<WarmChain | WarmTask>) {
      if (chains.length === 0) return Promise.resolve()
      const pool: WarmPool = pools.get(origin) ?? { active: 0, queue: [], pending: new Map() }
      pools.set(origin, pool)
      const complete = Promise.all(
        chains.map((task) => {
          if (typeof task === "function") {
            return new Promise<void>((resolve) => {
              pool.queue.push({ chain: task, resolve })
            })
          }
          const existing = pool.pending.get(task.id)
          if (existing) return existing
          const queued = new Promise<void>((resolve) => {
            pool.queue.push({
              chain: task.chain,
              resolve: () => {
                pool.pending.delete(task.id)
                resolve()
              },
            })
          })
          pool.pending.set(task.id, queued)
          return queued
        }),
      )
      drain(origin, pool)
      return complete
    },
  }
}

export async function warmSessionServerBatches<Server, Row, Session>(input: {
  servers: Server[]
  list: (server: Server) => Promise<Row[]>
  normalize: (row: Row) => Session
  remember: (server: Server, session: Session) => void
  warm: (server: Server, rows: Row[]) => Promise<void>
}) {
  const batches = await Promise.all(
    input.servers.map(async (server) => {
      let rows: Row[]
      try {
        rows = await input.list(server)
      } catch {
        return { server, rows: [] as Row[] }
      }
      const valid: Row[] = []
      for (const row of rows) {
        try {
          input.remember(server, input.normalize(row))
          valid.push(row)
        } catch {
          /* one malformed list row must not block its server batch */
        }
      }
      return { server, rows: valid }
    }),
  )
  await Promise.all(batches.map((batch) => input.warm(batch.server, batch.rows)))
}

export async function warmBulkSession(input: {
  remember: () => void
  hasLineage: () => boolean
  resolveLineage: () => Promise<unknown>
  shouldPrefetch: () => boolean
  prefetch: (limit: number) => Promise<unknown>
}) {
  try {
    input.remember()
  } catch {
    /* a malformed list row must not block its background chain */
  }
  void Promise.resolve()
    .then(() => (input.hasLineage() ? undefined : input.resolveLineage()))
    .catch(() => {
      /* lineage is best effort and must not suppress message warming */
    })
  try {
    if (input.shouldPrefetch()) await input.prefetch(BULK_WARM_MESSAGES)
  } catch {
    /* bulk warming is best effort */
  }
}

export async function warmOpenSessionTab(
  sessionID: string,
  prefetch: (sessionID: string, limit: number) => Promise<unknown>,
) {
  await prefetch(sessionID, BULK_WARM_MESSAGES)
  await prefetch(sessionID, OPEN_TAB_WARM_MESSAGES)
}
