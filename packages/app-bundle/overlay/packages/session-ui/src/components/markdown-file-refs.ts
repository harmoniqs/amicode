// AMICODE: file-reference linkification for chat markdown.
// The app registers a resolver (it owns the server connection + auth); the
// Markdown component then wraps path-like inline-code pills and relative
// authored links in file:// anchors that the VS Code bridge opens in the
// editor. session-ui stays server-agnostic: with no resolver registered
// (plain browser embed, stories, tests) nothing linkifies and pills stay pills.

export type FileRefResolver = (text: string) => Promise<string | null>

let resolver: FileRefResolver | undefined

/** App-side registration — called once at shell mount, `undefined` on
 *  unmount. The resolver must resolve its server connection PER CALL (a server
 *  switch is picked up by the very next resolution). */
export function registerFileRefResolver(next: FileRefResolver | undefined): void {
  resolver = next
}

export function fileRefResolver(): FileRefResolver | undefined {
  return resolver
}

// text → absolute path (null = resolved-to-nothing). Bounded FIFO: pill text
// is unbounded agent/user prose, so the cache must not grow with the session.
const CACHE_MAX = 500
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

/** undefined = not yet resolved; null = known-unresolvable; string = absolute path. */
export function cachedFileRef(text: string): string | null | undefined {
  return cache.get(text)
}

/** Resolve once, dedupe in-flight, cache definitive answers. Transient
 *  failures (server down mid-fetch) stay UNCACHED so the next render retries. */
export function resolveFileRefCached(text: string): Promise<string | null> {
  const hit = cache.get(text)
  if (hit !== undefined) return Promise.resolve(hit)
  const pending = inflight.get(text)
  if (pending) return pending
  const resolve = resolver
  if (!resolve) return Promise.resolve(null)
  const p = resolve(text)
    .then((abs) => {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(text, abs)
      return abs
    })
    .catch(() => null)
    .finally(() => inflight.delete(text))
  inflight.set(text, p)
  return p
}

/** The bridge (extension chat_bridge.ts) decodes via new URL(...).pathname +
 *  decodeURIComponent, so percent-encode here; posix-only fleet, keep the
 *  slashes readable. */
export function fileRefUrl(abs: string): string {
  return "file://" + encodeURI(abs)
}

/** Test hook. */
export function clearFileRefCache(): void {
  cache.clear()
  inflight.clear()
}
