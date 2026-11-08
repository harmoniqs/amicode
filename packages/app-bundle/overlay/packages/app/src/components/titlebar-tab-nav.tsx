import { createEffect, createMemo, createSignal, onCleanup, Show, type Ref } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { createMutation } from "@tanstack/solid-query"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useGlobal } from "@/context/global"
import { ServerConnection, serverName } from "@/context/server"
import { displayName, projectForSession } from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import type { Session } from "@opencode-ai/sdk/v2"
import { canOpenTabRename, forwardTabRef } from "./titlebar-tab-gesture"
import { TabPreviewPopover } from "./titlebar-tab-popover"
import { TabMenuItems, type TabMenu } from "./titlebar-tab-menu"
import "./titlebar-tab-nav.css"

// MouseEvent.button uses 1 for the middle/wheel button.
const MIDDLE_MOUSE_BUTTON = 1

export function TabNavItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  server: ServerConnection.Key
  session: () => Session | undefined
  fallbackTitle?: string
  drivingMachineId?: () => string | undefined
  drivenByMachine?: () => { machineId: string; machineName: string } | undefined
  onRename: (title: string) => Promise<void>
  onClose: () => void
  onNavigate: () => void
  active?: boolean
  forceTruncate?: boolean
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
  /** amicode(#2154): compact, protected from accidental close */
  pinned?: boolean
  /** amicode(#2154): the right-click menu's model (evaluated while open) */
  menu?: () => TabMenu
  /** amicode(#2154): extra hover-preview line, e.g. "Spawned from …" */
  note?: string
}) {
  const [editing, setEditing] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  let renameFromMenu = false
  const [titleOverflowing, setTitleOverflowing] = createSignal(false)
  let tabRoot!: HTMLDivElement
  let titleEl!: HTMLSpanElement
  let measureFrame: number | undefined
  const rename = createMutation(() => ({ mutationFn: props.onRename }))

  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const global = useGlobal()
  const serverCtx = createMemo(() => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const project = createMemo(() => {
    const session = props.session()
    if (!session) return
    return projectForSession(session, serverCtx()?.projects.list() ?? [])
  })
  const title = createMemo(() => props.session()?.title ?? props.fallbackTitle)

  const projectName = createMemo(() => {
    const session = props.session()
    if (!session) return
    return displayName(project() ?? { worktree: session.directory })
  })
  const previewPath = createMemo(() => {
    const session = props.session()
    if (!session) return
    const home = serverCtx()?.sync.data.path.home
    return home ? session.directory.replace(home, "~") : session.directory
  })
  // Only label the server when multiple servers are connected.
  const serverLabel = createMemo(() => {
    if (global.servers.list().length <= 1) return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.server)
    return conn ? serverName(conn) : undefined
  })

  const [popoverOpen, setPopoverOpen] = createSignal(false)
  const previewBlocked = () => !!props.dragging || editing() || menuOpen() || !!props.pressed || !props.session()

  const measureTitleOverflow = () => {
    if (!titleEl || editing()) {
      setTitleOverflowing(false)
      return
    }
    setTitleOverflowing(titleEl.scrollWidth > titleEl.clientWidth)
  }

  const scheduleTitleOverflow = () => {
    if (measureFrame !== undefined) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = undefined
      measureTitleOverflow()
    })
  }

  createEffect(() => {
    title()
    props.forceTruncate
    editing()
    scheduleTitleOverflow()
  })

  createResizeObserver(() => tabRoot, scheduleTitleOverflow)
  onCleanup(() => {
    if (measureFrame !== undefined) cancelAnimationFrame(measureFrame)
  })

  const selectTitle = () => {
    const range = document.createRange()
    range.selectNodeContents(titleEl)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  const closeRename = async (save: boolean) => {
    if (rename.isPending || !editing()) return

    const original = props.session()?.title ?? ""
    const next = (titleEl.textContent ?? "").trim()

    titleEl.scrollLeft = 0
    setEditing(false)

    if (!save || !next || next === original) {
      return
    }

    await rename.mutateAsync(next)
  }

  createEffect(() => {
    if (editing()) return
    if (!titleEl) return
    const value = title()
    if (value === undefined) return
    titleEl.textContent = value
  })

  const openRename = (event?: MouseEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    if (!canOpenTabRename(props.dragging, editing(), rename.isPending)) return
    const session = props.session()
    if (!session) return
    titleEl.textContent = session.title
    setEditing(true)

    requestAnimationFrame(() => {
      titleEl.focus()
      selectTitle()
    })
  }

  createEffect(() => {
    if (!editing()) return

    const cleanup = makeEventListener(
      document,
      "pointerdown",
      (event) => {
        const target = event.target
        if (!(target instanceof Node)) return
        if (tabRoot.contains(target)) return
        void closeRename(true)
      },
      { capture: true },
    )

    onCleanup(cleanup)
  })

  const tab = () => (
    <div
      ref={(el) => {
        tabRoot = el
        forwardTabRef(props.ref, el)
      }}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-title-overflow={titleOverflowing()}
      data-editing={editing()}
      data-pinned={props.pinned || undefined}
      class="group relative flex h-7 w-full min-w-0 select-none flex-row items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm px-1.5 [container-type:inline-size]"
      classList={{ invisible: props.hidden }}
      data-active={props.active}
      data-dragging={props.dragging}
      data-state={props.active || props.pressed ? "pressed" : undefined}
      onMouseDown={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        // A pinned tab ignores middle-click — it is pinned so a stray click
        // can't take it away. Close stays in its menu and on mod+w.
        if (props.pinned) {
          event.preventDefault()
          return
        }
        closeTab(event)
      }}
    >
      <MenuV2.Context.Trigger
        as="a"
        disabled={editing() || props.dragging || !props.menu}
        aria-haspopup={props.menu ? "menu" : undefined}
        aria-expanded={props.menu ? menuOpen() : undefined}
        aria-label={title()}
        data-slot="tab-link"
        data-titlebar-tab-link
        href={props.href}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          // Navigate on mousedown to shave the press-release delay off tab switches.
          if (event.button !== 0) return
          if (editing()) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        onClick={(event) => {
          event.preventDefault()
          // Mouse navigation already happened on mousedown; detail 0 means keyboard activation.
          if (event.detail > 0) return
          if (editing()) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base group-data-[editing='true']:text-v2-text-text-base [-webkit-user-drag:none]"
      >
        <span data-slot="project-avatar-slot" class="flex shrink-0 items-center justify-center gap-1">
          <Show
            when={props.session()}
            keyed
            fallback={
              <span class="block size-4 rounded-xs border border-v2-border-border-muted" aria-hidden="true" />
            }
          >
            {(session) => (
              <SessionTabAvatar
                project={project()}
                directory={session.directory}
                sessionId={session.id}
                server={props.server}
              />
            )}
          </Show>
          <Show when={props.drivingMachineId?.()}>
            {(machineId) => (
              <span
                data-slot="tab-driving-remote"
                title={`Driving ${machineId()}`}
                class="flex size-3.5 shrink-0 items-center justify-center text-v2-text-text-faint"
              >
                <IconV2 name="monitor" class="opacity-70" />
              </span>
            )}
          </Show>
          <Show when={props.drivenByMachine?.()}>
            {(machine) => (
              <span
                data-slot="tab-driven-by-remote"
                title={`Driven by ${machine().machineName}`}
                class="flex size-3.5 shrink-0 items-center justify-center text-v2-text-text-faint"
              >
                <IconV2 name="eye" class="opacity-70" />
              </span>
            )}
          </Show>
        </span>
        <span
          ref={(el) => {
            titleEl = el
            titleEl.textContent = title() ?? ""
          }}
          data-slot="tab-title"
          data-titlebar-tab-title
          class="min-w-0 flex-1 outline-none leading-4"
          classList={{
            "overflow-hidden text-ellipsis whitespace-nowrap": !editing(),
            "select-text": editing(),
          }}
          contenteditable={editing() ? true : undefined}
          onDblClick={openRename}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter") {
              event.preventDefault()
              void closeRename(true)
              return
            }
            if (event.key !== "Escape") return
            event.preventDefault()
            titleEl.textContent = props.session()?.title ?? ""
            void closeRename(false)
          }}
          onBlur={() => void closeRename(true)}
          onPointerDown={(event) => {
            if (!editing()) return
            event.stopPropagation()
          }}
          onClick={(event) => {
            if (!editing()) return
            event.preventDefault()
          }}
        />
      </MenuV2.Context.Trigger>

      <Show when={!props.pinned}>
        <div data-slot="tab-close">
          <IconButtonV2
            size="small"
            variant="ghost-muted"
            class="hover-reveal relative z-10 group-hover:opacity-100 group-data-[active=true]:opacity-100 group-data-[editing=true]:opacity-100"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
            onClick={closeTab}
            icon={<IconV2 name="xmark-small" />}
            aria-label={title() ? `Close ${title()}` : "Close tab"}
          />
        </div>
      </Show>
    </div>
  )

  return (
    <MenuV2.Context
      onOpenChange={(open) => {
        setMenuOpen(open)
        if (open) setPopoverOpen(false)
      }}
    >
      <TabPreviewPopover
        trigger={tab()}
        open={popoverOpen() && !previewBlocked()}
        onOpenChange={(value) => {
          if (value && previewBlocked()) return
          setPopoverOpen(value)
        }}
        data={{
          projectName: projectName(),
          title: props.session()?.title,
          path: previewPath(),
          note: props.note,
          serverName: serverLabel(),
        }}
      />
      <Show when={props.menu}>
        {(menu) => (
          <MenuV2.Context.Portal>
            <MenuV2.Context.Content
              onCloseAutoFocus={(event) => {
                // Rename from the menu: wait for the menu to hand focus back,
                // then open the inline editor (it needs focus to stay).
                if (!renameFromMenu) return
                event.preventDefault()
                renameFromMenu = false
                openRename()
              }}
            >
              <TabMenuItems
                menu={menu()()}
                renameDisabled={!props.session() || rename.isPending}
                onRename={() => {
                  renameFromMenu = true
                }}
                onClose={props.onClose}
              />
            </MenuV2.Context.Content>
          </MenuV2.Context.Portal>
        )}
      </Show>
    </MenuV2.Context>
  )
}

export function DraftTabItem(props: {
  ref?: Ref<HTMLDivElement>
  href: string
  title: string
  active?: boolean
  onNavigate: () => void
  onClose: () => void
  suppressNavigation?: () => boolean
  dragging?: boolean
  pressed?: boolean
  hidden?: boolean
  menu?: () => TabMenu
}) {
  const closeTab = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    props.onClose()
  }
  const tab = () => (
    <div
      ref={(el) => forwardTabRef(props.ref, el)}
      data-titlebar-tab
      data-slot="titlebar-tab-item"
      data-active={props.active}
      data-dragging={props.dragging}
      data-state={props.active || props.pressed ? "pressed" : undefined}
      class="group relative flex h-7 w-full min-w-0 flex-row items-center gap-1.5 overflow-hidden rounded-sm px-1.5 [container-type:inline-size] whitespace-nowrap"
      classList={{ invisible: props.hidden }}
      onMouseDown={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        event.preventDefault()
        event.stopPropagation()
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_MOUSE_BUTTON) return
        closeTab(event)
      }}
    >
      <MenuV2.Context.Trigger
        as="a"
        disabled={props.dragging || !props.menu}
        aria-haspopup={props.menu ? "menu" : undefined}
        aria-label={props.title}
        data-slot="tab-link"
        data-titlebar-tab-link
        href={props.href}
        draggable={false}
        onDragStart={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onMouseDown={(event) => {
          // Navigate on mousedown to shave the press-release delay off tab switches.
          if (event.button !== 0) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        onClick={(event) => {
          event.preventDefault()
          // Mouse navigation already happened on mousedown; detail 0 means keyboard activation.
          if (event.detail > 0) return
          if (props.suppressNavigation?.()) return
          props.onNavigate()
        }}
        class="flex h-full min-w-0 flex-1 flex-row items-center gap-1.5 text-[13px] font-medium text-v2-text-text-faint group-data-[active='true']:text-v2-text-text-base [-webkit-user-drag:none]"
      >
        <span class="flex size-4 shrink-0 items-center justify-center">
          <IconV2 name="edit" />
        </span>
        <span
          data-titlebar-tab-title
          class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap outline-none leading-4"
        >
          {props.title}
        </span>
      </MenuV2.Context.Trigger>
      <div data-slot="tab-close">
        <IconButtonV2
          size="small"
          variant="ghost-muted"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          class="hover-reveal relative z-10 group-hover:opacity-100 group-data-[active=true]:opacity-100 group-data-[editing=true]:opacity-100"
          onClick={closeTab}
          icon={<IconV2 name="xmark-small" />}
          aria-label="Close tab"
        />
      </div>
    </div>
  )
  return (
    <MenuV2.Context>
      {tab()}
      <Show when={props.menu}>
        {(menu) => (
          <MenuV2.Context.Portal>
            <MenuV2.Context.Content>
              <TabMenuItems menu={menu()()} onClose={props.onClose} />
            </MenuV2.Context.Content>
          </MenuV2.Context.Portal>
        )}
      </Show>
    </MenuV2.Context>
  )
}
