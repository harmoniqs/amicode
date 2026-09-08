import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Markdown } from "@opencode-ai/session-ui/markdown"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { SegmentedControlV2, SegmentedControlItemV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { writeClipboardViaBridge } from "@/components/prompt-input/clipboard-bridge"
import FileTreeV2 from "@/components/file-tree-v2"
import {
  previewFileTree,
  previewProjectRoot,
  previewEnv,
  requestPreviewFileTreeRefresh,
} from "@/utils/amicode-preview-file-tree"
import { preprocessMarkdown } from "@/utils/preview-markdown"
import { PreviewContentArea } from "@/components/session/preview-content-area"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import type { FileNode } from "@opencode-ai/sdk/v2"

// ─── Types ──────────────────────────────────────────────────────────────────

export interface PreviewFileEntry {
  path: string
  relativePath: string
  basename: string
  extension: ".md"
  changeType: "added" | "modified"
}

interface PreviewFileState {
  mode: "preview" | "raw"
  scrollPosition?: number
  unsavedContent?: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract the filename from an absolute or relative path. */
function basename(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function SessionPreviewTab(props: {
  diffs: () => Array<{ file: string; status?: string }>
  touchedFiles?: () => Array<{ file: string; status: string }>
}) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const [selectedFile, setSelectedFile] = createSignal<string | undefined>(undefined)
  const [fileStates, setFileStates] = createStore<Record<string, PreviewFileState>>({})
  const [fileContent, setFileContent] = createSignal<string>("")
  const [loading, setLoading] = createSignal(false)
  const [zoom, setZoom] = createSignal(100)

  const zoomIn = () => setZoom((z) => Math.min(z + 10, 200))
  const zoomOut = () => setZoom((z) => Math.max(z - 10, 50))

  /** Whether the project-wide file tree is available (extension pushed files). */
  const hasProjectTree = createMemo(() => previewFileTree().length > 0)

  // Derive the file list from touchedFiles (tool-edit history, persists regardless of git state)
  // supplemented by diffs for any files not already covered.
  // Used as fallback when no project tree is available.
  const markdownFiles = createMemo((): PreviewFileEntry[] => {
    const seen = new Set<string>()
    const entries: PreviewFileEntry[] = []

    // Build a suffix→absolute map from touchedFiles so we can resolve ~/... paths from diffs
    const touched = props.touchedFiles?.() ?? []
    const suffixToAbsolute = new Map<string, string>()
    for (const t of touched) {
      const parts = t.file.split("/")
      for (let i = 1; i < parts.length; i++) {
        suffixToAbsolute.set(parts.slice(i).join("/"), t.file)
      }
    }

    const resolveFile = (file: string): string => {
      if (!file.startsWith("~/")) return file
      const suffix = file.slice(2)
      const absolute = suffixToAbsolute.get(suffix)
      return absolute ?? file
    }

    const toEntry = (file: string, status: string): PreviewFileEntry | null => {
      if (!file.endsWith(".md")) return null
      const resolved = resolveFile(file)
      if (seen.has(resolved)) return null
      seen.add(resolved)
      const parts = resolved.split("/")
      const name = parts[parts.length - 1]
      const relativePath = resolved.replace(/^\/Users\/[^/]+\//, "")
      return {
        path: resolved,
        relativePath,
        basename: name,
        extension: ".md" as const,
        changeType: (status === "added" ? "added" : "modified") as "added" | "modified",
      }
    }

    for (const t of touched) {
      const entry = toEntry(t.file, t.status)
      if (entry) entries.push(entry)
    }
    for (const d of props.diffs()) {
      const entry = toEntry(d.file, d.status === "added" ? "added" : "modified")
      if (entry) entries.push(entry)
    }
    return entries
  })

  // ─── File content loading ───────────────────────────────────────────────

  createEffect(
    on(selectedFile, (path) => {
      if (!path) return
      setLoading(true)

      const fsPath = path.startsWith("~/") ? path.replace("~", process.env.HOME ?? "") : path

      sdk()
        .client.file.read({ path: fsPath })
        .then((result) => {
          const content = result.data
          if (content && content.type === "text") {
            setFileContent(content.content)
          }
        })
        .catch(() => {
          setFileContent("")
        })
        .finally(() => {
          setLoading(false)
        })
    }),
  )

  const currentMode = createMemo(() => {
    const path = selectedFile()
    if (!path) return "preview"
    return fileStates[path]?.mode ?? "preview"
  })

  const goBack = () => {
    setSelectedFile(undefined)
  }

  // ─── Handle file selection from project tree ────────────────────────────

  const handleProjectFileClick = (node: FileNode) => {
    // node.path is relative; resolve to absolute using the project root
    const root = previewProjectRoot()
    const absPath = root ? `${root}/${node.path}` : node.path
    setSelectedFile(absPath)
  }

  const handleEnvFileClick = (node: FileNode) => {
    const env = previewEnv()
    if (!env) return
    const absPath = `${env.root}/${node.path}`
    setSelectedFile(absPath)
  }

  // ─── Raw Editor Save ────────────────────────────────────────────────────

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const [saveStatus, setSaveStatus] = createSignal<"idle" | "saving" | "saved">("idle")
  let savedTimer: ReturnType<typeof setTimeout> | undefined

  const saveFile = (path: string, content: string) => {
    const fsPath = path.startsWith("~/") ? path.replace("~", process.env.HOME ?? "") : path

    const baseUrl = serverSDK().url
    if (!baseUrl) return

    setSaveStatus("saving")

    fetch(new URL("/file/write", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fsPath, content }),
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

  const debouncedSave = (path: string, content: string) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => saveFile(path, content), 1000)
  }

  const immediateSave = () => {
    const path = selectedFile()
    if (!path) return
    const content = fileStates[path]?.unsavedContent
    if (content !== undefined) {
      if (saveTimer) clearTimeout(saveTimer)
      saveFile(path, content)
      setFileStates(path, { ...fileStates[path], unsavedContent: undefined })
    }
  }

  const handleRawEdit = (content: string) => {
    const path = selectedFile()
    if (!path) return
    setFileStates(path, { ...fileStates[path], unsavedContent: content })
    setFileContent(content)
    debouncedSave(path, content)
  }

  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer)
    if (savedTimer) clearTimeout(savedTimer)
  })

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div class="h-full flex flex-col overflow-hidden">
      <Show
        when={selectedFile()}
        fallback={
          <Show
            when={hasProjectTree()}
            fallback={<PreviewFileList files={markdownFiles()} onSelect={setSelectedFile} />}
          >
            <ProjectFileTree
              active={selectedFile()}
              onFileClick={handleProjectFileClick}
              onEnvFileClick={handleEnvFileClick}
            />
          </Show>
        }
      >
        {(path) => (
          <Show
            when={hasProjectTree()}
            fallback={
              <LegacyMarkdownView
                path={path()}
                basename={markdownFiles().find((f) => f.path === path())?.basename ?? basename(path())}
                fileContent={fileContent()}
                loading={loading()}
                zoom={zoom()}
                zoomIn={zoomIn}
                zoomOut={zoomOut}
                currentMode={currentMode()}
                saveStatus={saveStatus()}
                onBack={goBack}
                onModeChange={(value) => {
                  const p = selectedFile()
                  if (p) setFileStates(p, { ...fileStates[p], mode: value as "preview" | "raw" })
                }}
                onEdit={handleRawEdit}
                onSave={immediateSave}
              />
            }
          >
            <PreviewContentArea filePath={path()} onBack={goBack} />
          </Show>
        )}
      </Show>
    </div>
  )
}

// ─── Legacy Markdown View (no-project content view) ─────────────────────────

function LegacyMarkdownView(props: {
  path: string
  basename: string
  fileContent: string
  loading: boolean
  zoom: number
  zoomIn: () => void
  zoomOut: () => void
  currentMode: string
  saveStatus: string
  onBack: () => void
  onModeChange: (value: string) => void
  onEdit: (content: string) => void
  onSave: () => void
}) {
  return (
    <div class="h-full flex flex-col overflow-hidden">
      <div class="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border-weaker-base">
        <IconButton icon="arrow-left" variant="ghost" class="h-6 w-6" onClick={props.onBack} aria-label="Back to file list" />
        <div class="flex-1 min-w-0 text-12-regular text-text-base truncate">{props.basename}</div>
        <Show when={props.saveStatus !== "idle"}>
          <span
            class="text-11-medium"
            classList={{
              "text-green-500": props.saveStatus === "saved",
              "text-text-weak": props.saveStatus === "saving",
            }}
          >
            {props.saveStatus === "saving" ? "Saving..." : "Saved"}
          </span>
        </Show>
        <div class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden">
          <input
            type="text"
            class="w-11 h-full text-center text-12-regular text-text-base bg-transparent outline-none"
            value={`${props.zoom}%`}
            onInput={(e) => {
              const val = parseInt(e.currentTarget.value)
              if (!isNaN(val) && val >= 50 && val <= 200) {
                // zoom is controlled by the parent, but we still validate inline
              }
            }}
            onBlur={(e) => {
              e.currentTarget.value = `${props.zoom}%`
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
          />
          <div class="flex items-center border-l border-border-base">
            <button
              class="flex items-center justify-center w-5 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
              onClick={props.zoomOut}
              aria-label="Zoom out"
            >
              <span class="text-12-medium leading-none">−</span>
            </button>
            <button
              class="flex items-center justify-center w-5 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors -ml-0.5"
              onClick={props.zoomIn}
              aria-label="Zoom in"
            >
              <span class="text-12-medium leading-none">+</span>
            </button>
          </div>
        </div>
        <SegmentedControlV2
          value={props.currentMode}
          onChange={(value) => {
            if (value !== "preview" && value !== "raw") return
            props.onModeChange(value)
          }}
          class="!w-auto"
          aria-label="View mode"
        >
          <TooltipV2 openDelay={400} value="Preview">
            <SegmentedControlItemV2 value="preview" aria-label="Preview" class="!flex-none !px-2">
              <Icon name="eye" size="small" />
            </SegmentedControlItemV2>
          </TooltipV2>
          <TooltipV2 openDelay={400} value="Raw">
            <SegmentedControlItemV2 value="raw" aria-label="Raw" class="!flex-none !px-2">
              <Icon name="edit" size="small" />
            </SegmentedControlItemV2>
          </TooltipV2>
        </SegmentedControlV2>
      </div>
      <div class="flex-1 min-h-0 overflow-auto">
        <Show when={!props.loading} fallback={<div class="p-4 text-12-regular text-text-weak">Loading...</div>}>
          <Show
            when={props.currentMode === "preview"}
            fallback={<RawEditor content={props.fileContent} onEdit={props.onEdit} onSave={props.onSave} zoom={props.zoom} />}
          >
            <div
              class="p-4 origin-top-left [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:max-w-full [&_.katex]:text-[0.9em]"
              style={{ transform: `scale(${props.zoom / 100})`, width: `${10000 / props.zoom}%` }}
            >
              <Markdown text={preprocessMarkdown(props.fileContent)} class="text-12-regular" />
            </div>
          </Show>
        </Show>
      </div>
    </div>
  )
}

// ─── Project File Tree (#725) ───────────────────────────────────────────────

// Environment pill color palette — same 8-color palette the sidebar uses.
const ENV_PILL_COLORS = [
  "bg-blue-500/15 text-blue-500",
  "bg-green-500/15 text-green-500",
  "bg-purple-500/15 text-purple-500",
  "bg-orange-500/15 text-orange-500",
  "bg-pink-500/15 text-pink-500",
  "bg-teal-500/15 text-teal-500",
  "bg-yellow-500/15 text-yellow-500",
  "bg-red-500/15 text-red-500",
] as const

function ProjectFileTree(props: {
  active?: string
  onFileClick: (node: FileNode) => void
  onEnvFileClick: (node: FileNode) => void
}) {
  const [filter, setFilter] = createSignal("")

  const filteredProjectFiles = createMemo(() => {
    const q = filter().toLowerCase()
    const files = previewFileTree()
    if (!q) return files
    return files.filter((f) => f.toLowerCase().includes(q))
  })

  const filteredEnvFiles = createMemo(() => {
    const env = previewEnv()
    if (!env) return []
    const q = filter().toLowerCase()
    if (!q) return env.files
    return env.files.filter((f) => f.toLowerCase().includes(q))
  })

  return (
    <div class="h-full flex flex-col overflow-hidden">
      {/* Search/filter input */}
      <div class="shrink-0 px-2 py-1.5 border-b border-border-weaker-base">
        <div class="flex items-center gap-1.5 px-2 h-7 rounded-md border border-border-base bg-background-base">
          <Icon name="magnifying-glass" size="small" class="text-text-faint shrink-0" />
          <input
            type="text"
            placeholder="Filter files..."
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
            class="flex-1 min-w-0 text-12-regular text-text-base bg-transparent outline-none placeholder:text-text-faint"
          />
          <Show when={filter()}>
            <button
              class="text-text-faint hover:text-text-base transition-colors"
              onClick={() => setFilter("")}
              aria-label="Clear filter"
            >
              <Icon name="close-small" size="small" />
            </button>
          </Show>
        </div>
      </div>

      {/* Refresh button row */}
      <div class="shrink-0 flex items-center justify-end px-2 py-1">
        <TooltipV2 openDelay={400} value="Refresh file tree">
          <IconButton
            icon="arrow-undo-down"
            variant="ghost"
            class="h-5 w-5"
            onClick={() => requestPreviewFileTreeRefresh()}
            aria-label="Refresh file tree"
          />
        </TooltipV2>
      </div>

      {/* File tree(s) */}
      <div class="flex-1 min-h-0 overflow-auto px-1 pb-2">
        <FileTreeV2
          allowed={filteredProjectFiles()}
          active={props.active}
          draggable={false}
          onFileClick={props.onFileClick}
        />

        {/* Environment divider + tree */}
        <Show when={previewEnv()} keyed>
          {(env) => (
            <Show when={filteredEnvFiles().length > 0}>
              <div class="flex items-center gap-2 px-2 py-2 mt-1">
                <div class="flex-1 h-px bg-border-weaker-base" />
                <span
                  class={`shrink-0 px-1.5 py-0.5 rounded text-10-medium ${ENV_PILL_COLORS[env.colorIndex % ENV_PILL_COLORS.length]}`}
                >
                  {env.name}
                </span>
                <div class="flex-1 h-px bg-border-weaker-base" />
              </div>
              <FileTreeV2
                allowed={filteredEnvFiles()}
                active={props.active}
                draggable={false}
                onFileClick={props.onEnvFileClick}
              />
            </Show>
          )}
        </Show>
      </div>
    </div>
  )
}

// ─── Legacy File List (no-project fallback) ─────────────────────────────────

function PreviewFileList(props: { files: PreviewFileEntry[]; onSelect: (path: string) => void }) {
  const copyToClipboard = (text: string) => {
    if (!writeClipboardViaBridge(text)) {
      void navigator.clipboard.writeText(text)
    }
  }

  return (
    <div class="h-full overflow-auto">
      <Show
        when={props.files.length > 0}
        fallback={
          <div class="h-full flex items-center justify-center text-12-regular text-text-weak p-4">
            No markdown files modified in this session
          </div>
        }
      >
        <div class="py-1">
          <For each={props.files}>
            {(file) => (
              <MenuV2.Context>
                <MenuV2.Context.Trigger
                  as="button"
                  class="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-background-stronger transition-colors"
                  onClick={() => props.onSelect(file.path)}
                >
                  <span
                    class="shrink-0 w-4 h-4 flex items-center justify-center rounded text-10-medium"
                    classList={{
                      "bg-green-500/15 text-green-500": file.changeType === "added",
                      "bg-yellow-500/15 text-yellow-500": file.changeType === "modified",
                    }}
                  >
                    {file.changeType === "added" ? "A" : "M"}
                  </span>
                  <div class="flex-1 min-w-0">
                    <div class="text-12-regular text-text-base truncate">{file.basename}</div>
                    <div class="text-11-regular text-text-weak truncate">{file.relativePath}</div>
                  </div>
                </MenuV2.Context.Trigger>
                <MenuV2.Context.Portal>
                  <MenuV2.Context.Content>
                    <MenuV2.Item onSelect={() => copyToClipboard(file.basename)}>Copy filename</MenuV2.Item>
                    <MenuV2.Item
                      onSelect={() => {
                        const fullPath = file.path.startsWith("~/")
                          ? file.path.replace("~", process.env.HOME ?? "")
                          : file.path
                        copyToClipboard(fullPath)
                      }}
                    >
                      Copy full path
                    </MenuV2.Item>
                  </MenuV2.Context.Content>
                </MenuV2.Context.Portal>
              </MenuV2.Context>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

// ─── Raw Editor ─────────────────────────────────────────────────────────────

function RawEditor(props: { content: string; onEdit: (content: string) => void; onSave: () => void; zoom: number }) {
  let textareaRef: HTMLTextAreaElement | undefined

  return (
    <textarea
      ref={(el) => {
        textareaRef = el
        el.value = props.content
        // Use a native (non-delegated) keydown listener so stopPropagation
        // actually prevents the app's global command system from stealing
        // Cmd+A, Cmd+Z, Cmd+Shift+Z, etc.
        el.addEventListener("keydown", (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault()
            e.stopPropagation()
            props.onSave()
            return
          }
          if (e.metaKey || e.ctrlKey) {
            e.stopPropagation()
          }
        })
      }}
      class="w-full h-full p-4 resize-none bg-transparent text-text-base font-mono outline-none border-none selection:bg-blue-500/30"
      style={{ "tab-size": "2", "font-size": `${props.zoom * 0.12}px` }}
      onInput={(e) => props.onEdit(e.currentTarget.value)}
      spellcheck={false}
    />
  )
}
