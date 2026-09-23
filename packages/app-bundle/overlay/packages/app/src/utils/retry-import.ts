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
 * Transient by construction: only the specific truncation error retries;
 * real errors (404, syntax) rethrow untouched. */

export function retryImport<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((err: unknown) => {
    const message = String((err as Error | undefined)?.message ?? err)
    const match = message.match(/Failed to fetch dynamically imported module:\s*(\S+)/)
    if (!match) throw err
    const url = match[1]
    const bust = `${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}`
    // @vite-ignore — the URL is runtime data (parsed from the error), never
    // a build-time specifier.
    return import(/* @vite-ignore */ bust) as Promise<T>
  })
}
