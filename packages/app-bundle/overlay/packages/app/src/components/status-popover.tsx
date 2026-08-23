import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Suspense, batch, createEffect, createMemo, createSignal, lazy, Show, type ComponentProps, type JSX } from "solid-js"
import { announceChromeDropdown, chromeDropdownOpenId, clearChromeDropdown } from "@/utils/chrome-dropdown"
import { statusPopoverLayout } from "./status-popover-model"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useSync } from "@/context/sync"
import { useGlobal } from "@/context/global"
import {
  hasNonBlockingServiceIssue,
  hasServiceNeedingAttention,
  serverStatusDotClass,
} from "./status-popover-indicator"

const Body = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverBody })))
const ServerBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverServerBody })))
const GlobalBody = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverGlobalBody })))

export function StatusPopover(props: { healthDot?: boolean }) {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => global.servers.health[server.key]?.healthy
  const ready = createMemo(() => serverHealth() === false || (sync().data.mcp_ready && sync().data.lsp_ready))
  const attention = createMemo(() =>
    hasServiceNeedingAttention({
      mcp: Object.values(sync().data.mcp ?? {}).map((item) => item.status),
    }),
  )
  const issue = createMemo(() =>
    hasNonBlockingServiceIssue({
      mcp: Object.values(sync().data.mcp ?? {}).map((item) => item.status),
      lsp: (sync().data.lsp ?? []).map((item) => item.status),
    }),
  )

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs={Button}
      triggerProps={{
        variant: "ghost",
        class: "titlebar-icon w-8 h-6 p-0 box-border",
        "aria-label": language.t("status.popover.trigger"),
        style: { scale: 1 },
      }}
      trigger={
        <div class="relative size-4">
          <div class="badge-mask-tight size-4 flex items-center justify-center">
            <Icon name={shown() ? "status-active" : "status"} size="small" />
          </div>
          {/* amicode (#174): the dot is the only part of the trigger the
              show-status setting governs — see statusTriggerVisibility. */}
          <Show when={props.healthDot ?? true}>
            <div
              class={`absolute -top-px -right-px size-1.5 rounded-full ${serverStatusDotClass({
                ready: ready(),
                serverHealth: serverHealth(),
                attention: attention(),
                issue: issue(),
              })}`}
            />
          </Show>
        </div>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-lg"
      {...statusPopoverLayout()}
    >
      <Show when={shown()}>
        <Suspense
          fallback={
            <div class="w-[360px] h-14 rounded-lg bg-[var(--v2-background-bg-base)] shadow-[var(--shadow-lg-border-base)]" />
          }
        >
          <Body shown={shown} onClose={() => setShown(false)} />
        </Suspense>
      </Show>
    </Popover>
  )
}

export function StatusPopoverV2(props: { scope?: "server"; healthDot?: boolean }) {
  if (props.scope === "server") return <ServerStatusPopover />
  return <DirectoryStatusPopover healthDot={props.healthDot} />
}

function DirectoryStatusPopover(props: { healthDot?: boolean }) {
  const language = useLanguage()
  const server = useServerSDK()
  const global = useGlobal()
  const sync = useSync()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => global.servers.health[ServerConnection.key(server().server)]?.healthy
  const ready = createMemo(() => serverHealth() === false || (sync().data.mcp_ready && sync().data.lsp_ready))
  const attention = createMemo(() =>
    hasServiceNeedingAttention({
      mcp: Object.values(sync().data.mcp ?? {}).map((item) => item.status),
    }),
  )
  const issue = createMemo(() =>
    hasNonBlockingServiceIssue({
      mcp: Object.values(sync().data.mcp ?? {}).map((item) => item.status),
      lsp: (sync().data.lsp ?? []).map((item) => item.status),
    }),
  )
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: ready(),
    serverHealth: serverHealth(),
    attention: attention(),
    issue: issue(),
    dotVisible: props.healthDot ?? true,
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <Body shown={shown} onClose={() => setShown(false)} />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

function ServerStatusPopover() {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const [shown, setShown] = createSignal(false)
  const serverHealth = () => global.servers.health[server.key]?.healthy
  const state = createMemo<StatusPopoverState>(() => ({
    shown: shown(),
    ready: serverHealth() !== undefined,
    serverHealth: serverHealth(),
    attention: false,
    issue: false,
    dotVisible: true,
    label: language.t("status.popover.trigger"),
    onOpenChange: setShown,
    body: () => (
      <StatusPopoverBody shown={shown()}>
        <ServerBody />
      </StatusPopoverBody>
    ),
  }))

  return <StatusPopoverView state={state()} />
}

type StatusPopoverState = {
  shown: boolean
  ready: boolean
  serverHealth: boolean | undefined
  attention: boolean
  issue: boolean
  /** amicode (#174): the show-status setting scopes to the dot, not the trigger */
  dotVisible: boolean
  label: string
  onOpenChange: (value: boolean) => void
  body: () => JSX.Element
}

function StatusPopoverBody(props: { shown: boolean; children: JSX.Element }) {
  return (
    <Show when={props.shown}>
      <Suspense
        fallback={<div class="w-[360px] h-14 rounded-lg bg-[var(--v2-background-bg-base)] shadow-[var(--shadow-lg-border-base)]" />}
      >
        {props.children}
      </Suspense>
    </Show>
  )
}

function StatusPopoverView(props: { state: StatusPopoverState }) {
  const popoverProps = {
    class:
      "[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-lg",
    ...statusPopoverLayout(),
  }

  return (
    <Popover
      open={props.state.shown}
      onOpenChange={props.state.onOpenChange}
      triggerAs={IconButtonV2}
      triggerProps={{
        variant: "ghost-muted",
        size: "large",
        class: "!w-9 shrink-0",
        state: props.state.shown ? "pressed" : undefined,
        "aria-label": props.state.label,
      }}
      trigger={
        <div class="relative size-4">
          <IconV2 name={props.state.shown ? "status-active" : "status"} />
          <Show when={props.state.dotVisible}>
            <div
              class={`absolute -top-1 -right-1 size-2 rounded-full border border-[var(--v2-background-bg-deep)] ${serverStatusDotClass(props.state)}`}
            />
          </Show>
        </div>
      }
      {...popoverProps}
    >
      {props.state.body()}
    </Popover>
  )
}

// amicode (#174): the home chrome's global Connections entry — a labeled pill
// matching the strip's Sessions control, opening the GLOBAL status surface
// (vaults + connections, Connections pre-selected). Home-safe by construction:
// nothing here touches the directory-scoped sync or prompt contexts, so it can
// mount before any session exists. One wiring, two mounts — the body is the
// same module the session-header popover lazy-loads.
export function GlobalConnectionsPopover(props: { onManageVaults: () => void }) {
  const language = useLanguage()
  const [shown, setShownRaw] = createSignal(false)
  // amicode#203: one chrome dropdown at a time (see chrome-dropdown.ts).
  const setShown = (next: boolean) => {
    // batch: announce + open flag must land atomically (press-twice bug).
    batch(() => {
      if (next) announceChromeDropdown("connections")
      else clearChromeDropdown("connections")
      setShownRaw(next)
    })
  }
  createEffect(() => {
    if (chromeDropdownOpenId() !== "connections" && shown()) setShownRaw(false)
    // amicode#105: the announce is bidirectional — deep links (the vault
    // drawer's attach CTA) open this popover by naming it, not just close it.
    if (chromeDropdownOpenId() === "connections" && !shown()) setShownRaw(true)
  })

  return (
    <Popover
      open={shown()}
      onOpenChange={setShown}
      triggerAs="button"
      triggerProps={
        {
          type: "button",
          // the collapse-to-hamburger CSS keys off this action id (amicode.css)
          "data-action": "home-connections-toggle",
          "aria-label": language.t("home.connections.trigger"),
          // Mirrors the Sessions pill next door (home.tsx chrome strip).
          style: {
            display: "inline-flex",
            "align-items": "center",
            gap: "6px",
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "var(--radius-sm)",
            background: "var(--v2-background-bg-layer-01)",
            color: "var(--v2-text-text-base)",
            padding: "4px 10px",
            "font-size": "12px",
            "font-weight": "600",
            cursor: "pointer",
          },
        } as ComponentProps<"button">
      }
      trigger={
        <>
          {language.t("home.connections.trigger")}
          <span aria-hidden="true" style={{ "font-size": "9px", color: "var(--v2-text-text-muted)" }}>
            ▾
          </span>
        </>
      }
      class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-lg"
      gutter={8}
      placement="bottom-end"
    >
      <Show when={shown()}>
        <Suspense
          fallback={
            <div class="w-[360px] h-14 rounded-lg bg-[var(--v2-background-bg-base)] shadow-[var(--shadow-lg-border-base)]" />
          }
        >
          <GlobalBody shown={shown} onClose={() => setShown(false)} onManageVaults={props.onManageVaults} />
        </Suspense>
      </Show>
    </Popover>
  )
}
