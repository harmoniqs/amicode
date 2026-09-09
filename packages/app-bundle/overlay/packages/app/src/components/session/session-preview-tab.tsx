/**
 * session-preview-tab — Companion file viewer for the Preview tab.
 *
 * Renders the file at `previewFile()` using PreviewFileView. When no file is
 * selected, shows a placeholder. File discovery, navigation, search, and the
 * Finder directory view have been removed (#933) — the Preview tab is now
 * driven externally by sidebar clicks and chat file-pill routing.
 *
 * Per-file state (mode, scroll position, unsaved content) persists across
 * file switches via a local store.
 *
 * @module
 */

import { createMemo, createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { PreviewFileState } from "@opencode-ai/session-ui/v2/preview-nav-state"
import { Icon } from "@opencode-ai/ui/icon"
import { PreviewFileView } from "./preview-file-view"
import type { Accessor } from "solid-js"

// ─── Types ──────────────────────────────────────────────────────────────────

interface PreviewFileStates {
  [path: string]: PreviewFileState
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function SessionPreviewTab(props: {
  previewFile: Accessor<string | null>
}) {
  // ─── Per-file State ──────────────────────────────────────────────────────

  const [fileStates, setFileStates] = createStore<PreviewFileStates>({})

  const [zoom, setZoom] = createSignal(100)

  const zoomIn = () => setZoom((z) => Math.min(z + 10, 500))
  const zoomOut = () => setZoom((z) => Math.max(z - 10, 50))
  const onZoomChange = (value: number) => setZoom(Math.round(Math.min(Math.max(value, 50), 500)))

  const getFileState = (path: string): PreviewFileState => {
    return fileStates[path] ?? { mode: "preview", scrollPosition: 0, unsavedContent: null }
  }

  const setFileState = (path: string, update: Partial<PreviewFileState>) => {
    const defaults: PreviewFileState = { mode: "preview", scrollPosition: 0, unsavedContent: null }
    setFileStates(path, (prev) => ({
      ...defaults,
      ...prev,
      ...update,
    }))
  }

  // ─── Header Display ─────────────────────────────────────────────────────

  const headerTitle = createMemo(() => {
    const file = props.previewFile()
    if (file) {
      const parts = file.split("/")
      return parts[parts.length - 1]
    }
    return "Preview"
  })

  // ─── Render ─────────────────────────────────────────────────────────────

  // Dirty state: true when the current file has unsaved edits
  const isUnsaved = createMemo(() => {
    const file = props.previewFile()
    if (!file) return false
    return fileStates[file]?.unsavedContent != null
  })

  return (
    <div class="h-full flex flex-col overflow-hidden">
      {/* Header: filename + unsaved dot */}
      <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-weaker-base">
        <div class="flex-1 min-w-0 flex items-center gap-1.5">
          <span class="text-12-regular text-text-base truncate">
            {headerTitle()}
          </span>
          <Show when={isUnsaved()}>
            <div class="w-2 h-2 rounded-full bg-v2-text-text-faint shrink-0" aria-label="Unsaved changes" />
          </Show>
        </div>
      </div>

      {/* Main content */}
      <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Show
          when={props.previewFile()}
          fallback={
            /* Empty state — no file selected */
            <div class="h-full flex flex-col items-center justify-center gap-3 text-text-weak p-6">
              <Icon name="open-file" class="w-8 h-8 text-v2-text-text-faint" />
              <p class="text-13-regular text-center">Select a file from the sidebar</p>
            </div>
          }
        >
          {(filePath) => (
            <PreviewFileView
              filePath={filePath()}
              fileState={getFileState(filePath())}
              onModeChange={(mode) => setFileState(filePath(), { mode })}
              onUnsavedContent={(content) => setFileState(filePath(), { unsavedContent: content })}
              onSave={() => {/* handled by PreviewFileView internally */}}
              zoom={zoom}
              zoomIn={zoomIn}
              zoomOut={zoomOut}
              onZoomChange={onZoomChange}
            />
          )}
        </Show>
      </div>
    </div>
  )
}
