import { createEffect, createMemo, createResource, createSignal, Match, onMount, Show, startTransition, Switch, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon } from "@opencode-ai/ui/icon"
import { Button } from "@opencode-ai/ui/button"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { LayoutRoute, useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useSettingsDialog } from "@/components/settings-dialog"
import { WindowsAppMenu } from "./windows-app-menu"
import { applyPath, backPath, forwardPath } from "./titlebar-history"
import { TitlebarTabStrip } from "@/components/titlebar-tab-strip"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { readSessionTabsRemovedDetail, SESSION_TABS_REMOVED_EVENT } from "@/components/titlebar-session-events"
import { ProfilePopoverTrigger } from "@/components/profile-popover"
import { useGlobal } from "@/context/global"
import { resolveLandingDirectory } from "@/pages/new-session-landing"
import { ServerConnection, useServer } from "@/context/server"
import { tabHref, useTabs, type Tab } from "@/context/tabs"
import type { PromptSession } from "@/context/prompt"
import { normalizeSessionInfo } from "@/utils/session"
import { channelBadgeText } from "./titlebar-channel"
import "./titlebar.css"

const legacyTitlebarHeight = 40
const v2TitlebarHeight = 36
const minTitlebarZoom = 0.25
const windowsControlsBaseWidth = 138 // 3 native Windows caption buttons at 46px each.
const macTrafficLightsBaseWidth = 84

export type TitlebarUpdate = {
  version: () => string | undefined
  installing: () => boolean
  install: () => void
}

export function useTitlebarRightMount() {
  const [mount, setMount] = createSignal<HTMLElement | null>(null)
  onMount(() => setMount(document.getElementById("opencode-titlebar-right")))
  return mount
}

export function Titlebar(props: { update?: TitlebarUpdate; debugTools?: { visible: boolean; toggle: () => void } }) {
  const layout = useLayout()
  const platform = usePlatform()
  const command = useCommand()
  const language = useLanguage()
  const settings = useSettings()
  const server = useServer()
  const navigate = useNavigate()
  const location = useLocation()
  const params = useParams()
  const useV2Titlebar = createMemo(() => settings.general.newLayoutDesigns())
  const mobile = createMediaQuery("(max-width: 767px)")
  const bottom = createMemo(() => useV2Titlebar() && mobile() && settings.general.mobileTitlebarPosition() === "bottom")

  const mac = createMemo(() => platform.platform === "desktop" && platform.os === "macos")
  const windows = createMemo(() => platform.platform === "desktop" && platform.os === "windows")
  const linux = createMemo(() => platform.platform === "desktop" && platform.os === "linux")
  const web = createMemo(() => platform.platform === "web")
  const macTrafficLights = createMemo(() => mac() && !platform.windowFullscreen?.())
  const zoom = () => platform.webviewZoom?.() ?? 1
  const titlebarZoom = () => (windows() ? Math.max(zoom(), minTitlebarZoom) : zoom())
  const counterZoom = () => (windows() && titlebarZoom() < 1 ? 1 / titlebarZoom() : 1)
  const minHeight = () => {
    const height = useV2Titlebar() ? v2TitlebarHeight : legacyTitlebarHeight
    if (mac()) return `${height / zoom()}px`
    if (windows()) return `${height / Math.min(titlebarZoom(), 1)}px`
    return undefined
  }
  const windowsControlsWidth = () => `${windowsControlsBaseWidth / Math.max(titlebarZoom(), 1)}px`

  // After a dev-tools rebuild + reload, auto-open settings at Developer Tools
  const showDevTools = useSettingsDialog("general", "settings-developer-tools")
  onMount(() => {
    try {
      if (localStorage.getItem("amicode:devtools-reopen") === "1") {
        localStorage.removeItem("amicode:devtools-reopen")
        setTimeout(showDevTools, 300)
      }
    } catch {
      // non-critical
    }
  })

  const [history, setHistory] = createStore({
    stack: [] as string[],
    index: 0,
    action: undefined as "back" | "forward" | undefined,
  })

  const path = () => `${location.pathname}${location.search}${location.hash}`
  const creating = createMemo(() => {
    const route = layout.route()
    if (route.type === "draft" || route.type === "dir-new-sesssion") return true
    if (!params.dir) return false
    if (params.id) return false
    const parts = location.pathname.replace(/\/+$/, "").split("/")
    return parts.at(-1) === "session"
  })

  createEffect(() => {
    const current = path()

    untrack(() => {
      const next = applyPath(history, current)
      if (next === history) return
      setHistory(next)
    })
  })

  const canBack = createMemo(() => history.index > 0)
  const canForward = createMemo(() => history.index < history.stack.length - 1)
  const hasProjects = createMemo(() => layout.projects.list().length > 0)
  const nav = createMemo(() => (useV2Titlebar() ? settings.general.showNavigation() : true))
  const updateState = createMemo<TitlebarUpdatePillState>(() => {
    const installing = props.update?.installing() ?? false
    const version = props.update?.version()
    return {
      visible: version !== undefined || installing,
      installing,
      label: "Update",
      ariaLabel: language.t("toast.update.action.installRestart"),
      title: version ? `Update ${version}` : undefined,
      onInstall: () => props.update?.install(),
    }
  })
  const v2RightState = createMemo<TitlebarV2RightState>(() => ({
    update: updateState(),
  }))

  const back = () => {
    const next = backPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  const forward = () => {
    const next = forwardPath(history)
    if (!next) return
    setHistory(next.state)
    navigate(next.to)
  }

  command.register(() => [
    {
      id: "common.goBack",
      title: language.t("common.goBack"),
      category: language.t("command.category.view"),
      keybind: "mod+[",
      onSelect: back,
    },
    {
      id: "common.goForward",
      title: language.t("common.goForward"),
      category: language.t("command.category.view"),
      keybind: "mod+]",
      onSelect: forward,
    },
  ])

  return (
    <header
      data-slot={useV2Titlebar() ? "titlebar-v2" : undefined}
      classList={{
        "shrink-0 relative flex flex-row": true,
        "h-9 bg-v2-background-bg-deep overflow-visible": useV2Titlebar(),
        "h-10 bg-background-base overflow-hidden": !useV2Titlebar(),
        "order-last": bottom(),
      }}
      style={{
        "min-height": minHeight(),
        // Keep native macOS traffic lights clear even when the desktop window is narrow.
        "padding-left": macTrafficLights() ? `${macTrafficLightsBaseWidth / zoom()}px` : 0,
        width: windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "max-width": windows() ? `env(titlebar-area-width, calc(100vw - ${windowsControlsWidth()}))` : undefined,
        "align-self": windows() ? "flex-start" : undefined,
      }}
      data-tauri-drag-region
    >
      <Switch>
        <Match when={useV2Titlebar()}>
          {(_) => {
            const layout = useLayout()
            const global = useGlobal()

            const tabs = useTabs()
            const tabsStore = tabs.store
            const tabsStoreActions = tabs
            const navigateTab = (tab: Tab) => {
              const href = tabHref(tab)
              if (tab.server === server.key) {
                navigate(href)
                return
              }
              void startTransition(() => {
                server.setActive(tab.server)
                navigate(href)
              })
            }
            const [session] = createResource(
              () => {
                const route = layout.route()
                if (route.type !== "session") return undefined
                const conn = global.servers
                  .list()
                  .find((item) => ServerConnection.key(item) === (route.server ?? server.key))
                return conn ? { route, sdk: global.ensureServerCtx(conn).sdk } : undefined
              },
              ({ route, sdk }) =>
                sdk.api.session
                  .get({ sessionID: route.sessionId })
                  .then(normalizeSessionInfo)
                  .catch(() => {}),
            )

            const matchRoute = (route: LayoutRoute) => {
              if (route.type === "home") return
              if (route.type === "draft") {
                return tabsStore.find((item) => item.type === "draft" && item.draftID === route.draftID)
              }
              if (route.type === "session") {
                const main = tabsStore.find(
                  (item) =>
                    item.type === "session" && item.server === route.server && item.sessionId === route.sessionId,
                )
                if (main) return main
                const s = session()
                if (s?.parentID) {
                  const parentID = s.parentID
                  const parent = tabsStore.find(
                    (item) => item.type === "session" && item.server === route.server && item.sessionId === parentID,
                  )
                  if (parent) return parent
                }
              }
            }

            const currentTab = () => matchRoute(layout.route())

            createEffect(() => {
              const route = layout.route()
              if (!tabs.ready()) return
              const tab = currentTab()
              if (tab) {
                tabs.remember(tab)
                return
              }

              if (route.type === "session") {
                const s = session()
                if (!s) return
                const sessionId = s.parentID ?? s.id
                const next = { server: route.server ?? server.key, sessionId }
                tabsStoreActions.addSessionTab(next)
              }
            })

            makeEventListener(window, SESSION_TABS_REMOVED_EVENT, (event) => {
              const detail = readSessionTabsRemovedDetail(event)
              if (!detail) return
              tabsStoreActions.removeSessions(detail)
            })

            const openNewTab = () => {
              const route = layout.route()
              const activeSession = session()
              if (route.type === "session" && activeSession) {
                const sessionTab = {
                  type: "session" as const,
                  server: route.server ?? server.key,
                  sessionId: activeSession.id,
                }
                const model = tabs.stateValue<PromptSession>(sessionTab, "prompt")?.model.current()
                tabs.newDraft({ server: sessionTab.server, directory: activeSession.directory }, "", model)
                return
              }

              const activeTab = currentTab()
              if (activeTab?.type === "draft") {
                const model = tabs.stateValue<PromptSession>(activeTab, "prompt")?.model.current()
                tabs.newDraft({ server: activeTab.server, directory: activeTab.directory }, "", model)
                return
              }

              if (route.type === "home") {
                const selection = layout.home.selection()
                const conn = global.servers.list().find((item) => ServerConnection.key(item) === selection.server)
                const project = conn
                  ? global
                      .ensureServerCtx(conn)
                      .projects.list()
                      .find((item) => item.worktree === selection.directory)
                  : undefined
                if (conn && project) {
                  tabs.newDraft({ server: ServerConnection.key(conn), directory: project.worktree }, "")
                  return
                }
              }

              const current = layout.projects.list()[0]
              if (current) {
                tabs.newDraft({ server: server.key, directory: current.worktree }, "")
                return
              }

              // Same fallback as NewSessionLanding: a server running outside any
              // registered project must not leave "+" as a silent no-op.
              const fallback = global.servers.list().flatMap((conn) => {
                const ctx = global.ensureServerCtx(conn)
                const directory = resolveLandingDirectory(ctx.projects.list(), ctx.sync.data.project[0]?.worktree)
                return directory ? [{ server: ServerConnection.key(conn), directory }] : []
              })[0]
              if (!fallback) return

              tabs.newDraft({ server: fallback.server, directory: fallback.directory }, "")
            }

            command.register("titlebar-home", () => [])

            command.register("tabs", () => {
              const current = currentTab()

              return [
                {
                  id: "tab.new",
                  category: "tab",
                  title: language.t("command.session.new"),
                  keybind: "mod+t,mod+n",
                  hidden: true,
                  onSelect: openNewTab,
                },
                current && {
                  id: "tab.close",
                  category: "tab",
                  title: language.t("command.tab.close"),
                  keybind: "mod+w",
                  hidden: true,
                  onSelect: () => {
                    tabsStoreActions.closeTab(tabsStore.findIndex((tab) => current === tab))
                  },
                },
                {
                  id: "tab.reopenClosed",
                  category: language.t("command.category.file"),
                  title: language.t("command.tab.reopenClosed"),
                  keybind: "mod+shift+t",
                  onSelect: () => tabsStoreActions.reopenClosedTab(),
                },
              ].filter((v) => v !== undefined)
            })

            const [tabsAreOverflowing, setTabsAreOverflowing] = createSignal(false)

            return (
              <div
                class="h-full flex-1 overflow-hidden flex flex-row items-center gap-1.5 px-2 md:pr-3"
                classList={{
                  "pt-2": !bottom(),
                  "pb-2": bottom(),
                  "md:pl-2": macTrafficLights(),
                  "md:pl-4": !macTrafficLights(),
                }}
              >
                <ChannelIndicator debugTools={props.debugTools} />
                <Show when={windows() || linux()}>
                  <WindowsAppMenu command={command} platform={platform} variant="v2" />
                </Show>
                {/* Profile and Settings live at the trailing edge with the
                    other account/status controls (Sessions, Status, Side
                    Panel) — see TitlebarV2Right. */}
                {/* Removed: sidebar-left toggle button (harmoniqs/amicode#265).
                    The button called layout.sidebar.toggle() but no component in
                    NewLayout observes that signal — WorkbenchPanel only mounts in
                    the legacy SplitFrame path. Re-add here when WorkbenchPanel is
                    ported to layout-new.tsx. */}

                <TitlebarTabStrip
                  tabs={tabsStore}
                  currentTab={currentTab}
                  forceTruncate={tabsAreOverflowing()}
                  onNavigate={(tab, el) => {
                    navigateTab(tab)
                    el?.scrollIntoView({ behavior: "instant" })
                  }}
                  onClose={(tab) => tabsStoreActions.closeTab(tabsStore.findIndex((t) => t === tab))}
                  onReorder={(keys) => tabsStoreActions.reorder(keys)}
                  onOverflowChange={setTabsAreOverflowing}
                />
                <Show when={!(creating() && params.dir)}>
                  <span class="flex shrink-0" data-tour-target="new-chat">
                    <TooltipV2
                      placement="bottom"
                      value={
                        <>
                          {language.t("command.session.new")}
                          <KeybindV2 keys={command.keybindParts("session.new")} variant="neutral" />
                        </>
                      }
                      class="shrink-0"
                    >
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="large"
                        class="shrink-0"
                        icon={<IconV2 name="plus" />}
                        onClick={openNewTab}
                        aria-label={language.t("command.session.new")}
                      />
                    </TooltipV2>
                  </span>
                </Show>
                <div class="flex-1" />
                <TitlebarV2Right state={v2RightState()} />
              </div>
            )
          }}
        </Match>
        <Match when>
          <div
            class="grid h-full min-h-full w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center"
            style={{ zoom: counterZoom() }}
          >
            <div
              classList={{
                "flex items-center min-w-0": true,
                "pl-2": !macTrafficLights(),
              }}
            >
              <Show when={windows() || linux()}>
                <WindowsAppMenu command={command} platform={platform} />
              </Show>
              <Show when={mac()}>
                <div class="xl:hidden w-10 shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <Show when={!mac()}>
                <div class="xl:hidden w-[48px] shrink-0 flex items-center justify-center">
                  <IconButton
                    icon="menu"
                    variant="ghost"
                    class="titlebar-icon rounded-md"
                    onClick={layout.mobileSidebar.toggle}
                    aria-label={language.t("sidebar.menu.toggle")}
                    aria-expanded={layout.mobileSidebar.opened()}
                  />
                </div>
              </Show>
              <div class="flex items-center gap-1 shrink-0">
                <TooltipKeybind
                  class={web() ? "hidden xl:flex shrink-0 ml-14" : "hidden xl:flex shrink-0 ml-2"}
                  placement="bottom"
                  title={language.t("command.sidebar.toggle")}
                  keybind={command.keybind("sidebar.toggle")}
                >
                  <Button
                    variant="ghost"
                    class="group/sidebar-toggle titlebar-icon w-8 h-6 p-0 box-border"
                    onClick={layout.sidebar.toggle}
                    aria-label={language.t("command.sidebar.toggle")}
                    aria-expanded={layout.sidebar.opened()}
                  >
                    <Icon size="small" name={layout.sidebar.opened() ? "sidebar-active" : "sidebar"} />
                  </Button>
                </TooltipKeybind>
                <div class="hidden xl:flex items-center shrink-0">
                  <Show when={params.dir}>
                    <div
                      class="flex items-center shrink-0 w-8 mr-1"
                      aria-hidden={layout.sidebar.opened() ? "true" : undefined}
                    >
                      <div
                        class="transition-opacity"
                        classList={{
                          "opacity-100 duration-120 ease-out": !layout.sidebar.opened(),
                          "opacity-0 duration-120 ease-in delay-0 pointer-events-none": layout.sidebar.opened(),
                        }}
                      >
                       </div>
                    </div>
                  </Show>
                  <div
                    class="flex items-center shrink-0"
                    classList={{
                      "-translate-x-[36px]": layout.sidebar.opened() && !!params.dir,
                      "duration-180 ease-out": !layout.sidebar.opened(),
                      "duration-180 ease-in": layout.sidebar.opened(),
                    }}
                  >
                    <Show when={hasProjects() && nav()}>
                      <div class="flex items-center gap-0 transition-transform">
                        <Tooltip placement="bottom" value={language.t("common.goBack")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-left"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canBack()}
                            onClick={back}
                            aria-label={language.t("common.goBack")}
                          />
                        </Tooltip>
                        <Tooltip placement="bottom" value={language.t("common.goForward")} openDelay={800}>
                          <Button
                            variant="ghost"
                            icon="chevron-right"
                            class="titlebar-icon w-6 h-6 p-0 box-border"
                            disabled={!canForward()}
                            onClick={forward}
                            aria-label={language.t("common.goForward")}
                          />
                        </Tooltip>
                      </div>
                    </Show>
                    <div id="opencode-titlebar-left" class="flex items-center gap-3 min-w-0 px-2" />
                  </div>
                </div>
                <ChannelIndicator debugTools={props.debugTools} />
              </div>
            </div>

            <div class="min-w-0 flex items-center justify-center pointer-events-none">
              <div
                id="opencode-titlebar-center"
                class="pointer-events-auto min-w-0 flex justify-center w-fit max-w-full"
              />
            </div>

            <div
              classList={{
                "flex items-center min-w-0 justify-end": true,
                "pr-2": !windows(),
              }}
              data-tauri-drag-region
            >
              <div id="opencode-titlebar-right" class="flex items-center gap-1 shrink-0 justify-end" />
              <Show when={windows()}>
                <div class="shrink-0" style={{ width: windowsControlsWidth() }} />
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </header>
  )
}

type TitlebarUpdatePillState = {
  visible: boolean
  installing: boolean
  label: string
  ariaLabel: string
  title?: string
  onInstall: () => void
}

type TitlebarV2RightState = {
  update: TitlebarUpdatePillState
}

function TitlebarV2Right(props: { state: TitlebarV2RightState }) {
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const params = useParams()
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const showSettings = () => {
    const sessionID = params.id
    void import("@/components/settings-v2").then((module) => {
      setSettingsOpen(true)
      void dialog.show(
        () => <module.DialogSettings sessionID={sessionID} />,
        () => setSettingsOpen(false),
      )
    })
  }
  return (
    <div class="relative z-20 flex shrink-0 items-center justify-end gap-0 overflow-visible">
      <Show when={props.state.update.visible}>
        <TitlebarUpdateIconButton state={props.state.update} />
      </Show>
      {/* Session-scoped controls (Sessions / Status / Side Panel) portal in here. */}
      <div id="opencode-titlebar-right" class="flex shrink-0 items-center justify-end gap-0" />
      <span class="flex shrink-0" data-tour-target="profile">
        <TooltipV2 placement="bottom" value={language.t("profile.title") || "Profile"} class="shrink-0">
          <ProfilePopoverTrigger />
        </TooltipV2>
      </span>
      <span class="flex shrink-0" data-tour-target="settings">
        <TooltipV2
          placement="bottom"
          value={
            <>
              {language.t("command.settings.open")}
              <KeybindV2 keys={command.keybindParts("settings.open")} variant="neutral" />
            </>
          }
          class="shrink-0"
        >
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="large"
            class="!w-9 shrink-0"
            icon={<IconV2 name="settings-gear" />}
            state={settingsOpen() ? "pressed" : undefined}
            onClick={showSettings}
            aria-label={language.t("command.settings.open")}
          />
        </TooltipV2>
      </span>
    </div>
  )
}

function TitlebarUpdateIconButton(props: { state: TitlebarUpdatePillState }) {
  return (
    <div class="group relative mr-3 h-5 w-5 shrink-0 rounded-full bg-v2-background-bg-deep transition-[width] duration-150 ease-out hover:z-30 hover:w-[68px] focus-within:z-30 focus-within:w-[68px] motion-reduce:transition-none">
      <button
        type="button"
        class="group absolute right-0 top-0 z-10 flex h-5 w-5 items-center justify-end overflow-hidden rounded-full bg-[var(--accent-fill-soft)] text-v2-icon-icon-accent shadow-[inset_0_0_0_1px_var(--accent-edge)] transition-[width,background-color] duration-150 ease-out hover:z-30 hover:w-[68px] focus-visible:z-30 focus-visible:w-[68px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-border-focus-base disabled:opacity-60 disabled:cursor-default motion-reduce:transition-none"
        onClick={props.state.onInstall}
        disabled={props.state.installing}
        aria-busy={props.state.installing}
        aria-label={props.state.ariaLabel}
      >
        <span class="shrink-0 ml-2 mr-px text-[11px] text-v2-text-text-accent font-medium opacity-0 translate-x-2 motion-safe:transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-x-0 group-focus-visible:opacity-100 group-focus-visible:translate-x-0 motion-reduce:translate-x-0">
          Update
        </span>
        <span class="flex size-5 shrink-0 items-center justify-center">
          <Show
            when={!props.state.installing}
            fallback={<span data-slot="titlebar-update-loader" aria-hidden="true" />}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M7 11V3M3.5 7.63128L7 11L10.5 7.63128" stroke="currentColor" />
            </svg>
          </Show>
        </span>
      </button>
    </div>
  )
}

function ChannelIndicator(props: { debugTools?: { visible: boolean; toggle: () => void } }) {
  const channel = import.meta.env.VITE_OPENCODE_CHANNEL
  const settings = useSettings()

  // When the build channel is "dev" AND debug tools are available, render
  // the interactive DEV button (toggles the debug panel). This is the
  // build-plumbing path for local opencode development.
  if (channel === "dev" && props.debugTools) {
    return (
      <button
        type="button"
        class="font-medium px-2 rounded-sm uppercase font-mono cursor-pointer"
        style={{
          // brand chip: yellow fill, ink text, ink edge. Yellow cannot define its
          // own edge on a light ground, so the border is not optional.
          background: "var(--accent)",
          color: "var(--accent-ink)",
          border: "var(--border-width) solid var(--accent-edge-ink)",
        }}
        onClick={props.debugTools.toggle}
        aria-label="Toggle debug tools"
        aria-pressed={props.debugTools.visible}
      >
        DEV
      </button>
    )
  }

  // For release builds: show DEV when developer mode is enabled in settings
  // (so the user knows they're running against a local binary/asset override),
  // BETA when running a pre-release channel, or nothing on prod.
  const badgeText = () => channelBadgeText(channel, settings.developer.enabled())
  const badgeSlot = () => (badgeText() === "DEV" ? "amicode-dev-tag" : "amicode-beta-tag")

  return (
    <>
      {badgeText() && (
        <div data-slot={badgeSlot()} class="font-medium px-2 rounded-sm uppercase font-mono">
          {badgeText()}
        </div>
      )}
    </>
  )
}
