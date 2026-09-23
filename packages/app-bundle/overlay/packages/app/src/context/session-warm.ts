export const BULK_WARM_MESSAGES = 20
export const OPEN_TAB_WARM_MESSAGES = 60
export const WARM_CONCURRENCY = 3

type WarmChain = () => Promise<void>

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
    warm(origin: string, chains: WarmChain[]) {
      if (chains.length === 0) return Promise.resolve()
      const pool = pools.get(origin) ?? { active: 0, queue: [] }
      pools.set(origin, pool)
      const complete = Promise.all(
        chains.map(
          (chain) =>
            new Promise<void>((resolve) => {
              pool.queue.push({ chain, resolve })
            }),
        ),
      )
      drain(origin, pool)
      return complete
    },
  }
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
  try {
    if (!input.hasLineage()) await input.resolveLineage()
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
