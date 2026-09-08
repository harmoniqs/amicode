// preview-content-area.tsx — Content area for the Preview tab (#726).
// Routes files to type-appropriate renderers based on renderer kind.

import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from "solid-js"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { PlainEditor } from "@opencode-ai/session-ui/v2/plain-editor"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { preprocessMarkdown } from "@/utils/preview-markdown"
import {
  rendererForExtension,
  toolbarForRenderer,
  extFromPath,
  isReadOnly,
  type RendererKind,
} from "@/utils/renderer-dispatch"
import { PDFViewer } from "@/components/pdf-viewer"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"

// ─── Types ──────────────────────────────────────────────────────────────────

type ContentMode = "preview" | "editor"

// ─── Main Component ─────────────────────────────────────────────────────────

export function PreviewContentArea(props: {
  filePath: string
  onBack: () => void
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()

  const ext = createMemo(() => extFromPath(props.filePath))
  const kind = createMemo((): RendererKind => rendererForExtension(ext()))
  const toolbar = createMemo(() => toolbarForRenderer(kind(), false /* TODO: wire texAvailable from #729 */))
  const readOnly = createMemo(() => isReadOnly(ext()))

  const [content, setContent] = createSignal<string>("")
  const [isBinary, setIsBinary] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [mode, setMode] = createSignal<ContentMode>("preview")
  const [zoom, setZoom] = createSignal(100)

  const zoomIn = () => setZoom((z) => Math.min(z + 10, 200))
  const zoomOut = () => setZoom((z) => Math.max(z - 10, 50))

  // ─── File content loading ───────────────────────────────────────────────

  createEffect(
    on(
      () => props.filePath,
      (path) => {
        if (!path) return
        setLoading(true)
        setError(false)
        setIsBinary(false)

        sdk()
          .client.file.read({ path })
          .then((result) => {
            const data = result.data
            if (data && data.type === "text") {
              setContent(data.content)
              setIsBinary(false)
            } else if (data && data.type === "binary") {
              // Binary files (images, PDFs) — store the base64 data
              setContent(data.content)
              setIsBinary(true)
            } else {
              setContent("")
            }
          })
          .catch(() => {
            setError(true)
            setContent("")
          })
          .finally(() => {
            setLoading(false)
          })
      },
    ),
  )

  // ─── Save logic (editor mode) ──────────────────────────────────────────

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle")
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  const saveFile = (path: string, newContent: string) => {
    const baseUrl = serverSDK().url
    if (!baseUrl) return

    setSaveStatus("saving")

    fetch(new URL("/file/write", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content: newContent }),
    })
      .then(() => {
        setSaveStatus("saved")
        if (savedTimer) clearTimeout(savedTimer)
        savedTimer = setTimeout(() => setSaveStatus("idle"), 2000)
      })
      .catch(() => {
        setSaveStatus("idle")
      })
  }

  const handleEdit = (newContent: string) => {
    setContent(newContent)
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveFile(props.filePath, newContent), 1000)
  }

  const handleImmediateSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveFile(props.filePath, content())
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (savedTimer) clearTimeout(savedTimer)
  })

  // ─── Helpers ────────────────────────────────────────────────────────────

  const basename = () => {
    const parts = props.filePath.split("/")
    return parts[parts.length - 1] ?? props.filePath
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div class="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-weaker-base">
        <IconButton icon="arrow-left" variant="ghost" class="h-6 w-6" onClick={props.onBack} aria-label="Back to file list" />
        <div class="flex-1 min-w-0 text-12-regular text-text-base truncate">{basename()}</div>

        {/* Save status (editor kind) */}
        <Show when={toolbar().save && saveStatus() !== "idle"}>
          <span
            class="text-11-medium"
            classList={{
              "text-green-500": saveStatus() === "saved",
              "text-text-weak": saveStatus() === "saving",
            }}
          >
            {saveStatus() === "saving" ? "Saving..." : "Saved"}
          </span>
        </Show>

        {/* Zoom control (pdf/image/markdown) */}
        <Show when={toolbar().zoom}>
          <div class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden">
            <input
              type="text"
              class="w-11 h-full text-center text-12-regular text-text-base bg-transparent outline-none"
              value={`${zoom()}%`}
              onInput={(e) => {
                const val = parseInt(e.currentTarget.value)
                if (!isNaN(val) && val >= 50 && val <= 200) setZoom(val)
              }}
              onBlur={(e) => {
                e.currentTarget.value = `${zoom()}%`
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
            />
            <div class="flex items-center border-l border-border-base">
              <button
                class="flex items-center justify-center w-5 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
                onClick={zoomOut}
                aria-label="Zoom out"
              >
                <span class="text-12-medium leading-none">−</span>
              </button>
              <button
                class="flex items-center justify-center w-5 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors -ml-0.5"
                onClick={zoomIn}
                aria-label="Zoom in"
              >
                <span class="text-12-medium leading-none">+</span>
              </button>
            </div>
          </div>
        </Show>

        {/* Build button (TeX, when available — wired by slice 5) */}
        <Show when={toolbar().build}>
          <TooltipV2 openDelay={400} value="Build TeX">
            <IconButton icon="play" variant="ghost" class="h-6 w-6" aria-label="Build TeX" />
          </TooltipV2>
        </Show>

        {/* Mode toggle (markdown: preview ↔ editor) */}
        <Show when={toolbar().modeToggle === "preview-editor"}>
          <SegmentedControlV2
            value={mode()}
            onChange={(value) => {
              if (value === "preview" || value === "editor") setMode(value)
            }}
            class="!w-auto"
            aria-label="View mode"
          >
            <TooltipV2 openDelay={400} value="Preview">
              <SegmentedControlItemV2 value="preview" aria-label="Preview" class="!flex-none !px-2">
                <Icon name="eye" size="small" />
              </SegmentedControlItemV2>
            </TooltipV2>
            <TooltipV2 openDelay={400} value="Editor">
              <SegmentedControlItemV2 value="editor" aria-label="Editor" class="!flex-none !px-2">
                <Icon name="edit" size="small" />
              </SegmentedControlItemV2>
            </TooltipV2>
          </SegmentedControlV2>
        </Show>
      </div>

      {/* Content area */}
      <div class="flex-1 min-h-0 overflow-auto">
        <Show when={!loading()} fallback={<div class="p-4 text-12-regular text-text-weak">Loading...</div>}>
          <Show when={!error()} fallback={<ErrorState />}>
            <Switch fallback={<PlainEditor content={content()} language={ext().replace(/^\./, "")} readOnly={readOnly()} onChange={handleEdit} onSave={handleImmediateSave} />}>
              <Match when={kind() === "markdown" && mode() === "preview"}>
                <div
                  class="p-4 origin-top-left [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:max-w-full [&_.katex]:text-[0.9em]"
                  style={{ transform: `scale(${zoom() / 100})`, width: `${10000 / zoom()}%` }}
                >
                  <Markdown text={preprocessMarkdown(content())} class="text-12-regular" />
                </div>
              </Match>
              <Match when={kind() === "markdown" && mode() === "editor"}>
                <PlainEditor content={content()} language="md" readOnly={false} onChange={handleEdit} onSave={handleImmediateSave} />
              </Match>
              <Match when={kind() === "pdf"}>
                <PDFViewer data={content()} isBase64={isBinary()} zoom={zoom()} />
              </Match>
              <Match when={kind() === "image"}>
                <div
                  class="p-4 flex items-center justify-center"
                  style={{ transform: `scale(${zoom() / 100})`, "transform-origin": "top left", width: `${10000 / zoom()}%` }}
                >
                  <img
                    src={`data:image/*;base64,${content()}`}
                    alt={basename()}
                    class="max-w-full"
                    style={{ "image-rendering": "auto" }}
                  />
                </div>
              </Match>
            </Switch>
          </Show>
        </Show>
      </div>
    </div>
  )
}

// ─── Error state ────────────────────────────────────────────────────────────
function ErrorState() {
  return (
    <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
      <div class="text-center">
        <Icon name="alert-circle" size="large" class="mx-auto mb-2 text-text-faint" />
        <p>Could not load file</p>
        <p class="text-11-regular text-text-faint mt-1">The file may have been deleted or moved</p>
      </div>
    </div>
  )
}
