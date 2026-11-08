import { createEffect, createMemo, createResource, createRoot, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { makeEventListener } from "@solid-primitives/event-listener"
import { DragDropProvider, PointerSensor } from "@dnd-kit/solid"
import { isSortable, useSortable } from "@dnd-kit/solid/sortable"
import { Accessibility, AutoScroller, Feedback, PointerActivationConstraints } from "@dnd-kit/dom"
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { arrayMove } from "@dnd-kit/helpers"
import { tabHref, tabKey, type SessionTab, type Tab } from "@/context/tabs"
import { ServerConnection } from "@/context/server"
import { DraftTabItem, TabNavItem } from "@/components/titlebar-tab-nav"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useTabs } from "@/context/tabs"
import { createTabPromptState } from "@/context/prompt"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { getFilename } from "@opencode-ai/core/util/path"
import { showToast } from "@/utils/toast"
import { canStartTabDrag, isTabCloseTarget } from "./titlebar-tab-gesture"
import { adjacentTabKey, mergeVisibleTabOrder } from "./titlebar-tab-order"
import {
  arrangeTabs,
  closeFinishedKeys,
  closeGroupKeys,
  closeOtherKeys,
  closeRightKeys,
  readSpawnedBy,
  type ArrangedTab,
} from "./titlebar-tab-arrange"
import type { TabMenu } from "./titlebar-tab-menu"
import { TabListMenu, type TabListRow } from "./titlebar-tab-list"
import type { Session } from "@opencode-ai/sdk/v2"
import { useControlProjectionForConnection } from "@/components/session/session-fleet-control-projection"
import { drivingBannerFromProjection, drivenByBannerFromProjection } from "@/components/session/session-fleet-peers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { sessionTabStatus, type SessionTabStatus } from "@/pages/layout/session-tab-status"

// amicode(#2154): a tab never squeezes below 160px (min-w-40, ~18 characters
// of title) — past that the strip scrolls instead and the all-tabs list takes
// over. The active tab keeps its full 224px so the title you are on is always
// legible. A pinned tab is a fixed 36px status-dot tab.
const SLOT_CLASS = "relative flex w-56 min-w-40 max-w-56 flex-shrink"
const ACTIVE_SLOT_CLASS = "relative flex w-56 max-w-56 shrink-0"
const PINNED_SLOT_CLASS = "relative flex w-9 shrink-0"
const slotClass = (input: { pinned?: boolean; active: boolean }) =>
  input.pinned ? PINNED_SLOT_CLASS : input.active ? ACTIVE_SLOT_CLASS : SLOT_CLASS

// A spawn stamp written moments after the tab opened (fork → PATCH) may not
// be there on the first look; only cache "not spawned" for older sessions.
const SPAWN_STAMP_GRACE_MS = 120_000

const TAB_LIST_KEYBIND = "mod+alt+a"

function SessionTabSlot(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  arrangement: () => ArrangedTab | undefined
  forceTruncate: boolean
  session: () => Session | undefined
  fallbackTitle?: string
  note?: string
  menu: () => TabMenu
  drivingMachineId?: () => string | undefined
  drivenByMachine?: () => { machineId: string; machineName: string } | undefined
  onRename: (title: string) => Promise<void>
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement
  const pinned = () => !!props.tab.pinned

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      data-pinned={pinned() || undefined}
      data-group-edge={props.arrangement()?.groupEdge}
      data-depth={props.arrangement()?.depth}
      class={slotClass({ pinned: pinned(), active: props.active() })}
    >
      <TabNavItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        server={props.tab.server}
        session={props.session}
        fallbackTitle={props.fallbackTitle}
        note={props.note}
        pinned={pinned()}
        menu={props.menu}
        drivingMachineId={props.drivingMachineId}
        drivenByMachine={props.drivenByMachine}
        onRename={props.onRename}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        forceTruncate={props.forceTruncate}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

/** Reports a loaded session's status dot up to the strip (for "Close finished"
 *  and the all-tabs list). Mounted only once the session's directory is known. */
function SessionStatusReporter(props: {
  server: ServerConnection.Key
  directory: string
  sessionId: string
  onStatus: (status: SessionTabStatus | undefined) => void
}) {
  const state = useSessionTabAvatarState(
    () => props.server,
    () => props.directory,
    () => props.sessionId,
  )
  createEffect(() =>
    props.onStatus(
      sessionTabStatus({
        loading: state.loading(),
        needsAttention: state.needsAttention(),
        hasError: state.hasError(),
        unread: state.unread(),
      }),
    ),
  )
  onCleanup(() => props.onStatus(undefined))
  return null
}

function SessionTabEntry(props: {
  tab: SessionTab
  id: string
  index: () => number
  active: () => boolean
  arrangement: () => ArrangedTab | undefined
  forceTruncate: boolean
  serverCtx: () => ServerCtx | undefined
  note?: string
  menu: () => TabMenu
  drivingMachineId?: () => string | undefined
  drivenByMachine?: () => { machineId: string; machineName: string } | undefined
  onVisibleChange: (visible: boolean) => void
  onStatusChange: (status: SessionTabStatus | undefined) => void
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const tabs = useTabs()
  const language = useLanguage()
  const sdk = createMemo(() => props.serverCtx()?.sdk ?? null)
  const cachedSession = createMemo(() => props.serverCtx()?.sync.session.peek(props.tab.sessionId))
  const persisted = createMemo(() => tabs.info[props.id])
  const [loadedSession] = createResource(
    () => {
      const ctx = props.serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const session = createMemo(() => cachedSession() ?? loadedSession())
  const missingSession = createMemo(() => !!props.serverCtx() && !loadedSession.loading && !session())
  const visible = createMemo(() => !!session() || loadedSession.loading || missingSession() || !!persisted()?.title)
  let prefetched = false
  let spawnChecked = false

  const rename = async (title: string) => {
    const value = session()
    const ctx = props.serverCtx()
    if (!value || !ctx) return

    ctx.sync.session.remember({ ...value, title })
    try {
      await ctx.sdk.api.session.rename({ sessionID: value.id, title })
    } catch (err) {
      const current = session()
      const currentCtx = props.serverCtx()
      if (current && currentCtx) currentCtx.sync.session.remember({ ...current, title: value.title })
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }

  createEffect(() => props.onVisibleChange(visible()))

  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value || prefetched) return
    prefetched = true
    createRoot((dispose) => {
      try {
        void ctx.sync
          .ensureDirSyncContext(value.directory)
          .session.sync(value.id)
          .catch(() => {})
          .finally(dispose)
      } catch {
        dispose()
      }
    })
  })

  createEffect(() => {
    const value = session()
    if (!value) return
    tabs.rememberSessionInfo(props.tab, value)
    const current = sdk()
    if (!current) return
    createTabPromptState(tabs, props.tab, current.scope, {
      dir: base64Encode(value.directory),
      id: value.id,
    })
  })

  // amicode(#2154): which session spawned this one (the amicode_session
  // stamp, `metadata.spawned_by`). The v2 session info the sync layer keeps
  // carries no metadata, so ask the session endpoint once; the answer is
  // cached on the tab's info so cold restores group without a fetch.
  createEffect(() => {
    const ctx = props.serverCtx()
    const value = session()
    if (!ctx || !value) return
    const stamped = readSpawnedBy((value as { metadata?: unknown }).metadata)
    if (stamped) {
      tabs.rememberSpawnedBy(props.tab, stamped)
      return
    }
    if (persisted()?.spawnedBy !== undefined || spawnChecked) return
    spawnChecked = true
    void ctx.sdk.client.session
      .get({ sessionID: value.id })
      .then((result) => {
        const spawnedBy = readSpawnedBy(result.data?.metadata)
        if (spawnedBy) tabs.rememberSpawnedBy(props.tab, spawnedBy)
        else if (Date.now() - value.time.created > SPAWN_STAMP_GRACE_MS) tabs.rememberSpawnedBy(props.tab, null)
      })
      .catch(() => {})
  })

  return (
    <>
      <Show when={session()?.directory}>
        {(directory) => (
          <SessionStatusReporter
            server={props.tab.server}
            directory={directory()}
            sessionId={props.tab.sessionId}
            onStatus={props.onStatusChange}
          />
        )}
      </Show>
      <Show when={visible()}>
        <SessionTabSlot
          tab={props.tab}
          id={props.id}
          index={props.index}
          active={props.active}
          arrangement={props.arrangement}
          forceTruncate={props.forceTruncate}
          session={session}
          note={props.note}
          menu={props.menu}
          drivingMachineId={props.drivingMachineId}
          drivenByMachine={props.drivenByMachine}
          fallbackTitle={persisted()?.title ?? (missingSession() ? language.t("session.tab.unknown") : loadedSession.loading ? "\u2026" : undefined)}
          onRename={rename}
          onNavigate={props.onNavigate}
          onClose={props.onClose}
        />
      </Show>
    </>
  )
}

function DraftTabSlot(props: {
  tab: Extract<Tab, { type: "draft" }>
  id: string
  index: () => number
  active: () => boolean
  title: string
  menu: () => TabMenu
  onNavigate: (element: HTMLDivElement) => void
  onClose: () => void
}) {
  const sortable = useSortable({
    get id() {
      return props.id
    },
    get index() {
      return props.index()
    },
  })
  let ref!: HTMLDivElement

  return (
    <div
      ref={sortable.ref}
      data-titlebar-tab-slot
      data-tab-key={props.id}
      data-active={props.active()}
      class={slotClass({ active: props.active() })}
    >
      <DraftTabItem
        ref={(el) => {
          ref = el
        }}
        href={tabHref(props.tab)}
        title={props.title}
        menu={props.menu}
        onNavigate={() => props.onNavigate(ref)}
        onClose={props.onClose}
        active={props.active()}
        dragging={sortable.isDragSource()}
      />
    </div>
  )
}

export function TitlebarTabStrip(props: {
  tabs: Tab[]
  currentTab: () => Tab | undefined
  forceTruncate: boolean
  onNavigate: (tab: Tab, el?: HTMLDivElement) => void
  onClose: (tab: Tab) => void
  onReorder: (keys: string[]) => void
  onOverflowChange: (overflowing: boolean) => void
}) {
  const global = useGlobal()
  const language = useLanguage()
  const command = useCommand()
  const tabs = useTabs()

  // Fleet driving indicator: acquire the shared control projection (same
  // ref-counted singleton the session header's composer scrim consumes — no
  // duplicate polling). For each session tab we derive a drivingMachineId;
  // the tab renders a monitor icon when non-null.
  const primaryConn = createMemo(() => global.servers.list()[0])
  const controlProjection = useControlProjectionForConnection(primaryConn)

  let scrollRef!: HTMLDivElement
  let listRef!: HTMLDivElement
  let resizeFrame: number | undefined
  const [visibility, setVisibility] = createStore<Record<string, boolean>>({})
  const [statuses, setStatuses] = createStore<Record<string, SessionTabStatus | undefined>>({})
  const [overflowing, setOverflowing] = createSignal(false)
  const [listOpen, setListOpen] = createSignal(false)

  const tabByKey = createMemo(() => new Map(props.tabs.map((tab) => [tabKey(tab), tab])))
  const visibleTabs = createMemo(() => props.tabs.filter((tab) => tab.type === "draft" || visibility[tabKey(tab)]))

  // amicode(#2154): the spawn parent's tab key, when that tab is open.
  const parentKeyOf = (tab: Tab) => {
    if (tab.type !== "session") return undefined
    const spawnedBy = tabs.info[tabKey(tab)]?.spawnedBy
    if (!spawnedBy) return undefined
    return tabKey({ type: "session", server: tab.server, sessionId: spawnedBy })
  }

  // Display order: pinned first, then spawned sessions after their parent.
  const arranged = createMemo(() =>
    arrangeTabs(
      visibleTabs().map((tab) => ({
        key: tabKey(tab),
        pinned: tab.type === "session" && !!tab.pinned,
        parentKey: parentKeyOf(tab),
      })),
    ),
  )
  const arrangedKeys = createMemo(() => arranged().map((tab) => tab.key))
  const arrangementByKey = createMemo(() => new Map(arranged().map((tab, index) => [tab.key, { tab, index }])))
  // Rendered order: the arranged visible tabs, then the not-yet-visible ones
  // (they render nothing until their session resolves). Store proxies keep
  // their identity, so <For> moves entries instead of re-creating them.
  const renderTabs = createMemo(() => {
    const byKey = tabByKey()
    const shown = arrangedKeys()
      .map((key) => byKey.get(key))
      .filter((tab): tab is Tab => !!tab)
    const placed = new Set(arrangedKeys())
    return [...shown, ...props.tabs.filter((tab) => !placed.has(tabKey(tab)))]
  })

  const activeKey = () => {
    const current = props.currentTab()
    return current ? tabKey(current) : undefined
  }

  const titleOf = (tab: Tab) =>
    tab.type === "draft" ? language.t("command.session.new") : (tabs.info[tabKey(tab)]?.title ?? language.t("session.tab.unknown"))

  const spawnNote = (tab: Tab) => {
    if (tab.type !== "session") return undefined
    const parentKey = parentKeyOf(tab)
    if (!parentKey) return undefined
    const parent = tabs.info[parentKey]?.title
    return parent ? `Spawned from “${parent}”` : "Spawned from another session"
  }

  // The right-click menu: what each bulk close would close, computed when
  // the menu opens (the content only renders while open).
  const menuFor = (tab: Tab) => (): TabMenu => {
    const key = tabKey(tab)
    const list = arranged()
    const active = activeKey()
    const others = closeOtherKeys(list, key)
    const right = closeRightKeys(list, key)
    const finished = closeFinishedKeys(list, (k) => statuses[k], active)
    const group = closeGroupKeys(list, key)
    const afterGroup = () => {
      const keys = list.map((item) => item.key)
      const first = keys.findIndex((k) => group.includes(k))
      const neighbour = keys.slice(first).find((k) => !group.includes(k)) ?? keys.slice(0, first).findLast(() => true)
      return neighbour ? tabByKey().get(neighbour) : undefined
    }
    return {
      pinned: tab.type === "session" ? !!tab.pinned : undefined,
      onTogglePin: tab.type === "session" ? () => tabs.setPinned(tab, !tab.pinned) : undefined,
      closeOthers: others.length,
      closeRight: right.length,
      closeFinished: finished.length,
      group: group.length,
      onCloseOthers: () => tabs.closeMany(others, { anchor: tab, activeKey: active }),
      onCloseRight: () => tabs.closeMany(right, { anchor: tab, activeKey: active }),
      onCloseFinished: () => tabs.closeMany(finished, { activeKey: active }),
      onCloseGroup: () => tabs.closeMany(group, { anchor: afterGroup(), activeKey: active }),
    }
  }

  const listRows = (): TabListRow[] => {
    const active = activeKey()
    return arranged().flatMap((item) => {
      const tab = tabByKey().get(item.key)
      if (!tab) return []
      const directory = tab.type === "draft" ? tab.directory : tabs.info[item.key]?.directory
      return [
        {
          key: item.key,
          title: titleOf(tab),
          project: directory ? getFilename(directory) : undefined,
          status: statuses[item.key],
          pinned: item.pinned,
          depth: item.depth,
          active: item.key === active,
          draft: tab.type === "draft",
        },
      ]
    })
  }

  command.register("titlebar-tab-cycle", () => [
    {
      id: `tab.prev`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowLeft,ctrl+shift+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(-1),
    },
    {
      id: `tab.next`,
      category: "tab",
      title: "",
      keybind: `mod+option+ArrowRight,ctrl+tab`,
      hidden: true,
      onSelect: () => selectAdjacentTab(1),
    },
    {
      id: `tab.list`,
      category: "tab",
      title: "Show all tabs",
      keybind: TAB_LIST_KEYBIND,
      onSelect: () => setListOpen(true),
    },
  ])

  function selectAdjacentTab(offset: -1 | 1) {
    const key = adjacentTabKey(arrangedKeys(), activeKey(), offset)
    const next = key ? tabByKey().get(key) : undefined
    if (next) props.onNavigate(next)
  }

  function slotFor(key: string): HTMLElement | undefined {
    if (!listRef) return undefined
    return [...listRef.querySelectorAll<HTMLElement>("[data-titlebar-tab-slot]")].find((el) => el.dataset.tabKey === key)
  }

  function refreshOverflow() {
    if (!scrollRef) return
    const next = scrollRef.scrollWidth > scrollRef.clientWidth
    setOverflowing(next)
    props.onOverflowChange(next)
  }

  createResizeObserver(
    () => [scrollRef, listRef],
    () => {
      if (resizeFrame !== undefined) return
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined
        refreshOverflow()
      })
    },
  )

  onMount(() => {
    refreshOverflow()
    // amicode(#2154): a vertical mouse wheel scrolls the strip sideways.
    makeEventListener(
      scrollRef,
      "wheel",
      (event: WheelEvent) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
        if (scrollRef.scrollWidth <= scrollRef.clientWidth) return
        scrollRef.scrollLeft += event.deltaY
        event.preventDefault()
      },
      { passive: false },
    )
  })

  onCleanup(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
  })

  createEffect(() => {
    props.tabs.length
    arrangedKeys()
    refreshOverflow()
  })

  // amicode(#2154): however the active tab changes — click, keybind, palette,
  // Sessions dropdown, all-tabs list — bring it into view.
  createEffect(
    on([activeKey, arrangedKeys], ([key]) => {
      if (!key) return
      requestAnimationFrame(() => slotFor(key)?.scrollIntoView({ block: "nearest", inline: "nearest" }))
    }),
  )

  return (
    <div data-slot="titlebar-tabs" data-tour-target="tabs" class="relative flex min-w-0 flex-row items-center gap-1">
      <div class="relative min-w-0">
        <div
          data-slot="titlebar-tabs-scroll"
          class="flex min-w-0 flex-row items-center gap-1.5 overflow-x-auto no-scrollbar [app-region:no-drag]"
          ref={scrollRef}
        >
          <DragDropProvider
            sensors={[
              PointerSensor.configure({
                activationConstraints: [new PointerActivationConstraints.Distance({ value: 4 })],
                preventActivation: (event) =>
                  !canStartTabDrag(event.pointerType) ||
                  isTabCloseTarget(event.target) ||
                  (event.target instanceof Element && !!event.target.closest('[contenteditable="true"]')),
              }),
            ]}
            modifiers={[RestrictToHorizontalAxis, RestrictToElement.configure({ element: () => listRef })]}
            plugins={(defaults) => [
              ...defaults.filter((plugin) => plugin !== Accessibility),
              AutoScroller.configure({ acceleration: 8, threshold: { x: 0.05, y: 0 } }),
              Feedback.configure({ dropAnimation: null }),
            ]}
            onDragStart={(event) => {
              const source = event.operation.source
              if (!source) return
              const tab = tabByKey().get(source.id.toString())
              if (!tab) return
              const tabEl = source.element?.querySelector<HTMLDivElement>("[data-titlebar-tab]")
              props.onNavigate(tab, tabEl ?? undefined)
            }}
            onDragEnd={(event) => {
              const current = arrangedKeys()
              const source = event.operation.source
              if (event.canceled || !isSortable(source)) return

              const { initialIndex, index } = source
              if (initialIndex !== index) {
                // The drop rewrites the stored order; the arrangement is then
                // re-derived, so a dragged parent carries its spawned tabs and
                // a drop across the pinned boundary settles back on its side.
                props.onReorder(
                  mergeVisibleTabOrder(
                    props.tabs.map(tabKey),
                    current,
                    arrayMove(current, source.initialIndex, source.index),
                  ),
                )
              }
            }}
          >
            <div data-titlebar-tab-list class="flex w-full min-w-0 flex-row items-center" ref={listRef}>
              <For each={renderTabs()}>
                {(tab) => {
                  const id = tabKey(tab)
                  let ref!: HTMLDivElement
                  const arrangement = () => arrangementByKey().get(id)
                  const visibleIndex = () => arrangement()?.index ?? -1
                  useTabShortcut(visibleIndex, () => props.onNavigate(tab, ref))
                  const serverCtx = createMemo(() => {
                    if (tab.type !== "session") return
                    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
                    if (conn) return global.ensureServerCtx(conn)
                  })

                  if (tab.type === "session") {
                    const drivingMachineId = createMemo(() => {
                      const driving = drivingBannerFromProjection(controlProjection(), tab.sessionId)
                      return driving?.machineId
                    })
                    const drivenByMachine = createMemo(() => {
                      const driven = drivenByBannerFromProjection(controlProjection(), tab.sessionId)
                      return driven ?? undefined
                    })
                    return (
                      <SessionTabEntry
                        tab={tab}
                        id={id}
                        index={visibleIndex}
                        active={() => props.currentTab() === tab}
                        arrangement={() => arrangement()?.tab}
                        forceTruncate={props.forceTruncate}
                        serverCtx={serverCtx}
                        note={spawnNote(tab)}
                        menu={menuFor(tab)}
                        drivingMachineId={drivingMachineId}
                        drivenByMachine={drivenByMachine}
                        onVisibleChange={(visible) => setVisibility(id, visible)}
                        onStatusChange={(status) => setStatuses(id, status)}
                        onNavigate={(element) => {
                          ref = element
                          props.onNavigate(tab, element)
                        }}
                        onClose={() => props.onClose(tab)}
                      />
                    )
                  }

                  return (
                    <DraftTabSlot
                      tab={tab}
                      id={id}
                      index={visibleIndex}
                      active={() => props.currentTab() === tab}
                      title={language.t("command.session.new")}
                      menu={menuFor(tab)}
                      onNavigate={(element) => {
                        ref = element
                        props.onNavigate(tab, element)
                      }}
                      onClose={() => props.onClose(tab)}
                    />
                  )
                }}
              </For>
            </div>
          </DragDropProvider>
        </div>
        <div
          data-slot="titlebar-tabs-fade-left"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-[linear-gradient(to_right,var(--v2-background-bg-deep),transparent)]"
        />
        <div
          data-slot="titlebar-tabs-fade-right"
          aria-hidden="true"
          class="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-[linear-gradient(to_left,var(--v2-background-bg-deep),transparent)]"
        />
      </div>
      {/* The list is reachable from the keybind/palette at any time; its
          chevron shows only once the tabs no longer fit. */}
      <Show when={overflowing() || listOpen()}>
        <TabListMenu
          rows={listRows}
          open={listOpen()}
          onOpenChange={setListOpen}
          keybind={command.keybind("tab.list") || undefined}
          onSelect={(key) => {
            const tab = tabByKey().get(key)
            if (tab) props.onNavigate(tab)
          }}
        />
      </Show>
    </div>
  )
}

function useTabShortcut(index: () => number, onSelect: () => void) {
  const command = useCommand()

  command.register(() => {
    const number = index() + 1
    if (number < 1 || number > 9) return []
    return [
      {
        id: `tab.${number}`,
        category: "tab",
        title: "",
        keybind: `mod+${number}`,
        hidden: true,
        onSelect,
      },
    ]
  })
}
