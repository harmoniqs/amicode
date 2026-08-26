import { For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { DragDropProvider as DndKitProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import {
  DragDropProvider,
  DragDropSensors,
  DragOverlay,
  SortableProvider,
  closestCenter,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import FileTree from "@/components/file-tree"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"
import { SessionContextUsage } from "@/components/session-context-usage"
import { RunInspector } from "@/amicode/inspector/run-inspector"
import { useInspectorBridge } from "@/amicode/inspector/inspector-context"
import {
  WidgetGrid,
  parseWidgetsResponse,
  parseDashboardResponse,
  resolveTokens,
  densityForViewport,
  type DashboardState,
  type Density,
  type WidgetHostCallbacks,
} from "@opencode-ai/ui/amicode-widget-grid"
import { useNavigate, useParams } from "@solidjs/router"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import { sortedRootSessions } from "@/pages/layout/helpers"
import { base64Encode } from "@opencode-ai/core/util/encode"

const reviewTabID = "session-side-panel-review-tab"
const reviewTabPanelID = "session-side-panel-review-tabpanel"
const fileBrowserTabPanelID = "session-side-panel-file-browser-tabpanel"
import { SessionContextTab, SortableTab, SortableTabV2, FileVisual, SessionPreviewTab, PanelMenu } from "@/components/session"
import type { PanelMenuItem } from "@/components/session/panel-menu"
import { OpenInAppV2 } from "@/components/session/open-in-app-v2"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  SESSION_PREVIEW_TAB,
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  shouldShowFileTree,
  type Sizing,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"
import { WORK_COLUMN_WIDTH_MIN } from "@/pages/session/session-panel-width"
import { SessionFileBrowserTab, type SessionFileBrowserState } from "@/pages/session/v2/session-file-browser-tab"

type PulseInspectorStage = "optimization" | "calibration" | "compilation"

function PulseInspectorContent() {
  const bridge = useInspectorBridge()
  const [stage, setStage] = createSignal<PulseInspectorStage>("optimization")

  const hasActiveRun = createMemo(() => {
    const r = bridge.runs()
    if (r.size === 0) return false
    const activeId = bridge.activeRunId()
    const state = activeId ? r.get(activeId) : r.values().next().value
    return state ? !state.completion : false
  })

  return (
    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden flex flex-col gap-3 p-3">
      {/* Stage segmented control */}
      {/* The active tab used to be distinguished by fill (bg-background-base on a
          bg-background-stronger track). Under the brand's one-background rule those
          two resolve to the SAME cream, so the control measured 1.00:1 and stopped
          saying anything. Selection is carried by a border now, which is how this
          palette separates surfaces everywhere else. */}
      <div class="flex items-center gap-0.5 rounded-md border border-border-weak-base p-0.5 min-w-0">
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1 rounded px-1.5 py-1 text-11-medium transition-colors truncate border"
          classList={{
            "border-v2-border-border-strong text-text-base font-[600]": stage() === "optimization",
            "border-transparent text-text-weak hover:text-text-base": stage() !== "optimization",
          }}
          onClick={() => setStage("optimization")}
        >
          <Show when={hasActiveRun()}>
            {/* the live dot is a semantic state, not a raw palette green */}
            <span class="shrink-0 inline-block w-[6px] h-[6px] rounded-full bg-v2-state-fg-success" />
          </Show>
          <span class="truncate">Optimization</span>
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1 rounded px-1.5 py-1 text-11-medium cursor-default truncate border border-transparent text-text-weak"
          disabled
        >
          <span class="truncate">Calibration</span>
          <span class="shrink-0 text-[9px] uppercase tracking-wide border border-border-weak-base text-text-weak rounded px-1 py-0.5">Soon</span>
        </button>
        <button
          class="flex-1 min-w-0 flex items-center justify-center gap-1 rounded px-1.5 py-1 text-11-medium cursor-default truncate border border-transparent text-text-weak"
          disabled
        >
          <span class="truncate">Compilation</span>
          <span class="shrink-0 text-[9px] uppercase tracking-wide border border-border-weak-base text-text-weak rounded px-1 py-0.5">Soon</span>
        </button>
      </div>

      {/* Stage content */}
      <Show when={stage() === "optimization"}>
        <div class="flex-1 min-h-0 overflow-y-auto">
          <RunInspector bridge={bridge} />
        </div>
      </Show>
    </div>
  )
}

function HomeTabContent() {
  const server = useServer()
  const sync = useServerSync()
  const sdk = useSDK()
  const params = useParams()
  const navigate = useNavigate()

  // Compute the most recent non-empty session that isn't the current one
  const resumeSession = createMemo(() => {
    const directory = sdk().directory
    const store = sync().child(directory, { bootstrap: false })[0]
    const sorted = sortedRootSessions(store, Date.now())
    const currentId = params.id
    // Find the first session that isn't the current one and has a title (non-empty)
    return sorted.find((s) => s.id !== currentId && s.title) ?? undefined
  })

  const widgetContext = createMemo(() => {
    const session = resumeSession()
    return {
      preview: false,
      resume: session ? { name: session.title, meta: undefined } : undefined,
    }
  })

  const widgetCallbacks: WidgetHostCallbacks = {
    fetch: (path) => amicodeGet(server.current, path),
    action: async (verb) => {
      if (verb === "resume-session") {
        const session = resumeSession()
        if (session) navigate(`/${base64Encode(session.directory)}/session/${session.id}`)
      }
      return { ok: true }
    },
    prompt: () => {},
    open: () => {},
  }

  const [widgetsRaw, { refetch: refetchWidgets }] = createResource(
    () => server.current,
    () => amicodeGet(server.current, "/amicode/widgets").catch(() => undefined),
  )
  const widgetInfos = createMemo(() => {
    const raw = widgetsRaw()
    return raw === undefined ? [] : parseWidgetsResponse(raw)
  })

  const [dashboardRaw] = createResource(
    () => server.current,
    () => amicodeGet(server.current, "/amicode/dashboard").catch(() => undefined),
  )
  const [savedDashboard, setSavedDashboard] = createSignal<DashboardState | undefined>(undefined)
  const dashboard = createMemo<DashboardState | undefined>(() => {
    const local = savedDashboard()
    if (local) return local
    const raw = dashboardRaw()
    return raw === undefined ? undefined : parseDashboardResponse(raw)
  })

  const widgetFrameSrcs = createMemo(() => {
    const conn = server.current
    if (!conn) return {}
    const out: Record<string, string> = {}
    for (const w of widgetInfos())
      out[w.id] = new URL(
        `/amicode/widget-frame?id=${encodeURIComponent(w.id)}&h=${w.hash}`,
        conn.http.url,
      ).toString()
    return out
  })

  const readTokens = () => {
    const style = getComputedStyle(document.documentElement)
    const density: Density = densityForViewport(window.innerWidth, window.innerHeight)
    return { tokens: resolveTokens((name) => style.getPropertyValue(name), density), density }
  }
  const [themeState, setThemeState] = createSignal(readTokens())

  createEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const update = () => setThemeState(readTokens())
    mq.addEventListener("change", update)
    onCleanup(() => mq.removeEventListener("change", update))
  })

  const saveDashboard = (next: DashboardState) => {
    setSavedDashboard(next)
    void amicodePost(server.current, "/amicode/dashboard", next)
      .then((res) => {
        const merged = parseDashboardResponse(res)
        if (merged) setSavedDashboard(merged)
      })
      .catch(() => {})
  }

  return (
    <div class="relative flex-1 min-h-0 overflow-y-auto p-3">
      <Show
        when={widgetInfos().length > 0 && dashboard()}
        fallback={
          <div class="h-full flex items-center justify-center text-center">
            <div class="text-12-regular text-text-weak max-w-48">
              No widgets yet. Ask Amico to create one for you.
            </div>
          </div>
        }
      >
        {(dash) => (
          <WidgetGrid
            widgets={widgetInfos()}
            dashboard={dash()}
            frameSrcs={widgetFrameSrcs()}
            tokens={themeState().tokens}
            density={themeState().density}
            context={widgetContext()}
            callbacks={widgetCallbacks}
            onSave={saveDashboard}
          />
        )}
      </Show>
    </div>
  )
}

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff
type RenderDiff = FileDiffInfo | (SnapshotFileDiff & { file: string }) | VcsFileDiff
const FILE_TREE_WIDTH_MIN = 240

function renderDiff(value: ReviewDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewHasFocusableContent: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  reviewSidebarToggle?: (disabled: boolean) => JSX.Element
  fileBrowserState?: SessionFileBrowserState
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  reviewSnap: boolean
  size: Sizing
  stacked?: boolean
  touchedFiles?: () => Array<{ file: string; status: string }>
}) {
  const layout = useLayout()
  const settings = useSettings()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const sdk = useSDK()
  const { sessionKey, tabs, view, params } = useSessionLayout()
  const projectDirectory = createMemo(() => sdk().directory)

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const shown = settings.visibility.fileTree

  // the tabs-column open state (historically the review panel's flag — the
  // persisted store key stays, the review UI is gone)
  const tabsOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const fileOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: shown(),
        opened: layout.fileTree.opened(),
      }),
  )
  // upstream's review UI rides the same persisted store key as the fork's tabs
  // column (reviewPanel.opened) — one memo, two names (the vault effects below
  // use tabsOpen; upstream's review machinery uses reviewOpen)
  const reviewOpen = tabsOpen
  const open = createMemo(() => reviewOpen() || fileOpen())
  const fileTreeWidth = createMemo(() => Math.max(FILE_TREE_WIDTH_MIN, layout.fileTree.width()))
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!open()) return "0px"
    // the tabs column owns its width (never flex-fills the window) and can be
    // dragged much narrower — Kate 2026-07-27
    if (reviewOpen()) return `${layout.panelColumn.width()}px`
    return `${fileTreeWidth()}px`
  })
  const treeWidth = createMemo(() => (fileOpen() ? `${fileTreeWidth()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalizeFileTreeV2Path(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
    fileBrowser: () => !!props.fileBrowserState,
  })
  const contextOpen = tabState.contextOpen
  const previewOpen = tabState.previewOpen
  const pulseInspectorOpen = tabState.pulseInspectorOpen
  const openFileOpen = tabState.openFileOpen
  const panelTabs = tabState.panelTabs
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  const fileTreeTab = () => layout.fileTree.tab()

  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    layout.fileTree.setTab("all")
  }

  let fileFilter: HTMLInputElement | undefined
  let tabList: HTMLDivElement | undefined
  const temporaryTab = tabs().preview
  const previewTab = (value: string) => {
    const next = normalizeTab(value)
    tabs().previewTab(next)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    queueMicrotask(() => tabs().setActive(next))
  }
  const activateTab = (value: string) => {
    const next = normalizeTab(value)
    const path = file.pathFromTab(next)
    if (path) void file.load(path)
    openReviewPanel()
    tabs().setActive(next)
  }
  const browserTab = createMemo(() => {
    if (!props.fileBrowserState) return undefined
    const active = activeTab()
    if (active && file.pathFromTab(active)) return active
    return activeFileTab()
  })
  // Keep the file-browser shell mounted while any file tab exists. Kobalte briefly
  // selects Review while the tab For replaces a preview trigger, which would
  // otherwise dispose the sidebar and reset scroll.
  const fileBrowserMounted = createMemo(() => {
    if (!props.fileBrowserState) return false
    return openedTabs().length > 0 || openFileOpen() || !!browserTab()
  })
  const fileBrowserVisible = createMemo(() => {
    const active = activeTab()
    return active !== "review" && active !== "context" && active !== "home" && active !== "empty" && active !== SESSION_PREVIEW_TAB
  })

  // Markdown files for the Preview tab — check both git diffs and tool-edit history
  const hasMarkdownFiles = createMemo(() => {
    if (diffs().some((d) => d.file.endsWith(".md"))) return true
    const touched = props.touchedFiles?.()
    if (touched?.some((t) => t.file.endsWith(".md"))) return true
    return false
  })

  // Panel menu items — Files Changed lives as the "review" trigger, Context and
  // Preview are the secondary tabs, and Pulse Inspector is the third requested tab.
  const panelMenuItems = createMemo((): PanelMenuItem[] => [
    {
      id: "context",
      label: "Context",
      icon: "context-ring",
      available: () => true,
      active: contextOpen,
    },
    {
      id: "pulseInspector",
      label: "Pulse Inspector",
      icon: "pulse",
      available: () => true,
      active: () => activeTab() === "pulseInspector",
      group: "Quantum",
    },
    {
      id: SESSION_PREVIEW_TAB,
      label: "Preview",
      icon: "eye",
      available: () => true,
      active: previewOpen,
    },
  ])

  const handlePanelMenuSelect = (id: string) => {
    tabs().open(id)
    tabs().setActive(id)
    openReviewPanel()
  }

  const closeTabKeybind = createMemo(() => command.keybindParts("tab.close"))
  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop() && !(settings.general.newLayoutDesigns() && !params.id)}>
      <aside
        id="review-panel"
        aria-label={language.t("session.panel.reviewAndFiles")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 flex overflow-hidden"
        classList={{
          "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
          "bg-background-base": !settings.general.newLayoutDesigns(),
          "h-full shrink-0": !props.stacked,
          "h-full min-h-0": props.stacked,
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active(),
          "rounded-md shadow-[var(--v2-elevation-raised)] overflow-hidden": settings.general.newLayoutDesigns(),
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={tabsOpen()}>
          <div onPointerDown={() => props.size.start()}>
            <ResizeHandle
              direction="horizontal"
              edge="start"
              size={layout.panelColumn.width()}
              min={WORK_COLUMN_WIDTH_MIN}
              max={typeof window === "undefined" ? 900 : window.innerWidth * 0.6}
              onResize={(width) => {
                props.size.touch()
                layout.panelColumn.resize(width)
              }}
            />
          </div>
        </Show>
        <Show when={open()}>
          <div
            class="size-full flex"
            classList={{
              "border-l border-border-weaker-base": !settings.general.newLayoutDesigns(),
            }}
          >
            <Show when={reviewOpen()}>
              <div
                class="relative min-w-0 h-full flex-1 overflow-hidden"
                classList={{
                  "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                  "bg-background-base": !settings.general.newLayoutDesigns(),
                }}
              >
                <div
                  class="size-full min-w-0 h-full"
                  classList={{
                    "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
                    "bg-background-base": !settings.general.newLayoutDesigns(),
                  }}
                >
                  <Show
                    when={props.fileBrowserState}
                    fallback={
                      <DragDropProvider
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragYAxis />
                        <Tabs value={activeTab()} onChange={activateTab}>
                          <div class="sticky top-0 shrink-0 flex">
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Tabs.Trigger value="home">
                                <div class="flex items-center gap-1.5">
                                  <Icon name="home" size="small" />
                                  <div>Home</div>
                                </div>
                              </Tabs.Trigger>
                              <Show when={reviewTab() && props.canReview()}>
                                <Tabs.Trigger
                                  value="review"
                                  id={reviewTabID}
                                  aria-controls={activeTab() === "review" ? reviewTabPanelID : undefined}
                                >
                                  <div class="flex items-center gap-1.5">
                                    <Icon name="review" size="small" />
                                    <div>{language.t("session.tab.review")}</div>
                                    <Show when={props.hasReview()}>
                                      <div>{props.reviewCount()}</div>
                                    </Show>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              {/* amicode#105: the vault tab is retired — the
                                  global drawer is the vault's only host (ADR
                                  docs/adr/0001). Do not re-add a tab here:
                                  two hosts mirrored through two stores was the
                                  desync this column's toggle got blamed for. */}
                              <div style={{ display: contextOpen() ? undefined : "none" }}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </div>
                              <div style={{ display: pulseInspectorOpen() ? undefined : "none" }}>
                                <Tabs.Trigger
                                  value="pulseInspector"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("pulseInspector")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("pulseInspector")}
                                >
                                   <div class="flex items-center gap-1.5">
                                     <Icon name="pulse" size="small" />
                                     <div>Pulse Inspector</div>
                                   </div>
                                 </Tabs.Trigger>
                              </div>
                              <div style={{ display: previewOpen() ? undefined : "none" }}>
                                <Tabs.Trigger
                                  value={SESSION_PREVIEW_TAB}
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close(SESSION_PREVIEW_TAB)}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close(SESSION_PREVIEW_TAB)}
                                >
                                  <div class="flex items-center gap-2">
                                    <Icon name="eye" size="small" />
                                    <div>Preview</div>
                                  </div>
                                </Tabs.Trigger>
                              </div>
                              <SortableProvider ids={openedTabs()}>
                                <For each={panelTabs()}>
                                  {(tab) => (
                                    <SortableTab
                                      tab={tab}
                                      temporary={temporaryTab() === tab}
                                      onTabClose={tabs().close}
                                      onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                                    />
                                  )}
                                </For>
                              </SortableProvider>
                            </Tabs.List>
                            <div class="shrink-0 flex items-center justify-center pl-2 pr-1">
                              <PanelMenu
                                items={panelMenuItems()}
                                onSelect={handlePanelMenuSelect}
                              />
                            </div>
                          </div>

                          <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                            <div
                              id={reviewTabPanelID}
                              role="tabpanel"
                              aria-labelledby={reviewTabID}
                              tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                              data-slot="tabs-content"
                              class="flex flex-col h-full overflow-hidden contain-strict"
                            >
                              {props.reviewPanel()}
                            </div>
                          </Show>

                          <Show when={activeTab() === "home"}>
                            <Tabs.Content value="home" class="flex flex-col h-full overflow-hidden contain-strict">
                              <HomeTabContent />
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "empty"}>
                            <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                  <Mark class="w-14 opacity-10" />
                                  <div class="text-14-regular text-text-weak max-w-56">
                                    {language.t("session.files.selectToOpen")}
                                  </div>
                                </div>
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "context"}>
                            <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <SessionContextTab />
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === "pulseInspector"}>
                            <Tabs.Content value="pulseInspector" class="flex flex-col h-full overflow-hidden contain-strict">
                              <PulseInspectorContent />
                            </Tabs.Content>
                          </Show>

                          <Show when={activeTab() === SESSION_PREVIEW_TAB}>
                            <Tabs.Content value={SESSION_PREVIEW_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                              <div class="relative flex-1 min-h-0 overflow-hidden">
                                <SessionPreviewTab diffs={diffs} touchedFiles={props.touchedFiles} />
                              </div>
                            </Tabs.Content>
                          </Show>

                          <Show when={activeFileTab()} keyed>
                            {(tab) => <FileTabContent tab={tab} />}
                          </Show>
                        </Tabs>
                        <DragOverlay>
                          <Show when={store.activeDraggable} keyed>
                            {(tab) => {
                              const path = file.pathFromTab(tab)
                              return (
                                <div data-component="tabs-drag-preview">
                                  <Show when={path}>
                                    {(p) => <FileVisual active path={p()} temporary={temporaryTab() === tab} />}
                                  </Show>
                                </div>
                              )
                            }}
                          </Show>
                        </DragOverlay>
                      </DragDropProvider>
                    }
                  >
                    <DndKitProvider
                      sensors={[
                        PointerSensor.configure({
                          activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                          preventActivation: (event) =>
                            event.target instanceof Element &&
                            (!!event.target.closest('[data-slot="tabs-trigger-close-button"]') ||
                              !!event.target.closest(".session-review-v2-open-in-app-slot")),
                        }),
                      ]}
                      modifiers={[
                        RestrictToHorizontalAxis,
                        RestrictToElement.configure({ element: () => tabList ?? null }),
                      ]}
                      plugins={(defaults) => [
                        ...defaults.filter((plugin) => plugin !== Accessibility),
                        AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
                        Feedback.configure({ dropAnimation: null }),
                      ]}
                      onDragEnd={(event) => {
                        const source = event.operation.source
                        if (event.canceled || !isSortable(source) || source.initialIndex === source.index) return
                        tabs().move(source.id.toString(), source.index)
                      }}
                    >
                      <Tabs value={activeTab()} onChange={activateTab}>
                        <div class="session-review-v2-tabs-bar sticky top-0 shrink-0 flex items-center">
                          <Tabs.List
                            ref={(el: HTMLDivElement) => {
                              tabList = el
                              const stop = createFileTabListSync({ el, contextOpen })
                              onCleanup(stop)
                            }}
                          >
                            <Show when={props.reviewSidebarToggle}>
                              {(toggle) => (
                                <div class="session-review-v2-sidebar-toggle-slot h-full shrink-0 sticky left-0 z-10 flex items-center justify-center bg-v2-background-bg-base">
                                  {toggle()(false)}
                                </div>
                              )}
                            </Show>
                            <Tabs.Trigger value="home">
                              <div class="flex items-center gap-1.5">
                                <Icon name="home" size="small" />
                                <div>Home</div>
                              </div>
                            </Tabs.Trigger>
                            <Show when={reviewTab() && props.canReview()}>
                              <Tabs.Trigger
                                value="review"
                                id={reviewTabID}
                                aria-controls={activeTab() === "review" ? reviewTabPanelID : undefined}
                              >
                                <div class="flex items-center gap-1.5">
                                  <Icon name="review" size="small" />
                                  <div>
                                    {props.hasReview()
                                       ? "Files Changed"
                                       : language.t("session.tab.review")}
                                  </div>
                                  <Show when={props.hasReview()}>
                                    <div>{props.reviewCount()}</div>
                                  </Show>
                                </div>
                              </Tabs.Trigger>
                            </Show>
                            <div style={{ display: contextOpen() ? undefined : "none" }}>
                              <Tabs.Trigger
                                value="context"
                                closeButton={
                                  <TooltipV2
                                    value={
                                      <>
                                        {language.t("common.closeTab")}
                                        <Show when={closeTabKeybind().length > 0}>
                                          <KeybindV2 keys={closeTabKeybind()} variant="neutral" />
                                        </Show>
                                      </>
                                    }
                                    placement="bottom"
                                    gutter={10}
                                  >
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      class="h-5 w-5"
                                      onClick={() => tabs().close("context")}
                                      aria-label={language.t("common.closeTab")}
                                    />
                                  </TooltipV2>
                                }
                                hideCloseButton
                                onMiddleClick={() => tabs().close("context")}
                              >
                                <div class="flex items-center gap-2">
                                  <SessionContextUsage variant="indicator" />
                                  <div>{language.t("session.tab.context")}</div>
                                </div>
                              </Tabs.Trigger>
                            </div>
                            <div style={{ display: pulseInspectorOpen() ? undefined : "none" }}>
                            <Tabs.Trigger
                              value="pulseInspector"
                              closeButton={
                                <TooltipV2
                                  value={
                                    <>
                                      {language.t("common.closeTab")}
                                      <Show when={closeTabKeybind().length > 0}>
                                        <KeybindV2 keys={closeTabKeybind()} variant="neutral" />
                                      </Show>
                                    </>
                                  }
                                  placement="bottom"
                                  gutter={10}
                                >
                                  <IconButton
                                    icon="close-small"
                                    variant="ghost"
                                    class="h-5 w-5"
                                    onClick={() => tabs().close("pulseInspector")}
                                    aria-label={language.t("common.closeTab")}
                                  />
                                </TooltipV2>
                              }
                              hideCloseButton
                              onMiddleClick={() => tabs().close("pulseInspector")}
                            >
                               <div class="flex items-center gap-1.5">
                                 <Icon name="pulse" size="small" />
                                 <div>Pulse Inspector</div>
                               </div>
                             </Tabs.Trigger>
                            </div>
                            <div style={{ display: previewOpen() ? undefined : "none" }}>
                              <Tabs.Trigger
                                value={SESSION_PREVIEW_TAB}
                                closeButton={
                                  <TooltipV2
                                    value={
                                      <>
                                        {language.t("common.closeTab")}
                                        <Show when={closeTabKeybind().length > 0}>
                                          <KeybindV2 keys={closeTabKeybind()} variant="neutral" />
                                        </Show>
                                      </>
                                    }
                                    placement="bottom"
                                    gutter={10}
                                  >
                                    <IconButton
                                      icon="close-small"
                                      variant="ghost"
                                      class="h-5 w-5"
                                      onClick={() => tabs().close(SESSION_PREVIEW_TAB)}
                                      aria-label={language.t("common.closeTab")}
                                    />
                                  </TooltipV2>
                                }
                                hideCloseButton
                                onMiddleClick={() => tabs().close(SESSION_PREVIEW_TAB)}
                              >
                                <div class="flex items-center gap-2">
                                  <Icon name="eye" size="small" />
                                  <div>Preview</div>
                                </div>
                              </Tabs.Trigger>
                            </div>
                            <For each={panelTabs()}>
                              {(tab) => (
                                <SortableTabV2
                                  tab={tab}
                                  index={() => tabs().all().indexOf(tab)}
                                  temporary={temporaryTab() === tab}
                                  onTabClose={tabs().close}
                                  onTabDoubleClick={temporaryTab() === tab ? openTab : undefined}
                                />
                              )}
                            </For>
                          </Tabs.List>
                          <div class="shrink-0 flex items-center justify-center pl-2 pr-1">
                            <PanelMenu
                              items={panelMenuItems()}
                              onSelect={handlePanelMenuSelect}
                              v2
                            />
                          </div>
                          <div
                            class="session-review-v2-open-in-app-slot shrink-0 flex items-center pr-3"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <OpenInAppV2 directory={projectDirectory} />
                          </div>
                        </div>

                        <Show when={reviewTab() && props.canReview() && activeTab() === "review"}>
                          <div
                            id={reviewTabPanelID}
                            role="tabpanel"
                            aria-labelledby={reviewTabID}
                            tabIndex={props.reviewHasFocusableContent() ? undefined : 0}
                            data-slot="tabs-content"
                            class="flex flex-col h-full overflow-hidden contain-strict"
                          >
                            {props.reviewPanel()}
                          </div>
                        </Show>

                        <Show when={activeTab() === "home"}>
                          <Tabs.Content value="home" class="flex flex-col h-full overflow-hidden contain-strict">
                            <HomeTabContent />
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "empty"}>
                          <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                <Mark class="w-14 opacity-10" />
                                <div class="text-14-regular text-text-weak max-w-56">
                                  {language.t("session.files.selectToOpen")}
                                </div>
                              </div>
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "context"}>
                          <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === "pulseInspector"}>
                          <Tabs.Content value="pulseInspector" class="flex flex-col h-full overflow-hidden contain-strict">
                            <PulseInspectorContent />
                          </Tabs.Content>
                        </Show>

                        <Show when={activeTab() === SESSION_PREVIEW_TAB}>
                           <Tabs.Content value={SESSION_PREVIEW_TAB} class="flex flex-col h-full overflow-hidden contain-strict">
                             <div class="relative flex-1 min-h-0 overflow-hidden">
                               <SessionPreviewTab diffs={diffs} touchedFiles={props.touchedFiles} />
                             </div>
                           </Tabs.Content>
                        </Show>

                        <Show when={fileBrowserMounted()}>
                          <div
                            id={fileBrowserTabPanelID}
                            role="tabpanel"
                            data-slot="tabs-content"
                            class="h-full min-h-0 overflow-hidden"
                            classList={{ hidden: !fileBrowserVisible() }}
                            inert={!fileBrowserVisible() || undefined}
                          >
                            <SessionFileBrowserTab
                              tab={browserTab() ?? activeFileTab() ?? ""}
                              placeholder={!browserTab() && !activeFileTab()}
                              active={file.pathFromTab(browserTab() ?? activeFileTab() ?? "")}
                              kinds={kinds()}
                              state={props.fileBrowserState!}
                              onSelect={(path) => previewTab(file.tab(path))}
                              onSelectPermanent={(path) => openTab(file.tab(path))}
                              filterRef={(element) => (fileFilter = element)}
                            />
                          </div>
                        </Show>
                      </Tabs>
                    </DndKitProvider>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={fileOpen()}>
              <div
                id="file-tree-panel"
                class="relative min-w-0 h-full shrink-0 overflow-hidden"
                classList={{
                  "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
                    !props.size.active(),
                }}
                style={{ width: treeWidth() }}
              >
                <div
                  class="h-full flex flex-col overflow-hidden group/filetree bg-background-stronger px-3"
                  classList={{ "border-l border-border-weaker-base": tabsOpen() }}
                >
                  <Tabs
                    variant="pill"
                    value={fileTreeTab()}
                    onChange={setFileTreeTabValue}
                    class="h-full"
                    data-scope="filetree"
                  >
                    <Tabs.List>
                      <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                        <Show
                          when={settings.general.newLayoutDesigns()}
                          fallback={
                            <>
                              {props.reviewCount()}{" "}
                              {language.t(
                                props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                              )}
                            </>
                          }
                        >
                          {"Files Changed"}
                        </Show>
                      </Tabs.Trigger>
                      <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                        {language.t("session.files.all")}
                      </Tabs.Trigger>
                    </Tabs.List>
                    <Show when={fileTreeTab() === "changes"}>
                      <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={props.hasReview() || !props.diffsReady()}>
                            <Show
                              when={props.diffsReady()}
                              fallback={
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </div>
                              }
                            >
                              <FileTree
                                path=""
                                class="pt-3"
                                allowed={diffFiles()}
                                kinds={kinds()}
                                draggable={false}
                                active={props.activeDiff}
                                onFileClick={(node) => props.focusReviewDiff(node.path)}
                              />
                            </Show>
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Show>
                    <Show when={fileTreeTab() === "all"}>
                      <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                          <Match when={true}>
                            <FileTree
                              path=""
                              class="pt-3"
                              modified={diffFiles()}
                              kinds={kinds()}
                              onFileClick={(node) => openTab(file.tab(node.path))}
                            />
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Show>
                  </Tabs>
                </div>
                <Show when={fileOpen()}>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={fileTreeWidth()}
                      min={FILE_TREE_WIDTH_MIN}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        layout.fileTree.resize(width)
                      }}
                    />
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
