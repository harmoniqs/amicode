// AMICODE: inline previews for images the agent wrote to the server's disk.
// `![equation](/home/me/talk/eq.png)` in chat markdown can't load directly: the
// chat iframe's origin is the server, a bare <img> can't carry the Basic
// credential, and file:// is stripped by the sanitizer and blocked by the CSP.
// The app registers a loader (it owns the server connection + auth) that reads
// the file through the server and returns a data: URL; the Markdown component
// swaps it in. With no loader registered (stories, tests, a plain browser
// embed) local images stay unloaded and show their alt text.

import { createSignal } from "solid-js"

export type LocalImageLoader = (path: string) => Promise<string | null>

let loader: LocalImageLoader | undefined
const [version, setVersion] = createSignal(0)

/** Same registration contract as registerFileRefResolver (#1845): the returned
 *  unregister clears ONLY this registration, so a remounting shell's late
 *  cleanup can't wipe its successor. */
export function registerLocalImageLoader(next: LocalImageLoader | undefined): () => void {
  loader = next
  setVersion((v) => v + 1)
  return () => {
    if (loader !== next) return
    loader = undefined
    setVersion((v) => v + 1)
  }
}

export function localImageLoaderVersion(): number {
  return version()
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i

/** An authored src that names a file on the server's disk: an absolute posix
 *  path (not a protocol-relative `//host`) or a file:// URL. */
export function localImagePath(src: string): string | undefined {
  const value = src.trim()
  if (/^file:\/\//i.test(value)) {
    const path = decodeURIComponent(value.replace(/^file:\/\//i, ""))
    return IMAGE_EXT.test(path) ? path : undefined
  }
  if (!value.startsWith("/") || value.startsWith("//")) return undefined
  const path = decodeURIComponent(value.split(/[?#]/)[0] ?? "")
  return IMAGE_EXT.test(path) ? path : undefined
}

// path → data URL (null = known-unloadable). Bounded FIFO by entry count; the
// images are small (equations, plots) but a session can show many of them.
const CACHE_MAX = 64
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

export function cachedLocalImage(path: string): string | null | undefined {
  return cache.get(path)
}

/** Load once, dedupe in-flight. Transient failures stay uncached so the next
 *  render retries (the image may still be being written). */
export function loadLocalImageCached(path: string): Promise<string | null> {
  const hit = cache.get(path)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(path)
  if (pending) return pending
  const load = loader
  if (!load) return Promise.resolve(null)
  const p = load(path)
    .then((url) => {
      if (!url) return null
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next()
        if (!oldest.done) cache.delete(oldest.value)
      }
      cache.set(path, url)
      return url
    })
    .catch(() => null)
    .finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

/** Test hook. */
export function clearLocalImageCache(): void {
  cache.clear()
  inflight.clear()
}

// Every chat image gets a frame with an action button (the caller supplies the
// copy button). Local-path sources (`![](/abs/x.png)`) can't load directly in
// the iframe: park the path in data-local-src and drop the src so no doomed
// request fires; loadLocalImages fills it in on the live container, and once
// cached the next pass sets it synchronously, so a morphdom rebuild of the
// block never flashes the image away. Idempotent.
export function frameImages(root: HTMLElement, button: () => HTMLElement) {
  for (const img of Array.from(root.querySelectorAll("img"))) {
    const local = localImagePath(img.getAttribute("src") ?? "")
    if (local) {
      img.setAttribute("data-local-src", local)
      const cached = cache.get(local)
      if (cached) img.setAttribute("src", cached)
      else img.removeAttribute("src")
    }
    if (img.parentElement?.getAttribute("data-component") === "markdown-image") continue
    const frame = document.createElement("span")
    frame.setAttribute("data-component", "markdown-image")
    // The paper backing (markdown.css) is for agent-written figures on the
    // server's disk — typically transparent PNG/SVG inked for a light slide.
    // Remote/data images render as authored.
    if (local) frame.setAttribute("data-local", "")
    img.parentNode?.replaceChild(frame, img)
    frame.appendChild(img)
    frame.appendChild(button())
  }
}

/** Live-container pass: load every parked local image that has no src yet. */
export function loadLocalImages(root: HTMLElement) {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-local-src]:not([src])"))) {
    const path = img.getAttribute("data-local-src")
    if (!path) continue
    void loadLocalImageCached(path).then((url) => {
      if (!url || !img.isConnected || img.getAttribute("data-local-src") !== path) return
      img.src = url
    })
  }
}
