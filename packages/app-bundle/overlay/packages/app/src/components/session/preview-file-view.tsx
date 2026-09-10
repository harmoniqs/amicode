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

import { createEffect, createMemo, createSignal, on, onCleanup, Show, Switch, Match } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { preprocessMarkdown } from "@opencode-ai/session-ui/v2/markdown-utils"
import { RENDERABLE_EXTENSIONS } from "@opencode-ai/session-ui/v2/markdown-utils"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
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

const MAX_FILE_SIZE = 1_000_000

// Wrapper padding: p-4 = 16px each side = 32px total
const IMAGE_WRAPPER_PADDING = 32

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PreviewFileView(props: {
  filePath: string
  onDirtyChange: (dirty: boolean) => void
  onSaveComplete?: () => void
  saveRequest?: () => number
  onSaveStatusChange?: (status: "idle" | "saving" | "saved") => void
  zoom: () => number
  zoomIn: () => void
  zoomOut: () => void
  onZoomChange?: (zoom: number) => void
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [fileContent, setFileContent] = createSignal("")
  const [mode, setMode] = createSignal<"preview" | "edit">("preview")
  const [unsavedContent, setUnsavedContent] = createSignal<string | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [fileType, setFileType] = createSignal<FileType>(null)

  // Binary data for image/PDF rendering (data URI / blob URL)
  const [binaryData, setBinaryData] = createSignal<{ base64: string; mime: string } | null>(null)

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
        setLoading(true)
        setFileType(null)
        setBinaryData(null)
        sdk()
          .client.file.read({ path })
          .then((result) => {
            const content = result.data
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
            setFileType("error")
            setFileContent("")
          })
          .finally(() => {
            setLoading(false)
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

  // ─── Save logic ────────────────────────────────────────────────────────

  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle")
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  // Surface save status to parent (for the header dot) if callback provided
  createEffect(() => {
    props.onSaveStatusChange?.(saveStatus())
  })

  const saveFile = async (filePath: string, content: string, closeAfterSave = false) => {
    setSaveStatus("saving")
    try {
      await serverSDK().client.file.write({ path: filePath, content })
      setSaveStatus("saved")
      setUnsavedContent(null)
      props.onDirtyChange(false)
      if (closeAfterSave) props.onSaveComplete?.()
      if (savedTimer) clearTimeout(savedTimer)
      savedTimer = setTimeout(() => setSaveStatus("idle"), 2000)
    } catch {
      setSaveStatus("idle")
    }
  }

  const handleEdit = (content: string) => {
    setUnsavedContent(content)
    props.onDirtyChange(true)
    setFileContent(content)
  }

  const handleImmediateSave = () => {
    const content = unsavedContent()
    if (content !== null) void saveFile(props.filePath, content)
  }

  createEffect(
    on(
      () => props.saveRequest?.() ?? 0,
      (request) => {
        if (request === 0) return
        const content = unsavedContent()
        if (content !== null) void saveFile(props.filePath, content, true)
      },
    ),
  )

  onCleanup(() => {
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

  const handleZoomOut = () => {
    if (props.zoom() <= zoomFloor()) return
    const before = props.zoom()
    props.zoomOut()
    adjustScrollForZoom(before, props.zoom())
  }

  // ─── Scroll-centered zoom ────────────────────────────────────────────
  // After a zoom change, adjust scroll so the viewport center stays fixed.
  // Uses rAF to let the DOM update first: image CSS reflows synchronously,
  // PDF canvas dimensions settle as a microtask (getPage().then()), and
  // rAF fires after both — so scrollWidth/scrollHeight are correct.

  let scrollRef: HTMLDivElement | undefined

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
  const imageWidth = () => Math.max(0, (containerWidth() - IMAGE_WRAPPER_PADDING) * props.zoom() / 100)

  const adjustScrollForZoom = (oldZoom: number, newZoom: number) => {
    const el = scrollRef
    if (!el || oldZoom === newZoom || oldZoom === 0) return
    const ratio = newZoom / oldZoom
    const centerX = el.scrollLeft + el.clientWidth / 2
    const centerY = el.scrollTop + el.clientHeight / 2
    requestAnimationFrame(() => {
      el.scrollLeft = centerX * ratio - el.clientWidth / 2
      el.scrollTop = centerY * ratio - el.clientHeight / 2
    })
  }

  // ─── Pinch / wheel zoom ──────────────────────────────────────────────
  // Trackpad pinch fires as WheelEvent with ctrlKey: true in Chromium.
  // Shift+scroll is the mouse-wheel equivalent. Both trigger continuous
  // zoom via onZoomChange. Must use addEventListener with passive: false
  // — Solid's onWheel is passive by default and can't preventDefault.

  const handleWheelZoom = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.shiftKey) return   // normal scroll — pass through
    e.preventDefault()
    if (!props.onZoomChange) return
    const delta = e.deltaY || e.deltaX      // shift+scroll may swap axes
    if (delta === 0) return
    const oldZoom = props.zoom()
    const factor = Math.exp(-delta * 0.003)
    const next = Math.round(
      Math.min(Math.max(oldZoom * factor, zoomFloor()), 500),
    )
    if (next === oldZoom) return
    props.onZoomChange(next)
    adjustScrollForZoom(oldZoom, next)
    setShowControls(true)
    startIdleTimer()
  }

  createEffect(() => {
    const el = scrollRef
    if (!el) return
    el.addEventListener("wheel", handleWheelZoom, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", handleWheelZoom))
  })

  return (
    <div
      class="h-full relative overflow-hidden"
      onMouseEnter={handleWrapperMouseEnter}
      onMouseMove={handleWrapperMouseMove}
      onMouseLeave={handleWrapperMouseLeave}
    >
      {/* Floating controls — top-right overlay */}
      <div
        onMouseEnter={handleControlsMouseEnter}
        onMouseLeave={handleControlsMouseLeave}
        style={{
          position: "absolute",
          top: "8px",
          right: "14px",
          "z-index": "20",
          display: "flex",
          gap: "6px",
          "align-items": "center",
          opacity: showControls() ? "1" : "0",
          "pointer-events": showControls() ? "auto" : "none",
          transition: "opacity 200ms ease",
        }}
      >
        <Show when={!isEditing()}>
          {/* Zoom controls: [editable %] [reset] [+ over -] */}
          <div class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden shadow-sm" style={{ background: "color-mix(in srgb, var(--background-base) 80%, transparent)", "backdrop-filter": "blur(4px)" }}>
            {/* Editable zoom percentage input */}
            <input
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
                  const clamped = Math.min(Math.max(val, zoomFloor()), 500)
                  const before = props.zoom()
                  props.onZoomChange(clamped)
                  adjustScrollForZoom(before, clamped)
                }
                e.currentTarget.value = `${props.zoom()}%`
              }}
            />
            {/* Reset to 100% */}
            <button
              class="flex items-center justify-center w-6 h-full border-l border-border-base text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
              onClick={() => {
                const before = props.zoom()
                props.onZoomChange?.(100)
                adjustScrollForZoom(before, 100)
              }}
              aria-label="Reset zoom"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
                  props.zoomIn()
                  adjustScrollForZoom(before, props.zoom())
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
        <Show when={showModeToggle()}>
          <div class="rounded-md border border-border-base shadow-sm overflow-hidden" style={{ background: "color-mix(in srgb, var(--background-base) 80%, transparent)", "backdrop-filter": "blur(4px)" }}>
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
      </div>

      {/* Content */}
      <div ref={scrollRef} class="h-full overflow-auto">
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
              />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}
