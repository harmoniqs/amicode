/**
 * preview-file-view — Routes file rendering by type for the Preview tab.
 *
 * Markdown files get Preview/Edit toggle (CodeMirror 6 via preview-editor.tsx).
 * Text files open directly in edit mode. Images render as <img> (data URI).
 * PDFs render via PDF.js canvas rendering (pdfjs-dist). Binary, error, and
 * oversize files get placeholders.
 *
 * #925: "text" replaces "unsupported" — all non-renderable files open in
 * the CM6 editor. Async fileType signal detects binary/error/oversize after
 * file.read().
 *
 * #934: images render via data URI from the SDK binary response. PDFs render
 * via PDF.js (pdfjs-dist) to canvas — no iframe, no browser plugin. Save dot
 * moved to parent (SessionPreviewTab); zoom controls moved here to share
 * Bar 2 with the edit/preview toggle.
 *
 * @module
 */

import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, Switch, Match } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { preprocessMarkdown } from "@opencode-ai/session-ui/v2/markdown-utils"
import { RENDERABLE_EXTENSIONS } from "@opencode-ai/session-ui/v2/markdown-utils"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { PreviewDraft, PreviewViewState } from "@/context/layout"
import { PreviewEditor } from "@opencode-ai/session-ui/v2/preview-editor"
import { PdfCanvasView } from "./pdf-canvas-view"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot > 0 ? path.slice(dot).toLowerCase() : ""
}

type FileCategory = "markdown" | "image" | "pdf" | "text"

/**
 * Sync, extension-based file classification (phase 1).
 * Extensionless files (Makefile, Dockerfile, LICENSE) → "text".
 */
function getFileCategory(path: string): FileCategory {
  const ext = getExtension(path)
  if (!ext) return "text" // extensionless → plain text
  if ((RENDERABLE_EXTENSIONS.markdown as readonly string[]).includes(ext)) return "markdown"
  if ((RENDERABLE_EXTENSIONS.images as readonly string[]).includes(ext)) return "image"
  if ((RENDERABLE_EXTENSIONS.pdf as readonly string[]).includes(ext)) return "pdf"
  return "text"
}

/** Async file-type classification after file.read() (phase 2). */
type FileType = "text" | "binary" | "error" | "too-large" | null
type PdfPageNavigation = {
  currentPage: number
  pageCount: number
  canPrevious: boolean
  canNext: boolean
  navigate: (page: number) => boolean
}

const MAX_FILE_SIZE = 1_000_000
const previewSaveQueues = new Map<string, Promise<boolean>>()
const previewSaves = new Map<string, Promise<boolean>>()

// Wrapper padding: p-4 = 16px each side = 32px total
const IMAGE_WRAPPER_PADDING = 32

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PreviewFileView(props: {
  filePath: string
  onSaveComplete?: (request: number) => void
  saveRequest?: () => number
  onSaveStatusChange?: (status: "idle" | "saving" | "saved") => void
  draft: () => PreviewDraft | undefined
  onDraftChange: (content: string) => void
  onDraftClear: (draft: PreviewDraft) => void
  viewState?: () => PreviewViewState | undefined
  onViewStateChange?: (state: PreviewViewState) => void
  zoom: () => number
  zoomIn: (maximum: number) => void
  zoomOut: () => void
  onZoomChange?: (zoom: number, maximum: number) => void
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [fileContent, setFileContent] = createSignal("")
  const [mode, setMode] = createSignal<"preview" | "edit">("preview")
  const [unsavedContent, setUnsavedContent] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [fileType, setFileType] = createSignal<FileType>(null)
  const [pdfNavigation, setPdfNavigation] = createSignal<PdfPageNavigation | null>(null)
  const pageInputID = `pdf-page-input-${props.filePath}`
  let loadGeneration = 0

  // Binary data for image/PDF rendering (data URI / blob URL)
  const [binaryData, setBinaryData] = createSignal<{ base64: string; mime: string } | null>(null)

  // ─── LaTeX compile status (#1253) ───────────────────────────────────────
  // A .tex Cmd+S posts `run-latex` to the extension host; the host relays
  // `run-latex-status` back. The .tex view shows the status; the companion
  // .pdf view (matching on the produced pdf path) re-reads on "done" (#1254).
  const [compileStatus, setCompileStatus] = createSignal<
    null | "compiling" | "done" | "error" | "unavailable"
  >(null)
  const [compileError, setCompileError] = createSignal<string | null>(null)
  const isLatex = () => /\.(tex|ltx)$/i.test(props.filePath)
  const toAbsolute = (p: string) => {
    if (p.startsWith("/")) return p
    const dir = (sdk().directory ?? "").replace(/\/$/, "")
    return dir ? `${dir}/${p}` : p
  }
  const selfAbsolute = () => toAbsolute(props.filePath)

  // ─── Container width for absolute-pixel image sizing ───────────────────
  // Same pattern as PdfCanvasView: measure the scroll container's width via
  // ResizeObserver and compute image display width as absolute pixels.
  // This avoids the circular CSS dependency that `width: ${zoom}%` creates
  // inside an inline-flex wrapper (the root cause of the left-scroll clipping
  // bug — see test "image uses absolute pixel width from measured container").
  const [containerWidth, setContainerWidth] = createSignal(0)

  // ─── File loading ──────────────────────────────────────────────────────

  const category = () => getFileCategory(props.filePath)

  createEffect(
    on(
      () => props.filePath,
      (path) => {
        const generation = ++loadGeneration
        const initialDraft = props.draft()
        setLoading(!initialDraft)
        setFileType(null)
        setBinaryData(null)
        setUnsavedContent(initialDraft?.content ?? null)
        if (initialDraft) {
          setFileType("text")
          setFileContent(initialDraft.content)
        }
        sdk()
          .client.file.read({ path })
          .then((result) => {
            if (generation !== loadGeneration) return
            const content = result.data
            const draft = props.draft()
            if (draft) {
              setUnsavedContent(draft.content)
              setFileType("text")
              setFileContent(draft.content)
              return
            }
            if (initialDraft) return
            if (!content) {
              setFileType("error")
              setFileContent("")
              return
            }
            if (content.type !== "text") {
              // Image/PDF binaries are renderable — store the base64 data and
              // let the category-based renderer handle them.
              const cat = getFileCategory(props.filePath)
              if ((cat === "image" || cat === "pdf") && (content as any).encoding === "base64") {
                setBinaryData({
                  base64: content.content,
                  mime: (content as any).mimeType ?? "application/octet-stream",
                })
                setFileType("text") // pass-through: let category branch render
                return
              }
              setFileType("binary")
              setFileContent("")
              return
            }
            const size = (content as any).length ?? content.content.length
            if (size > MAX_FILE_SIZE) {
              setFileType("too-large")
              setFileContent("")
              return
            }
            setFileType("text")
            setFileContent(content.content)
          })
          .catch(() => {
            if (generation !== loadGeneration) return
            const draft = props.draft()
            if (draft) {
              setUnsavedContent(draft.content)
              setFileType("text")
              setFileContent(draft.content)
              return
            }
            if (initialDraft) return
            setFileType("error")
            setFileContent("")
          })
          .finally(() => {
            if (generation === loadGeneration) setLoading(false)
          })
      },
    ),
  )

  // ─── Binary URLs ───────────────────────────────────────────────────────

  // Data URI for images (small enough for inline base64)
  const imageDataUrl = createMemo(() => {
    const data = binaryData()
    if (!data || category() !== "image") return ""
    return `data:${data.mime};base64,${data.base64}`
  })

  // ─── PDF refresh after compile (#1254) ─────────────────────────────────
  // Re-read the file from disk and swap the base64 payload. Used when the
  // companion .pdf's producer (latexmk) reports "done". Guards stale reads via
  // the shared load generation so a refresh can't clobber a newer navigation.
  const reloadBinary = () => {
    const path = props.filePath
    const generation = ++loadGeneration
    sdk()
      .client.file.read({ path })
      .then((result) => {
        if (generation !== loadGeneration) return
        const content = result.data
        if (!content || content.type === "text") return
        const cat = getFileCategory(path)
        if ((cat === "image" || cat === "pdf") && (content as any).encoding === "base64") {
          setBinaryData({
            base64: content.content,
            mime: (content as any).mimeType ?? "application/octet-stream",
          })
        }
      })
      .catch(() => {})
  }

  // Listen for compile status from the extension host. The .tex view reflects
  // status; the .pdf view refreshes itself when its producer finishes.
  onMount(() => {
    const handler = (event: MessageEvent) => {
      const d = event.data as
        | { source?: string; kind?: string; file?: string; pdf?: string; state?: string; error?: string }
        | null
      if (!d || d.source !== "amicode" || d.kind !== "run-latex-status") return
      const me = selfAbsolute()
      if (typeof d.file === "string" && d.file === me) {
        setCompileStatus((d.state as ReturnType<typeof compileStatus>) ?? null)
        setCompileError(d.state === "error" && typeof d.error === "string" ? d.error : null)
        if (d.state === "done" || d.state === "unavailable") {
          setTimeout(() => setCompileStatus((prev) => (prev === "done" || prev === "unavailable" ? null : prev)), 2500)
        }
      }
      if (typeof d.pdf === "string" && d.pdf === me && d.state === "done") {
        reloadBinary()
      }
    }
    window.addEventListener("message", handler)
    onCleanup(() => window.removeEventListener("message", handler))
  })

  // ─── Save logic ────────────────────────────────────────────────────────

  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle")
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  // Surface save status to parent (for the header dot) if callback provided
  createEffect(() => {
    props.onSaveStatusChange?.(saveStatus())
  })

  const saveFile = (filePath: string, draft: PreviewDraft, closeAfterSave = false, request?: number) => {
    const pending = { ...draft }
    const server = serverSDK()
    const target = sdk()
    const key = `${server.scope}\0${server.url}\0${target.directory}\0${filePath}`
    const saveKey = `${key}\0${pending.source}\0${pending.revision}`
    let save = previewSaves.get(saveKey)
    if (!save) {
      const previous = previewSaveQueues.get(key) ?? Promise.resolve(true)
      save = previous.catch(() => false).then(async () => {
        setSaveStatus("saving")
        try {
          const current = props.draft()
          if (!current || current.revision !== pending.revision || current.source !== pending.source) {
            setSaveStatus("idle")
            return false
          }
          await target.client.file.write({ path: filePath, content: pending.content })
          const saved = props.draft()
          if (!saved || saved.revision !== pending.revision || saved.source !== pending.source) {
            setSaveStatus("idle")
            return false
          }
          setSaveStatus("saved")
          setUnsavedContent(null)
          props.onDraftClear(pending)
          // #1253: a saved .tex asks the extension host to run latexmk. The
          // host compiles in the file's own directory and relays status back;
          // the companion .pdf view refreshes on "done" (#1254).
          if (isLatex()) {
            try {
              window.parent?.postMessage({ source: "amicode", kind: "run-latex", file: toAbsolute(filePath) }, "*")
            } catch {}
          }
          if (savedTimer) clearTimeout(savedTimer)
          savedTimer = setTimeout(() => setSaveStatus("idle"), 2000)
          return true
        } catch {
          setSaveStatus("idle")
          return false
        }
      })
      previewSaves.set(saveKey, save)
      previewSaveQueues.set(key, save)
      void save.finally(() => {
        if (previewSaves.get(saveKey) === save) previewSaves.delete(saveKey)
        if (previewSaveQueues.get(key) === save) previewSaveQueues.delete(key)
      })
    }
    if (closeAfterSave && request !== undefined) void save.then((saved) => saved && props.onSaveComplete?.(request))
    return save
  }

  const handleEdit = (content: string) => {
    setUnsavedContent(content)
    props.onDraftChange(content)
    setFileContent(content)
  }

  const handleImmediateSave = () => {
    const draft = props.draft()
    if (draft) void saveFile(props.filePath, draft)
  }

  createEffect(
    on(
      () => props.saveRequest?.() ?? 0,
      (request) => {
        if (request === 0) return
        const draft = props.draft()
        if (draft) void saveFile(props.filePath, draft, true, request)
      },
    ),
  )

  onCleanup(() => {
    loadGeneration++
    if (savedTimer) clearTimeout(savedTimer)
  })

  // ─── Render ────────────────────────────────────────────────────────────

  const showModeToggle = () => category() === "markdown"

  // Zoom is disabled in edit mode — pill disappears entirely
  const isEditing = () => {
    const cat = category()
    if (cat === "markdown") return mode() === "edit"
    if (cat === "image" || cat === "pdf") return false
    return true // text/code files are always in edit mode
  }

  // ─── Auto-hide floating controls on idle ─────────────────────────────
  const [showControls, setShowControls] = createSignal(true)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let controlsHovered = false

  const startIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (!controlsHovered) setShowControls(false)
    }, 2000)
  }

  const handleWrapperMouseEnter = () => {
    setShowControls(true)
    startIdleTimer()
  }
  const handleWrapperMouseMove = () => {
    if (!showControls()) setShowControls(true)
    startIdleTimer()
  }
  const handleWrapperMouseLeave = () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (!controlsHovered) setShowControls(false)
  }
  const handleControlsMouseEnter = () => {
    controlsHovered = true
    if (idleTimer) clearTimeout(idleTimer)
  }
  const handleControlsMouseLeave = () => {
    controlsHovered = false
    startIdleTimer()
  }

  // Start the initial auto-hide timer
  startIdleTimer()

  // Image/PDF: zoom floor at 100% (never shrink below panel fit).
  // Markdown/text: floor stays at the global 50%.
  const zoomFloor = () => {
    const cat = category()
    return cat === "image" || cat === "pdf" ? 100 : 50
  }
  const zoomCeiling = () => {
    const cat = category()
    return cat === "image" || cat === "pdf" ? 1000 : 500
  }

  const handleZoomOut = () => {
    if (props.zoom() <= zoomFloor()) return
    const before = props.zoom()
    adjustScrollForZoom(before, Math.max(before - 10, zoomFloor()))
    props.zoomOut()
  }

  // ─── Focus-preserving zoom ───────────────────────────────────────────
  // After a zoom change, adjust scroll so the focus point stays fixed.
  // Toolbar and typed zoom use the viewport center; wheel zoom uses its
  // pointer location. A single rAF coalesces a gesture instead of letting
  // stale scroll positions from earlier wheel events overwrite the latest.

  let scrollRef: HTMLDivElement | undefined
  let zoomFrame: number | undefined
  let pendingZoom:
    | {
        oldZoom: number
        newZoom: number
        focusX: number
        focusY: number
        contentX: number
        contentY: number
        element: HTMLDivElement
        host: HTMLElement | null
      }
    | undefined

  // ─── Track scroll container width for image sizing ───────────────────
  // Observe scrollRef (the scroll container) to get its content width.
  // The image display width is computed as absolute pixels from this,
  // matching the PdfCanvasView pattern (which observes parentElement
  // because the PDF wrapper IS inline-flex — here scrollRef is the
  // scroll container directly).
  createEffect(() => {
    const el = scrollRef
    if (!el) return
    setContainerWidth(el.clientWidth)
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentBoxSize[0].inlineSize)
      }
    })
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  // Image display width: absolute pixels, not percentage.
  // At 100% zoom, the image fills the container width (minus wrapper padding).
  // At 200% it's twice that, etc. Deterministic sizing — the inline-flex
  // wrapper sizes correctly around it, so justify-center never pushes
  // content into unreachable negative scroll territory.
  const imageWidth = () => Math.max(0, ((containerWidth() - IMAGE_WRAPPER_PADDING) * props.zoom()) / 100)

  const adjustScrollForZoom = (oldZoom: number, newZoom: number, focus?: { x: number; y: number }) => {
    const el = scrollRef
    if (!el || oldZoom === newZoom || oldZoom === 0) return
    const focusX = Math.min(Math.max(focus?.x ?? el.clientWidth / 2, 0), el.clientWidth)
    const focusY = Math.min(Math.max(focus?.y ?? el.clientHeight / 2, 0), el.clientHeight)

    if (pendingZoom) {
      pendingZoom.newZoom = newZoom
      pendingZoom.focusX = focusX
      pendingZoom.focusY = focusY
    } else {
      pendingZoom = {
        oldZoom,
        newZoom,
        focusX,
        focusY,
        contentX: el.scrollLeft + focusX,
        contentY: el.scrollTop + focusY,
        element: el,
        host: el.closest<HTMLElement>("[data-preview-host]"),
      }
    }

    if (zoomFrame) return
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = undefined
      const pending = pendingZoom
      pendingZoom = undefined
      if (!pending) return
      const ratio = pending.newZoom / pending.oldZoom
      const element = pending.host?.querySelector<HTMLDivElement>("[data-preview-scroll]") ?? pending.element
      element.scrollLeft = pending.contentX * ratio - pending.focusX
      element.scrollTop = pending.contentY * ratio - pending.focusY
    })
  }

  // ─── Pinch / wheel zoom ──────────────────────────────────────────────
  // Trackpad pinch fires as WheelEvent with ctrlKey: true in Chromium.
  // Shift+scroll is the mouse-wheel equivalent. Both trigger continuous
  // zoom via onZoomChange. Must use addEventListener with passive: false
  // — Solid's onWheel is passive by default and can't preventDefault.

  const handleWheelZoom = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.shiftKey) return // normal scroll — pass through
    e.preventDefault()
    if (!props.onZoomChange) return
    const delta = e.deltaY || e.deltaX // shift+scroll may swap axes
    if (delta === 0) return
    const oldZoom = props.zoom()
    const factor = Math.exp(-delta * 0.003)
    const next = Math.round(Math.min(Math.max(oldZoom * factor, zoomFloor()), zoomCeiling()))
    if (next === oldZoom) return
    const scroll = scrollRef
    if (!scroll) return
    const bounds = scroll.getBoundingClientRect()
    adjustScrollForZoom(oldZoom, next, {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top,
    })
    props.onZoomChange(next, zoomCeiling())
    setShowControls(true)
    startIdleTimer()
  }

  createEffect(() => {
    const el = scrollRef
    if (!el) return
    el.addEventListener("wheel", handleWheelZoom, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", handleWheelZoom))
  })

  const previewControlSurfaceStyle = {
    background: "color-mix(in srgb, var(--background-base) 80%, transparent)",
    "backdrop-filter": "blur(4px)",
  }

  return (
    <div
      class="h-full relative overflow-hidden"
      onMouseEnter={handleWrapperMouseEnter}
      onMouseMove={handleWrapperMouseMove}
      onMouseLeave={handleWrapperMouseLeave}
    >
      {/* LaTeX compile status chip (#1253) — bottom-left, only while relevant. */}
      <Show when={compileStatus()}>
        {(status) => (
          <div
            data-latex-status={status()}
            class="absolute bottom-2 left-2 z-30 flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-border-base shadow-sm text-12-regular"
            style={{
              background: "color-mix(in srgb, var(--background-base) 85%, transparent)",
              "backdrop-filter": "blur(4px)",
              color:
                status() === "error"
                  ? "var(--text-danger, var(--text-base))"
                  : "var(--text-weak, var(--text-base))",
            }}
            title={compileError() ?? undefined}
          >
            <Switch>
              <Match when={status() === "compiling"}>
                <Icon name="context-ring" size="small" class="animate-spin" />
                <span>Compiling LaTeX…</span>
              </Match>
              <Match when={status() === "done"}>
                <Icon name="circle-check" size="small" />
                <span>Compiled</span>
              </Match>
              <Match when={status() === "error"}>
                <Icon name="circle-x" size="small" />
                <span>Compile failed</span>
              </Match>
              <Match when={status() === "unavailable"}>
                <Icon name="circle-x" size="small" />
                <span>latexmk not found</span>
              </Match>
            </Switch>
          </div>
        )}
      </Show>
      {/* Floating controls — top-right overlay */}
      <div
        data-preview-controls
        onMouseEnter={handleControlsMouseEnter}
        onMouseLeave={handleControlsMouseLeave}
        style={{
          position: "absolute",
          "z-index": "20",
          display: "flex",
          "align-items": "center",
          opacity: showControls() ? "1" : "0",
          "pointer-events": showControls() ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}
      >
        <Show when={showModeToggle()}>
          <div
            class="rounded-md border border-border-base shadow-sm overflow-hidden"
            style={{
              background: "color-mix(in srgb, var(--background-base) 80%, transparent)",
              "backdrop-filter": "blur(4px)",
            }}
          >
            <SegmentedControlV2
              value={mode()}
              onChange={(value) => {
                if (value === "preview" || value === "edit") {
                  setMode(value)
                }
              }}
              class="!w-auto"
              aria-label="View mode"
            >
              <TooltipV2 openDelay={400} value="Preview">
                <SegmentedControlItemV2 value="preview" aria-label="Preview" class="!flex-none !px-2">
                  <Icon name="eye" size="small" />
                </SegmentedControlItemV2>
              </TooltipV2>
              <TooltipV2 openDelay={400} value="Edit">
                <SegmentedControlItemV2 value="edit" aria-label="Edit" class="!flex-none !px-2">
                  <Icon name="edit" size="small" />
                </SegmentedControlItemV2>
              </TooltipV2>
            </SegmentedControlV2>
          </div>
        </Show>
        <Show when={!isEditing()}>
          <Show when={pdfNavigation()}>
            {(navigation) => {
              return (
                <div
                  data-pdf-page-navigation
                  class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden shadow-sm"
                  style={previewControlSurfaceStyle}
                >
                  <label class="sr-only" for={pageInputID}>
                    Page number, 1 through {navigation().pageCount}
                  </label>
                  <input
                    data-pdf-page-input
                    id={pageInputID}
                    type="text"
                    class="w-11 h-full text-center text-12-regular text-text-base bg-transparent outline-none"
                    value={`${navigation().currentPage} / ${navigation().pageCount}`}
                    onFocus={(event) => {
                      event.currentTarget.value = `${navigation().currentPage}`
                      event.currentTarget.select()
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur()
                      } else if (event.key === "Escape") {
                        const state = navigation()
                        event.currentTarget.value = `${state.currentPage} / ${state.pageCount}`
                        event.currentTarget.blur()
                      }
                    }}
                    onBlur={(event) => {
                      const state = navigation()
                      const raw = event.currentTarget.value.trim()
                      const numeric = /^-?\d+$/.test(raw) ? Number(raw) : null
                      if (numeric === null || numeric < 1 || numeric > state.pageCount) {
                        event.currentTarget.value = `${state.currentPage} / ${state.pageCount}`
                        return
                      }

                      const moved = state.navigate(numeric)
                      event.currentTarget.value = moved ? `${numeric} / ${state.pageCount}` : `${state.currentPage} / ${state.pageCount}`
                    }}
                  />
                  <div class="flex flex-col border-l border-border-base">
                    <button
                      class="flex items-center justify-center w-5 h-3.5 cursor-pointer text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                      disabled={!navigation().canPrevious}
                      onClick={() => navigation().navigate(navigation().currentPage - 1)}
                      aria-label="Previous page"
                    >
                      <Icon name="chevron-right" size="small" class="-rotate-90" />
                    </button>
                    <button
                      class="flex items-center justify-center w-5 h-3.5 cursor-pointer text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors border-t border-border-base disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-focus"
                      disabled={!navigation().canNext}
                      onClick={() => navigation().navigate(navigation().currentPage + 1)}
                      aria-label="Next page"
                    >
                      <Icon name="chevron-right" size="small" class="rotate-90" />
                    </button>
                  </div>
                  <span
                    class="sr-only"
                    role="status"
                    aria-live="polite"
                    aria-label={`Page ${navigation().currentPage} of ${navigation().pageCount}`}
                  >
                    {navigation().currentPage} / {navigation().pageCount}
                  </span>
                </div>
              )
            }}
          </Show>
          {/* Zoom controls: [editable %] [reset] [+ over -] */}
          <div
            class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden shadow-sm"
            style={previewControlSurfaceStyle}
          >
            {/* Editable zoom percentage input */}
            <input
              data-preview-zoom
              type="text"
              class="w-11 h-full text-center text-12-regular text-text-base bg-transparent outline-none"
              value={`${props.zoom()}%`}
              onFocus={(e) => {
                e.currentTarget.value = `${props.zoom()}`
                e.currentTarget.select()
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  e.currentTarget.value = `${props.zoom()}`
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => {
                const val = parseInt(e.currentTarget.value)
                if (!isNaN(val) && props.onZoomChange) {
                  const clamped = Math.min(Math.max(val, zoomFloor()), zoomCeiling())
                  const before = props.zoom()
                  adjustScrollForZoom(before, clamped)
                  props.onZoomChange(clamped, zoomCeiling())
                }
                e.currentTarget.value = `${props.zoom()}%`
              }}
            />
            {/* Reset to 100% */}
            <button
              class="flex items-center justify-center w-6 h-full border-l border-border-base text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
              onClick={() => {
                const before = props.zoom()
                adjustScrollForZoom(before, 100)
                props.onZoomChange?.(100, zoomCeiling())
              }}
              aria-label="Reset zoom"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            {/* Vertical +/- stepper */}
            <div class="flex flex-col border-l border-border-base">
              <button
                class="flex items-center justify-center w-5 h-3.5 text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
                onClick={() => {
                  const before = props.zoom()
                  adjustScrollForZoom(before, Math.min(before + 10, zoomCeiling()))
                  props.zoomIn(zoomCeiling())
                }}
                aria-label="Zoom in"
              >
                <span class="text-[10px] font-medium leading-none">+</span>
              </button>
              <button
                class="flex items-center justify-center w-5 h-3.5 text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors border-t border-border-base"
                onClick={() => handleZoomOut()}
                aria-label="Zoom out"
              >
                <span class="text-[10px] font-medium leading-none">−</span>
              </button>
            </div>
          </div>
        </Show>
      </div>

      {/* Content */}
      <div ref={scrollRef} data-preview-scroll class="h-full overflow-auto">
        <Show when={!loading()} fallback={<div class="p-4 text-12-regular text-text-weak">Loading...</div>}>
          <Switch>
            <Match when={fileType() === "error"}>
              <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
                Could not read file
              </div>
            </Match>

            {/* Renderable binaries: image/PDF use data URI or blob URL */}
            <Match when={category() === "image" && (binaryData() || fileType() === "text")}>
              <div class="inline-flex items-center justify-center min-w-full min-h-full p-4">
                <img
                  src={imageDataUrl()}
                  alt={props.filePath.split("/").pop() ?? ""}
                  class="object-contain max-w-none shrink-0"
                  style={{ width: `${imageWidth()}px`, "image-rendering": "auto" }}
                />
              </div>
            </Match>

            <Match when={category() === "pdf" && binaryData()}>
              <PdfCanvasView
                base64={binaryData()!.base64}
                mime={binaryData()!.mime}
                zoom={props.zoom()}
                filePath={props.filePath}
                onPageNavigationChange={setPdfNavigation}
                initialPage={props.viewState?.()?.pdf?.page}
                initialScrollTop={props.viewState?.()?.pdf?.scrollTop}
                onViewStateChange={(pdf) => props.onViewStateChange?.({ pdf })}
              />
            </Match>

            <Match when={fileType() === "binary"}>
              <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
                Binary file — cannot preview
              </div>
            </Match>
            <Match when={fileType() === "too-large"}>
              <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
                File too large to preview in this tab
              </div>
            </Match>

            {/* Text-based rendering by category */}
            <Match when={category() === "markdown"}>
              <Show
                when={mode() === "preview"}
                fallback={
                  <PreviewEditor
                    content={fileContent()}
                    filePath={props.filePath}
                    onChange={handleEdit}
                    onSave={handleImmediateSave}
                    viewState={() => props.viewState?.()?.editor}
                    onViewStateChange={(editor) => props.onViewStateChange?.({ editor })}
                  />
                }
              >
                <div
                  class="p-4 origin-top-left [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:max-w-full [&_.katex]:text-[0.9em]"
                  style={{ transform: `scale(${props.zoom() / 100})`, width: `${10000 / props.zoom()}%` }}
                >
                  <Markdown text={preprocessMarkdown(fileContent())} class="text-12-regular" />
                </div>
              </Show>
            </Match>

            {/* Text files: open directly in edit mode */}
            <Match when={category() === "text"}>
              <PreviewEditor
                content={fileContent()}
                filePath={props.filePath}
                onChange={handleEdit}
                onSave={handleImmediateSave}
                viewState={() => props.viewState?.()?.editor}
                onViewStateChange={(editor) => props.onViewStateChange?.({ editor })}
              />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
