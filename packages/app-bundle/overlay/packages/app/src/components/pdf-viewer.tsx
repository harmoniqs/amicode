// pdf-viewer.tsx — PDF rendering for the Preview tab (#727).
// Uses pdfjs-dist to render PDF pages to canvas in a scrollable container.
// Zoom controls, scroll position preservation across reloads, and
// device-pixel-ratio-aware rendering.

import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import * as pdfjsLib from "pdfjs-dist"

// ── Worker setup ────────────────────────────────────────────────────────────
// The pdfjs worker handles the heavy PDF parsing off the main thread.
// Vite's ?url suffix gives us the asset URL without inlining.
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

// ── Types ───────────────────────────────────────────────────────────────────

interface PageState {
  pageNum: number
  rendered: boolean
}

// ── Component ───────────────────────────────────────────────────────────────

export function PDFViewer(props: {
  /** Binary content as base64 string, or a file URL. */
  data: string | null
  /** Whether data is base64-encoded binary. */
  isBase64?: boolean
  /** Current zoom level (100 = 100%). */
  zoom: number
}) {
  const [pages, setPages] = createSignal<PageState[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [pdfDoc, setPdfDoc] = createSignal<pdfjsLib.PDFDocumentProxy | null>(null)

  let containerRef: HTMLDivElement | undefined
  let scrollTop = 0
  let activeLoadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null

  // Track scroll position for preservation across reloads
  const saveScroll = () => {
    if (containerRef) scrollTop = containerRef.scrollTop
  }

  // ── Load PDF ────────────────────────────────────────────────────────────

  createEffect(
    on(
      () => props.data,
      async (data) => {
        if (!data) {
          setLoading(false)
          setError(true)
          return
        }

        setLoading(true)
        setError(false)

        try {
          saveScroll()

          // Clean up previous loading task
          if (activeLoadingTask) {
            activeLoadingTask.destroy()
            activeLoadingTask = null
          }
          setPdfDoc(null)

          // Load PDF from base64 or URL
          let loadingTask: pdfjsLib.PDFDocumentLoadingTask
          if (props.isBase64) {
            const binaryStr = atob(data)
            const bytes = new Uint8Array(binaryStr.length)
            for (let i = 0; i < binaryStr.length; i++) {
              bytes[i] = binaryStr.charCodeAt(i)
            }
            loadingTask = pdfjsLib.getDocument({ data: bytes })
          } else {
            loadingTask = pdfjsLib.getDocument({ url: data })
          }
          activeLoadingTask = loadingTask

          const doc = await loadingTask.promise
          setPdfDoc(doc)

          const pageStates: PageState[] = []
          for (let i = 1; i <= doc.numPages; i++) {
            pageStates.push({ pageNum: i, rendered: false })
          }
          setPages(pageStates)

          // Restore scroll position after render
          requestAnimationFrame(() => {
            if (containerRef) containerRef.scrollTop = scrollTop
          })
        } catch {
          setError(true)
        } finally {
          setLoading(false)
        }
      },
    ),
  )

  onCleanup(() => {
    if (activeLoadingTask) {
      activeLoadingTask.destroy()
      activeLoadingTask = null
    }
  })

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <Show when={loading()}>
        <div class="p-4 text-12-regular text-text-weak">Loading PDF...</div>
      </Show>
      <Show when={error()}>
        <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
          <div class="text-center">
            <Icon name="circle-x" size="large" class="mx-auto mb-2 text-text-faint" />
            <p>Could not load PDF</p>
          </div>
        </div>
      </Show>
      <Show when={!loading() && !error()}>
        <div ref={(el) => (containerRef = el)} class="flex-1 min-h-0 overflow-auto" onScroll={saveScroll}>
          <div class="flex flex-col items-center gap-2 py-4">
            <For each={pages()}>
              {(page) => (
                <PDFPage
                  doc={pdfDoc()!}
                  pageNum={page.pageNum}
                  zoom={props.zoom}
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

// ── Single page renderer ────────────────────────────────────────────────────

function PDFPage(props: {
  doc: pdfjsLib.PDFDocumentProxy
  pageNum: number
  zoom: number
}) {
  let canvasRef: HTMLCanvasElement | undefined
  const [pageError, setPageError] = createSignal(false)

  createEffect(
    on(
      () => [props.doc, props.pageNum, props.zoom] as const,
      async ([doc, num, zoom]) => {
        if (!canvasRef || !doc) return
        setPageError(false)

        try {
          const page = await doc.getPage(num)
          const scale = (zoom / 100) * (window.devicePixelRatio || 1)
          const viewport = page.getViewport({ scale })

          canvasRef.width = viewport.width
          canvasRef.height = viewport.height
          canvasRef.style.width = `${viewport.width / (window.devicePixelRatio || 1)}px`
          canvasRef.style.height = `${viewport.height / (window.devicePixelRatio || 1)}px`

          const ctx = canvasRef.getContext("2d")
          if (!ctx) return

          await page.render({ canvasContext: ctx, canvas: canvasRef, viewport }).promise
        } catch {
          setPageError(true)
        }
      },
    ),
  )

  return (
    <Show
      when={!pageError()}
      fallback={
        <div class="p-4 text-12-regular text-text-weak">
          Could not render page {props.pageNum}
        </div>
      }
    >
      <canvas
        ref={(el) => (canvasRef = el)}
        class="shadow-sm border border-border-weaker-base"
        data-page={props.pageNum}
      />
    </Show>
  )
}
