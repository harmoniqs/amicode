import { AmicoSpinner } from "@opencode-ai/ui/amico-spinner"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Button } from "@opencode-ai/ui/button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Keybind } from "@opencode-ai/ui/keybind"
import { writeClipboardViaBridge } from "@/components/prompt-input/clipboard-bridge"
import { showToast } from "@/utils/toast"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"

import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { getFilename } from "@opencode-ai/core/util/path"
import { batch, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Portal } from "solid-js/web"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useServer, ServerConnection } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { useTerminal } from "@/context/terminal"
import { focusTerminalById } from "@/pages/session/helpers"
import { useSessionLayout } from "@/pages/session/session-layout"
import { messageAgentColor } from "@/utils/agent"
import { decode64 } from "@/utils/base64"
import { fileManagerApp } from "@/utils/file-manager"
import { Persist, persisted } from "@/utils/persist"
import { sessionTitle } from "@/utils/session-title"
import { SessionTabStatusDot, sessionTabStatus } from "@/pages/layout/session-tab-status"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { StatusPopover, StatusPopoverV2 } from "../status-popover"
import { statusTriggerVisibility } from "../status-popover-model"
import { useServerSync } from "@/context/server-sync"
import { useGlobal } from "@/context/global"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { sessionListDirectories, sortedRootSessions } from "@/pages/layout/helpers"
import { useNavigate } from "@solidjs/router"
import type { Session } from "@opencode-ai/sdk/v2/client"

// AMICODE: the MCP/LSP/Plugins/Vaults status popover is opencode-operator
// noise here ("No MCPs configured"). Hidden, not deleted — the trigger slot is
// where a solver-health panel (server/Julia env/runs dir) belongs later.
// Un-hidden 2026-07-20 (amicode#159 test drive): the 7/7 hide targeted the
// popover's then-only content (upstream MCP/LSP operator noise). It now hosts
// the amicode-first Vaults + Connections tabs — hiding it orphaned both.
const AMICODE_HIDE_STATUS_POPOVER = false
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { reviewTooltipKeybind } from "../command-tooltip-keybind"
import { useTitlebarRightMount, useTitlebarControlMount } from "../titlebar"

const OPEN_APPS = [
  "vscode",
  "cursor",
  "zed",
  "textmate",
  "antigravity",
  "finder",
  "terminal",
  "iterm2",
  "ghostty",
  "warp",
  "xcode",
  "android-studio",
  "powershell",
  "sublime-text",
] as const

type OpenApp = (typeof OPEN_APPS)[number]
type OS = "macos" | "windows" | "linux" | "unknown"

const MAC_APPS = [
  {
    id: "vscode",
    label: "session.header.open.app.vscode",
    icon: "vscode",
    openWith: "Visual Studio Code",
  },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "Cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "Zed" },
  { id: "textmate", label: "session.header.open.app.textmate", icon: "textmate", openWith: "TextMate" },
  {
    id: "antigravity",
    label: "session.header.open.app.antigravity",
    icon: "antigravity",
    openWith: "Antigravity",
  },
  { id: "terminal", label: "session.header.open.app.terminal", icon: "terminal", openWith: "Terminal" },
  { id: "iterm2", label: "session.header.open.app.iterm2", icon: "iterm2", openWith: "iTerm" },
  { id: "ghostty", label: "session.header.open.app.ghostty", icon: "ghostty", openWith: "Ghostty" },
  { id: "warp", label: "session.header.open.app.warp", icon: "warp", openWith: "Warp" },
  { id: "xcode", label: "session.header.open.app.xcode", icon: "xcode", openWith: "Xcode" },
  {
    id: "android-studio",
    label: "session.header.open.app.androidStudio",
    icon: "android-studio",
    openWith: "Android Studio",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const WINDOWS_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "powershell",
    label: "session.header.open.app.powershell",
    icon: "powershell",
    openWith: "powershell",
  },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const LINUX_APPS = [
  { id: "vscode", label: "session.header.open.app.vscode", icon: "vscode", openWith: "code" },
  { id: "cursor", label: "session.header.open.app.cursor", icon: "cursor", openWith: "cursor" },
  { id: "zed", label: "session.header.open.app.zed", icon: "zed", openWith: "zed" },
  {
    id: "sublime-text",
    label: "session.header.open.app.sublimeText",
    icon: "sublime-text",
    openWith: "Sublime Text",
  },
] as const

const detectOS = (platform: ReturnType<typeof usePlatform>): OS => {
  if (platform.platform === "desktop" && platform.os) return platform.os
  if (typeof navigator !== "object") return "unknown"
  const value = navigator.platform || navigator.userAgent
  if (/Mac/i.test(value)) return "macos"
  if (/Win/i.test(value)) return "windows"
  if (/Linux/i.test(value)) return "linux"
  return "unknown"
}

const showRequestError = (language: ReturnType<typeof useLanguage>, err: unknown) => {
  showToast({
    variant: "error",
    title: language.t("common.requestFailed"),
    description: err instanceof Error ? err.message : String(err),
  })
}

export function SessionHeader() {
  const layout = useLayout()
  const command = useCommand()
  const server = useServer()
  const platform = usePlatform()
  const language = useLanguage()
  const settings = useSettings()
  const sync = useSync()
  const terminal = useTerminal()
  const { params, view } = useSessionLayout()

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const name = createMemo(() => {
    const current = project()
    if (current) return current.name || getFilename(current.worktree)
    return getFilename(projectDirectory())
  })
  const hotkey = createMemo(() => command.keybind("file.open"))
  const os = createMemo(() => detectOS(platform))
  const isV2 = settings.general.newLayoutDesigns
  const isDesktopV2 = createMemo(() => platform.platform === "desktop" && settings.general.newLayoutDesigns())
  const search = createMemo(() => (isDesktopV2() ? settings.general.showSearch() : true))
  // AMICODE (#174 AC2): unlike its siblings above, showStatus no longer gates
  // the whole trigger — the popover now hosts the global Connections + Vaults
  // tabs, and the setting defaults OFF, which orphaned them in every session.
  // The settings row sells "server status", so that is all it scopes now: the
  // health dot. Policy + rationale live in status-popover-model.ts (tested).
  const statusVis = createMemo(() =>
    statusTriggerVisibility({ desktopV2: isDesktopV2(), showStatus: settings.general.showStatus() }),
  )
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const [exists, setExists] = createStore<Partial<Record<OpenApp, boolean>>>({
    finder: true,
  })

  const apps = createMemo(() => {
    if (os() === "macos") return MAC_APPS
    if (os() === "windows") return WINDOWS_APPS
    return LINUX_APPS
  })

  const fileManager = createMemo(() => fileManagerApp(os()))

  createEffect(() => {
    if (platform.platform !== "desktop") return
    if (!platform.checkAppExists) return

    const list = apps()

    setExists(Object.fromEntries(list.map((app) => [app.id, undefined])) as Partial<Record<OpenApp, boolean>>)

    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => {
      setExists(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>)
    })
  })

  const options = createMemo(() => {
    return [
      { id: "finder", label: language.t(fileManager().label), icon: fileManager().icon },
      ...apps()
        .filter((app) => exists[app.id])
        .map((app) => ({ ...app, label: language.t(app.label) })),
    ] as const
  })

  const toggleTerminal = () => {
    const next = !view().terminal.opened()
    view().terminal.toggle()
    if (!next) return

    const id = terminal.active()
    if (!id) return
    focusTerminalById(id)
  }

  const [prefs, setPrefs] = persisted(Persist.global("open.app"), createStore({ app: "finder" as OpenApp }))
  const [menu, setMenu] = createStore({ open: false })
  const [openRequest, setOpenRequest] = createStore({
    app: undefined as OpenApp | undefined,
  })

  const canOpen = createMemo(() => platform.platform === "desktop" && !!platform.openPath && server.isLocal())
  const current = createMemo(
    () =>
      options().find((o) => o.id === prefs.app) ??
      options()[0] ??
      ({ id: "finder", label: fileManager().label, icon: fileManager().icon } as const),
  )
  const opening = createMemo(() => openRequest.app !== undefined)
  const tint = createMemo(() =>
    messageAgentColor(params.id ? sync().data.message[params.id] : undefined, sync().data.agent),
  )
  const v2ActionsState = createMemo<SessionHeaderV2ActionsState>(() => ({
    statusDotVisible: statusVis().healthDot,
    statusLabel: language.t("status.popover.trigger"),
    currentSessionID: params.id,
    reviewLabel: language.t("command.review.toggle"),
    reviewKeybind: reviewTooltipKeybind(command),
    reviewVisible: isDesktop(),
    reviewOpened: view().reviewPanel.opened(),
    onReviewToggle: () => view().reviewPanel.toggle(),
  }))

  const selectApp = (app: OpenApp) => {
    if (!options().some((item) => item.id === app)) return
    setPrefs("app", app)
  }

  const openDir = (app: OpenApp) => {
    if (opening() || !canOpen() || !platform.openPath) return
    const directory = projectDirectory()
    if (!directory) return

    const item = options().find((o) => o.id === app)
    const openWith = item && "openWith" in item ? item.openWith : undefined
    setOpenRequest("app", app)
    platform
      .openPath(directory, openWith)
      .catch((err: unknown) => showRequestError(language, err))
      .finally(() => {
        setOpenRequest("app", undefined)
      })
  }

  const copyPath = async () => {
    const directory = projectDirectory()
    if (!directory) return
    try {
      // Amicode webview: navigator.clipboard dies in the chat iframe — bridge first.
      if (!writeClipboardViaBridge(directory)) await navigator.clipboard.writeText(directory)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("session.share.copy.copied"),
        description: directory,
      })
    } catch (err: unknown) {
      showRequestError(language, err)
    }
  }

  const [centerMount, setCenterMount] = createSignal<HTMLElement | null>(null)
  const rightMount = useTitlebarRightMount()
  const sessionsMount = useTitlebarControlMount("sessions")
  const statusMount = useTitlebarControlMount("status")
  const sidePanelMount = useTitlebarControlMount("side-panel")
  onMount(() => {
    setCenterMount(document.getElementById("opencode-titlebar-center"))
  })

  return (
    <>
      <Show when={search() && centerMount()} keyed>
        {(mount) => (
          <Portal mount={mount}>
            <Button
              type="button"
              variant="ghost"
              size="small"
              class="hidden md:flex w-[240px] max-w-full min-w-0 items-center gap-2 justify-between rounded-md border border-border-weak-base bg-surface-panel shadow-none cursor-default"
              onClick={() => command.trigger("file.open")}
              aria-label={language.t("session.header.searchFiles")}
            >
              <div class="flex min-w-0 flex-1 items-center overflow-visible">
                <span class="flex-1 min-w-0 text-12-regular text-text-weak truncate text-left">
                  {language.t("session.header.search.placeholder", {
                    project: name(),
                  })}
                </span>
              </div>

              <Show when={hotkey()} keyed>
                {(keybind) => (
                  <Keybind class="shrink-0 !border-0 !bg-transparent !shadow-none px-0 text-text-weaker">
                    {keybind}
                  </Keybind>
                )}
              </Show>
            </Button>
          </Portal>
        )}
      </Show>
      <Show when={rightMount()} keyed>
        {(mount) => (
          <Portal mount={mount}>
            <Show
              when={isV2}
              fallback={
                <div class="flex items-center gap-2">
                  <Show when={projectDirectory()}>
                    <div class="hidden xl:flex items-center">
                      <Show
                        when={canOpen()}
                        fallback={
                          <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                            <Button
                              variant="ghost"
                              class="rounded-none h-full py-0 pr-3 pl-0.5 gap-1.5 border-none shadow-none"
                              onClick={copyPath}
                              aria-label={language.t("session.header.open.copyPath")}
                            >
                              <Icon name="copy" size="small" class="text-icon-base" />
                              <span class="text-12-regular text-text-strong">
                                {language.t("session.header.open.copyPath")}
                              </span>
                            </Button>
                          </div>
                        }
                      >
                        <div class="flex items-center">
                          <div class="flex h-[24px] box-border items-center rounded-md border border-border-weak-base bg-surface-panel overflow-hidden">
                            <Button
                              variant="ghost"
                              class="rounded-none h-full px-0.5 border-none shadow-none disabled:!cursor-default"
                              classList={{
                                "bg-surface-raised-base-active": opening(),
                              }}
                              onClick={() => openDir(current().id)}
                              disabled={opening()}
                              aria-label={language.t("session.header.open.ariaLabel", { app: current().label })}
                            >
                              <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                                <Show when={opening()} fallback={<AppIcon id={current().icon} />}>
                                  <AmicoSpinner class="size-3.5" style={{ color: tint() ?? "var(--icon-base)" }} />
                                </Show>
                              </div>
                            </Button>
                            <DropdownMenu
                              gutter={4}
                              placement="bottom-end"
                              open={menu.open}
                              onOpenChange={(open) => setMenu("open", open)}
                            >
                              <DropdownMenu.Trigger
                                as={IconButton}
                                icon="chevron-down"
                                variant="ghost"
                                disabled={opening()}
                                class="rounded-none h-full w-[20px] p-0 border-none shadow-none data-[expanded]:bg-surface-raised-base-active disabled:!cursor-default"
                                classList={{
                                  "bg-surface-raised-base-active": opening(),
                                }}
                                aria-label={language.t("session.header.open.menu")}
                              />
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content class="[&_[data-slot=dropdown-menu-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]]:pl-1 [&_[data-slot=dropdown-menu-radio-item]+[data-slot=dropdown-menu-radio-item]]:mt-1">
                                  <DropdownMenu.Group>
                                    <DropdownMenu.GroupLabel class="!px-1 !py-1">
                                      {language.t("session.header.openIn")}
                                    </DropdownMenu.GroupLabel>
                                    <DropdownMenu.RadioGroup
                                      class="mt-1"
                                      value={current().id}
                                      onChange={(value) => {
                                        if (!OPEN_APPS.includes(value as OpenApp)) return
                                        selectApp(value as OpenApp)
                                      }}
                                    >
                                      <For each={options()}>
                                        {(o) => (
                                          <DropdownMenu.RadioItem
                                            value={o.id}
                                            disabled={opening()}
                                            onSelect={() => {
                                              setMenu("open", false)
                                              openDir(o.id)
                                            }}
                                          >
                                            <div class="flex size-5 shrink-0 items-center justify-center [&_[data-component=app-icon]]:size-5">
                                              <AppIcon id={o.icon} />
                                            </div>
                                            <DropdownMenu.ItemLabel>{o.label}</DropdownMenu.ItemLabel>
                                            <DropdownMenu.ItemIndicator>
                                              <Icon name="check-small" size="small" class="text-icon-weak" />
                                            </DropdownMenu.ItemIndicator>
                                          </DropdownMenu.RadioItem>
                                        )}
                                      </For>
                                    </DropdownMenu.RadioGroup>
                                  </DropdownMenu.Group>
                                  <DropdownMenu.Separator />
                                  <DropdownMenu.Item
                                    onSelect={() => {
                                      setMenu("open", false)
                                      copyPath()
                                    }}
                                  >
                                    <div class="flex size-5 shrink-0 items-center justify-center">
                                      <Icon name="copy" size="small" class="text-icon-weak" />
                                    </div>
                                    <DropdownMenu.ItemLabel>
                                      {language.t("session.header.open.copyPath")}
                                    </DropdownMenu.ItemLabel>
                                  </DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu>
                          </div>
                        </div>
                      </Show>
                    </div>
                  </Show>
                  <div class="flex items-center gap-1">
                    <Show when={!AMICODE_HIDE_STATUS_POPOVER && statusVis().trigger}>
                      <Tooltip placement="bottom" value={language.t("status.popover.trigger")}>
                        <StatusPopover healthDot={statusVis().healthDot} />
                      </Tooltip>
                    </Show>
                    <TooltipKeybind
                      title={language.t("command.terminal.toggle")}
                      keybind={command.keybind("terminal.toggle")}
                    >
                      <Button
                        variant="ghost"
                        class="group/terminal-toggle titlebar-icon w-8 h-6 p-0 box-border shrink-0"
                        onClick={toggleTerminal}
                        aria-label={language.t("command.terminal.toggle")}
                        aria-expanded={view().terminal.opened()}
                        aria-controls="terminal-panel"
                      >
                        <Icon size="small" name={view().terminal.opened() ? "terminal-active" : "terminal"} />
                      </Button>
                    </TooltipKeybind>

                    <div class="hidden md:flex items-center gap-1 shrink-0">
                      <TooltipKeybind
                        title={language.t("command.review.toggle")}
                        keybind={command.keybind("review.toggle")}
                      >
                        <Button
                          variant="ghost"
                          class="group/review-toggle titlebar-icon w-8 h-6 p-0 box-border"
                          onClick={() => view().reviewPanel.toggle()}
                          aria-label={language.t("command.review.toggle")}
                          aria-controls="review-panel"
                        >
                          <Icon size="small" name={view().reviewPanel.opened() ? "review-active" : "review"} />
                        </Button>
                      </TooltipKeybind>

                      <TooltipKeybind
                        title={language.t("command.fileTree.toggle")}
                        keybind={command.keybind("fileTree.toggle")}
                      >
                        <Button
                          variant="ghost"
                          class="titlebar-icon w-8 h-6 p-0 box-border"
                          onClick={() => layout.fileTree.toggle()}
                          aria-label={language.t("command.fileTree.toggle")}
                          aria-expanded={layout.fileTree.opened()}
                          aria-controls="file-tree-panel"
                        >
                          <div class="relative flex items-center justify-center size-4">
                            <Icon
                              size="small"
                              name={layout.fileTree.opened() ? "file-tree-active" : "file-tree"}
                              classList={{
                                "text-icon-strong": layout.fileTree.opened(),
                                "text-icon-weak": !layout.fileTree.opened(),
                              }}
                            />
                          </div>
                        </Button>
                       </TooltipKeybind>

                       {/* Compact button for legacy layout */}
                       <TooltipKeybind
                         title={language.t("command.session.compact")}
                         keybind={command.keybind("session.compact")}
                       >
                         <Button
                           variant="ghost"
                           class="titlebar-icon w-8 h-6 p-0 box-border"
                           onClick={() => command.trigger("session.compact", "palette")}
                           aria-label={language.t("command.session.compact")}
                         >
                           <Icon size="small" name="arrow-down-to-line" />
                         </Button>
                       </TooltipKeybind>
                     </div>
                   </div>
                 </div>
               }
            >
              {/* V2 is now handled by per-button portals below; render nothing here. */}
              <></>
            </Show>
          </Portal>
        )}
      </Show>
      {/* V2 per-button portals — each session-scoped control portals to its own mount point */}
      <Show when={isV2}>
        <Show when={sessionsMount()} keyed>
          {(mount) => (
            <Portal mount={mount}>
              <span class="flex shrink-0" data-tour-target="sessions">
                <SessionChatsDropdown currentSessionID={v2ActionsState().currentSessionID} />
              </span>
            </Portal>
          )}
        </Show>
        <Show when={!AMICODE_HIDE_STATUS_POPOVER}>
          <Show when={statusMount()} keyed>
            {(mount) => (
              <Portal mount={mount}>
                <span class="flex shrink-0" data-tour-target="status">
                  <TooltipV2 placement="bottom" value={v2ActionsState().statusLabel} class="shrink-0">
                    <StatusPopoverV2 healthDot={v2ActionsState().statusDotVisible} />
                  </TooltipV2>
                </span>
              </Portal>
            )}
          </Show>
        </Show>
        <Show when={v2ActionsState().reviewVisible}>
          <Show when={sidePanelMount()} keyed>
            {(mount) => (
              <Portal mount={mount}>
                <TooltipV2
                  class="shrink-0"
                  placement="bottom"
                  value={
                    <>
                      {v2ActionsState().reviewLabel}
                      <Show when={v2ActionsState().reviewKeybind.length > 0}>
                        <KeybindV2 keys={v2ActionsState().reviewKeybind} variant="neutral" />
                      </Show>
                    </>
                  }
                >
                  <span class="flex shrink-0" data-tour-target="side-panel">
                    <IconButtonV2
                      type="button"
                      variant="ghost-muted"
                      size="large"
                      class="!w-9 shrink-0"
                      state={v2ActionsState().reviewOpened ? "pressed" : undefined}
                      onClick={v2ActionsState().onReviewToggle}
                      aria-label={v2ActionsState().reviewLabel}
                      aria-controls="review-panel"
                      icon={<IconV2 name="sidebar-right" />}
                    />
                  </span>
                </TooltipV2>
              </Portal>
            )}
          </Show>
        </Show>
      </Show>
    </>
  )
}

type SessionHeaderV2ActionsState = {
  /** AMICODE (#174 AC2): the trigger itself always renders in a session; the
   *  show-status setting only drives this health-dot flag. */
  statusDotVisible: boolean
  statusLabel: string
  currentSessionID?: string
  reviewLabel: string
  reviewKeybind: string[]
  reviewVisible: boolean
  reviewOpened: boolean
  onReviewToggle: () => void
}

function SessionHeaderV2Actions(props: { state: SessionHeaderV2ActionsState }) {
  const language = useLanguage()
  const command = useCommand()

  return (
    <div class="flex items-center gap-2">

      {/* amicode#274: Session Chats Dropdown — chat navigation from within a session */}
      <span class="flex shrink-0" data-tour-target="sessions">
        <SessionChatsDropdown currentSessionID={props.state.currentSessionID} />
      </span>
      <Show when={!AMICODE_HIDE_STATUS_POPOVER}>
        <span class="flex shrink-0" data-tour-target="status">
          <TooltipV2 placement="bottom" value={props.state.statusLabel} class="shrink-0">
            <StatusPopoverV2 healthDot={props.state.statusDotVisible} />
          </TooltipV2>
        </span>
      </Show>
      <Show when={props.state.reviewVisible}>
        <TooltipV2
          class="shrink-0"
          placement="bottom"
          value={
            <>
              {props.state.reviewLabel}
              <Show when={props.state.reviewKeybind.length > 0}>
                <KeybindV2 keys={props.state.reviewKeybind} variant="neutral" />
              </Show>
            </>
          }
        >
          <span class="flex shrink-0" data-tour-target="side-panel">
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="large"
              class="!w-9 shrink-0"
              state={props.state.reviewOpened ? "pressed" : undefined}
              onClick={props.state.onReviewToggle}
              aria-label={props.state.reviewLabel}
              aria-controls="review-panel"
              icon={<IconV2 name="sidebar-right" />}
            />
          </span>
        </TooltipV2>
      </Show>
    </div>
  )
}

// amicode#274: Session Chats Dropdown — mirrors the dashboard sessions flyout
// (amicode#273) inside the session header: tabbed Active/Archived, search,
// open-tab indicators, archive/unarchive actions, and cursor-based pagination.
const SESSION_DROPDOWN_ROW =
  "flex min-w-0 w-full shrink-0 cursor-default items-center rounded-sm bg-transparent text-left transition-[background-color,color,box-shadow] duration-[120ms] ease-in-out focus-visible:outline-none h-7 gap-2 px-1.5 [font-weight:440] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base"

export function SessionChatsDropdown(props: { currentSessionID?: string } = {}) {
  const tabs = useTabs()
  const server = useServer()
  const serverSync = useServerSync()
  const globalCtx = useGlobal()
  const language = useLanguage()
  const navigate = useNavigate()

  const [open, setOpen] = createSignal(false)
  const [flyoutTab, setFlyoutTab] = createSignal<"active" | "archived">("active")
  const [search, setSearch] = createSignal("")
  const [archivedSessions, setArchivedSessions] = createSignal<Session[]>([])
  const [archivedLoading, setArchivedLoading] = createSignal(false)
  const [archivedCursor, setArchivedCursor] = createSignal<string | undefined>(undefined)
  const [archivedHasMore, setArchivedHasMore] = createSignal(true)
  const ARCHIVED_PAGE_SIZE = 20

  let flyoutRoot: HTMLDivElement | undefined

  const currentSessionID = createMemo(() => props.currentSessionID)

  // Active sessions — only computed when the flyout is open to avoid
  // triggering reactive subscriptions (serverSync().child pins the directory
  // and can cascade re-renders to the parent Portal).
  // Source from ALL project directories (same as dashboard) — not just the
  // server's cwd, which may not be where sessions live (amicode#138).
  const activeSessions = createMemo(() => {
    if (!open()) return []
    try {
      const conn = server.current
      if (!conn) return []
      const ctx = globalCtx.ensureServerCtx(conn)
      if (!ctx) return []
      const directories = sessionListDirectories(ctx.projects.list(), ctx.sync.data?.project ?? [])
      const seen = new Set<string>()
      const sessions: Session[] = []
      for (const dir of directories) {
        const [store] = ctx.sync.child(dir, { bootstrap: false })
        for (const session of sortedRootSessions(store, Date.now())) {
          if (seen.has(session.id)) continue
          seen.add(session.id)
          sessions.push(session)
        }
      }
      return sessions.sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    } catch {
      return []
    }
  })

  // Fresh clients have no bootstrapped child stores for the fallback
  // directories (the dropdown reads with bootstrap: false) — kick the loads
  // once per open. Converges: re-runs find the stores populated and skip.
  createEffect(() => {
    if (!open()) return
    const conn = server.current
    if (!conn) return
    const ctx = globalCtx.ensureServerCtx(conn)
    if (!ctx) return
    for (const dir of sessionListDirectories(ctx.projects.list(), ctx.sync.data?.project ?? [])) {
      const [store] = ctx.sync.child(dir, { bootstrap: false })
      if ((store.session?.length ?? 0) === 0) ctx.sync.project.loadSessions(dir, { limit: 50 })
    }
  })

  // Sort: open-tab sessions first
  const sortedActiveSessions = createMemo(() => {
    if (!open()) return []
    const all = activeSessions()
    const openTabs: Session[] = []
    const rest: Session[] = []
    for (const session of all) {
      if (sessionHasOpenTab(tabs.store, server.key, session)) {
        openTabs.push(session)
      } else {
        rest.push(session)
      }
    }
    return [...openTabs, ...rest]
  })

  // Search filtering
  const searchQuery = createMemo(() => search().trim().toLowerCase())
  const filteredActiveSessions = createMemo(() => {
    if (!open()) return []
    const q = searchQuery()
    if (!q) return sortedActiveSessions()
    return sortedActiveSessions().filter((session) => {
      const title = sessionTitle(session.title) || session.id
      return title.toLowerCase().includes(q)
    })
  })
  const filteredArchivedSessions = createMemo(() => {
    const q = searchQuery()
    if (!q) return archivedSessions()
    return archivedSessions().filter((session) => {
      const title = sessionTitle(session.title) || session.id
      return title.toLowerCase().includes(q)
    })
  })

  // SDK access for archived sessions
  function getServerCtx() {
    const conn = server.current
    if (!conn) return
    return globalCtx.ensureServerCtx(conn)
  }

  async function loadArchivedSessions(reset = false) {
    const ctx = getServerCtx()
    if (!ctx) return
    setArchivedLoading(true)
    try {
      const cursor = reset ? undefined : archivedCursor()
      const result = await ctx.sdk.client.experimental.session.list(
        { archived: true, limit: ARCHIVED_PAGE_SIZE, ...(cursor ? { cursor: Number(cursor) } : {}) },
      )
      const sessions: Session[] = (result.data ?? []) as Session[]
      if (reset) {
        setArchivedSessions(sessions)
      } else {
        setArchivedSessions((prev) => [...prev, ...sessions])
      }
      const lastSession = sessions[sessions.length - 1]
      if (sessions.length >= ARCHIVED_PAGE_SIZE && lastSession) {
        setArchivedCursor(String(lastSession.time.updated ?? lastSession.time.created))
        setArchivedHasMore(true)
      } else {
        setArchivedCursor(undefined)
        setArchivedHasMore(false)
      }
    } catch {
      // degrade gracefully
    } finally {
      setArchivedLoading(false)
    }
  }

  async function archiveSession(session: Session) {
    const ctx = getServerCtx()
    if (!ctx) return
    try {
      await (ctx.sdk.client.session.update as Function)({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: Date.now() },
      })
      setArchivedSessions((prev) => [session, ...prev])
      // Reload active sessions for this session's directory
      await serverSync().project.loadSessions(session.directory, { limit: 64 })
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: String(cause),
      })
    }
  }

  async function unarchiveSession(session: Session) {
    const ctx = getServerCtx()
    if (!ctx) return
    try {
      await (ctx.sdk.client.session.update as Function)({
        sessionID: session.id,
        directory: session.directory,
        time: { archived: null },
      })
      setArchivedSessions((prev) => prev.filter((s) => s.id !== session.id))
      await serverSync().project.loadSessions(session.directory, { limit: 64 })
    } catch (cause) {
      showToast({
        title: language.t("common.requestFailed"),
        description: String(cause),
      })
    }
  }

  // amicode#255: permanently delete an archived session (inline confirm in row).
  async function deleteArchivedSession(session: Session) {
    const ctx = getServerCtx()
    if (!ctx) return
    try {
      await (ctx.sdk.client.session.delete as Function)({
        sessionID: session.id,
        directory: session.directory,
      })
      setArchivedSessions((prev) => prev.filter((s) => s.id !== session.id))
    } catch (cause) {
      showToast({
        title: language.t("session.delete.failed.title"),
        description: String(cause),
      })
    }
  }

  async function openSession(session: Session) {
    // Close flyout first so its Portal unmounts cleanly.
    setOpen(false)

    // Mirror the dashboard's project setup: ensure the directory is registered and
    // touched so the workspace context is warm when the session page mounts.
    const conn = server.current
    if (conn) {
      const ctx = globalCtx.ensureServerCtx(conn)
      ctx.projects.open(session.directory)
      ctx.projects.touch(session.directory)
    }

    // Await session sync BEFORE navigating (issue #176). When switching sessions
    // within the same route (params.id change), the Page component persists and
    // the timeline re-keys immediately. If data isn't fully cached yet, rows
    // trickle in and the measurement burst overlaps with user interaction, causing
    // the virtualizer's scroll anchoring to snap the viewport back. Awaiting here
    // ensures messagesReady() is true with complete data the moment the timeline
    // mounts — matching the dashboard path where the fresh route mount naturally
    // gates on messagesReady(). For already-cached sessions this resolves instantly.
    await serverSync().session.sync(session.id).catch(() => {})

    // Use tabs.select for sessions that already have an open tab (no transition).
    // For sessions without a tab, navigate directly — DO NOT use tabs.openPath
    // which calls addSessionTab(startTransition), keeping both old and new UI
    // mounted during the transition and duplicating Portal-rendered buttons.
    const existingTab = tabs.store.find(
      (t) => t.type === "session" && t.sessionId === session.id,
    )
    if (existingTab) {
      tabs.select(existingTab)
    } else {
      const path = `/${base64Encode(session.directory)}/session/${session.id}`
      navigate(path)
    }
  }

  function handleNewChat() {
    const dir = serverSync().data.path.directory || ""
    void tabs.newDraft({ server: server.key, directory: dir })
    setOpen(false)
  }

  // Dismiss on outside click or Escape
  createEffect(() => {
    if (!open()) return
    // Defer listener attachment so the opening mousedown doesn't immediately dismiss
    const timer = setTimeout(() => {
      const onDown = (e: MouseEvent) => {
        const target = e.target as Node
        if (flyoutRoot?.contains(target)) return
        if (triggerRef?.contains(target)) return
        // Don't dismiss if the click landed inside a dialog (e.g. delete confirmation)
        if (target instanceof Element && target.closest("[data-dialog-layer], [data-component='dialog-overlay']")) return
        setOpen(false)
      }
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setOpen(false)
      }
      document.addEventListener("mousedown", onDown)
      document.addEventListener("keydown", onKey)
      onCleanup(() => {
        document.removeEventListener("mousedown", onDown)
        document.removeEventListener("keydown", onKey)
      })
    }, 0)
    onCleanup(() => clearTimeout(timer))
  })

  let triggerRef: HTMLButtonElement | undefined

  return (
    <>
      <TooltipV2 placement="bottom" value="Sessions" class="shrink-0">
        <button
          ref={triggerRef}
          type="button"
          data-action="session-chats-toggle-flyout"
          class="flex w-9 h-7 shrink-0 items-center justify-center rounded-sm border-none bg-transparent cursor-pointer text-v2-icon-icon-muted hover:text-v2-icon-icon-base hover:bg-v2-overlay-simple-overlay-hover transition-colors"
          aria-label="Sessions"
          onClick={() => setOpen(!open())}
        >
          <IconV2 name="menu" />
        </button>
      </TooltipV2>
      <Show when={open()}>
        <Portal>
          <div
            ref={flyoutRoot}
            data-slot="amicode-sessions-flyout"
            role="dialog"
            aria-label={language.t("sidebar.project.recentSessions")}
            style={{
              position: "fixed",
              top: `${(triggerRef?.getBoundingClientRect().bottom ?? 0) + 8}px`,
              right: `${document.documentElement.clientWidth - (triggerRef?.getBoundingClientRect().right ?? 0)}px`,
              "z-index": "9999",
              width: "min(440px, 88vw)",
              "max-height": "min(70vh, 680px)",
              display: "flex",
              "flex-direction": "column",
              gap: "12px",
              overflow: "hidden auto",
              border: "1px solid var(--v2-border-border-base)",
              "border-radius": "var(--radius-md)",
              background: "var(--v2-background-bg-base)",
              "box-shadow": "0 14px 40px -18px rgba(0, 0, 0, 0.55)",
              padding: "14px",
            }}
          >
          <section class="isolate min-h-0 min-w-0 flex flex-col" aria-label={language.t("sidebar.project.recentSessions")}>
            {/* Search */}
            <label
              class="relative z-20 flex h-9 w-full items-center gap-2 rounded-sm py-1 pl-3 pr-2 text-v2-icon-icon-muted bg-v2-background-bg-deep focus-within:bg-v2-background-bg-base focus-within:shadow-[0_0_0_0.5px_var(--v2-border-border-focus),var(--v2-elevation-raised)] transition-[background-color,box-shadow] duration-[120ms] ease-in-out"
            >
              <IconV2 name="magnifying-glass" />
              <input
                class="relative z-20 min-w-0 flex-1 border-0 bg-transparent text-v2-text-text-base outline-0 [font-weight:440] placeholder:text-v2-text-text-faint"
                value={search()}
                placeholder={language.t("home.sessions.search.placeholder")}
                aria-label={language.t("home.sessions.search.placeholder")}
                onInput={(e) => setSearch(e.currentTarget.value)}
              />
              <Show when={search().length > 0}>
                <IconButtonV2
                  variant="ghost-muted"
                  size="small"
                  icon={<IconV2 name="xmark-small" />}
                  aria-label="Clear"
                  onClick={() => setSearch("")}
                />
              </Show>
            </label>

            {/* Tab bar — Active vs Archived */}
            <div class="flex items-center gap-0.5 pt-3 pb-2">
              <button
                type="button"
                class="rounded-md px-2.5 py-1 text-[11px] font-semibold border-none cursor-pointer transition-colors"
                style={{
                  background: flyoutTab() === "active" ? "var(--v2-background-bg-layer-02)" : "transparent",
                  color: flyoutTab() === "active" ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
                }}
                onClick={() => setFlyoutTab("active")}
              >
                Active
              </button>
              <button
                type="button"
                class="rounded-md px-2.5 py-1 text-[11px] font-semibold border-none cursor-pointer transition-colors"
                style={{
                  background: flyoutTab() === "archived" ? "var(--v2-background-bg-layer-02)" : "transparent",
                  color: flyoutTab() === "archived" ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
                }}
                onClick={() => {
                  setFlyoutTab("archived")
                  if (archivedSessions().length === 0) void loadArchivedSessions(true)
                }}
              >
                Archived
              </button>
              <div class="flex-1" />
              <Show when={flyoutTab() === "active"}>
                <IconButtonV2
                  variant="ghost-muted"
                  size="large"
                  class="[&_[data-slot=icon-svg]]:text-v2-icon-icon-muted"
                  icon={<IconV2 name="edit" />}
                  onClick={handleNewChat}
                  aria-label={language.t("command.session.new")}
                />
              </Show>
            </div>

            {/* Tab content */}
            <div class="min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <Show when={flyoutTab() === "active"}>
                <Show
                  when={filteredActiveSessions().length > 0}
                  fallback={
                    <div class="pl-1.5 py-2 text-v2-text-text-faint" style={{ "font-size": "12px" }}>
                      {searchQuery() ? language.t("home.sessions.search.noResults", { query: search() }) : language.t("home.sessions.empty")}
                    </div>
                  }
                >
                  <div class="flex min-w-0 flex-col gap-px">
                    <For each={filteredActiveSessions()}>
                      {(session) => (
                        <SessionDropdownRow
                          session={session}
                          isOpenTab={sessionHasOpenTab(tabs.store, server.key, session)}
                          isCurrent={session.id === currentSessionID()}
                          onOpen={openSession}
                          onArchive={archiveSession}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
              <Show when={flyoutTab() === "archived"}>
                <Show
                  when={!archivedLoading() || archivedSessions().length > 0}
                  fallback={
                    <div class="pl-1.5 py-2 text-v2-text-text-faint" style={{ "font-size": "12px" }}>
                      {language.t("common.loading")}
                    </div>
                  }
                >
                  <Show
                    when={filteredArchivedSessions().length > 0}
                    fallback={
                      <div class="pl-1.5 py-2 text-v2-text-text-faint" style={{ "font-size": "12px" }}>
                        No archived sessions
                      </div>
                    }
                  >
                    <div class="flex min-w-0 flex-col gap-px">
                      <For each={filteredArchivedSessions()}>
                        {(session) => (
                          <ArchivedSessionDropdownRow
                            session={session}
                            onOpen={openSession}
                            onUnarchive={unarchiveSession}
                            onDelete={deleteArchivedSession}
                          />
                        )}
                      </For>
                    </div>
                    <Show when={archivedHasMore() && !searchQuery()}>
                      <button
                        type="button"
                        class="mt-2 w-full text-center text-[12px] text-v2-text-text-muted cursor-pointer border-none bg-transparent hover:text-v2-text-text-base"
                        onClick={() => void loadArchivedSessions()}
                        disabled={archivedLoading()}
                      >
                        {archivedLoading() ? language.t("common.loading") : "Show more"}
                      </button>
                    </Show>
                  </Show>
                </Show>
              </Show>
            </div>
          </section>
        </div>
        </Portal>
      </Show>
    </>
  )
}

function SessionDropdownRow(props: {
  session: Session
  isOpenTab: boolean
  isCurrent: boolean
  onOpen: (session: Session) => void
  onArchive: (session: Session) => void
}) {
  const language = useLanguage()
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  const rowServer = useServer()
  const status = useSessionTabAvatarState(
    () => rowServer.key,
    () => props.session.directory,
    () => props.session.id,
  )
  const dotStatus = createMemo(() =>
    sessionTabStatus({
      loading: status.loading(),
      needsAttention: status.needsAttention(),
      hasError: status.hasError(),
      unread: status.unread(),
    }),
  )

  return (
    <div class="group/session relative flex h-7 min-w-0 items-center rounded-sm">
      <button
        type="button"
        data-component="session-dropdown-row"
        class={SESSION_DROPDOWN_ROW}
        onClick={() => props.onOpen(props.session)}
      >
        <Show when={props.isOpenTab || dotStatus() !== "idle"}>
          <SessionTabStatusDot status={dotStatus()} />
        </Show>
        <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap">
          {title()}
        </span>
      </button>
      <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center opacity-0 group-hover/session:opacity-100 focus-within:opacity-100 transition-opacity">
        <TooltipV2 placement="top" value={language.t("common.archive")}>
          <IconButtonV2
            data-action="session-dropdown-archive"
            variant="ghost-muted"
            size="large"
            icon={<IconV2 name="archive" />}
            aria-label={language.t("common.archive")}
            onClick={(event: MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
              void props.onArchive(props.session)
            }}
          />
        </TooltipV2>
      </div>
    </div>
  )
}

function ArchivedSessionDropdownRow(props: {
  session: Session
  onOpen: (session: Session) => void
  onUnarchive: (session: Session) => void
  onDelete: (session: Session) => void
}) {
  const title = createMemo(() => sessionTitle(props.session.title) || props.session.id)
  const [armed, setArmed] = createSignal(false)
  let resetTimer: ReturnType<typeof setTimeout> | undefined

  function arm(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    setArmed(true)
    clearTimeout(resetTimer)
    resetTimer = setTimeout(() => setArmed(false), 3000)
  }

  function confirmDelete(event: MouseEvent) {
    event.preventDefault()
    event.stopPropagation()
    clearTimeout(resetTimer)
    setArmed(false)
    void props.onDelete(props.session)
  }

  function disarm() {
    clearTimeout(resetTimer)
    setArmed(false)
  }

  onCleanup(() => clearTimeout(resetTimer))

  return (
    <div class="group/archived relative flex h-7 min-w-0 items-center rounded-sm">
      <button
        type="button"
        data-component="archived-session-dropdown-row"
        class={`${SESSION_DROPDOWN_ROW} opacity-70`}
        onClick={() => props.onOpen(props.session)}
      >
        <IconV2 name="archive" size="small" class="shrink-0 text-v2-icon-icon-faint" />
        <span class="min-w-0 flex-[1_1_auto] overflow-hidden text-ellipsis whitespace-nowrap">
          {title()}
        </span>
      </button>
      <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/archived:opacity-100 focus-within:opacity-100 transition-opacity">
        <TooltipV2 placement="top" value="Unarchive">
          <IconButtonV2
            data-action="session-dropdown-unarchive"
            variant="ghost-muted"
            size="large"
            icon={<Icon name="arrow-undo-down" size="small" />}
            aria-label="Unarchive"
            onClick={(event: MouseEvent) => {
              event.preventDefault()
              event.stopPropagation()
              void props.onUnarchive(props.session)
            }}
          />
        </TooltipV2>
        <Show
          when={armed()}
          fallback={
            <TooltipV2 placement="top" value="Delete permanently">
              <IconButtonV2
                data-action="session-dropdown-delete"
                variant="ghost-muted"
                size="large"
                icon={<Icon name="trash" size="small" />}
                aria-label="Delete permanently"
                onClick={arm}
              />
            </TooltipV2>
          }
        >
          <ButtonV2
            data-action="session-dropdown-delete-confirm"
            variant="danger"
            size="small"
            aria-label="Confirm delete"
            aria-live="polite"
            onClick={confirmDelete}
            onBlur={disarm}
            onKeyDown={(e: KeyboardEvent) => e.key === "Escape" && disarm()}
          >
            Delete
          </ButtonV2>
        </Show>
      </div>
    </div>
  )
}


