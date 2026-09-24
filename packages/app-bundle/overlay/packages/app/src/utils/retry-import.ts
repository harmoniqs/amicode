/** Recover selected lazy imports from Chromium's cached truncated-module error.
 *
 * A failed module URL is retried with only its `retry` query marker replaced,
 * giving Chromium a fresh module-map key. Recovery is deliberately bounded to
 * five delayed attempts (1s, 2s, 4s, 8s, 16s): at most 31 seconds total.
 * Errors outside this transient failure shape are rethrown unchanged. */

export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const

type RetryImportOptions<T> = {
  delays?: readonly number[]
  importer?: (url: string) => Promise<T>
  now?: () => number
  sleep?: (delay: number) => Promise<void>
}

/** Return the failed dynamic-module URL only for Chromium's transient error. */
export function parseTruncatedModuleUrl(error: unknown): string | null {
  const message = String((error as { message?: unknown } | undefined)?.message ?? error)
  return message.match(/Failed to fetch dynamically imported module:\s*(\S+)/)?.[1] ?? null
}

function withRetryMarker(url: string, now: () => number): string {
  const retryUrl = new URL(url)
  retryUrl.searchParams.set("retry", String(now()))
  return retryUrl.href
}

const wait = (delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay))

export async function retryImport<T>(load: () => Promise<T>, options: RetryImportOptions<T> = {}): Promise<T> {
  const delays = options.delays ?? RETRY_DELAYS_MS
  const importer = options.importer ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<T>)
  const sleep = options.sleep ?? wait
  const now = options.now ?? Date.now

  try {
    return await load()
  } catch (error) {
    const failedUrl = parseTruncatedModuleUrl(error)
    if (!failedUrl || delays.length === 0) throw error

    return retry(failedUrl, 0)
  }

  async function retry(failedUrl: string, attempt: number): Promise<T> {
    await sleep(delays[attempt])
    try {
      return await importer(withRetryMarker(failedUrl, now))
    } catch (error) {
      const nextUrl = parseTruncatedModuleUrl(error)
      if (!nextUrl || attempt + 1 === delays.length) throw error
      return retry(nextUrl, attempt + 1)
    }
  }
}
