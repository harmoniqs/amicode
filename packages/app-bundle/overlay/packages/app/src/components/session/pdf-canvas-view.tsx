/**
 * pdf-canvas-view — Renders PDF pages to <canvas> elements via PDF.js.
 *
 * Uses pdfjs-dist (Mozilla's PDF renderer) to decode PDF binary data and
 * paint each page onto a canvas. No browser plugin, no iframe, no Chromium
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
}

// Wrapper padding: p-4 = 16px each side
const WRAPPER_PADDING = 32

// ---------------------------------------------------------------------------
// Single page renderer
// ---------------------------------------------------------------------------

function PdfPage(props: {
  doc: pdfjsLib.PDFDocumentProxy
  pageNum: number
  zoom: number
  /** Available content width in CSS pixels (container minus padding) */
  containerWidth: number
}) {
  let canvasRef: HTMLCanvasElement | undefined
  let activeRender: { cancel(): void } | null = null

  // Re-render whenever zoom, container width, or page changes
  createEffect(() => {
    const doc = props.doc
    const zoom = props.zoom
    const pageNum = props.pageNum
    const containerWidth = props.containerWidth
    if (!canvasRef || !doc || containerWidth <= 0) return

    // Cancel any in-flight render from a previous reactive cycle
    if (activeRender) {
      activeRender.cancel()
      activeRender = null
    }

    let cancelled = false

    doc.getPage(pageNum).then((page) => {
      if (cancelled || !canvasRef) return

      const dpr = window.devicePixelRatio || 1

      // Get intrinsic page size (PDF points at scale=1)
      const intrinsic = page.getViewport({ scale: 1 })

      // Base scale: fit the page width to the container at 100% zoom.
      // User zoom multiplies on top: 200% = twice the container width.
      const baseScale = containerWidth / intrinsic.width
      const scale = baseScale * (zoom / 100) * dpr
      const viewport = page.getViewport({ scale })

      canvasRef.width = viewport.width
      canvasRef.height = viewport.height
      // CSS size = physical ÷ dpr so it's crisp on HiDPI
      canvasRef.style.width = `${viewport.width / dpr}px`
      canvasRef.style.height = `${viewport.height / dpr}px`

      const ctx = canvasRef.getContext("2d")
      if (!ctx) return

      const task = page.render({ canvas: null, canvasContext: ctx, viewport })
      activeRender = task
      task.promise
        .then(() => { activeRender = null })
        .catch(() => { activeRender = null })
    })

    onCleanup(() => {
      cancelled = true
      if (activeRender) {
        activeRender.cancel()
        activeRender = null
      }
    })
  })

  return (
    <canvas
      ref={canvasRef}
      class="shadow-sm rounded-sm"
      style={{ background: "white" }}
    />
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PdfCanvasView(props: PdfCanvasViewProps) {
  const [pageCount, setPageCount] = createSignal(0)
  const [pdfDoc, setPdfDoc] = createSignal<pdfjsLib.PDFDocumentProxy | null>(null)
  const [error, setError] = createSignal(false)
  const [containerWidth, setContainerWidth] = createSignal(0)

  let wrapperRef: HTMLDivElement | undefined

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

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // contentBoxSize = scroll container's content width (no padding on it).
        // Subtract the wrapper's padding to get available page width.
        setContainerWidth(entry.contentBoxSize[0].inlineSize - WRAPPER_PADDING)
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
        setPdfDoc(null)

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
  })

  return (
    <div ref={wrapperRef} class="inline-flex flex-col items-center gap-3 p-4 min-w-full min-h-full">
      {/* Rendered pages */}
      <For each={Array.from({ length: pageCount() }, (_, i) => i + 1)}>
        {(pageNum) => (
          <PdfPage
            doc={pdfDoc()!}
            pageNum={pageNum}
            zoom={props.zoom}
            containerWidth={containerWidth()}
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
    </div>
  )
}
