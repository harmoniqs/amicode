import type { FilePart, Project, SnapshotFileDiff, UserMessage } from "@opencode-ai/sdk/v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createQuery, keepPreviousData, skipToken, useMutation } from "@tanstack/solid-query"
import {
  batch,
  ErrorBoundary,
  onCleanup,
  Suspense,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  createSignal,
  on,
  onMount,
  type ParentProps,
  untrack,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { useLocal } from "@/context/local"
import { FileProvider, selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import type { SessionReviewLineComment } from "@opencode-ai/session-ui/session-review"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner } from "@opencode-ai/ui/scroll-view"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { createAutoScroll } from "@opencode-ai/ui/hooks"
import { previewSelectedLines } from "@opencode-ai/session-ui/pierre/selection-bridge"
import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@/utils/toast"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { NewSessionView, SessionHeader } from "@/components/session"
import { ContextWarningBanner } from "@/components/session/context-warning-banner"
import { ErrorPage } from "@/pages/error"
import { CommentsProvider, useComments } from "@/context/comments"
import { useCommand } from "@/context/command"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { useNotification } from "@/context/notification"
import { PromptProvider, usePrompt } from "@/context/prompt"
import { usePlatform } from "@/context/platform"
import { SDKProvider, useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { TerminalProvider, useTerminal } from "@/context/terminal"
import { PromptInput } from "@/components/prompt-input"
import { PromptInputV2Composer, usePromptInputV2Controller } from "@/components/prompt-input-v2"
import { useSettingsCommand } from "@/components/settings-dialog"
import { setCursorPosition } from "@/components/prompt-input/editor-dom"
import { promptLength } from "@/components/prompt-input/history"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import {
  createPromptInputController,
  createSessionComposerController,
  createSessionComposerRegionController,
  SessionComposerRegion,
} from "@/pages/session/composer"
import { createOpenReviewFile, createSessionTabs, createSizing, shouldShowFileTree } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/timeline/message-timeline"
import { createTimelineModel } from "@/pages/session/timeline/model"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { restorePromptModel, syncPromptModel, syncSessionModel } from "@/pages/session/session-model-helpers"
import {
  clampSessionPanelWidth,
  clampWorkColumnWidth,
  SESSION_PANEL_WIDTH_MIN,
  sessionChatTakesRemainder,
  sessionPanelWidthMax,
  WORK_COLUMN_WIDTH_MIN,
  workColumnWidthMax,
} from "@/pages/session/session-panel-width"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { sessionPanelLayout } from "@/pages/session/session-panel-layout"
import { SessionReviewEmptyChangesV2 } from "@opencode-ai/session-ui/v2/session-review-empty-changes-v2"
import { ReviewPanelV2 } from "@/pages/session/v2/review-panel-v2"
import { createReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"
import { accumulateDiffs } from "@/pages/session/v2/accumulate-diffs"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { TerminalPanelV2 } from "@/pages/session/terminal-panel-v2"
import { useComposerCommands } from "@/pages/session/use-composer-commands"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useAmicodeCommands } from "@/pages/session/use-amicode-commands"
import { InspectorProvider } from "@/amicode/inspector/inspector-context"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { Identifier } from "@/utils/id"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { authTokenFromCredentials } from "@/utils/server"
import { formatServerError, isLocalSessionNotFoundError, isSessionNotFoundError } from "@/utils/server-errors"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { postRouteInfo } from "@/utils/amicode-route-info"
import { notifyProjectSelected } from "@/utils/amicode-workspace-projects"
import { setSessionCopyProvider } from "@/utils/global-clipboard"
import { serializeSession } from "@/utils/serialize-session"
import { useUsageExceededDialogs } from "./session/usage-exceeded-dialogs"
import { createSessionOwnership } from "./session/session-ownership"
import { createSessionLineage } from "./session/session-lineage"

type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

const sessionViewState = () => ({
  messageId: undefined as string | undefined,
  mobileTab: "session" as "session" | "changes",
})

function isCurrentSessionNotFoundError(error: unknown, sessionID: string | undefined) {
  if (!sessionID) return false
  return isSessionNotFoundError(error, sessionID) || isLocalSessionNotFoundError(error, sessionID)
}

async function runPromptRollbackMutation<T, R>(input: {
  capturePrompt: () => { current: () => T[]; set: (value: T[]) => void; reset: () => void }
  optimistic: (prompt: { set: (value: T[]) => void; reset: () => void }) => void
  request: () => Promise<R>
  complete: (result: R) => void
  rollback: () => void
  fail: (error: unknown) => void
}) {
  const prompt = input.capturePrompt()
  const previous = prompt.current().slice()
  batch(() => input.optimistic(prompt))
  await input
    .request()
    .then(input.complete)
    .catch((error) => {
      batch(() => {
        input.rollback()
        prompt.set(previous)
      })
      input.fail(error)
    })
}

export function SessionPage() {
  return (
    <SessionProviders>
      <Page />
    </SessionProviders>
  )
}

// Rendered under app.tsx's TargetSessionRoute, which owns the per-server keyed
// remount around the server-scoped providers. Nothing here may key on the
// session ID: session tabs on the same server share this route instance, and
// workspace-scoped state (terminal, directory providers) lives below.
export function TargetSessionRouteContent() {
  const params = useParams<{ serverKey: string; id: string }>()
  const serverSync = useServerSync()
  const directory = createMemo(() => serverSync().session.lineage.peek(params.id)?.session.directory)
  return (
    // Settings must keep the target-server SDK, sync, and models context and remain registered
    // when session content falls back to the route error boundary.
    <TargetServerScopedProviders directory={directory} sessionID={() => params.id}>
      <TargetSessionSettingsCommand />
      <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)} padded>
        <ResolvedTargetSessionRoute />
      </SessionRouteErrorBoundary>
    </TargetServerScopedProviders>
  )
}

function TargetSessionSettingsCommand() {
  useSettingsCommand()
  return null
}

export function SessionRouteErrorBoundary(
  props: ParentProps<{ sessionID?: string; serverKey?: ServerConnection.Key; padded?: boolean }>,
) {
  const settings = useSettings()
  return (
    <ErrorBoundary
      fallback={(error) =>
        settings.general.newLayoutDesigns() ? (
          <SessionRouteFrame padded={props.padded}>
            <SessionPanelFrame newLayout raised={!!props.sessionID}>
              <SessionErrorFallback error={error} sessionID={props.sessionID} serverKey={props.serverKey} />
            </SessionPanelFrame>
          </SessionRouteFrame>
        ) : (
          <ErrorPage error={error} />
        )
      }
    >
      {props.children}
    </ErrorBoundary>
  )
}

function SessionErrorFallback(props: { error: unknown; sessionID?: string; serverKey?: ServerConnection.Key }) {
  const language = useLanguage()
  const server = useServer()
  const tabs = useTabs()
  const displayServer = createMemo(() => {
    const key = props.serverKey ?? server.key
    const conn = server.list.find((item) => ServerConnection.key(item) === key)
    return conn ? serverName(conn) : key
  })
  const closeTab = () => {
    if (!props.sessionID) return
    tabs.removeSessionTab({ server: props.serverKey ?? server.key, sessionId: props.sessionID })
  }
  if (isCurrentSessionNotFoundError(props.error, props.sessionID)) {
    return (
      <div class="flex-1 min-h-0 overflow-hidden">
        <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-4">
          <div class="flex flex-col items-center gap-2">
            <div class="text-16-medium text-text max-w-md">{language.t("session.error.notFound")}</div>
            <div class="text-13-regular text-text-weak max-w-md">
              {language.t("session.error.notFound.description")}
            </div>
          </div>
          <Show when={props.sessionID}>
            {(sessionID) => (
              <div class="max-w-full flex flex-col items-center gap-1">
                <div class="max-w-full text-11-regular text-text-faint break-all">{displayServer()}</div>
                <code class="max-w-full rounded-sm px-1 py-0.5 font-mono text-xs font-medium leading-4 text-text-base break-all bg-[color-mix(in_oklch,var(--v2-text-text-base)_8%,transparent)]">
                  {sessionID()}
                </code>
              </div>
            )}
          </Show>
          <ButtonV2 variant="neutral" size="normal" icon="xmark-small" onClick={closeTab}>
            {language.t("session.error.notFound.closeTab")}
          </ButtonV2>
        </div>
      </div>
    )
  }
  return <ErrorPage error={props.error} />
}

function ResolvedTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  const tabs = useTabs()
  const sync = useServerSync()
  const serverKey = createMemo(() => requireServerKey(params.serverKey))
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )
  const directory = createMemo(() => current()?.session.directory)
  const targetDirectory = () => directory()!

  createEffect(() => {
    const session = current()
    if (!session) return
    tabs.addSessionTab({
      server: serverKey(),
      sessionId: session.root.id,
    })
  })

  // Notify the extension which project this session is bound to so the
  // sidebar highlight tracks the active tab. autoExpand=false: session
  // navigation should only change the highlight, never toggle folder state.
  createEffect(() => {
    const dir = directory()
    if (dir) notifyProjectSelected(dir, false)
  })

  return (
    // Non-keyed: closes only while the target's directory is unknown (uncached
    // lineage mid-resolution), which tears down the workspace subtree including
    // the terminal. Same-workspace tab switches keep it open because warm
    // targets resolve synchronously from the sync cache.
    <Show when={directory()}>
      <SDKProvider directory={targetDirectory}>
        <DirectoryDataProvider directory={targetDirectory} server={serverKey}>
          <TargetSessionPage />
        </DirectoryDataProvider>
      </SDKProvider>
    </Show>
  )
}

// Owns the workspace-identity remount. Must not include the session ID in the
// key: SessionPage handles session changes reactively, and remounting here
// destroys workspace-scoped state (terminal PTYs, file/prompt providers).
function TargetSessionPage() {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  return (
    <Show when={`${serverSDK().scope}\0${sdk().directory}`} keyed>
      <SessionPage />
    </Show>
  )
}

function TargetServerScopedProviders(
  props: ParentProps<{ directory?: () => string | undefined; sessionID?: () => string | undefined }>,
) {
  return (
    <>
      <MarkSessionNotificationsViewed sessionID={props.sessionID} />
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </>
  )
}

function MarkSessionNotificationsViewed(props: { sessionID?: () => string | undefined }) {
  const notification = useNotification()
  createEffect(() => {
    const sessionID = props.sessionID?.()
    if (!notification.ready() || !sessionID) return
    if (notification.session.unseenCount(sessionID) === 0) return
    notification.session.markViewed(sessionID)
  })
  return null
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>
            <InspectorProvider>{props.children}</InspectorProvider>
          </CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

function SessionRouteFrame(props: ParentProps<{ padded?: boolean }>) {
  return (
    <div class="relative size-full overflow-hidden flex flex-col" classList={{ "p-2": props.padded }}>
      {props.children}
    </div>
  )
}

function SessionPanelFrame(props: ParentProps<{ newLayout: boolean; raised?: boolean }>) {
  return (
    <div
      classList={{
        "flex-1 min-h-0 flex flex-col": true,
        "bg-v2-background-bg-base": props.newLayout,
        "bg-background-stronger": !props.newLayout,
        "rounded-md overflow-hidden": props.newLayout,
        "shadow-[var(--v2-elevation-raised)]": props.newLayout && props.raised,
      }}
    >
      {props.children}
    </div>
  )
}

export default function Page() {
  const serverSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const settings = useSettings()
  const platform = usePlatform()
  const prompt = usePrompt()
  const comments = useComments()
  const command = useCommand()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey, workspaceKey, tabs, view } = useSessionLayout()
  const reviewFile = () => view().review.file()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const newSessionDesign = createMemo(() => settings.general.newLayoutDesigns())

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerController()
  const inputController = createPromptInputController({
    sessionKey,
    sessionID: () => params.id,
    queryOptions: serverSync().queryOptions,
  })

  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))
  const sessionPanelKey = createMemo(() => (params.id ? `${serverSDK().scope}\0${params.id}` : undefined))

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }
        if (pending.scope !== serverSDK().scope) return

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== base64Encode(sdk().directory)) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const desktopV2ReviewOpen = createMemo(() => newSessionDesign() && desktopReviewOpen() && !!params.id)
  const terminalOpen = createMemo(() => view().terminal.opened())
  const desktopTerminalOpen = createMemo(() => isDesktop() && terminalOpen())
  const desktopInlineTerminalOnlyOpen = createMemo(
    () => newSessionDesign() && desktopTerminalOpen() && !desktopV2ReviewOpen(),
  )
  const desktopFileTreeOpen = createMemo(
    () =>
      isDesktop() &&
      shouldShowFileTree({
        visible: settings.visibility.fileTree(),
        opened: layout.fileTree.opened(),
      }),
  )
  const desktopSessionResizeOpen = createMemo(() =>
    newSessionDesign() ? desktopV2ReviewOpen() || desktopTerminalOpen() : desktopReviewOpen(),
  )
  const desktopSidePanelOpen = createMemo(() => desktopSessionResizeOpen() || desktopFileTreeOpen())
  let panelRow: HTMLDivElement | undefined
  const [panelRowWidth, setPanelRowWidth] = createSignal<number>()
  createResizeObserver(
    () => panelRow,
    ({ width }) => setPanelRowWidth(width),
  )
  const splitReview = createMemo(
    () => (newSessionDesign() ? desktopV2ReviewOpen() : desktopReviewOpen()) && layout.review.diffStyle() === "split",
  )
  // The observer reports the content-box width, which already excludes the row
  // padding; only the flex gap between the panels remains to subtract.
  const sessionPanelAvailable = createMemo(() => {
    const width = panelRowWidth()
    if (width === undefined) return undefined
    return width - (settings.general.newLayoutDesigns() ? 8 : 0)
  })
  const sessionPanelMax = createMemo(() => {
    const available = sessionPanelAvailable()
    if (available === undefined) return 1000
    return sessionPanelWidthMax({ available, split: splitReview() })
  })
  // Clamp at render time so window or sidebar resizes squeeze the chat panel
  // instead of the review pane, without overwriting the persisted width.
  const sessionPanelResizedWidth = createMemo(() =>
    clampSessionPanelWidth({
      width: layout.session.width(),
      available: sessionPanelAvailable(),
      split: splitReview(),
    }),
  )
  const centered = createMemo(() => isDesktop() && (newSessionDesign() || !desktopReviewOpen()))
  const desktopV2PanelLayout = createMemo(() =>
    sessionPanelLayout({
      review: desktopV2ReviewOpen(),
      terminal: desktopTerminalOpen(),
      files: desktopFileTreeOpen(),
    }),
  )
  // amicode#105: in v2 the WORK COLUMN owns a bounded width (default 320,
  // user-resizable) and the CHAT is the flex remainder — the pre-fix layout
  // gave the review pane whatever the chat left behind, squishing the chat
  // into the margin on wide monitors. (After desktopV2PanelLayout — createMemo
  // evaluates eagerly, so order is load-bearing.)
  const chatTakesRemainder = createMemo(() =>
    sessionChatTakesRemainder({ newDesign: newSessionDesign(), columnVisible: isDesktop() && desktopV2PanelLayout().visible }),
  )
  const workColumnWidth = createMemo(() =>
    clampWorkColumnWidth({ width: layout.panelColumn.width(), available: sessionPanelAvailable() }),
  )
  const sessionPanelWidth = createMemo(() => {
    if (chatTakesRemainder()) return undefined
    if (!desktopSidePanelOpen()) return "100%"
    if (desktopSessionResizeOpen()) return `${sessionPanelResizedWidth()}px`
    return `calc(100% - ${layout.fileTree.width()}px)`
  })

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  // amicode(deck): report the live route + session title to a framing host —
  // path immediately (so a dragged pane rebuilds HERE), title once the session
  // record lands (its async summarize may follow it in).
  createEffect(() => {
    if (!params.id) return
    postRouteInfo(`${location.pathname}${location.search}`, info()?.title)
  })
  const canReview = createMemo(() => !!sync().project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const timeline = createTimelineModel({ sessionID: () => params.id, revertMessageID })
  const historyLoading = timeline.history.loading
  const historyMore = timeline.history.more
  const lastUserMessage = timeline.lastUserMessage
  const messages = timeline.messages
  const messagesReady = timeline.ready
  const sessionSync = timeline.resource
  const userMessages = timeline.userMessages
  const visibleUserMessages = timeline.visibleUserMessages

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  let restoredModelSession: string | undefined
  createEffect(() => {
    const id = params.id
    if (!id || !prompt.ready() || !local.session.ready()) return
    if (restoredModelSession !== id) {
      restoredModelSession = id
      if (restorePromptModel(local, prompt)) return
    }
    syncPromptModel(local, prompt)
  })

  createEffect(
    on(
      () => ({ dir: sdk().directory, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    ...sessionViewState(),
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.serverWorkspace(serverSDK().scope, sdk().directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      const owner = sessionOwnership.capture()
      requestAnimationFrame(() => {
        setTimeout(() => owner.run(() => setStore("deferRender", false)), 0)
      })
    }
    return key
  })

  let reviewFrame: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])
  // Refetch when the session transitions to idle (assistant finished, snapshot taken)
  // or when a file-editing tool completes mid-turn (diff_version bumps)
  const sessionDiffVersion = () => {
    const id = params.id
    const status = id ? sync().data.session_status[id]?.type ?? "idle" : "idle"
    const version = id ? sync().data.diff_version[id] ?? 0 : 0
    return `${status}:${version}`
  }
  const sessionDiffKey = () => ["session-diff", params.id ?? "", sessionDiffVersion()] as const
  const sessionDiffQuery = createQuery(() => {
    const sessionID = params.id
    return {
      queryKey: sessionDiffKey(),
      enabled: !!sessionID,
      placeholderData: keepPreviousData,
      queryFn: sessionID
        ? () =>
            sdk()
              .client.session.diff({ sessionID, directory: sdk().directory })
              .then((result) => (result.data ?? []) as Array<SnapshotFileDiff>)
              .catch(() => [] as SnapshotFileDiff[])
        : skipToken,
    }
  })
  const reviewDiffs = createMemo(() => {
    // Server endpoint returns the authoritative full-session diff (queries all messages).
    const serverDiffs = sessionDiffQuery.data ?? []
    // Once the server has responded at least once, trust it — even if it returned [].
    // The client-side fallback is only for the initial load before any server response,
    // never during refetches (where keepPreviousData already preserves the last result).
    const serverResponded = sessionDiffQuery.status === "success" || sessionDiffQuery.isPlaceholderData
    if (serverDiffs.length > 0 || serverResponded) {
      // Server paths are relative to the project root — prefix with ~/project-path
      const dir = sdk().directory
      const home = typeof globalThis.process !== "undefined" ? globalThis.process.env?.HOME : undefined
      const prefix = home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
      return serverDiffs
        .filter((d): d is SnapshotFileDiff & { file: string } => !!d.file)
        .map((d) => ({ ...d, file: d.file.startsWith("/") || d.file.startsWith("~/") ? d.file : `${prefix}/${d.file}` }))
    }
    // Fallback: derive from tool parts currently loaded in the client.
    // This shows immediate results for visible messages while the server query loads.
    const allMessages = messages()
    if (!allMessages.length) return [] as Array<SnapshotFileDiff & { file: string }>
    const dir = sdk().directory
    const home = typeof globalThis.process !== "undefined" ? globalThis.process.env?.HOME : undefined
    const prefix = home && dir.startsWith(home) ? "~" + dir.slice(home.length) : dir
    const toHomePath = (p: string) => {
      if (p.startsWith("~/")) return p
      if (home && p.startsWith(home)) return "~" + p.slice(home.length)
      if (!p.startsWith("/")) return `${prefix}/${p}`
      return p
    }
    const editParts: import("@/pages/session/v2/accumulate-diffs").ToolEditPart[] = []
    for (const msg of allMessages) {
      const msgParts = sync().data.part[msg.id]
      if (!msgParts) continue
      for (const part of msgParts) {
        if (part.type !== "tool" || !EDIT_TOOLS.has(part.tool)) continue
        if (part.state.status !== "completed") continue
        const meta = part.state.metadata as Record<string, unknown> | undefined
        const filediff = meta?.filediff as { file?: string; patch?: string; additions?: number; deletions?: number } | undefined
        if (filediff?.file) {
          const rawTitle = (part.state as { title?: string }).title || filediff.file
          editParts.push({
            file: filediff.file,
            title: toHomePath(rawTitle),
            patch: filediff.patch,
            additions: filediff.additions ?? 0,
            deletions: filediff.deletions ?? 0,
          })
        }
      }
    }
    return accumulateDiffs(editParts)
  })

  // All files touched by edit tools in this session — fetched from the server
  // which scans ALL messages regardless of client-side pagination.
  const touchedFilesQuery = createQuery(() => {
    const sessionID = params.id
    return {
      queryKey: ["session-touched-files", sessionID ?? "", sessionDiffVersion()] as const,
      enabled: !!sessionID,
      placeholderData: keepPreviousData,
      staleTime: 30_000,
      queryFn: sessionID
        ? async () => {
            const server = serverSDK()
            const url = new URL(`/session/${sessionID}/touched-files`, server.url)
            url.searchParams.set("directory", sdk().directory)
            const headers: Record<string, string> = {}
            const httpServer = server.server.http
            if (httpServer.password) {
              headers.Authorization = `Basic ${authTokenFromCredentials({ username: httpServer.username, password: httpServer.password })}`
            }
            const res = await fetch(url.toString(), { headers })
            if (!res.ok) return [] as Array<{ file: string; status: string }>
            return (await res.json()) as Array<{ file: string; status: string }>
          }
        : skipToken,
    }
  })
  const touchedFiles = createMemo(() => {
    const serverFiles = touchedFilesQuery.data ?? []
    if (serverFiles.length > 0) {
      // Keep absolute paths from the server — the file read endpoint handles them directly.
      // Do NOT normalize to ~/ (the webview can't reliably resolve ~ back to $HOME).
      return serverFiles.map((f) => ({ file: f.file, status: f.status }))
    }
    // Fallback: derive from loaded tool parts (covers live edits before server catches up)
    const allMessages = messages()
    if (!allMessages.length) return [] as Array<{ file: string; status: string }>
    const seen = new Map<string, string>()
    for (const msg of allMessages) {
      const msgParts = sync().data.part[msg.id]
      if (!msgParts) continue
      for (const part of msgParts) {
        if (part.type !== "tool" || !EDIT_TOOLS.has(part.tool)) continue
        if (part.state.status !== "completed") continue
        const meta = part.state.metadata as Record<string, unknown> | undefined
        const filediff = meta?.filediff as { file?: string } | undefined
        if (filediff?.file) {
          if (!seen.has(filediff.file)) {
            seen.set(filediff.file, part.tool === "write" ? "added" : "modified")
          }
        }
      }
    }
    return Array.from(seen, ([file, status]) => ({ file, status }))
  })

  const activeReviewFile = () => {
    const diffs = reviewDiffs()
    const selected = reviewFile()
    if (selected && diffs.some((diff) => diff.file === selected)) return selected
    return diffs[0]?.file
  }
  const reviewCount = () => reviewDiffs().length
  const hasReview = () => true
  const reviewReady = () => true
  const loadReviewDiff = async (file: string, _version?: number): Promise<(SnapshotFileDiff & { file: string }) | undefined> => {
    const diffs = reviewDiffs()
    const found = diffs.find((d) => d.file === file)
    if (found && found.file) return found as SnapshotFileDiff & { file: string }
    return undefined
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync().project
    if (project && sdk().directory !== project.worktree) return sdk().directory
    return "main"
  })

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    setStore("messageId", message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = () => {
    const root = scroller
    if (!root) return store.messageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? store.messageId
  }

  function navigateMessageByOffset(offset: number) {
    const msgs = visibleUserMessages()
    if (msgs.length === 0) return

    const current = store.messageId && messageMark === scrollMark ? store.messageId : cursor()
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      resumeScroll()
      return
    }

    autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  function upsert(next: Project) {
    const list = serverSync().data.project
    sync().set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      serverSync().set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      serverSync().set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    serverSync().set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk().client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  let scrollToEnd = () => {}
  let scrollMark = 0
  let messageMark = 0

  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk().directory,
          id,
          id ? (sync().data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync().data.todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk().directory !== dir || params.id !== id) return
            untrack(() => {
              void sync().session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore(sessionViewState())
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  // Bump diff_version when the watcher reports external changes to files in the
  // current session's worktree (#743). Debounced: 1s trailing-edge per session.
  let watcherDebounce: ReturnType<typeof setTimeout> | undefined
  const stopVcs = sdk().event.listen((evt) => {
    const details = evt.details as { type: string; properties?: unknown }
    if (details.type !== "file.watcher.updated" && details.type !== "filesystem.changed") return
    const props =
      typeof details.properties === "object" && details.properties
        ? (details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    const id = params.id
    if (!id) return
    if (watcherDebounce !== undefined) clearTimeout(watcherDebounce)
    watcherDebounce = setTimeout(() => {
      watcherDebounce = undefined
      sync().set("diff_version", id, (v: number | undefined) => (v ?? 0) + 1)
    }, 1000)
  })
  onCleanup(() => {
    stopVcs()
    if (watcherDebounce !== undefined) clearTimeout(watcherDebounce)
  })

  createEffect(
    on(
      () => sdk().directory,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const isEditableTarget = (target: EventTarget | null | undefined) => {
    if (!(target instanceof HTMLElement)) return false
    return /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable
  }

  const deepActiveElement = () => {
    let current: Element | null = document.activeElement
    while (current instanceof HTMLElement && current.shadowRoot?.activeElement) {
      current = current.shadowRoot.activeElement
    }
    return current instanceof HTMLElement ? current : undefined
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const path = event.composedPath()
    const target = path.find((item): item is HTMLElement => item instanceof HTMLElement)
    const activeElement = deepActiveElement()

    const protectedTarget = path.some(
      (item) => item instanceof HTMLElement && item.closest("[data-prevent-autofocus]") !== null,
    )
    if (protectedTarget || isEditableTarget(target)) return

    if (activeElement) {
      const isProtected = activeElement.closest("[data-prevent-autofocus]")
      const isInput = isEditableTarget(activeElement)
      if (isProtected || isInput) return
    }
    if (dialog.active) return

    if (activeElement === inputRef) {
      if (event.key === "Escape") inputRef?.blur()
      return
    }

    const key = scrollKey(event)
    if (key) {
      if (!scroller || !isScrollKeyTarget(target ?? null, key)) return
      if (scrollKeyOwner(scroller, target ?? null, key) !== scroller) return
      markScrollGesture(scroller)
      return
    }

    if (event.key.length === 1 && event.key !== "Unidentified" && !(event.ctrlKey || event.metaKey)) {
      if (composer.blocked() || isChildSession()) return
      const input = inputRef
      if (!input) return
      input.focus()
      setCursorPosition(input, prompt.cursor() ?? promptLength(prompt.current()))
    }
  }

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useComposerCommands()
  useSessionCommands({
    navigateMessageByOffset,
    setActiveMessage,
    focusInput,
    review: reviewTab,
    fileBrowser: () => newSessionDesign() && isDesktop() && !!params.id,
  })
  useAmicodeCommands()
  command.register("session-palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: () => command.trigger("file.open", "palette"),
    },
  ])

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => null

  const changesTitleV2 = () => null

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const createGit = (input: { emptyClass: string }) => (
    <div class={input.emptyClass}>
      <div class="flex flex-col gap-3">
        <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
        <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
          {language.t("session.review.noVcs.createGit.description")}
        </div>
      </div>
      <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
        {gitMutation.isPending
          ? language.t("session.review.noVcs.createGit.actionLoading")
          : language.t("session.review.noVcs.createGit.action")}
      </Button>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
    return empty(reviewEmptyText())
  }

  const reviewEmptyV2 = () => {
    if (!reviewReady()) {
      return <div class="px-6 py-4 text-text-weak">{language.t("session.review.loadingChanges")}</div>
    }
    return <SessionReviewEmptyChangesV2 />
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={activeReviewFile()}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewV2State = createReviewPanelV2State()

  // Getters defer reactive reads to the consuming scope. Eager reads here ran inside
  // the side panel's Show children and remounted the whole review panel on unrelated
  // updates such as session switches.
  const reviewPanelV2Props = () => ({
    get title() {
      return changesTitleV2()
    },
    get empty() {
      return reviewEmptyV2()
    },
    diffs: reviewDiffs,
    diffsReady: reviewReady,
    get diffVersion() {
      return lastUserMessage()?.time.created
    },
    loadDiff: loadReviewDiff,
    get activeFile() {
      return activeReviewFile()
    },
    onSelectFile: focusReviewDiff,
    get diffStyle() {
      return layout.review.diffStyle()
    },
    onDiffStyleChange: layout.review.setDiffStyle,
    state: reviewV2State,
    onRefresh: () => {
      const id = params.id
      if (id) sync().set("diff_version", id, (v: number | undefined) => (v ?? 0) + 1)
    },
    onLineComment: (comment: SessionReviewLineComment) => addCommentToContext({ ...comment, origin: "review" }),
    onLineCommentUpdate: updateCommentInContext,
    onLineCommentDelete: removeCommentFromContext,
    get lineCommentActions() {
      return reviewCommentActions()
    },
    get comments() {
      return comments.all()
    },
    get focusedComment() {
      return comments.focus()
    },
    onFocusedCommentChange: (focus: { file: string; id: string } | null) => {
      // The preview clears the focus once it has opened the comment; persist the
      // focused file as the active selection so the preview stays on it. Skip
      // files outside the current diff set (their focus is cleared unhandled).
      if (!focus) {
        const current = comments.focus()
        if (current && reviewDiffs().some((diff) => diff.file === current.file)) focusReviewDiff(current.file)
      }
      comments.setFocus(focus)
    },
  })

  // Latch: defer only the first diff render off the mount critical path. This Page
  // stays mounted across same-workspace session tab switches, so gating on every
  // deferRender flip tore down and remounted the whole review pane on tab switch.
  const reviewPanelV2Rendered = createMemo<boolean>((prev) => prev || !store.deferRender, false)

  const reviewPanelV2 = () => (
    <div class="flex flex-col h-full overflow-hidden bg-v2-background-bg-base contain-strict">
      <Show when={reviewPanelV2Rendered()}>
        <ReviewPanelV2 {...reviewPanelV2Props()} />
      </Show>
    </div>
  )

  const reviewPanel = () => (
    <div
      classList={{
        "flex flex-col h-full overflow-hidden contain-strict": true,
        "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
        "bg-background-stronger": !settings.general.newLayoutDesigns(),
      }}
    >
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const reviewDiffId = (path: string) => {
    const sum = checksum(path)
    if (!sum) return
    return `session-review-diff-${sum}`
  }

  const reviewDiffTop = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return

    const id = reviewDiffId(path)
    if (!id) return

    const el = document.getElementById(id)
    if (!(el instanceof HTMLElement)) return
    if (!root.contains(el)) return

    const a = el.getBoundingClientRect()
    const b = root.getBoundingClientRect()
    return a.top - b.top + root.scrollTop
  }

  const scrollToReviewDiff = (path: string) => {
    const root = tree.reviewScroll
    if (!root) return false

    const top = reviewDiffTop(path)
    if (top === undefined) return false

    view().setScroll("review", { x: root.scrollLeft, y: top })
    root.scrollTo({ top, behavior: "auto" })
    return true
  }

  const focusReviewDiff = (path: string) => {
    openReviewPanel()
    view().review.openPath(path)
    view().review.setFile(path)
    setTree("pendingDiff", path)
  }

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk().directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync().status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk().directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  // Only follow the bottom while the model is actually streaming. This was
  // previously hard-coded to `true`, so the auto-scroller's ResizeObserver
  // force-scrolled on *any* reflow (image load, tool accordion expand, font
  // swap, layout settle) — which read as the chat "jumping" on its own. Gating
  // it on the session's real working state also stops it from competing with
  // the timeline's own bottom-lock outside of streaming.
  const autoScroll = createAutoScroll({
    // amicode: only follow the bottom while the model is actually streaming —
    // `true` force-scrolled on ANY reflow (the chat-jitter fix, ac8246e97)
    working: () => {
      const id = params.id
      return id ? sync().data.session_working(id) : false
    },
    overflowAnchor: "dynamic",
  })
  createEffect(
    on(
      () => params.id,
      (id, previous) => {
        if (!id || !previous || id === previous) return
        if (location.hash || store.messageId || ui.pendingMessage) return
        autoScroll.resume()
      },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  const resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.resume()
    scrollToEnd()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = () => {
    scrollMark += 1
  }

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  let captureHistoryAnchor = () => {}
  let restoreHistoryAnchor = (_done: boolean) => {}
  const historyRequests = new Set<string>()
  let historyContinuationFrame: number | undefined
  const loadOlder = async () => {
    const owner = sessionOwnership.capture()
    if (historyLoading() || historyRequests.has(owner.key)) return
    historyRequests.add(owner.key)
    const before = timeline.messages().length
    try {
      await timeline.history.loadOlder({
        before: () => owner.run(captureHistoryAnchor),
        after: (done) => owner.run(() => restoreHistoryAnchor(done)),
      })
    } finally {
      historyRequests.delete(owner.key)
    }
    if (!owner.current() || timeline.messages().length <= before) return
    if (!autoScroll.userScrolled() || !scroller || scroller.scrollTop >= 200 || !historyMore()) return
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
    historyContinuationFrame = requestAnimationFrame(() => {
      historyContinuationFrame = undefined
      owner.run(onHistoryScroll)
    })
  }
  const onHistoryScroll = () => {
    if (
      historyRequests.has(sessionOwnership.key()) ||
      historyLoading() ||
      !autoScroll.userScrolled() ||
      !scroller ||
      scroller.scrollTop >= 200
    )
      return
    void loadOlder()
  }

  onCleanup(() => {
    if (historyContinuationFrame !== undefined) cancelAnimationFrame(historyContinuationFrame)
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void loadOlder()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync().data.part[id] ?? [], {
      directory: sdk().directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>, target = sync()) => target.session.remember(next)

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"], target = sync()) => {
    const session = target.session.get(sessionID)
    if (!session) return
    target.session.remember({ ...session, revert: next })
  }

  const busy = (sessionID: string) => sync().data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const owner = sessionOwnership.capture()
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        api: sdk().api.session,
        sync: sync(),
        serverSync: serverSync(),
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk().directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) owner.run(resumeScroll)
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked() && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync().session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID)
      ? sdk()
          .api.session.interrupt({ sessionID })
          .catch(() => {})
      : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const session = sdk().api.session
      const target = sync()
      const last = target.session.get(input.sessionID)?.revert
      const value = draft(input.messageID)
      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (prompt) => {
          roll(input.sessionID, { messageID: input.messageID }, target)
          prompt.set(value)
        },
        request: () => halt(input.sessionID).then(() => session.revert.stage(input)),
        complete: () => undefined,
        rollback: () => roll(input.sessionID, last, target),
        fail,
      })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const session = sdk().api.session
      const target = sync()
      const next = userMessages().find((item) => item.id > id)
      const last = target.session.get(sessionID)?.revert

      await runPromptRollbackMutation({
        capturePrompt: prompt.capture,
        optimistic: (promptSession) => {
          roll(sessionID, next ? { messageID: next.id } : undefined, target)
          if (next) {
            promptSession.set(draft(next.id))
            return
          }
          promptSession.reset()
        },
        request: () =>
          !next
            ? halt(sessionID).then(() => session.revert.clear({ sessionID }))
            : halt(sessionID).then(() => session.revert.stage({ sessionID, messageID: next.id }).then(() => undefined)),
        complete: () => undefined,
        rollback: () => roll(sessionID, last, target),
        fail,
      })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  // attachment bytes are embedded as a data URL, so downloading always works;
  // revealing requires the on-disk path captured by the client that attached the file
  const openAttachment = (file: FilePart) => {
    const download = () => {
      const anchor = document.createElement("a")
      anchor.href = file.url
      anchor.download = getFilename(file.filename) || "attachment"
      anchor.click()
    }
    const path = file.filename ?? ""
    const absolute = path.startsWith("/") || path.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(path)
    if (platform.revealPath && absolute) {
      void platform.revealPath(path).then(
        (revealed) => {
          if (!revealed) download()
        },
        () => download(),
      )
      return
    }
    download()
  }

  const actions = { revert, openAttachment }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (isChildSession()) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) scrollToEnd()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage,
    autoScroll: {
      pause: autoScroll.pause,
      forceScrollToBottom: () => {
        autoScroll.resume()
        scrollToEnd()
      },
    },
    scroller: () => scroller,
    anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  // Register the session copy provider so Cmd+A → Cmd+C copies the full
  // session from the data model (not limited by DOM virtualization).
  setSessionCopyProvider(() => {
    const id = params.id
    if (!id) return ""
    const messages = sync().data.message[id] ?? []
    return serializeSession(messages, (msgId) => sync().data.part[msgId] ?? [])
  })
  onCleanup(() => setSessionCopyProvider(undefined))

  onCleanup(() => {
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  useUsageExceededDialogs()

  const mobileTabs = (compact = false, bottom = false) => (
    <Tabs value={store.mobileTab} class="h-auto">
      <Tabs.List
        classList={{
          "!h-9": compact,
          "[&::after]:!border-b-0 [&::after]:!border-t [&::after]:!border-border-weak-base": bottom,
        }}
      >
        <Tabs.Trigger
          value="session"
          classList={{
            "!w-1/2 !max-w-none": true,
            "!border-b-0 !border-t !border-border-weak-base [&:has([data-selected])]:!border-t-transparent": bottom,
          }}
          classes={{ button: compact ? "w-full !py-2" : "w-full" }}
          onClick={() => setStore("mobileTab", "session")}
        >
          {language.t("session.tab.session")}
        </Tabs.Trigger>
        <Tabs.Trigger
          value="changes"
          classList={{
            "!w-1/2 !max-w-none !border-r-0": true,
            "!border-b-0 !border-t !border-border-weak-base [&:has([data-selected])]:!border-t-transparent": bottom,
          }}
          classes={{ button: compact ? "w-full !py-2" : "w-full" }}
          onClick={() => setStore("mobileTab", "changes")}
        >
{"Files Changed"}
</Tabs.Trigger>
      </Tabs.List>
    </Tabs>
  )
  const mobileTabsBottom = createMemo(
    () => !isDesktop() && settings.general.newLayoutDesigns() && settings.general.mobileTitlebarPosition() === "bottom",
  )

  const sessionErrorFallback = (error: unknown, reset: () => void) => {
    createEffect(on(sessionKey, reset, { defer: true }))
    return <SessionErrorFallback error={error} sessionID={params.id} />
  }

  const sessionPanelContent = () => (
    <>
      {sessionSync() ?? ""}
      <Show when={!isDesktop() && !!params.id && settings.general.newLayoutDesigns() && !mobileTabsBottom()}>
        {mobileTabs(true)}
      </Show>
      <div class="flex-1 min-h-0 overflow-hidden">
        <Switch>
          <Match when={params.id && mobileChanges()}>
            <div class="relative h-full overflow-hidden">
              {reviewContent({
                diffStyle: "unified",
                classes: {
                  root: "pb-8 [&_[data-slot=session-review-list]]:pb-0",
                  header: "px-4 !h-16 !pb-4",
                  container: "px-4",
                },
                loadingClass: "px-4 py-4 text-text-weak",
                emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
              })}
            </div>
          </Match>
          <Match when={params.id}>
            <Show when={messagesReady() ? params.id : undefined} keyed>
              {(_id) => (
                <Show
                  when={visibleUserMessages().length > 0 || rolled().length === 0}
                  fallback={
                    <div class="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center">
                      <div class="text-14-regular text-text-weak">All messages are rolled back</div>
                      <div class="text-12-regular text-text-weaker max-w-sm">
                        Use the rolled-back bar below to restore a message and continue.
                      </div>
                    </div>
                  }
                >
                  <MessageTimeline
                    actions={actions}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={markUserScroll}
                    onHistoryScroll={onHistoryScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    shouldAnchorBottom={() =>
                      !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                    }
                    centered={centered()}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    userMessages={visibleUserMessages()}
                    setHistoryAnchor={(handlers) => {
                      captureHistoryAnchor = handlers.capture
                      restoreHistoryAnchor = handlers.restore
                    }}
                    anchor={anchor}
                    setRevealMessage={(fn) => {
                      revealMessage = fn
                    }}
                    setScrollToEnd={(fn) => {
                      scrollToEnd = fn
                    }}
                  />
                </Show>
              )}
            </Show>
          </Match>
          <Match when={true}>
            <NewSessionView worktree={newSessionWorktree()} />
          </Match>
        </Switch>
      </div>

      <Show when={(params.id || !newSessionDesign()) && !mobileChanges()}>
        {(_) => {
          const controller = createSessionComposerRegionController({
            state: composer,
            sessionKey,
            sessionID: () => params.id,
            prompt,
            ready: () => !store.deferRender && messagesReady(),
            centered,
            todo: {
              collapsed: () => view().todoCollapsed.get(),
              onToggle: () => view().todoCollapsed.set(!view().todoCollapsed.get()),
            },
            followup: () =>
              params.id && !isChildSession()
                ? {
                    items: followupDock(),
                    sending: sendingFollowup(),
                    onSend: (id) => void sendFollowup(params.id!, id, { manual: true }),
                    onEdit: editFollowup,
                  }
                : undefined,
            revert: () =>
              rolled().length > 0
                ? {
                    items: rolled(),
                    restoring: restoring(),
                    disabled: reverting(),
                    onRestore: restore,
                  }
                : undefined,
            onResponseSubmit: resumeScroll,
            openParent: () => {
              const id = info()?.parentID
              if (!id) return
              navigate(
                params.serverKey
                  ? sessionHref(requireServerKey(params.serverKey), id)
                  : legacySessionHref(sdk().directory, id),
              )
            },
            onUnarchive: async () => {
              const id = params.id
              if (!id) return
              if ((await sdk().protocol) !== "v1") return
              try {
                await (sdk().client.session.update as Function)({ sessionID: id, directory: sdk().directory, time: { archived: null } })
                void sync().session.sync(id, { force: true })
              } catch (err: unknown) {
                showToast({
                  title: language.t("common.requestFailed"),
                  description: formatServerError(err, language.t),
                })
              }
            },
            setPromptRef: (el) => {
              inputRef = el
            },
            setDockRef: (el) => {
              promptDock = el
            },
          })
          return (
            <SessionComposerRegion
              controller={controller}
              promptInput={
                <Show
                  when={newSessionDesign()}
                  fallback={
                    <PromptInput
                      controls={inputController()}
                      ref={(el) => {
                        inputRef = el
                      }}
                      newSessionWorktree={newSessionWorktree()}
                      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
                      onSubmit={() => {
                        comments.clear()
                        resumeScroll()
                      }}
                      edit={editingFollowup()}
                      onEditLoaded={clearFollowupEdit}
                      shouldQueue={queueEnabled}
                      onQueue={queueFollowup}
                      onAbort={() => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      }}
                    />
                  }
                >
                  {(_) => {
                    const controller = usePromptInputV2Controller({
                      get controls() {
                        return inputController()
                      },
                      ref: (el) => {
                        inputRef = el
                      },
                      get newSessionWorktree() {
                        return newSessionWorktree()
                      },
                      onNewSessionWorktreeReset: () => setStore("newSessionWorktree", "main"),
                      onSubmit: () => {
                        comments.clear()
                        resumeScroll()
                      },
                      get edit() {
                        return editingFollowup()
                      },
                      onEditLoaded: clearFollowupEdit,
                      shouldQueue: queueEnabled,
                      onQueue: queueFollowup,
                      onAbort: () => {
                        const id = params.id
                        if (!id) return
                        setFollowup("paused", id, true)
                      },
                    })
                    return <PromptInputV2Composer controller={controller} borderUnderlay />
                  }}
                </Show>
              }
            />
          )
        }}
      </Show>
      <Show when={!!params.id && mobileTabsBottom()}>{mobileTabs(true, true)}</Show>
    </>
  )

  return (
    <SessionRouteFrame>
      <SessionHeader />
      <ContextWarningBanner />
      <div
        ref={panelRow}
        class="flex-1 min-h-0 flex flex-col md:flex-row"
        classList={{
          "gap-2 p-2": settings.general.newLayoutDesigns(),
        }}
      >
        <Show when={!isDesktop() && !!params.id && !settings.general.newLayoutDesigns()}>{mobileTabs()}</Show>

        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full transition-[width]": true,
            "flex-1 md:flex-none": !chatTakesRemainder(),
            "flex-1": chatTakesRemainder(),
            "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !size.active() && !ui.reviewSnap && !desktopInlineTerminalOnlyOpen(),
          }}
          style={{
            width: sessionPanelWidth(),
          }}
        >
          {settings.general.newLayoutDesigns() ? (
            <Show when={sessionPanelKey()} keyed>
              {(_) => (
                <SessionPanelFrame newLayout raised={!!params.id}>
                  <ErrorBoundary fallback={sessionErrorFallback}>{sessionPanelContent()}</ErrorBoundary>
                </SessionPanelFrame>
              )}
            </Show>
          ) : (
            <SessionPanelFrame newLayout={false} raised={!!params.id}>
              {sessionPanelContent()}
            </SessionPanelFrame>
          )}

          {/* the chat-side handle only survives in the classic layout — in v2
              the work column owns its width and the handle rides its edge */}
          <Show when={!newSessionDesign() && desktopSessionResizeOpen()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                direction="horizontal"
                size={sessionPanelResizedWidth()}
                min={SESSION_PANEL_WIDTH_MIN}
                max={sessionPanelMax()}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
              />
            </div>
          </Show>
        </div>

        <Show when={!newSessionDesign() && desktopSidePanelOpen()}>
          <Suspense>
            <SessionSidePanel
              canReview={canReview}
              diffs={reviewDiffs}
              diffsReady={reviewReady}
              empty={reviewEmptyText}
              hasReview={hasReview}
              reviewHasFocusableContent={hasReview}
              reviewCount={reviewCount}
              reviewPanel={reviewPanel}
              activeDiff={activeReviewFile()}
              focusReviewDiff={focusReviewDiff}
              reviewSnap={ui.reviewSnap}
              size={size}
              touchedFiles={touchedFiles}
            />
          </Suspense>
        </Show>
        <Show when={newSessionDesign()}>
          <Show when={isDesktop() ? desktopV2PanelLayout().visible : terminalOpen()}>
            <div
              classList={{
                "min-w-0 h-full flex flex-col relative": true,
                "flex-1": !isDesktop(),
                "flex-none": isDesktop(),
              }}
              style={{ width: isDesktop() ? `${workColumnWidth()}px` : undefined }}
            >
              {/* amicode#105: the work column's own resize handle (its left
                  edge), sizing layout.panelColumn within the policy bounds —
                  the chat flexes around it, never below it. */}
              <Show when={isDesktop()}>
                <div onPointerDown={() => size.start()}>
                  <ResizeHandle
                    direction="horizontal"
                    edge="start"
                    size={layout.panelColumn.width()}
                    min={WORK_COLUMN_WIDTH_MIN}
                    max={workColumnWidthMax(sessionPanelAvailable() ?? 900)}
                    onResize={(width) => {
                      size.touch()
                      layout.panelColumn.resize(width)
                    }}
                  />
                </div>
              </Show>
              <Show when={isDesktop() && (desktopV2ReviewOpen() || desktopFileTreeOpen())}>
                <div class="min-h-0 flex-1">
                  <Suspense>
                    {/* amicode#105: no reviewSidebarToggle — the Work Column is
                        single-pane (reviewSidebarOpened is policy-false), so the
                        old kanban-icon affordance would be a dead button. */}
                    <SessionSidePanel
                      canReview={canReview}
                      diffs={reviewDiffs}
                      diffsReady={reviewReady}
                      empty={reviewEmptyText}
                      hasReview={hasReview}
                      reviewHasFocusableContent={() => hasReview() || reviewV2State.sidebarOpened()}
                      reviewCount={reviewCount}
                      reviewPanel={reviewPanelV2}
                      fileBrowserState={reviewV2State}
                      activeDiff={activeReviewFile()}
                      focusReviewDiff={focusReviewDiff}
                      reviewSnap={ui.reviewSnap}
                      size={size}
                      stacked={desktopV2PanelLayout().stacked}
                      touchedFiles={touchedFiles}
                    />
                  </Suspense>
                </div>
              </Show>
              <Show when={desktopV2PanelLayout().stacked}>
                <div class="relative h-2 shrink-0" onPointerDown={() => size.start()}>
                  <ResizeHandle
                    class="!relative !inset-auto !h-full !w-full !transform-none"
                    direction="vertical"
                    size={layout.terminal.height()}
                    min={100}
                    max={typeof window === "undefined" ? 600 : window.innerHeight * 0.6}
                    collapseThreshold={50}
                    onResize={(height) => {
                      size.touch()
                      layout.terminal.resize(height)
                    }}
                    onCollapse={() => view().terminal.close()}
                  />
                </div>
              </Show>
              <Show when={terminalOpen()}>
                <div
                  classList={{
                    "min-h-0 shrink-0": desktopV2PanelLayout().stacked,
                    "min-h-0 flex-1": !desktopV2PanelLayout().stacked,
                  }}
                >
                  <TerminalPanelV2 stacked={desktopV2PanelLayout().stacked} />
                </div>
              </Show>
            </div>
          </Show>
        </Show>
      </div>

      <Show when={!newSessionDesign()}>
        <TerminalPanel />
      </Show>
    </SessionRouteFrame>
  )
}
