/**
 * pdf-canvas-view — Renders PDF pages to <canvas> elements via PDF.js.
 *
 * Uses pdfjs-dist (Mozilla's PDF renderer) to decode PDF binary data and
 * paint each page onto a canvas, with a DOM text layer over the same viewport
 * for native selection and copy. No browser plugin, no iframe, no Chromium
 * PDF viewer — works in any context including VS Code sandboxed webviews.
 *
 * Worker runs on the main thread via globalThis.pdfjsWorker injection
 * (LoopbackPort). For a side-panel preview showing one PDF at a time this
 * is fine and avoids CSP/bundling complexity with real Web Workers.
 *
 * Pages fit the container width at 100% zoom (like images do). User zoom
 * multiplies on top of the fit-to-width base scale. A ResizeObserver tracks
 * container width so pages reflow when the panel is resized.
 *
 * @module
 */

import { createEffect, createSignal, For, on, onCleanup } from "solid-js"
import * as pdfjsLib from "pdfjs-dist"
// @ts-expect-error — no type declarations for the worker bundle; Vite resolves it at build time
import * as pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs"

// Inject the worker module on globalThis — the one code path in pdfjs-dist v6
// that bypasses BOTH `new Worker()` AND the `workerSrc` getter. PDF.js sees
// `globalThis.pdfjsWorker.WorkerMessageHandler`, routes through LoopbackPort,
// and runs everything on the main thread. No CSP issue, no blob worker, no
// external fetch. Fine for a side-panel preview.
;(globalThis as any).pdfjsWorker = pdfjsWorker

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PdfCanvasViewProps {
  /** Base64-encoded PDF content */
  base64: string
  /** MIME type (e.g. "application/pdf") */
  mime: string
  /** Zoom percentage (100 = fit container width) */
  zoom: number
  /** The file path — used for the "Open in editor" button */
  filePath: string
  /** Reports the current PDF page state to the Preview controls. */
  onPageNavigationChange?: (navigation: PdfPageNavigation | null) => void
}

type PdfPageNavigation = {
  currentPage: number
  pageCount: number
  canPrevious: boolean
  canNext: boolean
  navigate: (page: number) => boolean
}

// Wrapper padding: p-4 = 16px each side
const WRAPPER_PADDING = 32
const ZOOM_RENDER_DEBOUNCE_MS = 100
const PAGE_CENTER_TIE_TOLERANCE_PX = 0.5

// PDF.js generates positioned spans but intentionally leaves their layout CSS
// to its host viewer. Keep the layer transparent so canvas remains authoritative
// for appearance while the browser can still select and copy its real text.
const PDF_TEXT_LAYER_STYLE = `
[data-pdf-text-layer] {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  text-align: initial;
  text-size-adjust: none;
  transform-origin: 0 0;
  z-index: 1;
  --user-unit: 1;
  --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
  --scale-round-x: 1px;
  --scale-round-y: 1px;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}

[data-pdf-text-layer] :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
  user-select: text;
}

[data-pdf-text-layer] > :not(.markedContent),
[data-pdf-text-layer] .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}

[data-pdf-text-layer] ::selection {
  background: Highlight;
  color: transparent;
}
`

// ---------------------------------------------------------------------------
// Single page renderer
// ---------------------------------------------------------------------------

function PdfPage(props: {
  doc: pdfjsLib.PDFDocumentProxy
  pageNum: number
  zoom: number
  /** Available content width in CSS pixels (container minus padding) */
  containerWidth: number
  onTextAvailability: (available: boolean) => void
  onAnchorChange: (anchor: HTMLDivElement | null) => void
}) {
  const [page, setPage] = createSignal<pdfjsLib.PDFPageProxy | null>(null)
  let canvasRef: HTMLCanvasElement | undefined
  let textLayerRef: HTMLDivElement | undefined
  let activeRender: { cancel(): void } | null = null
  let activeTextLayer: pdfjsLib.TextLayer | null = null
  let renderTimer: ReturnType<typeof setTimeout> | undefined

  // Load the PDF page and text stream once. Zoom and resize retain the text
  // layer, avoiding a fresh stream read and DOM reconstruction each time.
  createEffect(() => {
    const doc = props.doc
    const pageNum = props.pageNum
    if (!doc) return

    setPage(null)
    activeTextLayer?.cancel()
    activeTextLayer = null
    textLayerRef?.replaceChildren()

    let cancelled = false

    doc.getPage(pageNum).then((page) => {
      if (cancelled) return
      setPage(page)
    })

    onCleanup(() => {
      cancelled = true
      activeTextLayer?.cancel()
      activeTextLayer = null
      textLayerRef?.replaceChildren()
    })
  })

  // Keep the last painted canvas visible while rapid zoom input settles. The
  // new high-resolution raster is staged offscreen, then copied in atomically.
  createEffect(() => {
    const currentPage = page()
    const zoom = props.zoom
    const containerWidth = props.containerWidth
    if (!canvasRef || !textLayerRef || !currentPage || containerWidth <= 0) return

    const dpr = window.devicePixelRatio || 1
    const intrinsic = currentPage.getViewport({ scale: 1 })
    const scale = (containerWidth / intrinsic.width) * (zoom / 100)
    const viewport = currentPage.getViewport({ scale })
    const canvasViewport = currentPage.getViewport({ scale: scale * dpr })

    textLayerRef.style.setProperty("--scale-factor", `${scale}`)
    // Uniform zoom is expressed through the layer's CSS scale variable, so the
    // existing DOM spans remain valid without a fresh text stream read.
    if (!activeTextLayer) {
      const textLayer = new pdfjsLib.TextLayer({
        textContentSource: currentPage.streamTextContent(),
        container: textLayerRef,
        viewport,
      })
      activeTextLayer = textLayer
      void textLayer.render().then(() => {
        if (activeTextLayer !== textLayer) return
        props.onTextAvailability(textLayer.textContentItemsStr.some((text) => text.trim().length > 0))
      }).catch(() => {
        if (activeTextLayer !== textLayer) return
        props.onTextAvailability(false)
      })
    }

    // Scale the last completed bitmap immediately; it preserves the page's
    // geometry during the gesture while the crisp replacement is rendered.
    canvasRef.style.width = `${canvasViewport.width / dpr}px`
    canvasRef.style.height = `${canvasViewport.height / dpr}px`

    const render = () => {
      const staging = document.createElement("canvas")
      staging.width = canvasViewport.width
      staging.height = canvasViewport.height
      const ctx = staging.getContext("2d")
      if (!ctx) return

      const task = currentPage.render({ canvas: null, canvasContext: ctx, viewport: canvasViewport })
      activeRender = task
      task.promise
        .then(() => {
          if (activeRender !== task || !canvasRef) return
          canvasRef.width = staging.width
          canvasRef.height = staging.height
          canvasRef.getContext("2d")?.drawImage(staging, 0, 0)
        })
        .catch(() => {})
        .finally(() => {
          if (activeRender === task) activeRender = null
        })
    }

    if (canvasRef.width === 0 || canvasRef.height === 0) {
      render()
    } else {
      renderTimer = setTimeout(render, ZOOM_RENDER_DEBOUNCE_MS)
    }

    onCleanup(() => {
      if (renderTimer) clearTimeout(renderTimer)
      renderTimer = undefined
      activeRender?.cancel()
      activeRender = null
    })
  })

  onCleanup(() => props.onAnchorChange(null))

  return (
    <div ref={props.onAnchorChange} class="relative">
      <canvas
        ref={canvasRef}
        class="block shadow-sm rounded-sm"
        style={{ background: "white" }}
      />
      <div ref={textLayerRef} data-pdf-text-layer />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PdfCanvasView(props: PdfCanvasViewProps) {
  const [pageCount, setPageCount] = createSignal(0)
  const [currentPage, setCurrentPage] = createSignal(1)
  const [pdfDoc, setPdfDoc] = createSignal<pdfjsLib.PDFDocumentProxy | null>(null)
  const [error, setError] = createSignal(false)
  const [containerWidth, setContainerWidth] = createSignal(0)
  const [containerHeight, setContainerHeight] = createSignal(0)
  const [textAvailability, setTextAvailability] = createSignal<Record<number, boolean>>({})
  const [anchorVersion, setAnchorVersion] = createSignal(0)

  let wrapperRef: HTMLDivElement | undefined
  let navigationFrame: number | undefined
  const pageAnchors = new Map<number, HTMLDivElement>()

  const setPageAnchor = (page: number, anchor: HTMLDivElement | null) => {
    if (anchor) pageAnchors.set(page, anchor)
    else pageAnchors.delete(page)
    setAnchorVersion((version) => version + 1)
  }

  const updateCurrentPage = () => {
    if (navigationFrame !== undefined) return
    navigationFrame = requestAnimationFrame(() => {
      navigationFrame = undefined
      const scroll = wrapperRef?.parentElement
      if (!scroll || pageAnchors.size === 0) return

      const viewportCenter = scroll.getBoundingClientRect().top + scroll.clientHeight / 2
      let closestPage = 1
      let closestDistance = Infinity
      for (const [page, anchor] of pageAnchors) {
        const bounds = anchor.getBoundingClientRect()
        const distance = Math.abs((bounds.top + bounds.bottom) / 2 - viewportCenter)
        if (
          distance < closestDistance - PAGE_CENTER_TIE_TOLERANCE_PX ||
          (Math.abs(distance - closestDistance) <= PAGE_CENTER_TIE_TOLERANCE_PX && page < closestPage)
        ) {
          closestPage = page
          closestDistance = distance
        }
      }
      setCurrentPage(closestPage)
    })
  }

  const navigateToPage = (page: number) => {
    const scroll = wrapperRef?.parentElement
    const anchor = pageAnchors.get(page)
    if (!scroll || !anchor) return false

    const target = scroll.scrollTop + anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    setCurrentPage(page)
    scroll.scrollTo({ top: target, behavior: "smooth" })
    return true
  }

  // ─── Track container width via ResizeObserver ───────────────────────
  // Observe the PARENT element (the scroll container), not the wrapper.
  // The wrapper is inline-flex and grows to fit page canvases — observing
  // it would create a feedback loop: pages render → wrapper resizes →
  // observer fires → containerWidth changes → pages re-render → ...
  // The parent's width is flex-determined and independent of content.
  createEffect(() => {
    const parent = wrapperRef?.parentElement
    if (!parent) return

    // Initial measurement: parentElement (scroll container) has no padding,
    // so clientWidth is its full inner width. Subtract the wrapper's p-4.
    setContainerWidth(parent.clientWidth - WRAPPER_PADDING)
    setContainerHeight(parent.clientHeight)

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentBoxSize = scroll container's content width (no padding on it).
        // Subtract the wrapper's padding to get available page width.
        setContainerWidth(entry.contentBoxSize[0].inlineSize - WRAPPER_PADDING)
        setContainerHeight(entry.contentBoxSize[0].blockSize)
      }
    })
    observer.observe(parent)
    onCleanup(() => observer.disconnect())
  })

  // ─── Load the PDF document from base64 ──────────────────────────────
  createEffect(
    on(
      () => props.base64,
      (b64) => {
        if (!b64) return
        setError(false)
        setPageCount(0)
        setCurrentPage(1)
        pageAnchors.clear()
        setAnchorVersion((version) => version + 1)
        setPdfDoc(null)
        setTextAvailability({})

        try {
          // Decode base64 → Uint8Array
          const raw = atob(b64)
          const bytes = new Uint8Array(raw.length)
          for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

          const loadingTask = pdfjsLib.getDocument({
            data: bytes,
            // Disable worker-fetch — we already have the data in memory
            useWorkerFetch: false,
            useSystemFonts: true,
          })

          loadingTask.promise
            .then((doc) => {
              setPdfDoc(doc)
              setPageCount(doc.numPages)
            })
            .catch(() => {
              setError(true)
            })
        } catch {
          setError(true)
        }
      },
    ),
  )

  // Clean up the document on unmount
  onCleanup(() => {
    const doc = pdfDoc()
    if (doc) doc.cleanup()
    if (navigationFrame !== undefined) cancelAnimationFrame(navigationFrame)
    props.onPageNavigationChange?.(null)
  })

  createEffect(() => {
    const count = pageCount()
    const page = currentPage()
    anchorVersion()
    props.onPageNavigationChange?.(
      count > 0 && !error()
        ? {
            currentPage: page,
            pageCount: count,
            canPrevious: page > 1 && pageAnchors.has(page - 1),
            canNext: page < count && pageAnchors.has(page + 1),
            navigate: navigateToPage,
          }
        : null,
    )
  })

  createEffect(() => {
    anchorVersion()
    const scroll = wrapperRef?.parentElement
    if (!scroll) return
    scroll.addEventListener("scroll", updateCurrentPage, { passive: true })
    updateCurrentPage()
    onCleanup(() => scroll.removeEventListener("scroll", updateCurrentPage))
  })

  const textAvailabilityMessage = () => {
    const availability = textAvailability()
    if (pageCount() === 0 || Object.keys(availability).length !== pageCount()) return null
    const pagesWithText = Object.values(availability).filter(Boolean).length
    if (pagesWithText === 0) return "This PDF has no selectable text."
    if (pagesWithText < pageCount()) return "Text selection is unavailable on some pages."
    return null
  }

  return (
    <div ref={wrapperRef} class="inline-flex flex-col items-center gap-3 p-4 min-w-full min-h-full">
      <style>{PDF_TEXT_LAYER_STYLE}</style>
      {textAvailabilityMessage() && (
        <p role="status" class="self-start text-12-regular text-text-weak">
          {textAvailabilityMessage()}
        </p>
      )}
      {/* Rendered pages */}
      <For each={Array.from({ length: pageCount() }, (_, i) => i + 1)}>
        {(pageNum) => (
          <PdfPage
            doc={pdfDoc()!}
            pageNum={pageNum}
            zoom={props.zoom}
            containerWidth={containerWidth()}
            onTextAvailability={(available) => {
              setTextAvailability((current) => ({ ...current, [pageNum]: available }))
            }}
            onAnchorChange={(anchor) => setPageAnchor(pageNum, anchor)}
          />
        )}
      </For>

      {/* Error state */}
      {error() && (
        <div class="flex flex-col items-center gap-2 py-8">
          <p class="text-12-regular text-text-weak">Could not render PDF</p>
        </div>
      )}

      {/* Open in editor — secondary action below the rendered pages */}
      <button
        class="text-11-regular text-text-faint hover:text-text-weak transition-colors py-2"
        onClick={() => {
          window.parent.postMessage(
            { source: "amicode", kind: "open-file", path: props.filePath },
            "*",
          )
        }}
      >
        Open in editor
      </button>
      <div aria-hidden="true" style={{ height: `${containerHeight()}px` }} />
    </div>
  )
}
