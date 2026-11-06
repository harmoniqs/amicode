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
 * @module
 */

import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { usePlatform } from "@/context/platform"
import {
  MAX_INLINE_CHARS,
  MAX_INLINE_IMAGES,
  classifyLink,
  dataUrlFromRead,
  prepareHtml,
  serializeHtml,
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
  /** Called after each render with the local files the page inlined (#2142). */
  onAssetsChange?: (paths: string[]) => void
  /** Bumped by the parent to re-render even when the page text is unchanged
   *  (a referenced image changed on disk, #2142). */
  refreshKey?: () => number
}) {
  const platform = usePlatform()
  const [srcdoc, setSrcdoc] = createSignal<string | undefined>(undefined)
  let frame: HTMLIFrameElement | undefined
  let generation = 0
  let savedScroll: { x: number; y: number } | undefined

  // ─── Prepare + inline ────────────────────────────────────────────────
  const render = async (html: string, path: string) => {
    const mine = ++generation
    const prepared = prepareHtml(html, path)
    const unique = [...new Set(prepared.images.map((image) => image.path))].slice(0, MAX_INLINE_IMAGES)
    const urls = new Map<string, string>()
    let budget = MAX_INLINE_CHARS
    const reads = await Promise.all(
      unique.map((file) =>
        props
          .readFile(file)
          .then((result) => [file, dataUrlFromRead(result, file)] as const)
          .catch(() => [file, undefined] as const),
      ),
    )
    if (mine !== generation) return
    for (const [file, url] of reads) {
      if (!url || url.length > budget) continue
      budget -= url.length
      urls.set(file, url)
    }
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
    props.onAssetsChange?.(unique)
  }

  createEffect(
    on(
      () => [props.html(), props.filePath, props.refreshKey?.() ?? 0] as const,
      ([html, path]) => {
        void render(html, path)
      },
    ),
  )
  onCleanup(() => {
    generation++
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
