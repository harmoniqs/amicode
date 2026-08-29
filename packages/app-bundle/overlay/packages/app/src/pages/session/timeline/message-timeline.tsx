import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
  type Accessor,
  type JSX,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { useNavigate, useParams } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { createVirtualizer, defaultRangeExtractor, elementScroll, type VirtualItem } from "@tanstack/solid-virtual"
import { Accordion } from "@opencode-ai/ui/accordion"
import { AmicodeEntityRail } from "@opencode-ai/ui/amicode-entity-rail"
import { DEFAULT_DOT_CENTRE, ThoughtRail, ThoughtRailLabel, THOUGHT_RAIL_INSET, shouldRenderRail } from "./thought-rail"
import { formatElapsed, formatTokens, turnTokens } from "@opencode-ai/ui/amicode-thinking"
import {
  AmicodeEntityView,
  entityLabel,
  parseProblemResponse,
  parseRunStatusResponse,
} from "@opencode-ai/ui/amicode-entity-view"
import { parseDashboardResponse, type DashboardState } from "@opencode-ai/ui/amicode-widget-grid"
import { Button } from "@opencode-ai/ui/button"
import { Card } from "@opencode-ai/ui/card"
import {
  ContextToolGroup,
  EditToolGroup,
  Message,
  MessageDivider,
  Part as MessagePart,
  partDefaultOpen,
  renderable,
  ShellToolGroup,
  type UserActions,
} from "@opencode-ai/session-ui/message-part"
import { readPartText, settledChunkBoundary } from "@opencode-ai/session-ui/message-part-text"
import { buildTrace } from "@opencode-ai/session-ui/build-trace"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { InlineInput } from "@opencode-ai/ui/inline-input"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SessionRetry } from "@opencode-ai/session-ui/session-retry"
import { isScrollKeyTarget, scrollKey, scrollKeyOwner, ScrollView } from "@opencode-ai/ui/scroll-view"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { TextField } from "@opencode-ai/ui/text-field"
import { TextReveal } from "@opencode-ai/ui/text-reveal"
import type {
  AssistantMessage,
  Message as MessageType,
  Part as PartType,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { showToast } from "@/utils/toast"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { normalize } from "@opencode-ai/session-ui/session-diff"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSessionKey } from "@/pages/session/session-layout"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { usePrompt } from "@/context/prompt"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import { draftPrompt } from "@/utils/start-prompt"
import { inAmicode, postAmicode } from "@/pages/session/use-amicode-commands"
import { writeClipboardViaBridge } from "@/components/prompt-input/clipboard-bridge"
import { legacySessionHref, requireServerKey, sessionHref } from "@/utils/session-route"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { notifySessionTabsRemoved } from "@/components/titlebar-session-events"
import { sessionTitle } from "@/utils/session-title"
import { scheduleConnectedMeasure } from "./measure"
import { observeElementOffsetReconnectAware } from "./observe-element-offset"
import { createTimelineProjection } from "./projection"
import { MessageComment, SummaryDiff, TimelineRow, TimelineRowMap } from "./rows"
import { filterVirtualIndexes } from "./virtual-items"

const emptyMessages: MessageType[] = []
const emptyParts: PartType[] = []
const emptyTools: ToolPart[] = []
const emptyAssistantMessages: AssistantMessage[] = []
const idle = { type: "idle" as const }

type FramedTimelineRow = Exclude<TimelineRow.TimelineRow, { _tag: "TurnGap" }>
type TimelineRowByTag<T extends TimelineRow.TimelineRow["_tag"]> = Extract<TimelineRow.TimelineRow, { _tag: T }>

const timelineFallbackItemSize = 60
const timelineCache = new Map<string, { measurements: VirtualItem[]; toolOpen: Record<string, boolean | undefined> }>()

const taskDescription = (part: PartType, sessionID: string) => {
  if (part.type !== "tool" || part.tool !== "task") return
  const metadata = "metadata" in part.state ? part.state.metadata : undefined
  if (metadata?.sessionId !== sessionID) return
  const value = part.state.input?.description
  if (typeof value === "string" && value) return value
}

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) {
    input.onMarkScrollGesture(input.root)
    return
  }
  if (
    shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    })
  ) {
    input.onMarkScrollGesture(input.root)
  }
}

function TimelineThinkingRow(_props: { reasoningHeading?: string; showReasoningSummaries: boolean }) {
  return (
    <div data-slot="session-turn-thinking">
      <span class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong leading-[22px]">
        <span class="shrink-0">Thinking</span>
      </span>
    </div>
  )
}

function TimelineThinkingMetaRow(props: { turnDurationMs?: number; tokens?: number; onCopy?: () => void }) {
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)

  const handleCopy = () => {
    props.onCopy?.()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div data-slot="session-turn-thinking-meta">
      <TooltipV2
        value={copied() ? language.t("ui.message.copied") : language.t("ui.message.copyTrace")}
        placement="bottom"
        gutter={4}
      >
        <IconButtonV2
          icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
          size="normal"
          variant="ghost-muted"
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleCopy}
          aria-label={copied() ? language.t("ui.message.copied") : language.t("ui.message.copyTrace")}
        />
      </TooltipV2>
      <Show when={props.turnDurationMs != null}>
        <span class="amc-thinking" data-slot="amc-thinking">
          <span class="amc-thinking-meta" aria-hidden="true">
            <span class="amc-thinking-sep">·</span>
            <span class="amc-thinking-elapsed">{formatElapsed(props.turnDurationMs!)}</span>
            <Show when={props.tokens != null}>
              <span class="amc-thinking-sep">·</span>
              <span class="amc-thinking-tokens">↑ {formatTokens(props.tokens!)} tokens</span>
            </Show>
          </span>
        </span>
      </Show>
    </div>
  )
}

function TimelineDiffSummaryRow(props: { diffs: SummaryDiff[] }) {
  const language = useLanguage()
  const maxFiles = 10
  const [state, setState] = createStore({
    showAll: false,
    expanded: [] as string[],
  })
  const showAll = () => state.showAll
  const expanded = () => state.expanded
  const overflow = createMemo(() => Math.max(0, props.diffs.length - maxFiles))
  const visible = createMemo(() => (showAll() ? props.diffs : props.diffs.slice(0, maxFiles)))

  return (
    <div
      data-slot="session-turn-diffs"
      data-component="session-turn-diffs-group"
      data-show-all={showAll() || undefined}
    >
      <div data-slot="session-turn-diffs-header">
        <span data-slot="session-turn-diffs-label">
          {language.t(
            props.diffs.length === 1 ? "ui.sessionTurn.diffs.changed.one" : "ui.sessionTurn.diffs.changed.other",
            { count: String(props.diffs.length) },
          )}
        </span>
        <DiffChanges changes={props.diffs} />
        <Show when={overflow() > 0}>
          <span data-slot="session-turn-diffs-toggle" onClick={() => setState("showAll", !showAll())}>
            {showAll() ? language.t("ui.sessionTurn.diffs.showLess") : language.t("ui.sessionTurn.diffs.showAll")}
          </span>
        </Show>
      </div>
      <div data-component="session-turn-diffs-content">
        <Accordion
          multiple
          style={{ "--sticky-accordion-offset": "44px" }}
          value={expanded()}
          onChange={(value) => setState("expanded", Array.isArray(value) ? value : value ? [value] : [])}
        >
          <For each={visible()}>
            {(diff) => {
              const opened = createMemo(() => expanded().includes(diff.file))

              return (
                <Accordion.Item value={diff.file}>
                  <StickyAccordionHeader>
                    <Accordion.Trigger>
                      <div data-slot="session-turn-diff-trigger">
                        <span data-slot="session-turn-diff-path">
                          <Show when={diff.file.includes("/")}>
                            <span data-slot="session-turn-diff-directory">{`\u202A${getDirectory(diff.file)}\u202C`}</span>
                          </Show>
                          <span data-slot="session-turn-diff-filename">{getFilename(diff.file)}</span>
                        </span>
                        <div data-slot="session-turn-diff-meta">
                          <span data-slot="session-turn-diff-changes">
                            <DiffChanges changes={diff} />
                          </span>
                          <span data-slot="session-turn-diff-chevron">
                            <Icon name="chevron-down" size="small" />
                          </span>
                        </div>
                      </div>
                    </Accordion.Trigger>
                  </StickyAccordionHeader>
                  <Accordion.Content>
                    <Show when={opened()}>
                      <TimelineDiffView diff={diff} />
                    </Show>
                  </Accordion.Content>
                </Accordion.Item>
              )
            }}
          </For>
        </Accordion>
        <Show when={!showAll() && overflow() > 0}>
          <div data-slot="session-turn-diffs-more" onClick={() => setState("showAll", true)}>
            {language.t("ui.sessionTurn.diffs.more", { count: String(overflow()) })}
          </div>
        </Show>
      </div>
    </div>
  )
}

function TimelineDiffView(props: { diff: SummaryDiff }) {
  const fileComponent = useFileComponent()
  const view = normalize(props.diff)

  return (
    <div data-slot="session-turn-diff-view" data-scrollable>
      <Dynamic component={fileComponent} mode="diff" virtualize={false} fileDiff={view.fileDiff} />
    </div>
  )
}

export function MessageTimeline(props: {
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onHistoryScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  shouldAnchorBottom: () => boolean
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  userMessages: UserMessage[]
  anchor: (id: string) => string
  setRevealMessage?: (fn: (id: string) => void) => void
  setScrollToEnd?: (fn: () => void) => void
  setHistoryAnchor?: (handlers: { capture: () => void; restore: (done: boolean) => void }) => void
}) {
  let touchGesture: number | undefined

  const navigate = useNavigate()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const tabs = useTabs()
  const dialog = useDialog()
  const language = useLanguage()
  const command = useCommand()
  const { params, sessionKey } = useSessionKey()

  // ── amicode: problem-UI wiring (ported from the pre-merge message-timeline;
  // the mounts died with that file — see AMICODE-PATCHES.md "Upstream sync
  // 2026-08-01"). The app owns transport (per-active-server Basic auth via
  // amicodeGet) + the ring-2 entity dialog; the rail owns its own polling.
  // Dialog resources are gated on the open signal, cleared on close.
  const server = useServer()
  const prompt = usePrompt()
  const [entityViewOpen, setEntityViewOpen] = createSignal(false)
  const [problemRaw, { refetch: refetchProblem }] = createResource(
    () => (entityViewOpen() ? 1 : undefined),
    () => amicodeGet(server.current, "/amicode/problem"),
  )
  const problemView = createMemo(() => {
    if (problemRaw.error) return parseProblemResponse({ ok: false, error: language.t("amicode.fetchFailed") })
    const raw = problemRaw.latest
    return raw === undefined ? undefined : parseProblemResponse(raw)
  })
  // Capability warrants (spec-20260727-164748 §9.5). Fetched unconditionally rather
  // than gated on a dialog: the approval card lives IN the transcript, so it needs
  // its state on first paint. Cheap — one ledger read, and the card's state derives
  // from these rows rather than from optimistic local state, so a press round-trips
  // through the ledger before it reads as granted.
  const [warrantsRaw, { refetch: refetchWarrants }] = createResource(() =>
    amicodeGet(server.current, "/amicode/warrants").catch(() => undefined),
  )
  const warrants = createMemo(() => {
    const raw = warrantsRaw.latest as { ok?: boolean; warrants?: unknown } | undefined
    if (!raw?.ok || !Array.isArray(raw.warrants)) return []
    // Tolerant per row: a malformed row is dropped, never defaulted into a warrant.
    return raw.warrants.flatMap((r) => {
      const row = r as Record<string, unknown>
      if (typeof row.plan_hash !== "string" || typeof row.expires_at !== "string") return []
      return [{
        plan_hash: row.plan_hash,
        bounds: (typeof row.bounds === "object" && row.bounds !== null ? row.bounds : {}) as Record<string, never>,
        expires_at: row.expires_at,
        issued_by: typeof row.issued_by === "string" ? row.issued_by : "unknown",
        // Omitted when the server did not send it, so the rail chip drops the count
        // rather than rendering a wrong "0 of N".
        ...(typeof row.solves_used === "number" ? { solves_used: row.solves_used } : {}),
      }]
    })
  })
  // Run verdict data for the entity view: /amicode/run-status is fetched
  // whenever a dialog opens (cheap, server-cached ~1s); only the Run dialog
  // reads it. Same endpoint the rail's run chip polls.
  const [runStatusRaw] = createResource(
    () => (entityViewOpen() ? 1 : undefined),
    () => amicodeGet(server.current, "/amicode/run-status"),
  )
  const entityRunStatus = createMemo(() => parseRunStatusResponse(runStatusRaw.latest))
  const openEntityView = (kind: string, seq?: number) => {
    setEntityViewOpen(true)
    dialog.show(
      () => (
        <Dialog title={`AMICO · ${entityLabel(kind)}`} fit>
          {/* fit-to-content goes near-fullscreen on run entities (long paths +
              history) — cap the panel and let it scroll internally instead */}
          <div style={{ width: "100%", "max-height": "68vh", "overflow-y": "auto" }}>
            <AmicodeEntityView
              view={problemView()}
              kind={kind}
              runStatus={entityRunStatus()}
              anchorSeq={seq}
              onDraftPrompt={(text) => {
                dialog.close()
                draftPrompt(prompt, text)
              }}
              onRetry={() => void refetchProblem()}
              retryLabel={language.t("amicode.retry")}
              editLabel={language.t("amicode.editInChat")}
            />
          </div>
        </Dialog>
      ),
      () => setEntityViewOpen(false),
    )
  }

  const ownerSessionKey = sessionKey()
  const cached = timelineCache.get(ownerSessionKey)
  const initialMeasurements = cached?.measurements
  const coldBottomMount = !initialMeasurements?.length && props.shouldAnchorBottom()
  // Hide the scroll container for the first frame on cold-bottom-mount to prevent
  // a flash of content at the top before scrollToEnd fires.
  const [scrollReady, setScrollReady] = createSignal(!coldBottomMount)
  // The open cascade holds until the virtualizer has settled at the bottom —
  // entering rows sit paused at opacity 0 (see [data-entrance-pending] in
  // design-polish.css) so the entrance never plays behind the opacity veil or
  // during the initial scroll jump. Flipped one frame after the mount scroll.
  const [entranceReady, setEntranceReady] = createSignal(false)
  const platform = usePlatform()

  const [listRoot, setListRoot] = createSignal<HTMLDivElement>()
  const sessionID = createMemo(() => params.id)
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync().data.session_status[id] ?? idle
  })
  const sessionMessages = createMemo(() => (sessionID() ? (sync().data.message[sessionID()!] ?? []) : []))
  const projectedMessages = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    const visible = new Set(props.userMessages.map((message) => message.id))
    const boundary = sessionMessages().find((message) => message.role === "user" && !visible.has(message.id))?.id
    const messages = sync().data.session_message[id] ?? []
    return boundary ? messages.filter((message) => message.id < boundary) : messages
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync().session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const shareUrl = createMemo(() => info()?.share?.url)
  const shareEnabled = createMemo(() => sync().data.config.share !== "disabled")
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync().session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync().data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const getMsgParts = (msgId: string) => sync().data.part[msgId] ?? emptyParts

  // amicode: live token count for a turn's assistant messages — feeds the
  // thinking line's token chip on the Thinking row (the recovered wave mount).
  const assistantTokensForTurn = (userMessageID: string) => {
    const msgs = sessionMessages()
    const start = msgs.findIndex((m) => m.id === userMessageID)
    if (start === -1) return 0
    return turnTokens(msgs.slice(start + 1).filter((m) => m.role === "assistant"))
  }

  // Copy the full assistant trace for a turn to the clipboard.
  const copyTraceForTurn = (userMessageID: string) => {
    const msgs = sessionMessages()
    const start = msgs.findIndex((m) => m.id === userMessageID)
    if (start === -1) return
    const assistantMsgs = msgs.slice(start + 1).filter((m): m is AssistantMessage => m.role === "assistant")
    const content = buildTrace(assistantMsgs, getMsgParts)
    if (!content) return
    if (!writeClipboardViaBridge(content)) void navigator.clipboard?.writeText(content)
  }
  /** True when at least one AssistantPart ROW exists in the projected timeline
   *  for this turn — meaning renderable, settled output is visible. Reasoning
   *  parts withheld while streaming do NOT count (they produce no row until
   *  they settle), which prevents the harmonic dot from leaving the Thinking
   *  row prematurely. */
  const hasAssistantParts = (userMessageID: string) => {
    return timelineRows().some((row) => row._tag === "AssistantPart" && row.userMessageID === userMessageID)
  }
  const getMsgPart = (messageID: string, partID: string) => getMsgParts(messageID).find((part) => part.id === partID)
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => getMsgParts(message.id))
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  // The chunk gate for a streaming prose tail (Kate 2026-08-25: replies land
  // in chunks). rows.ts withholds the tail only until its FIRST chunk settles
  // — but the freshest streamed text lives in part_text_accum_delta (part.text
  // lags during delta streaming), which the pure row construction cannot see.
  // Computed here as a boolean memo so the per-token recomputation stops at an
  // unchanged value instead of rebuilding the whole row projection per delta.
  const tailProseSettled = createMemo(() => {
    const last = sessionMessages().findLast(
      (message): message is AssistantMessage => message.role === "assistant",
    )
    if (!last || typeof last.time.completed === "number") return false
    const tail = getMsgParts(last.id)
      .filter((part) => renderable(part, settings.general.showReasoningSummaries()))
      .at(-1)
    if (!tail || tail.type !== "text" || tail.time?.end) return false
    const text = readPartText(sync().data.part_text_accum_delta, tail)
    return settledChunkBoundary(text) > 0
  })
  const projection = createTimelineProjection({
    messages: sessionMessages,
    userMessages: () => props.userMessages,
    sessionMessages: projectedMessages,
    parts: getMsgParts,
    status: sessionStatus,
    showReasoningSummaries: settings.general.showReasoningSummaries,
    inlineComments: settings.general.newLayoutDesigns,
    tailProseSettled,
  })
  const activeMessageID = projection.activeMessageID
  const assistantMessagesByParent = projection.assistantMessagesByParent
  const lastAssistantGroupKey = projection.lastAssistantGroupKey
  const messageByID = projection.messageByID
  const messageLastRowIndex = projection.messageLastRowIndex
  const messageRowIndex = projection.messageRowIndex
  const timelineRowByKey = projection.rowByKey
  const timelineRows = projection.rows

  // Entrance bookkeeping (Kate 2026-08-24/25: "all the elements fade in from
  // the bottom", blocks land whole, crisply). Two moments animate, nothing
  // else ever does:
  //
  // 1. THE OPEN CASCADE — every session open / switch / reload cascades the
  //    initially rendered rows in, staggered top-to-bottom. Rows arming
  //    inside the first CASCADE_WINDOW_MS after the per-session reset are the
  //    initial batch; each takes an animation-delay step. The cascade holds
  //    paused behind [data-entrance-pending] until the virtualizer settles at
  //    the bottom, which also removes the old unanimated flash-jump (history
  //    used to paint one frame at the top, then teleport to the bottom).
  //
  // 2. THE LIVE TURN — after the open, only rows of the ACTIVE turn enter
  //    (the just-sent bubble, Thinking, the settled reply blocks). Settled
  //    history joining later — scroll-back remounts, pagination prepends,
  //    far jumps — lands silently by rule, which closes the whole class of
  //    replay/burn bugs the per-key ledger alone could not (an audit found
  //    prepends animating a full page, and off-screen mounts burning their
  //    once-only entrance invisibly).
  //
  // Each key still animates at most once (virtual rows remount on every
  // scroll-back, so mount alone must never trigger the entrance).
  const CASCADE_WINDOW_MS = 600
  const CASCADE_STEP_MS = 40
  const CASCADE_MAX_STEPS = 12
  let enteredFor: string | undefined
  let enteredAt = 0
  let cascadeStep = 0
  const enteredKeys = new Set<string>()
  const shouldAnimateEnter = (rowKey: string, row: TimelineRow.TimelineRow): number | false => {
    const sid = sessionID()
    if (enteredFor !== sid) {
      enteredFor = sid
      enteredKeys.clear()
      enteredAt = performance.now()
      cascadeStep = 0
    }
    if (enteredKeys.has(rowKey)) return false
    enteredKeys.add(rowKey)
    if (performance.now() - enteredAt < CASCADE_WINDOW_MS) {
      return Math.min(cascadeStep++, CASCADE_MAX_STEPS) * CASCADE_STEP_MS
    }
    if (row.userMessageID === activeMessageID()) return 0
    return false
  }

  let prependAnchor: { key: string; offset: number } | undefined
  let prependAnchorFrame: number | undefined
  let prependLoading = false
  const clearPrependAnchor = () => {
    prependLoading = false
    prependAnchor = undefined
    if (prependAnchorFrame === undefined) return
    cancelAnimationFrame(prependAnchorFrame)
    prependAnchorFrame = undefined
  }
  const capturePrependAnchor = () => {
    prependLoading = true
    updatePrependAnchor()
  }
  const updatePrependAnchor = () => {
    const root = listRoot()
    if (!root) return
    const view = root.getBoundingClientRect()
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-timeline-key]")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter((item) => item.rect.bottom > view.top && item.rect.top < view.bottom)
      .sort((a, b) => a.rect.top - b.rect.top)[0]
    if (!anchor) return
    if (!anchor.element.dataset.timelineKey) return
    prependAnchor = { key: anchor.element.dataset.timelineKey, offset: anchor.rect.top - view.top }
  }
  const restorePrependAnchor = (done: boolean) => {
    if (done) prependLoading = false
    applyPrependAnchor()
  }
  const applyPrependAnchor = () => {
    const root = listRoot()
    if (!root || !prependAnchor) return
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    let frames = 0
    let stable = 0
    const apply = () => {
      prependAnchorFrame = undefined
      const anchor = prependAnchor
      if (!anchor) return
      const element = root.querySelector<HTMLElement>(`[data-timeline-key="${CSS.escape(anchor.key)}"]`)
      const delta = element
        ? element.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset
        : undefined
      if (delta !== undefined && Math.abs(delta) > 0.5) {
        root.scrollTop += delta
        stable = 0
      } else {
        stable += 1
      }
      frames += 1
      if (stable >= 30 || frames >= 180) {
        if (!prependLoading) prependAnchor = undefined
        return
      }
      prependAnchorFrame = requestAnimationFrame(apply)
    }
    prependAnchorFrame = requestAnimationFrame(apply)
  }

  const [toolOpen, setToolOpen] = createStore<Record<string, boolean | undefined>>(cached?.toolOpen ?? {})
  const [renderOverscan, setRenderOverscan] = createSignal(initialMeasurements?.length || coldBottomMount ? 6 : 20)
  let resizePinnedIndexes: number[] = []
  let resizePinFrame: number | undefined
  let virtualContent: HTMLDivElement | undefined
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return timelineRows().length
    },
    getScrollElement: () => listRoot() ?? null,
    observeElementOffset: observeElementOffsetReconnectAware,
    initialOffset: () => (props.shouldAnchorBottom() ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    estimateSize: () => timelineFallbackItemSize,
    scrollToFn: (offset, options, instance) => {
      // Expose the computed range before core writes an anchor correction so the browser does not clamp it to the old height.
      if (virtualContent) virtualContent.style.height = `${instance.getTotalSize()}px`
      elementScroll(offset, options, instance)
    },
    get getItemKey() {
      const rows = timelineRows()
      return (index: number) => {
        const row = rows[index]
        // ResizeObserver can report a removed element after its row has left the projection.
        if (!row) return `removed:${index}`
        return TimelineRow.key(row)
      }
    },
    anchorTo: "end",
    get followOnAppend() {
      return props.shouldAnchorBottom() && !props.hasScrollGesture()
    },
    scrollEndThreshold: 80,
    get scrollMargin() {
      return showHeader() ? 64 : 0
    },
    overscan: 50,
    paddingEnd: 24,
    rangeExtractor: (range) => {
      const id = activeMessageID()
      const active = id ? (messageLastRowIndex().get(id) ?? -1) : -1
      const indexes = defaultRangeExtractor({ ...range, overscan: renderOverscan() })
      return filterVirtualIndexes(
        [...new Set([...resizePinnedIndexes, ...indexes, ...(active < 0 ? [] : [active])])].sort((a, b) => a - b),
        range.count,
      )
    },
  })
  const resizeItem = virtualizer.resizeItem
  let resizeAnchorScheduled = false
  const anchorResizedBottom = () => {
    if (resizeAnchorScheduled || props.hasScrollGesture()) return
    resizeAnchorScheduled = true
    queueMicrotask(() => {
      resizeAnchorScheduled = false
      if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
      virtualizer.scrollToEnd()
    })
  }
  virtualizer.resizeItem = (index, size) => {
    const item = virtualizer.measurementsCache[index]
    const previous = item ? (virtualizer.itemSizeCache.get(item.key) ?? item.size) : undefined
    const root = listRoot()
    if (root && previous !== undefined && Math.abs(size - previous) > root.clientHeight) {
      const view = root.getBoundingClientRect()
      resizePinnedIndexes = [...root.querySelectorAll<HTMLElement>("[data-index]")]
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          return rect.bottom > view.top && rect.top < view.bottom
        })
        .map((element) => Number(element.dataset.index))
      if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
      resizePinFrame = requestAnimationFrame(() => {
        resizePinFrame = requestAnimationFrame(() => {
          resizePinFrame = undefined
          resizePinnedIndexes = []
        })
      })
    }
    resizeItem(index, size)
    if (root && props.shouldAnchorBottom()) anchorResizedBottom()
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) => {
    if (props.shouldAnchorBottom()) return false
    const first = virtualizer.range?.startIndex
    return first !== undefined && item.index < first
  }
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )
  const virtualRowKeys = createMemo(() => virtualizer.getVirtualItems().map((item) => item.key as string))
  // amicode#271: a signal tracking the scroll container's scrollTop, updated on
  // every scroll event. Drives the last-prompt bubble reactivity.
  const [scrollTop, setScrollTop] = createSignal(0)
  createEffect(() => {
    const root = listRoot()
    if (root) setScrollTop(root.scrollTop)
  })
  // The bubble state: which user message text to show and link to.
  // Computed from scroll position, but explicitly overridden on click.
  const [bubbleOverride, setBubbleOverride] = createSignal<{ text: string; messageId: string } | undefined>(undefined)
  const computeBubble = (): { text: string; messageId: string } | undefined => {
    const range = virtualizer.range
    if (!range) return undefined
    const startIndex = range.startIndex
    const messages = props.userMessages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      const rowIndex = messageRowIndex().get(msg.id)
      if (rowIndex === undefined) continue
      if (rowIndex < startIndex) {
        const parts = getMsgParts(msg.id)
        const textPart = parts.find((p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic)
        const text = textPart?.text?.trim()
        if (text) return { text, messageId: msg.id }
        continue
      }
    }
    return undefined
  }
  // Recompute on scroll; clears any override so the bubble tracks scroll position
  const visiblePromptBubble = createMemo<{ text: string; messageId: string } | undefined>(() => {
    scrollTop()
    return computeBubble()
  })
  // What the bubble actually shows: override (from click) takes priority
  const activeBubble = () => bubbleOverride() ?? visiblePromptBubble()

  // Find the previous user message with text before a given message ID
  const findPreviousBubble = (currentMessageId: string): { text: string; messageId: string } | undefined => {
    const messages = props.userMessages
    const currentIdx = messages.findIndex((m) => m.id === currentMessageId)
    if (currentIdx <= 0) return undefined
    for (let i = currentIdx - 1; i >= 0; i--) {
      const msg = messages[i]
      const parts = getMsgParts(msg.id)
      const textPart = parts.find((p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic)
      const text = textPart?.text?.trim()
      if (text) return { text, messageId: msg.id }
    }
    return undefined
  }

  // Flag to suppress override clearing during programmatic scrolls from bubble click
  let bubbleScrolling = false

  const scrollToBubbleMessage = () => {
    const bubble = activeBubble()
    if (!bubble) return
    const rowIndex = messageRowIndex().get(bubble.messageId)
    if (rowIndex !== undefined) {
      const prev = findPreviousBubble(bubble.messageId)
      setBubbleOverride(prev)
      bubbleScrolling = true
      virtualizer.scrollToIndex(rowIndex, { align: "center" })
      // Allow the programmatic scroll to settle before re-enabling override clearing
      setTimeout(() => { bubbleScrolling = false }, 300)
    }
  }
  createEffect(() => {
    props.setRevealMessage?.((id) => {
      const index = messageRowIndex().get(id)
      if (index === undefined) return
      virtualizer.scrollToIndex(index, { align: "center" })
    })
    props.setScrollToEnd?.(() => virtualizer.scrollToEnd())
    props.setHistoryAnchor?.({ capture: capturePrependAnchor, restore: restorePrependAnchor })
  })

  let overscanFrame: number | undefined
  onMount(() => {
    // Single scroll to end after initial render to prevent flicker
    overscanFrame = requestAnimationFrame(() => {
      overscanFrame = undefined
      if (renderOverscan() < 20) setRenderOverscan(20)
      if (props.shouldAnchorBottom()) virtualizer.scrollToEnd()
      if (!scrollReady()) setScrollReady(true)
      // one more frame so measurement-driven scroll corrections land before
      // the cascade is released
      requestAnimationFrame(() => setEntranceReady(true))
    })
  })

  const maybeAnchorBottom = () => {
    if (timelineRows().length === 0) return
    if (!props.shouldAnchorBottom() || props.hasScrollGesture()) return
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    clearPrependAnchor()
    if (prependAnchorFrame !== undefined) cancelAnimationFrame(prependAnchorFrame)
    virtualizer.scrollToEnd()
  }

  let measuredSessionKey = sessionKey()
  createEffect(() => {
    const key = sessionKey()
    timelineRows().length
    if (measuredSessionKey !== key) {
      measuredSessionKey = key
      virtualizer.measure()
    }
    maybeAnchorBottom()
  })

  onCleanup(() => {
    clearPrependAnchor()
    timelineCache.delete(ownerSessionKey)
    timelineCache.set(ownerSessionKey, { measurements: virtualizer.takeSnapshot(), toolOpen: { ...toolOpen } })
    while (timelineCache.size > 16) timelineCache.delete(timelineCache.keys().next().value!)
    if (resizePinFrame !== undefined) cancelAnimationFrame(resizePinFrame)
    if (overscanFrame !== undefined) cancelAnimationFrame(overscanFrame)
    props.setRevealMessage?.(() => {})
    props.setScrollToEnd?.(() => {})
    props.setHistoryAnchor?.({ capture: () => {}, restore: () => {} })
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
    pendingShare: false,
  })
  let titleRef: HTMLInputElement | undefined

  const [share, setShare] = createStore({
    open: false,
    dismiss: null as "escape" | "outside" | null,
  })
  let more: HTMLButtonElement | undefined

  const bindListRoot = (root: HTMLDivElement) => {
    if (root === listRoot()) return
    setListRoot(root)
    props.setScrollRef(root)
  }

  const handleListWheel = (event: WheelEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    const root = event.currentTarget
    const delta = normalizeWheelDelta({
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      rootHeight: root.clientHeight,
    })
    if (!delta) return
    markBoundaryGesture({ root, target: event.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
  }

  const handleListTouchStart = (event: TouchEvent) => {
    if (!prependLoading) clearPrependAnchor()
    touchGesture = event.touches[0]?.clientY
  }

  const handleListTouchMove = (event: TouchEvent & { currentTarget: HTMLDivElement }) => {
    const next = event.touches[0]?.clientY
    const prev = touchGesture
    touchGesture = next
    if (next === undefined || prev === undefined) return

    const delta = prev - next
    if (!delta) return

    markBoundaryGesture({
      root: event.currentTarget,
      target: event.target,
      delta,
      onMarkScrollGesture: props.onMarkScrollGesture,
    })
  }

  const handleListTouchEnd = () => {
    touchGesture = undefined
  }

  const handleListPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }) => {
    if (!prependLoading) clearPrependAnchor()
    props.onMarkScrollGesture(event.target)
  }

  const handleListPointerMove = (event: PointerEvent) => {
    if (event.buttons !== 1) return
    props.onMarkScrollGesture(event.target)
  }

  const handleListKeyDown = (event: KeyboardEvent & { currentTarget: HTMLDivElement }) => {
    const key = scrollKey(event)
    if (!key) return
    if (!isScrollKeyTarget(event.target, key)) return
    if (scrollKeyOwner(event.currentTarget, event.target, key) !== event.currentTarget) return
    if (!prependLoading) clearPrependAnchor()
    props.onMarkScrollGesture(event.currentTarget)
  }

  const handleListScroll = (event: Event & { currentTarget: HTMLDivElement }) => {
    if (prependLoading) updatePrependAnchor()
    props.onScheduleScrollState(event.currentTarget)
    props.onHistoryScroll()
    // amicode#271: update scroll offset for the last-prompt bubble
    setScrollTop(event.currentTarget.scrollTop)
    if (!props.hasScrollGesture()) return
    // User-initiated scroll — clear any click override so bubble tracks position
    // (but not if we're mid-programmatic scroll from a bubble click)
    if (!bubbleScrolling) setBubbleOverride(undefined)
    props.onUserScroll()
    props.onAutoScrollHandleScroll()
    props.onMarkScrollGesture(event.currentTarget)
  }

  onCleanup(() => {
    props.setScrollRef(undefined)
  })

  const viewShare = () => {
    const url = shareUrl()
    if (!url) return
    platform.openExternal(url)
  }

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const shareMutation = useMutation(() => ({
    mutationFn: (id: string) => serverSDK().client.session.share({ sessionID: id }),
    onError: (err) => {
      console.error("Failed to share session", err)
    },
  }))

  const unshareMutation = useMutation(() => ({
    mutationFn: (id: string) => serverSDK().client.session.unshare({ sessionID: id }),
    onError: (err) => {
      console.error("Failed to unshare session", err)
    },
  }))

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk().api.session.rename({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync().set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const shareSession = () => {
    const id = sessionID()
    if (!id || shareMutation.isPending) return
    if (!shareEnabled()) return
    shareMutation.mutate(id)
  }

  const unshareSession = () => {
    const id = sessionID()
    if (!id || unshareMutation.isPending) return
    if (!shareEnabled()) return
    unshareMutation.mutate(id)
  }
  const copyShareUrl = () => {
    const url = shareUrl()
    if (!url) return
    void navigator.clipboard
      .writeText(url)
      .then(() =>
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("session.share.copy.copied"),
          description: url,
        }),
      )
      .catch((err: unknown) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        }),
      )
  }
  const selectShareUrlText: JSX.EventHandler<HTMLDivElement, MouseEvent> = (event) => {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(event.currentTarget)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
          pendingShare: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync().data.message[id] !== undefined) return
        void sync().session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      if (!titleRef) return
      titleRef.focus()
      titleRef.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateAfterSessionRemoval = (sessionID: string, parentID?: string, nextSessionID?: string) => {
    if (params.id !== sessionID) return
    const href = (id: string) =>
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id)
    if (parentID) {
      navigate(href(parentID))
      return
    }
    if (nextSessionID) {
      navigate(href(nextSessionID))
      return
    }
    if (params.serverKey) {
      tabs.newDraft({ server: requireServerKey(params.serverKey), directory: sdk().directory })
      return
    }
    navigate(`/${params.dir}/session`)
  }

  const archiveSession = async (sessionID: string) => {
    const session = sync().session.get(sessionID)
    if (!session) return
    if ((await sdk().protocol) !== "v1") return

    const sessions = sync().data.session ?? []
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    await sdk()
      .client.session.update({ sessionID, directory: sdk().directory, time: { archived: Date.now() } })
      .then(() => {
        sync().set(
          produce((draft) => {
            const index = draft.session.findIndex((s) => s.id === sessionID)
            if (index !== -1) draft.session.splice(index, 1)
          }),
        )
        sync().session.evict(sessionID)
        navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)
        notifySessionTabsRemoved({ directory: sdk().directory, sessionIDs: [sessionID] })
      })
      .catch((err) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const unarchiveSession = async (sessionID: string) => {
    if ((await sdk().protocol) !== "v1") return
    await (sdk().client.session.update as Function)({ sessionID, directory: sdk().directory, time: { archived: null } })
      .then(() => void sync().session.sync(sessionID, { force: true }))
      .catch((err: unknown) => {
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(err),
        })
      })
  }

  const deleteSession = async (sessionID: string) => {
    const session = sync().session.get(sessionID)
    if (!session) return false

    const sessions = (sync().data.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === sessionID)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await sdk()
      .api.session.remove({ sessionID })
      .then(() => true)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err),
        })
        return false
      })

    if (!result) return false

    const removed = new Set<string>([sessionID])
    const byParent = new Map<string, string[]>()
    for (const item of sync().data.session) {
      const parentID = item.parentID
      if (!parentID) continue
      const existing = byParent.get(parentID)
      if (existing) {
        existing.push(item.id)
        continue
      }
      byParent.set(parentID, [item.id])
    }

    const stack = [sessionID]
    while (stack.length) {
      const parentID = stack.pop()
      if (!parentID) continue

      const children = byParent.get(parentID)
      if (!children) continue

      for (const child of children) {
        if (removed.has(child)) continue
        removed.add(child)
        stack.push(child)
      }
    }

    navigateAfterSessionRemoval(sessionID, session.parentID, nextSession?.id)

    sync().set(
      produce((draft) => {
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    for (const id of removed) {
      sync().session.evict(id)
    }
    notifySessionTabsRemoved({ directory: sdk().directory, sessionIDs: [...removed] })
    return true
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(
      params.serverKey ? sessionHref(requireServerKey(params.serverKey), id) : legacySessionHref(sdk().directory, id),
    )
  }

  function DialogDeleteSession(props: { sessionID: string }) {
    const name = createMemo(
      () => sessionTitle(sync().session.get(props.sessionID)?.title) ?? language.t("command.session.new"),
    )
    const handleDelete = async () => {
      await deleteSession(props.sessionID)
      dialog.close()
    }

    if (settings.general.newLayoutDesigns())
      return (
        <DialogV2 fit>
          <DialogHeader hideClose>
            <DialogTitleGroup
              title={language.t("session.delete.title")}
              description={language.t("session.delete.confirm", { name: name() })}
            />
          </DialogHeader>
          <DialogFooter>
            <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 variant="danger" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </ButtonV2>
          </DialogFooter>
        </DialogV2>
      )

    return (
      <Dialog title={language.t("session.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-14-regular text-text-strong">
              {language.t("session.delete.confirm", { name: name() })}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="large" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" size="large" onClick={handleDelete}>
              {language.t("session.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const workingTurn = (userMessageID: string) => sessionStatus().type !== "idle" && activeMessageID() === userMessageID

  const turnDurationMs = (userMessageID: string) => {
    const message = messageByID().get(userMessageID)
    if (!message || message.role !== "user") return
    const end = (assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages).reduce<number | undefined>(
      (max, item) => {
        const completed = item.time.completed
        if (typeof completed !== "number") return max
        if (max === undefined) return completed
        return Math.max(max, completed)
      },
      undefined,
    )
    if (typeof end !== "number") return
    if (end < message.time.created) return
    return end - message.time.created
  }

  const assistantCopyPartID = (userMessageID: string) => {
    if (workingTurn(userMessageID)) return null
    const messages = assistantMessagesByParent().get(userMessageID) ?? emptyAssistantMessages

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message) continue

      const parts = getMsgParts(message.id)
      for (let j = parts.length - 1; j >= 0; j--) {
        const part = parts[j]
        if (!part || part.type !== "text" || !part.text?.trim()) continue
        return part.id
      }
    }
  }

  const renderAssistantPartGroup = (row: Accessor<TimelineRowMap["AssistantPart"]>, onSizeChange?: () => void) => {
    if (row().group.type === "context") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "context") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      const contextOpenKey = () => `context:${row().group.key}`
      const open = createMemo(() => {
        return toolOpen[contextOpenKey()] === true
      })

      return (
        <ContextToolGroup
          parts={parts()}
          open={open()}
          onOpenChange={(value) => setToolOpen(contextOpenKey(), value)}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
      )
    }

    // Shell and edit groups (≥2 consecutive bash / file-mutation calls,
    // message-part-groups.ts). These MUST render: rows.ts makes every group a
    // rail node and lets it claim lastAssistantPart, so a group that fell
    // through to the part branch below rendered nothing — a phantom node.
    // The step before it then drew a MID segment down its full height (the
    // "line extends past the last dot" report), and the turn's spine ended in
    // thin air where the contentless row sat (the "missing node" report).
    if (row().group.type === "shell") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "shell") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      return (
        <ShellToolGroup
          parts={parts()}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
      )
    }
    if (row().group.type === "edit") {
      const parts = createMemo(() => {
        const group = row().group
        if (group.type !== "edit") return emptyTools
        return group.refs
          .map((ref) => getMsgPart(ref.messageID, ref.partID))
          .filter((part): part is ToolPart => part?.type === "tool")
      })
      return (
        <EditToolGroup
          parts={parts()}
          busy={
            workingTurn(row().userMessageID) && lastAssistantGroupKey().get(row().userMessageID) === row().group.key
          }
          onSizeChange={onSizeChange}
        />
      )
    }

    const message = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return messageByID().get(group.ref.messageID)
    })
    const part = createMemo(() => {
      const group = row().group
      if (group.type !== "part") return
      return getMsgPart(group.ref.messageID, group.ref.partID)
    })
    const defaultOpen = createMemo(() => {
      const item = part()
      if (!item) return
      return partDefaultOpen(item, settings.general.shellToolPartsExpanded(), settings.general.editToolPartsExpanded())
    })

    return (
      <Show when={message()}>
        {(message) => (
          <Show when={part()}>
            {(part) => (
              <MessagePart
                part={part()}
                message={message()}
                showAssistantCopyPartID={assistantCopyPartID(row().userMessageID)}
                turnDurationMs={turnDurationMs(row().userMessageID)}
                useV2Actions={settings.general.newLayoutDesigns()}
                defaultOpen={defaultOpen()}
                toolOpen={toolOpen[part().id] ?? defaultOpen()}
                onToolOpenChange={(open) => setToolOpen(part().id, open)}
                deferToolContent
                virtualizeDiff={false}
                onContentRendered={onSizeChange}
              />
            )}
          </Show>
        )}
      </Show>
    )
  }

  function TimelineRowFrame(input: { row: Accessor<FramedTimelineRow>; children: JSX.Element }) {
    const anchor = () => {
      const row = input.row()
      return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
    }
    const previousAssistantPart = () => {
      const row = input.row()
      if (row._tag === "ThinkingMeta") return false
      if (row._tag !== "AssistantPart") return false
      // Gap above if there's a previous assistant part, OR if Thinking row
      // sits above (always true since Thinking is always first)
      return true
    }
    const assistantPart = () => {
      const tag = input.row()._tag
      return tag === "AssistantPart" || tag === "Thinking" || tag === "ThinkingMeta"
    }
    const railLabel = () => {
      const row = input.row()
      if (row._tag === "AssistantPart") return row.railLabel
      return undefined
    }
    // The thought rail: a spine down a turn's assistant steps. Drawn per-row
    // because the timeline is virtualised and consecutive rows share no ancestor.
    //
    // The harmonic dot TRAVELS down the rail:
    //   - No output yet: dot on Thinking (model is thinking, nothing to show)
    //   - Output has landed: dot moves to the LAST AssistantPart (current step)
    //   - Turn complete: all dots are static done dots
    // ThinkingMeta does NOT participate in the rail (no dot).
    const rail = () => {
      const row = input.row()
      if (row._tag === "Thinking") {
        const hasOutput = hasAssistantParts(row.userMessageID)
        // Dot stays on Thinking only while no output exists
        return { first: true, last: !hasOutput, running: row.turnRunning && !hasOutput }
      }
      if (row._tag !== "AssistantPart") return undefined
      if (!shouldRenderRail(row)) return undefined
      // Last AssistantPart gets the dot when the turn is still running
      return { first: false, last: row.lastAssistantPart, running: row.turnRunning && row.lastAssistantPart }
    }

    // The dot sits on the row's FIRST TEXT LINE, wherever the content puts it
    // (Kate 2026-08-24: dots must line up with the text they coincide with).
    // Prose and rail-label rows put it at the default 11px; rows that open
    // with a card (a tool chip, a group header, a widget preview) start their
    // first line lower by that card's own padding — measured, not tabulated,
    // because the set of card species is open-ended. The ResizeObserver
    // re-measures when async card content mounts (deferToolContent) or
    // streaming reflows the row; observers exist only on rendered rows, so
    // the count is bounded by the virtualizer's window.
    let turnEl: HTMLDivElement | undefined
    const [dotCentre, setDotCentre] = createSignal(DEFAULT_DOT_CENTRE)
    const [dotSettled, setDotSettled] = createSignal(false)
    const measureDotCentre = () => {
      if (!turnEl || !rail()) return
      const hostTop = turnEl.getBoundingClientRect().top
      // Travelling dot (#265): ONLY the running dot tracks the last
      // prose-fragment card. The done-dot stays at the first text line
      // (top of the row) so the rail reads as a sequence of origin marks.
      const r = rail()
      const isRunning = r && r.last && r.running
      const fragments = isRunning ? turnEl.querySelectorAll("[data-prose-fragment]") : undefined
      const lastFragment = fragments && fragments.length > 0 ? (fragments[fragments.length - 1] as HTMLElement) : null
      const target = lastFragment ?? turnEl
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      let node: Node | null
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getClientRects()[0]
        if (!rect || rect.height === 0) continue
        const centre = rect.top + rect.height / 2 - hostTop
        // When targeting a fragment, the dot can be anywhere down the row
        // (no ceiling). For non-fragment rows the 80px ceiling guards against
        // mid-virtualisation nonsense measurements.
        const maxCentre = lastFragment ? Infinity : 80
        if (centre > 0 && centre < maxCentre) setDotCentre(Math.max(DEFAULT_DOT_CENTRE, Math.round(centre * 2) / 2))
        if (!dotSettled()) setDotSettled(true)
        return
      }
    }
    onMount(() => {
      if (!rail()) return
      measureDotCentre()
      const observer = new ResizeObserver(() => measureDotCentre())
      if (turnEl) observer.observe(turnEl)
      onCleanup(() => observer.disconnect())
    })

    return (
      <div
        id={anchor() ? props.anchor(input.row().userMessageID) : undefined}
        data-message-id={input.row().userMessageID}
        data-timeline-row={input.row()._tag}
        classList={{
          "min-w-0 w-full max-w-full": true,
          "md:max-w-200 2xl:max-w-[1000px]": props.centered,
          "md:mx-auto": props.centered,
          "pt-3": previousAssistantPart(),
        }}
      >
        <div
          ref={turnEl}
          data-component="session-turn"
          class="min-w-0 w-full relative"
          style={{ height: "auto" }}
        >
          <Show when={rail()}>
            {(r) => (
              <ThoughtRail
                first={r().first}
                last={r().last}
                running={r().running}
                dotCentre={dotCentre()}
                settled={dotSettled()}
                turnStartedAt={"turnStartedAt" in input.row() ? (input.row() as any).turnStartedAt : undefined}
                tokens={r().running && r().last ? assistantTokensForTurn(input.row().userMessageID) || undefined : undefined}
              />
            )}
          </Show>
          {/* The gutter is reserved for EVERY assistant part, not only the ones
              that draw a rail. Gating it on rail() left a single-step turn's
              content 16px to the left of a multi-step turn's, so the column
              stepped in and out as turns changed length. */}
          <div classList={{ "min-w-0 w-full": true, [THOUGHT_RAIL_INSET]: assistantPart() }}>
            <Show when={rail() && railLabel()}>{(label) => <ThoughtRailLabel label={label()} />}</Show>
            {input.children}
          </div>
        </div>
      </div>
    )
  }

  const renderTimelineRow = (row: Accessor<TimelineRow.TimelineRow>, onSizeChange?: () => void) => {
    switch (row()._tag) {
      case "TurnGap":
        return <div data-timeline-row="TurnGap" aria-hidden="true" class="h-6" />
      case "CommentStrip": {
        const commentStripRow = row as Accessor<TimelineRowByTag<"CommentStrip">>
        const comments = createMemo(() =>
          getMsgParts(commentStripRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? []),
        )
        return (
          <TimelineRowFrame row={commentStripRow}>
            <div class="w-full px-4 md:px-5 pb-2">
              <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                <div class="flex w-max min-w-full justify-end gap-2">
                  <Index each={comments()}>
                    {(comment) => (
                      <div
                        classList={{
                          "shrink-0 max-w-[260px] rounded-sm border-border-weak-base bg-background-stronger px-2.5 py-2": true,
                          "border-[0.5px]": settings.general.newLayoutDesigns(),
                          border: !settings.general.newLayoutDesigns(),
                        }}
                      >
                        <div class="flex items-center gap-1.5 min-w-0 text-11-medium text-text-strong">
                          <FileIcon node={{ path: comment().path, type: "file" }} class="size-3.5 shrink-0" />
                          <span class="truncate">{getFilename(comment().path)}</span>
                          <Show when={comment().selection}>
                            {(selection) => (
                              <span class="shrink-0 text-text-weak">
                                {selection().startLine === selection().endLine
                                  ? `:${selection().startLine}`
                                  : `:${selection().startLine}-${selection().endLine}`}
                              </span>
                            )}
                          </Show>
                        </div>
                        <div class="pt-1 text-12-regular text-text-strong whitespace-pre-wrap break-words">
                          {comment().comment}
                        </div>
                      </div>
                    )}
                  </Index>
                </div>
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "UserMessage": {
        const userMessageRow = row as Accessor<TimelineRowByTag<"UserMessage">>
        const message = createMemo(() => {
          const m = messageByID().get(userMessageRow().userMessageID)
          if (m?.role === "user") return m
        })
        const messageComments = createMemo(() => {
          if (!settings.general.newLayoutDesigns()) return []
          return getMsgParts(userMessageRow().userMessageID).flatMap((part) => MessageComment.fromPart(part) ?? [])
        })
        return (
          <TimelineRowFrame row={userMessageRow}>
            <Show when={message()}>
              {(message) => (
                <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
                  <div data-slot="session-turn-message-content" aria-live="off">
                    <Message
                      message={message()}
                      parts={getMsgParts(userMessageRow().userMessageID)}
                      actions={props.actions}
                      useV2Actions={settings.general.newLayoutDesigns()}
                      comments={messageComments()}
                    />
                  </div>
                </div>
              )}
            </Show>
          </TimelineRowFrame>
        )
      }
      case "TurnDivider": {
        const turnDividerRow = row as Accessor<TimelineRowByTag<"TurnDivider">>
        return (
          <TimelineRowFrame row={turnDividerRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div data-slot="session-turn-compaction">
                <MessageDivider
                  label={language.t(
                    turnDividerRow().label === "compaction" ? "ui.messagePart.compaction" : "ui.message.interrupted",
                  )}
                />
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "AssistantPart": {
        const assistantPartRow = row as Accessor<TimelineRowByTag<"AssistantPart">>
        return (
          <TimelineRowFrame row={assistantPartRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <div
                data-slot="session-turn-assistant-content"
                aria-hidden={workingTurn(assistantPartRow().userMessageID)}
              >
                {renderAssistantPartGroup(assistantPartRow, onSizeChange)}
              </div>
            </div>
          </TimelineRowFrame>
        )
      }
      case "Thinking": {
        const thinkingRow = row as Accessor<TimelineRowByTag<"Thinking">>
        return (
          <TimelineRowFrame row={thinkingRow}>
            <div
              data-slot="session-turn-message-container"
              class="w-full px-4 md:px-5 relative"
            >
              <TimelineThinkingRow
                reasoningHeading={thinkingRow().reasoningHeading}
                showReasoningSummaries={settings.general.showReasoningSummaries()}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "ThinkingMeta": {
        const metaRow = row as Accessor<TimelineRowByTag<"ThinkingMeta">>
        return (
          <TimelineRowFrame row={metaRow}>
            <div
              data-slot="session-turn-message-container"
              class="w-full px-4 md:px-5 relative"
            >
              <TimelineThinkingMetaRow
                turnDurationMs={metaRow().turnDurationMs}
                tokens={assistantTokensForTurn(metaRow().userMessageID) || undefined}
                onCopy={() => copyTraceForTurn(metaRow().userMessageID)}
              />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Retry": {
        const retryRow = row as Accessor<TimelineRowByTag<"Retry">>
        return (
          <TimelineRowFrame row={retryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <SessionRetry status={sessionStatus()} show={activeMessageID() === retryRow().userMessageID} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "DiffSummary": {
        const diffSummaryRow = row as Accessor<TimelineRowByTag<"DiffSummary">>
        return (
          <TimelineRowFrame row={diffSummaryRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <TimelineDiffSummaryRow diffs={diffSummaryRow().diffs} />
            </div>
          </TimelineRowFrame>
        )
      }
      case "Error": {
        const errorRow = row as Accessor<TimelineRowByTag<"Error">>
        return (
          <TimelineRowFrame row={errorRow}>
            <div data-slot="session-turn-message-container" class="w-full px-4 md:px-5">
              <Card variant="error" class="error-card">
                {errorRow().text}
              </Card>
            </div>
          </TimelineRowFrame>
        )
      }
    }
  }

  function TimelineRowView(props: { row: TimelineRow.TimelineRow; onSizeChange?: () => void }) {
    return renderTimelineRow(() => props.row, props.onSizeChange)
  }

  function VirtualTimelineRow(props: { rowKey: string }) {
    let element: HTMLDivElement
    const initialItem = virtualItemByKey().get(props.rowKey)!
    const initialRow = timelineRowByKey().get(props.rowKey)!
    // Decided once at creation — remounts of an already-entered row get false.
    // A number is the cascade's per-row animation-delay in ms (0 for live rows).
    const enterDelay = shouldAnimateEnter(props.rowKey, initialRow)
    const item = createMemo(() => virtualItemByKey().get(props.rowKey) ?? initialItem)
    const row = createMemo(() => timelineRowByKey().get(props.rowKey) ?? initialRow)
    const tool = () => {
      const value = row()
      if (value._tag !== "AssistantPart" || value.group.type !== "part") return
      const part = getMsgPart(value.group.ref.messageID, value.group.ref.partID)
      if (part?.type === "tool") return part
    }
    const asyncFile = () => ["edit", "write", "apply_patch"].includes(tool()?.tool ?? "")
    const [ready, setReady] = createSignal(initialItem.size <= timelineFallbackItemSize || !asyncFile())
    let contentMeasureFrame: number | undefined

    onMount(() => virtualizer.measureElement(element))

    createEffect(
      on(
        () => item().index,
        () => {
          virtualizer.measureElement(element)
        },
        { defer: true },
      ),
    )

    onCleanup(() => {
      if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
      // NO exit ghost. The site's exit grammar (GONE: up + re-blur) was tried
      // here as a positioned clone of the departing Thinking row and misfired
      // in real use: a body-appended clone escapes the app's theme scope (its
      // color var fell back to the dark-scheme yellow inside a light webview)
      // and the rect captured at cleanup lags the virtualizer's relayout —
      // a wrong-colored flash in the wrong place (Kate 2026-08-25). Removed
      // rows are replaced instantly; the replacing block's entrance carries
      // the transition. Exits in a virtualized timeline need real FLIP
      // machinery or nothing — this is nothing, on purpose.
    })

    return (
      <div
        data-timeline-key={props.rowKey}
        style={{
          position: "absolute",
          top: `${item().start - (showHeader() ? 64 : 0)}px`,
          left: "0",
          width: "100%",
          height: `${item().size}px`,
          overflow: "clip",
          // Rounded virtual measurements can otherwise clip a framed row's outer paint.
          // 24px, not 0.5px: the live rail dot breathes by a 0→4px ring
          // (index.css thought-rail-breathe; found clipped in PR #246's
          // testing), an entering row rides the 8px --motion-enter-rise
          // translate, and the entrance's blur(8px) paints a halo well past
          // the border box — the margin must cover ring + rise + halo.
          "overflow-clip-margin": row()._tag === "TurnGap" ? undefined : "24px",
        }}
      >
        <div
          ref={(value) => {
            element = value
          }}
          data-index={item().index}
          data-timeline-enter={enterDelay !== false ? "" : undefined}
          style={{
            "min-height": ready() ? undefined : `${initialItem.size}px`,
            "animation-delay": enterDelay !== false && enterDelay > 0 ? `${enterDelay}ms` : undefined,
          }}
        >
          <TimelineRowView
            row={row()}
            onSizeChange={() => {
              setReady(true)
              if (contentMeasureFrame !== undefined) cancelAnimationFrame(contentMeasureFrame)
              contentMeasureFrame = scheduleConnectedMeasure(element, virtualizer.measureElement)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div class="relative w-full h-full min-w-0">
      <div
        class="absolute left-1/2 -translate-x-1/2 z-[60] pointer-events-none transition-all duration-200 ease-out"
        classList={{
          "bottom-8": settings.general.newLayoutDesigns(),
          "bottom-6": !settings.general.newLayoutDesigns(),
          "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump,
          "opacity-0 translate-y-2 pointer-events-none": !props.scroll.overflow || !props.scroll.jump,
          "scale-[0.8]": (!props.scroll.overflow || !props.scroll.jump) && settings.general.newLayoutDesigns(),
          "scale-95": (!props.scroll.overflow || !props.scroll.jump) && !settings.general.newLayoutDesigns(),
        }}
      >
        <Show
          when={settings.general.newLayoutDesigns()}
          fallback={
            <button
              type="button"
              aria-label={language.t("session.messages.jumpToLatest")}
              class="pointer-events-auto flex items-center justify-center w-10 h-8 bg-transparent border-none cursor-pointer p-0 group"
              onClick={props.onResumeScroll}
            >
              <div
                class="flex items-center justify-center w-8 h-6 rounded-sm border border-border-weaker-base bg-[color-mix(in_srgb,var(--surface-raised-stronger-non-alpha)_80%,transparent)] backdrop-blur-[0.75px] transition-colors group-hover:border-[var(--border-weak-base)] group-hover:[--icon-base:var(--icon-hover)]"
                style={{
                  "box-shadow":
                    "0 51px 60px 0 rgba(0,0,0,0.10), 0 15px 18px 0 rgba(0,0,0,0.12), 0 6.386px 7.513px 0 rgba(0,0,0,0.12), 0 2.31px 2.717px 0 rgba(0,0,0,0.20)",
                }}
              >
                <Icon name="arrow-down-to-line" size="small" />
              </div>
            </button>
          }
        >
          <button
            type="button"
            aria-label={language.t("session.messages.jumpToLatest")}
            class="pointer-events-auto flex items-center justify-center w-8 h-7 px-2 py-1.5 rounded-lg border-none cursor-pointer text-v2-text-text-base backdrop-blur-[2px]"
            style={{
              background: "color-mix(in srgb, var(--v2-background-bg-base) 92%, transparent)",
              "box-shadow": "var(--v2-elevation-raised), 0px 2px 8px var(--v2-background-bg-base)",
            }}
            onClick={props.onResumeScroll}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M12.3333 8.66665L8 13L3.66667 8.66665M8 12.6667V2.83332"
                stroke="currentColor"
                stroke-linecap="square"
              />
            </svg>
          </button>
        </Show>
      </div>
      <ScrollView
        viewportRef={bindListRoot}
        onWheel={handleListWheel}
        onTouchStart={handleListTouchStart}
        onTouchMove={handleListTouchMove}
        onTouchEnd={handleListTouchEnd}
        onTouchCancel={handleListTouchEnd}
        onPointerDown={handleListPointerDown}
        onPointerMove={handleListPointerMove}
        onKeyDown={handleListKeyDown}
        onScroll={handleListScroll}
        onClick={props.onAutoScrollInteraction}
        class="relative min-w-0 w-full h-full"
        data-entrance-pending={entranceReady() ? undefined : ""}
        style={{
          "--sticky-accordion-top": showHeader() ? "48px" : "0px",
          opacity: scrollReady() ? undefined : "0",
        }}
      >
        <Show when={showHeader()}>
          <div
            data-session-title
            classList={{
              "sticky top-0 z-30": true,
              "bg-[linear-gradient(to_bottom,var(--v2-background-bg-base)_48px,transparent)]":
                settings.general.newLayoutDesigns(),
              "bg-[linear-gradient(to_bottom,var(--background-stronger)_48px,transparent)]":
                !settings.general.newLayoutDesigns(),
              "w-full": true,
              "pb-4": true,
              "pr-3": true,
              "pl-2.5": settings.general.newLayoutDesigns(),
              "pl-2 md:pl-4": !settings.general.newLayoutDesigns(),
              "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered && !settings.general.newLayoutDesigns(),
            }}
          >
            <div class="h-12 w-full flex items-center justify-between gap-2">
              <div
                classList={{
                  "flex items-center gap-1 min-w-0 flex-1": true,
                  "pr-3": !settings.general.newLayoutDesigns(),
                }}
              >
                <div class="flex items-center min-w-0 flex-1 w-full">
                  <Show when={parentID()}>
                    <button
                      type="button"
                      data-slot="session-title-parent"
                      class="min-w-0 max-w-[40%] truncate pl-2 text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-faint transition-colors hover:text-v2-text-text-muted"
                      onClick={navigateParent}
                    >
                      {parentTitle()}
                    </button>
                    <span
                      data-slot="session-title-separator"
                      class="-translate-y-[0.5px] pl-2 pr-1 text-[11px] font-medium text-v2-text-text-faint"
                      aria-hidden="true"
                    >
                      /
                    </span>
                  </Show>
                  <Show when={childTitle() || title.editing}>
                    <Show
                      when={title.editing}
                      fallback={
                        <h1
                          data-slot="session-title-child"
                          classList={{
                            "truncate text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                            "w-fit rounded-sm px-2 py-1 hover:bg-v2-overlay-simple-overlay-hover":
                              settings.general.newLayoutDesigns(),
                            "grow-1 min-w-0": !settings.general.newLayoutDesigns(),
                          }}
                          onClick={openTitleEditor}
                        >
                          {childTitle()}
                        </h1>
                      }
                    >
                      <InlineInput
                        ref={(el) => {
                          titleRef = el
                        }}
                        data-slot="session-title-child"
                        value={title.draft}
                        disabled={titleMutation.isPending}
                        classList={{
                          "block text-[13px] font-[530] leading-4 tracking-[-0.04px] text-v2-text-text-base": true,
                          "w-full flex-1 grow-1 min-w-0 pl-1 -ml-1 rounded-sm": !settings.general.newLayoutDesigns(),
                          "field-sizing-content self-start rounded-sm px-2 py-1 ":
                            settings.general.newLayoutDesigns(),
                        }}
                        style={{
                          "--inline-input-shadow": settings.general.newLayoutDesigns()
                            ? "none"
                            : "var(--shadow-xs-border-select)",
                        }}
                        onInput={(event) => setTitle("draft", event.currentTarget.value)}
                        onKeyDown={(event) => {
                          event.stopPropagation()
                          if (event.key === "Enter") {
                            event.preventDefault()
                            void saveTitleEditor()
                            return
                          }
                          if (event.key === "Escape") {
                            event.preventDefault()
                            closeTitleEditor()
                          }
                        }}
                        onBlur={closeTitleEditor}
                      />
                    </Show>
                  </Show>
                </div>
              </div>
              <Show when={sessionID()} keyed>
                {(id) => (
                  <div
                    classList={{
                      "shrink-0 flex items-center": true,
                      "gap-2": settings.general.newLayoutDesigns(),
                      "gap-3": !settings.general.newLayoutDesigns(),
                    }}
                  >
                    <SessionContextUsage
                      placement="bottom"
                      buttonAppearance={settings.general.newLayoutDesigns() ? "v2" : "default"}
                    />
                    <TooltipV2
                      class="shrink-0"
                      placement="bottom"
                      value={<>{language.t("command.session.compact")}<KeybindV2 keys={["mod", "shift", "c"]} variant="neutral" /></>}
                    >
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="!w-9 shrink-0"
                        onClick={() => command.trigger("session.compact", "palette")}
                        aria-label={language.t("command.session.compact")}
                        icon={<IconV2 name="collapse" />}
                      />
                    </TooltipV2>
                    <Show when={!parentID()}>
                      <Show
                        when={settings.general.newLayoutDesigns()}
                        fallback={
                          <DropdownMenu
                            gutter={4}
                            placement="bottom-end"
                            open={title.menuOpen}
                            onOpenChange={(open) => {
                              setTitle("menuOpen", open)
                              if (open) return
                            }}
                          >
                            <DropdownMenu.Trigger
                              as={IconButton}
                              icon="dot-grid"
                              variant="ghost"
                              class="size-6 rounded-md data-[expanded]:bg-surface-base-active"
                              classList={{
                                "bg-surface-base-active": share.open || title.pendingShare,
                              }}
                              aria-label={language.t("common.moreOptions")}
                              aria-expanded={title.menuOpen || share.open || title.pendingShare}
                              ref={(el: HTMLButtonElement) => {
                                more = el
                              }}
                            />
                            <DropdownMenu.Portal>
                              <DropdownMenu.Content
                                style={{ "min-width": "104px" }}
                                onCloseAutoFocus={(event) => {
                                  if (title.pendingRename) {
                                    event.preventDefault()
                                    setTitle("pendingRename", false)
                                    openTitleEditor()
                                    return
                                  }
                                  if (title.pendingShare) {
                                    event.preventDefault()
                                    requestAnimationFrame(() => {
                                      setShare({ open: true, dismiss: null })
                                      setTitle("pendingShare", false)
                                    })
                                  }
                                }}
                              >
                                <DropdownMenu.Item
                                  onSelect={() => {
                                    setTitle("pendingRename", true)
                                    setTitle("menuOpen", false)
                                  }}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                                <Show when={shareEnabled()}>
                                  <DropdownMenu.Item
                                    onSelect={() => {
                                      setTitle({ pendingShare: true, menuOpen: false })
                                    }}
                                  >
                                    <DropdownMenu.ItemLabel>
                                      {language.t("session.share.action.share")}
                                    </DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </Show>
                                <Show
                                  when={sync().session.get(id)?.time?.archived}
                                  fallback={
                                    <DropdownMenu.Item onSelect={() => void archiveSession(id)}>
                                      <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                                    </DropdownMenu.Item>
                                  }
                                >
                                  <DropdownMenu.Item onSelect={() => void unarchiveSession(id)}>
                                    <DropdownMenu.ItemLabel>{language.t("common.unarchive")}</DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </Show>
                                <DropdownMenu.Separator />
                                <DropdownMenu.Item
                                  onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}
                                >
                                  <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                                </DropdownMenu.Item>
                              </DropdownMenu.Content>
                            </DropdownMenu.Portal>
                          </DropdownMenu>
                        }
                      >
                        <MenuV2
                          gutter={6}
                          placement="bottom-end"
                          open={title.menuOpen}
                          onOpenChange={(open) => {
                            setTitle("menuOpen", open)
                            if (open) return
                          }}
                        >
                          <MenuV2.Trigger
                            as={IconButtonV2}
                            icon={<IconV2 name="outline-dots" />}
                            variant="ghost-muted"
                            size="large"
                            state={share.open || title.pendingShare ? "pressed" : undefined}
                            aria-label={language.t("common.moreOptions")}
                            aria-expanded={title.menuOpen || share.open || title.pendingShare}
                            ref={(el: HTMLButtonElement) => {
                              more = el
                            }}
                          />
                          <MenuV2.Portal>
                            <MenuV2.Content
                              style={{ width: "120px", "min-width": "120px" }}
                              onCloseAutoFocus={(event) => {
                                if (title.pendingRename) {
                                  event.preventDefault()
                                  setTitle("pendingRename", false)
                                  openTitleEditor()
                                  return
                                }
                                if (title.pendingShare) {
                                  event.preventDefault()
                                  requestAnimationFrame(() => {
                                    setShare({ open: true, dismiss: null })
                                    setTitle("pendingShare", false)
                                  })
                                }
                              }}
                            >
                              <MenuV2.Item
                                onSelect={() => {
                                  setTitle("pendingRename", true)
                                  setTitle("menuOpen", false)
                                }}
                              >
                                {language.t("common.rename")}
                              </MenuV2.Item>
                              <Show when={shareEnabled()}>
                                <MenuV2.Item
                                  onSelect={() => {
                                    setTitle({ pendingShare: true, menuOpen: false })
                                  }}
                                >
                                  {language.t("session.share.action.share")}...
                                </MenuV2.Item>
                              </Show>
                              <Show
                                when={sync().session.get(id)?.time?.archived}
                                fallback={
                                  <MenuV2.Item onSelect={() => void archiveSession(id)}>
                                    {language.t("common.archive")}
                                  </MenuV2.Item>
                                }
                              >
                                <MenuV2.Item onSelect={() => void unarchiveSession(id)}>
                                  {language.t("common.unarchive")}
                                </MenuV2.Item>
                              </Show>
                              <MenuV2.Separator />
                              <MenuV2.Item onSelect={() => dialog.show(() => <DialogDeleteSession sessionID={id} />)}>
                                {language.t("common.delete")}...
                              </MenuV2.Item>
                            </MenuV2.Content>
                          </MenuV2.Portal>
                        </MenuV2>
                      </Show>

                      <KobaltePopover
                        open={share.open}
                        anchorRef={() => more}
                        placement="bottom-end"
                        gutter={settings.general.newLayoutDesigns() ? 6 : 4}
                        modal={false}
                        onOpenChange={(open) => {
                          if (open) setShare("dismiss", null)
                          setShare("open", open)
                        }}
                      >
                        <KobaltePopover.Portal>
                          <KobaltePopover.Content
                            data-component="popover-content"
                            classList={{
                              "flex w-80 max-w-none flex-col items-start gap-3 rounded-md border-0 bg-v2-background-bg-layer-01 p-3 shadow-[var(--v2-elevation-floating)]":
                                settings.general.newLayoutDesigns(),
                            }}
                            style={{ "min-width": "320px" }}
                            onEscapeKeyDown={(event) => {
                              setShare({ dismiss: "escape", open: false })
                              event.preventDefault()
                              event.stopPropagation()
                            }}
                            onPointerDownOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onFocusOutside={() => {
                              setShare({ dismiss: "outside", open: false })
                            }}
                            onCloseAutoFocus={(event) => {
                              if (share.dismiss === "outside") event.preventDefault()
                              setShare("dismiss", null)
                            }}
                          >
                            <Show
                              when={settings.general.newLayoutDesigns()}
                              fallback={
                                <div class="flex flex-col p-3">
                                  <div class="flex flex-col gap-1">
                                    <div class="text-13-medium text-text-strong">
                                      {language.t("session.share.popover.title")}
                                    </div>
                                    <div class="text-12-regular text-text-weak">
                                      {shareUrl()
                                        ? language.t("session.share.popover.description.shared")
                                        : language.t("session.share.popover.description.unshared")}
                                    </div>
                                  </div>
                                  <div class="mt-3 flex flex-col gap-2">
                                    <Show
                                      when={shareUrl()}
                                      fallback={
                                        <Button
                                          size="large"
                                          variant="primary"
                                          class="w-full"
                                          onClick={shareSession}
                                          disabled={shareMutation.isPending}
                                        >
                                          {shareMutation.isPending
                                            ? language.t("session.share.action.publishing")
                                            : language.t("session.share.action.publish")}
                                        </Button>
                                      }
                                    >
                                      <div class="flex flex-col gap-2">
                                        <TextField
                                          value={shareUrl() ?? ""}
                                          readOnly
                                          copyable
                                          copyKind="link"
                                          tabIndex={-1}
                                          class="w-full"
                                        />
                                        <div class="grid grid-cols-2 gap-2">
                                          <Button
                                            size="large"
                                            variant="secondary"
                                            class="w-full shadow-none border border-border-weak-base"
                                            onClick={unshareSession}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {unshareMutation.isPending
                                              ? language.t("session.share.action.unpublishing")
                                              : language.t("session.share.action.unpublish")}
                                          </Button>
                                          <Button
                                            size="large"
                                            variant="primary"
                                            class="w-full"
                                            onClick={viewShare}
                                            disabled={unshareMutation.isPending}
                                          >
                                            {language.t("session.share.action.view")}
                                          </Button>
                                        </div>
                                      </div>
                                    </Show>
                                  </div>
                                </div>
                              }
                            >
                              <div class="flex w-full flex-col gap-1.5 px-0.5 pt-0.5">
                                <div class="select-none text-[13px] font-[530] leading-none tracking-[-0.04px] text-v2-text-text-base [font-variation-settings:'slnt'_0]">
                                  {language.t("session.share.popover.title")}
                                </div>
                                <div class="select-none text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-muted [font-variation-settings:'slnt'_0]">
                                  {shareUrl()
                                    ? language.t("session.share.popover.description.shared")
                                    : language.t("session.share.popover.description.unshared")}
                                </div>
                              </div>
                              <div class="flex w-full flex-col gap-2">
                                <Show
                                  when={shareUrl()}
                                  fallback={
                                    <ButtonV2
                                      variant="contrast"
                                      class="w-full"
                                      onClick={shareSession}
                                      disabled={shareMutation.isPending}
                                    >
                                      {shareMutation.isPending
                                        ? language.t("session.share.action.publishing")
                                        : language.t("session.share.action.publish")}
                                    </ButtonV2>
                                  }
                                >
                                  <div class="flex flex-col gap-2">
                                    <div
                                      class="flex h-8 w-full items-center gap-1.5 rounded-sm py-1 pl-2.5 pr-1.5 shadow-[var(--v2-elevation-button-neutral)]"
                                      style={{
                                        background:
                                          "linear-gradient(180deg, var(--v2-alpha-light-2) 0%, var(--v2-alpha-light-0) 100%), var(--v2-background-bg-button-neutral)",
                                      }}
                                    >
                                      <div
                                        class="min-w-0 flex-1 truncate select-text cursor-text text-[13px] font-[440] leading-5 tracking-[-0.04px] text-v2-text-text-base [font-variation-settings:'slnt'_0]"
                                        onClick={selectShareUrlText}
                                      >
                                        {shareUrl()}
                                      </div>
                                      <IconButtonV2
                                        type="button"
                                        size="small"
                                        variant="ghost-muted"
                                        icon={<IconV2 name="outline-copy" />}
                                        aria-label={language.t("session.share.copy.copyLink")}
                                        onClick={copyShareUrl}
                                      />
                                      <IconButtonV2
                                        type="button"
                                        size="small"
                                        variant="ghost-muted"
                                        icon={<IconV2 name="outline-square-arrow" />}
                                        aria-label={language.t("session.share.action.view")}
                                        onClick={viewShare}
                                        disabled={unshareMutation.isPending}
                                      />
                                    </div>
                                    <div class="flex w-full">
                                      <ButtonV2
                                        variant="outline"
                                        class="w-full"
                                        onClick={unshareSession}
                                        disabled={unshareMutation.isPending}
                                      >
                                        {unshareMutation.isPending
                                          ? language.t("session.share.action.unpublishing")
                                          : language.t("session.share.action.unpublish")}
                                      </ButtonV2>
                                    </div>
                                  </div>
                                </Show>
                              </div>
                            </Show>
                          </KobaltePopover.Content>
                        </KobaltePopover.Portal>
                      </KobaltePopover>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
            {/* amicode: problem-header rail (renders only when the session has
                amicode_* parts) + ask/ui bridges — ported from the pre-merge
                message-timeline (AMICODE-PATCHES.md "Upstream sync 2026-08-01") */}
            <AmicodeEntityRail
              messages={sessionMessages()}
              partsFor={getMsgParts}
              fetchProblem={() => amicodeGet(server.current, "/amicode/problem")}
              fetchRunStatus={() => amicodeGet(server.current, "/amicode/run-status")}
              fetchRunSeries={(run, lab) =>
                amicodeGet(
                  server.current,
                  `/amicode/run-series?run=${encodeURIComponent(run)}${lab ? `&lab=${encodeURIComponent(lab)}` : ""}`,
                )
              }
              // Disable rail in chat sessions to prevent showing in unrelated sessions (issue #272)
              disabled={true}
              widgetHost={{
                // Stage 2: the in-chat widget preview reuses the home grid's
                // frame kernel; server context is resolved live per call.
                frameSrc: (id, hash) => {
                  const url = server.current?.http.url
                  return url
                    ? new URL(
                        `/amicode/widget-frame?id=${encodeURIComponent(id)}&h=${encodeURIComponent(hash)}`,
                        url,
                      ).toString()
                    : ""
                },
                callbacks: {
                  fetch: (path) => amicodeGet(server.current, path),
                  action: async () => ({ ok: true }),
                  prompt: (text) => {
                    const id = sessionID()
                    if (id) void sdk().client.session.promptAsync({ sessionID: id, parts: [{ type: "text", text }] })
                  },
                  open: () => {},
                },
                // pin = GET current dashboard, append this widget if absent, POST
                // the full state back (applySave treats the body as the whole
                // state, so a partial POST would wipe other tiles).
                pin: async (id) => {
                  const raw = await amicodeGet(server.current, "/amicode/dashboard")
                  const state: DashboardState = parseDashboardResponse(raw) ?? { version: 1, widget: [] }
                  if (!state.widget.some((e) => e.id === id))
                    state.widget = [...state.widget, { key: id, id, hidden: false, config: {} }]
                  return amicodePost(server.current, "/amicode/dashboard", state)
                },
              }}
              onOpenEntity={openEntityView}
              onDraftPrompt={(text) => draftPrompt(prompt, text)}
              editLabel={language.t("amicode.editInChat")}
              onInspectRun={inAmicode() ? () => postAmicode("amicode.openInspector") : undefined}
              retryLabel={language.t("amicode.retry")}
              unavailableLabel={language.t("amicode.unavailable")}
              onAsk={(text) => {
                const id = sessionID()
                if (!id) return
                void sdk().client.session.promptAsync({ sessionID: id, parts: [{ type: "text", text }] })
              }}
              // Warrant transport (spec-20260727-164748 §9.5). NOT routed through
              // onAsk on purpose: an approval delivered as a chat message would be
              // read by the agent, which would then write the ledger row, leaving
              // the only provenance as "the agent says the user approved".
              warrants={() => warrants() ?? []}
              onApprove={(request) => {
                void amicodePost(server.current, "/amicode/approve", {
                  plan_hash: request.plan_hash,
                  bounds: request.bounds,
                })
                  // Refetch so the card flips to "granted" from the LEDGER rather
                  // than from optimistic local state — same discipline as deriving
                  // state from the durable log in the first place.
                  .then(() => void refetchWarrants())
                  .catch(() => void refetchWarrants())
              }}
            />
            {/* amicode#271: bubble inside the header — naturally below the
                title row + chip rail */}
            <Show when={activeBubble()}>
              {(bubble) => (
                <div
                  data-slot="last-prompt-bubble"
                  class="w-full px-4 md:px-5 pt-2"
                  classList={{ "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered }}
                >
                  <button
                    type="button"
                    class="ml-auto block w-fit max-w-[min(75%,56ch)] text-left cursor-pointer border-none rounded-lg px-3 py-1.5 text-[13px] leading-[18px] font-normal truncate backdrop-blur-[2px]"
                    style={{
                      // the ghost of the prompt bubble keeps the bubble's own
                      // ground, translucent — one grammar for the user's
                      // words on every surface (--prompt-bubble-*: the
                      // inverse, seated per scheme in design-polish.css)
                      background: "color-mix(in srgb, var(--prompt-bubble-bg) 90%, transparent)",
                      color: "var(--prompt-bubble-ink)",
                      "box-shadow": "0 1px 3px color-mix(in srgb, var(--v2-background-bg-base) 40%, transparent)",
                    }}
                    onClick={scrollToBubbleMessage}
                    title={bubble().text}
                  >
                    <span class="opacity-60 text-[11px] font-medium uppercase tracking-wider mr-2">You</span>
                    {bubble().text}
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Show>
        {/* amicode#271: no-header fallback (new untitled sessions only) */}
        <Show when={!showHeader() && activeBubble()}>
          {(_) => {
            const bubble = () => activeBubble()!
            return (
              <div
                data-slot="last-prompt-bubble"
                class="sticky top-0 z-30 w-full px-4 md:px-5 py-2"
                classList={{ "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": props.centered }}
              >
                <button
                  type="button"
                  class="ml-auto block w-fit max-w-[min(75%,56ch)] text-left cursor-pointer border-none rounded-lg px-3 py-1.5 text-[13px] leading-[18px] font-normal truncate backdrop-blur-[2px]"
                  style={{
                    // the ghost of the prompt bubble keeps the bubble's own
                    // ground, translucent — one grammar for the user's
                    // words on every surface (--prompt-bubble-*: the
                    // inverse, seated per scheme in design-polish.css)
                    background: "color-mix(in srgb, var(--prompt-bubble-bg) 90%, transparent)",
                    color: "var(--prompt-bubble-ink)",
                    "box-shadow": "0 1px 3px color-mix(in srgb, var(--v2-background-bg-base) 40%, transparent)",
                  }}
                  onClick={scrollToBubbleMessage}
                  title={bubble().text}
                >
                  <span class="opacity-60 text-[11px] font-medium uppercase tracking-wider mr-2">You</span>
                  {bubble().text}
                </button>
              </div>
            )
          }}
        </Show>
        <div
          data-timeline-virtual-content
          ref={(element) => {
            virtualContent = element
            props.setContentRef(element)
          }}
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          <For each={virtualRowKeys()}>{(rowKey) => <VirtualTimelineRow rowKey={rowKey} />}</For>
          <Show when={timelineRows().length > 0}>
            <div
              data-timeline-row="bottom-spacer"
              aria-hidden="true"
              class="h-6 absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${virtualizer.getTotalSize() - 24}px)` }}
            />
          </Show>
        </div>
      </ScrollView>
    </div>
  )
}
