/** #1459: retrying dynamic imports — the tunnel-truncation class.
 *
 * The fleet's ssh tunnel restarts on network transitions (launchd
 * KeepAlive), and each restart kills every in-flight tunneled response
 * MID-STREAM. A lazily-imported chunk that crosses a restart window gets a
 * cleanly-truncated body (observed live: 2,884 of 28,497 bytes — the client
 * sees a clean EOF, so no network error, just a broken module stream).
 * Chromium's module map then caches the failure FOR THE DOCUMENT'S LIFE:
 * every later import of the same URL throws "Failed to fetch dynamically
 * imported module" WITHOUT a network request — the panel's new-session
 * launch freezes in the loading hold forever.
 *
 * The heal: parse the failing URL from the error and re-import it
 * CACHE-BUSTED — a fresh module-map key, a fresh fetch, clean recovery.
 * The transport can be down for MINUTES at a time (observed: the tunnel
 * watchdog's consecutive-000 probe windows), so the retry BACKS OFF
 * (1s→2s→4s→8s→16s, ~31s of ride-out) and keeps going until the link
 * returns — a single immediate retry drowned in the storm's first beat.
 * Transient by construction: only the specific truncation error retries;
 * real errors (404, syntax) rethrow untouched. */

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000]

/** Extract the module URL from a truncation error; null when the error is
 * anything else (the retry contract: transient-only). */
export function parseTruncatedModuleUrl(err: unknown): string | null {
  const message = String((err as Error | undefined)?.message ?? err)
  const match = message.match(/Failed to fetch dynamically imported module:\s*(\S+)/)
  return match ? match[1] : null
}

export function retryImport<T>(
  load: () => Promise<T>,
  opts?: { attempts?: number; importer?: (url: string) => Promise<T>; delays?: number[] },
): Promise<T> {
  const attempts = opts?.attempts ?? RETRY_DELAYS_MS.length
  const delays = opts?.delays ?? RETRY_DELAYS_MS
  // The engine importer: a runtime URL (parsed from the error, bust-suffixed)
  // — never a build-time specifier.
  const importer = opts?.importer ?? ((url: string) => import(/* @vite-ignore */ url) as Promise<T>)
  const attempt = (remaining: number): Promise<T> =>
    load().catch((err: unknown) => {
      const url = parseTruncatedModuleUrl(err)
      if (!url || remaining <= 0) throw err
      // A chained failure's URL may already carry a previous ?retry= — strip
      // it so every bust is a genuinely fresh module-map key.
      const base = url.split("?")[0]
      const delay = delays[delays.length - remaining] ?? delays[delays.length - 1] ?? 8_000
      return new Promise((resolve) => setTimeout(resolve, delay))
        .then(() => importer(`${base}?retry=${Date.now()}`))
        .catch((err2: unknown) => {
          if (parseTruncatedModuleUrl(err2)) return attempt(remaining - 1)
          throw err2
        })
    })
  return attempt(attempts)
}
