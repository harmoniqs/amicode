/**
 * preview-html-view — the Preview tab's rendered view of an `.html` page (#2141).
 *
 * The page is shown in an iframe sandboxed with `allow-same-origin` and WITHOUT
 * `allow-scripts`: nothing in the page runs (scripts, inline handlers, meta
 * refresh), while the host can still read the frame to route link clicks,
 * apply zoom and keep scroll across re-renders. NEVER add `allow-scripts` to
 * this frame — combined with same-origin it would hand the page the app.
 *
 * Content arrives as the file's text (the parent view owns reading and
 * watcher-driven reloads); this view prepares it (preview-html.ts), inlines
 * local images through the engine's file API, and swaps the srcdoc.
 *
 * #2142: the view also keeps itself live where the engine's watcher cannot
 * see — while visible it re-reads the page (handing new text to the parent)
 * and, under a size cap, its images; a watcher change to any inlined image
 * re-renders too.
 *
 * @module
 */

import { createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { usePlatform } from "@/context/platform"
import { useSDK } from "@/context/sdk"
import {
  ASSET_POLL_MAX_CHARS,
  HTML_POLL_MS,
  MAX_INLINE_CHARS,
  assetsChanged,
  MAX_INLINE_IMAGES,
  classifyLink,
  dataUrlFromRead,
  prepareHtml,
  serializeHtml,
  shouldPollHtml,
  watcherPathMatches,
} from "./preview-html"

export type HtmlFileRead = (path: string) => Promise<
  { type?: string; content?: string; encoding?: string; mimeType?: string } | null | undefined
>

export function PreviewHtmlView(props: {
  filePath: string
  html: () => string
  zoom: () => number
  readFile: HtmlFileRead
  /** The session the view belongs to — preview-file opens target it (#1648). */
  sessionID?: string
  /** Whether this pane is the visible one; polling stops when it is not (#2142). */
  active?: () => boolean
  /** New page text found by a poll (#2142); the parent decides whether to apply it. */
  onExternalContent?: (text: string) => void
}) {
  const platform = usePlatform()
  const sdk = useSDK()
  const [srcdoc, setSrcdoc] = createSignal<string | undefined>(undefined)
  const [refresh, setRefresh] = createSignal(0)
  let inlined = new Map<string, string>()
  let inlinedChars = 0
  let frame: HTMLIFrameElement | undefined
  let generation = 0
  let savedScroll: { x: number; y: number } | undefined

  // ─── Prepare + inline ────────────────────────────────────────────────
  const readImages = async (files: string[]) => {
    const reads = await Promise.all(
      files.map((file) =>
        props
          .readFile(file)
          .then((result) => [file, dataUrlFromRead(result, file)] as const)
          .catch(() => [file, undefined] as const),
      ),
    )
    const urls = new Map<string, string>()
    let budget = MAX_INLINE_CHARS
    for (const [file, url] of reads) {
      if (!url || url.length > budget) continue
      budget -= url.length
      urls.set(file, url)
    }
    return urls
  }

  const render = async (html: string, path: string) => {
    const mine = ++generation
    const prepared = prepareHtml(html, path)
    const unique = [...new Set(prepared.images.map((image) => image.path))].slice(0, MAX_INLINE_IMAGES)
    const urls = await readImages(unique)
    if (mine !== generation) return
    inlined = urls
    inlinedChars = [...urls.values()].reduce((total, url) => total + url.length, 0)
    for (const image of prepared.images) {
      const url = urls.get(image.path)
      if (url) image.element.setAttribute(image.attribute, url)
      else {
        image.element.removeAttribute(image.attribute)
        if (!image.element.getAttribute("title")) image.element.setAttribute("title", `Could not load ${image.path}`)
      }
    }
    // keep the reader's place across a re-render
    try {
      const win = frame?.contentWindow
      if (win) savedScroll = { x: win.scrollX, y: win.scrollY }
    } catch {}
    setSrcdoc(serializeHtml(prepared.doc))
  }

  createEffect(
    on(
      () => [props.html(), props.filePath, refresh()] as const,
      ([html, path]) => {
        void render(html, path)
      },
    ),
  )
  onCleanup(() => {
    generation++
  })

  // ─── Live refresh (#2142) ────────────────────────────────────────────
  // A watcher change to an inlined image re-renders (the page's own changes
  // reach us through the parent's watcher re-read).
  createEffect(() => {
    const unsub = sdk().event.listen((e) => {
      if (e.details.type !== "file.watcher.updated") return
      const details = e.details.properties as Record<string, unknown> | undefined
      const changed = typeof details?.file === "string" ? details.file : undefined
      if (!changed || (details?.event !== "change" && details?.event !== "add")) return
      for (const asset of inlined.keys()) {
        if (watcherPathMatches(changed, asset)) {
          setRefresh((n) => n + 1)
          return
        }
      }
    })
    onCleanup(unsub)
  })

  // A visible page re-reads itself, and (under the cap) its images, on a timer:
  // the watcher never sees a file a script rewrites outside the project.
  let polling = false
  const poll = async () => {
    if (polling) return
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden"
    if (!shouldPollHtml({ active: props.active?.() ?? true, visible })) return
    polling = true
    try {
      const mine = generation
      const page = await props.readFile(props.filePath).catch(() => undefined)
      if (mine !== generation) return
      if (page && page.type === "text" && typeof page.content === "string" && page.content !== props.html()) {
        props.onExternalContent?.(page.content)
        return
      }
      if (inlined.size === 0 || inlinedChars > ASSET_POLL_MAX_CHARS) return
      const fresh = await readImages([...inlined.keys()])
      if (mine !== generation) return
      if (assetsChanged(inlined, fresh)) setRefresh((n) => n + 1)
    } finally {
      polling = false
    }
  }
  onMount(() => {
    const timer = setInterval(() => void poll(), HTML_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // ─── Frame wiring ────────────────────────────────────────────────────
  const frameDocument = () => {
    try {
      return frame?.contentDocument ?? undefined
    } catch {
      return undefined
    }
  }

  const applyZoom = () => {
    const doc = frameDocument()
    if (doc?.documentElement) doc.documentElement.style.zoom = `${props.zoom() / 100}`
  }
  createEffect(on(() => props.zoom(), applyZoom, { defer: true }))

  const openPreview = (path: string) => {
    window.postMessage({ source: "amicode", kind: "preview-file", path, sessionID: props.sessionID }, "*")
  }

  const onFrameClick = (event: MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target?.closest?.("a[href], area[href], a") as Element | null
    if (!anchor) return
    const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href")
    if (href === null) return
    event.preventDefault()
    if (event.type !== "click") return
    const action = classifyLink(href, props.filePath)
    if (action.kind === "external") platform.openExternal(action.url)
    else if (action.kind === "preview") openPreview(action.path)
    else if (action.kind === "anchor") {
      const doc = frameDocument()
      const el = doc?.getElementById(action.id) ?? doc?.getElementsByName(action.id)[0]
      el?.scrollIntoView({ block: "start" })
    }
  }

  const onLoad = () => {
    const doc = frameDocument()
    if (!doc) return
    applyZoom()
    doc.addEventListener("click", onFrameClick)
    doc.addEventListener("auxclick", onFrameClick)
    // forms cannot submit (no allow-forms); swallow the attempt quietly
    doc.addEventListener("submit", (event) => event.preventDefault())
    const scroll = savedScroll
    savedScroll = undefined
    if (scroll) frame?.contentWindow?.scrollTo(scroll.x, scroll.y)
  }

  return (
    <iframe
      ref={frame}
      data-preview-html
      title={props.filePath.split("/").pop() ?? "HTML preview"}
      sandbox="allow-same-origin"
      srcdoc={srcdoc() ?? ""}
      onLoad={onLoad}
      class="block w-full h-full border-0"
      style={{ background: "#ffffff", "color-scheme": "light" }}
    />
  )
}
