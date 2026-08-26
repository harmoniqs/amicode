import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tabs } from "@opencode-ai/ui/tabs"
import { showToast } from "@/utils/toast"
import { useNavigate } from "@solidjs/router"
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSXElement,
  onCleanup,
  Show,
} from "solid-js"
import { createStore } from "solid-js/store"
import { ServerHealthIndicator, ServerRow } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { type ServerHealth } from "@/utils/server-health"
import { useGlobal } from "@/context/global"
import { useSettings } from "@/context/settings"
import { useMcpToggle } from "@/context/mcp"
import {
  AmicodeVaultsTab,
  AMICODE_MANAGE_VAULTS_PROMPT,
  parseVaultsResponse,
  type VaultsView,
} from "@opencode-ai/ui/amicode-vaults-tab"
import {
  AmicodeConnectionsTab,
  applyConnectionOverlay,
  parseConnectionActionResponse,
  parseConnectionsResponse,
  type ChooseProjectPayload,
  type ConnectionActionView,
  type ConnectionOverlay,
  type ConnectionsView,
  type CredentialSubmitPayload,
} from "@opencode-ai/ui/amicode-connections-tab"
import { usePrompt } from "@/context/prompt"
import { startPrompt } from "@/utils/start-prompt"
import { authTokenFromCredentials } from "@/utils/server"
import { GLOBAL_STATUS_DEFAULT_TAB } from "./status-popover-model"
import { useServerProtocol } from "@/context/server-sdk"
import { beginSolverSwitch } from "@/components/solver-switch-banner"

const pluginEmptyMessage = (value: string, file: string): JSXElement => {
  const parts = value.split(file)
  if (parts.length === 1) return value
  return (
    <>
      {parts[0]}
      <code class="bg-surface-raised-base px-1.5 py-0.5 rounded-sm text-text-base">{file}</code>
      {parts.slice(1).join(file)}
    </>
  )
}

const listServersByHealth = (
  list: ServerConnection.Any[],
  active: ServerConnection.Key | undefined,
  status: Record<ServerConnection.Key, ServerHealth | undefined>,
) => {
  if (!list.length) return list
  const order = new Map(list.map((url, index) => [url, index] as const))
  const rank = (value?: ServerHealth) => {
    if (value?.healthy === true) return 0
    if (value?.healthy === false) return 2
    return 1
  }

  return list.slice().sort((a, b) => {
    if (ServerConnection.key(a) === active) return -1
    if (ServerConnection.key(b) === active) return 1
    const diff = rank(status[ServerConnection.key(a)]) - rank(status[ServerConnection.key(b)])
    if (diff !== 0) return diff
    return (order.get(a) ?? 0) - (order.get(b) ?? 0)
  })
}

const useDefaultServerKey = (
  get: (() => string | Promise<string | null | undefined> | null | undefined) | undefined,
) => {
  const [state, setState] = createStore({
    key: undefined as ServerConnection.Key | undefined,
    tick: 0,
  })

  createEffect(() => {
    state.tick
    let dead = false
    const result = get?.()
    if (!result) {
      setState("key", undefined)
      onCleanup(() => {
        dead = true
      })
      return
    }

    if (result instanceof Promise) {
      void result.then((next) => {
        if (dead) return
        setState("key", next ?? undefined)
      })
      onCleanup(() => {
        dead = true
      })
      return
    }

    setState("key", ServerConnection.Key.make(result))
    onCleanup(() => {
      dead = true
    })
  })

  return {
    key: () => {
      return state.key
    },
    refresh: () => setState("tick", (value) => value + 1),
  }
}

type ServerStatusState = {
  servers: () => ServerStatusItem[]
  defaultKey: () => ServerConnection.Key | undefined
  ariaLabel: string
  serversLabel: string
  defaultLabel: string
  manageLabel: string
  onManage: () => void
}

type ServerStatusItem = {
  key: ServerConnection.Key
  conn: ServerConnection.Any
  health?: ServerHealth
  blocked: boolean
  active: boolean
  onSelect: () => void
}

export function StatusPopoverServerBody() {
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })

  const sortedServers = createMemo(() => listServersByHealth(global.servers.list(), server.key, global.servers.health))
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const serverItems = createMemo(() =>
    sortedServers().map((conn) => {
      const key = ServerConnection.key(conn)
      return {
        key,
        conn,
        health: global.servers.health[key],
        blocked: global.servers.health[key]?.healthy === false,
        active: !!server.current && key === ServerConnection.key(server.current),
        onSelect: () => {
          navigate("/")
          queueMicrotask(() => server.setActive(key))
        },
      }
    }),
  )

  return (
    <ServerStatusPopoverView
      state={{
        servers: serverItems,
        defaultKey: defaultServer.key,
        ariaLabel: language.t("status.popover.ariaLabel"),
        serversLabel: language.t("status.popover.tab.servers"),
        defaultLabel: language.t("common.default"),
        manageLabel: language.t("status.popover.action.manageServers"),
        onManage: () => {
          const run = ++dialogRun
          void import("./dialog-select-server").then((x) => {
            if (dialogDead || dialogRun !== run) return
            dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
          })
        },
      }}
    />
  )
}

function ServerStatusPopoverView(props: { state: ServerStatusState }) {
  return (
    <div class="flex items-center gap-1 w-[360px] rounded-lg shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={props.state.ariaLabel}
        class="tabs bg-[var(--v2-background-bg-base)] rounded-lg overflow-hidden"
        data-component="tabs"
        data-active="servers"
        defaultValue="servers"
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
            {props.state.servers().length > 0 ? `${props.state.servers().length} ` : ""}
            {props.state.serversLabel}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="servers">
          <ServerStatusList state={props.state} />
        </Tabs.Content>
      </Tabs>
    </div>
  )
}

function ServerStatusList(props: { state: ServerStatusState }) {
  return (
    <div class="flex flex-col px-2 pb-2">
      <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
        <For each={props.state.servers()}>
          {(item) => {
            return (
              <button
                type="button"
                class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                classList={{
                  "hover:bg-surface-raised-base-hover": !item.blocked,
                  "cursor-not-allowed": item.blocked,
                }}
                aria-disabled={item.blocked}
                onClick={() => {
                  if (item.blocked) return
                  item.onSelect()
                }}
              >
                <ServerHealthIndicator health={item.health} />
                <ServerRow
                  conn={item.conn}
                  dimmed={item.blocked}
                  status={item.health}
                  class="flex items-center gap-2 w-full min-w-0"
                  nameClass="text-14-regular text-text-base truncate"
                  versionClass="text-12-regular text-text-weak truncate"
                  badge={
                    <Show when={item.key === props.state.defaultKey()}>
                      <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                        {props.state.defaultLabel}
                      </span>
                    </Show>
                  }
                >
                  <div class="flex-1" />
                  <Show when={item.active}>
                    <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                  </Show>
                </ServerRow>
              </button>
            )
          }}
        </For>

        <Button variant="secondary" class="mt-3 self-start h-8 px-3 py-1.5" onClick={props.state.onManage}>
          {props.state.manageLabel}
        </Button>
      </div>
    </div>
  )
}

export function StatusPopoverBody(props: { shown: Accessor<boolean>; onClose?: () => void }) {
  const sync = useSync()
  const global = useGlobal()
  const server = useServer()
  const platform = usePlatform()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const settings = useSettings()
  const protocol = useServerProtocol()

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  createEffect(() => {
    if (!props.shown()) return
  })

  let dialogRun = 0
  let dialogDead = false
  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
  })
  const sortedServers = createMemo(() => {
    const list = settings.general.newLayoutDesigns()
      ? global.servers.list()
      : global.servers.list().filter((x) => global.ensureServerCtx(x).sdk.protocolKind() !== "v2")
    return listServersByHealth(list, server.key, global.servers.health)
  })
  const toggleMcp = useMcpToggle()
  const defaultServer = useDefaultServerKey(platform.getDefaultServer)
  const mcpNames = createMemo(() => Object.keys(sync().data.mcp ?? {}).sort((a, b) => a.localeCompare(b)))
  const mcpStatus = (name: string) => sync().data.mcp?.[name]?.status
  const mcpConnected = createMemo(() => mcpNames().filter((name) => mcpStatus(name) === "connected").length)
  const lspItems = createMemo(() => sync().data.lsp ?? [])
  const lspCount = createMemo(() => lspItems().length)
  const plugins = createMemo(() =>
    (sync().data.config.plugin ?? []).map((item) => (typeof item === "string" ? item : item[0])),
  )
  const pluginCount = createMemo(() => plugins().length)
  const pluginEmpty = createMemo(() => pluginEmptyMessage(language.t("dialog.plugins.empty"), "opencode.json"))

  // amicode: Vaults + Connections wiring — shared with the home-chrome global
  // popover (#174), see createAmicodeStatusTabs below. This session mount
  // routes "Manage vaults" through the composer of the OPEN session.
  const prompt = usePrompt()
  const amicodeTabs = createAmicodeStatusTabs({
    shown: props.shown,
    onManageVaults: () => {
      props.onClose?.()
      startPrompt(prompt, AMICODE_MANAGE_VAULTS_PROMPT)
    },
  })

  return (
    <div class="flex items-center gap-1 w-[360px] rounded-lg shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="tabs bg-[var(--v2-background-bg-base)] rounded-lg overflow-hidden"
        data-component="tabs"
        data-active={settings.general.newLayoutDesigns() ? "mcp" : "servers"}
        defaultValue={settings.general.newLayoutDesigns() ? "mcp" : "servers"}
        variant="alt"
      >
        <Tabs.List data-slot="tablist" class="bg-transparent border-b-0 px-4 pt-2 pb-0 gap-4 h-10">
          {!settings.general.newLayoutDesigns() && (
            <Tabs.Trigger value="servers" data-slot="tab" class="text-12-regular">
              {sortedServers().length > 0 ? `${sortedServers().length} ` : ""}
              {language.t("status.popover.tab.servers")}
            </Tabs.Trigger>
          )}
          <Tabs.Trigger value="mcp" data-slot="tab" class="text-12-regular">
            {mcpConnected() > 0 ? `${mcpConnected()} ` : ""}
            {language.t("status.popover.tab.mcp")}
          </Tabs.Trigger>
          <Tabs.Trigger value="lsp" data-slot="tab" class="text-12-regular">
            {lspCount() > 0 ? `${lspCount()} ` : ""}
            {language.t("status.popover.tab.lsp")}
          </Tabs.Trigger>
          <Show when={protocol() === "v1"}>
            <Tabs.Trigger value="plugins" data-slot="tab" class="text-12-regular">
              {pluginCount() > 0 ? `${pluginCount()} ` : ""}
              {language.t("status.popover.tab.plugins")}
            </Tabs.Trigger>
          </Show>
          <AmicodeStatusTabTriggers state={amicodeTabs} />
        </Tabs.List>

        {!settings.general.newLayoutDesigns() && (
          <Tabs.Content value="servers">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <For each={sortedServers()}>
                  {(s) => {
                    const key = ServerConnection.key(s)
                    const blocked = () => global.servers.health[key]?.healthy === false
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full h-8 pl-3 pr-1.5 py-1.5 rounded-md transition-colors text-left"
                        classList={{
                          "hover:bg-surface-raised-base-hover": !blocked(),
                          "cursor-not-allowed": blocked(),
                        }}
                        aria-disabled={blocked()}
                        onClick={() => {
                          if (blocked()) return
                          navigate("/")
                          queueMicrotask(() => server.setActive(key))
                        }}
                      >
                        <ServerHealthIndicator health={global.servers.health[key]} />
                        <ServerRow
                          conn={s}
                          dimmed={blocked()}
                          status={global.servers.health[key]}
                          class="flex items-center gap-2 w-full min-w-0"
                          nameClass="text-14-regular text-text-base truncate"
                          versionClass="text-12-regular text-text-weak truncate"
                          badge={
                            <Show when={key === defaultServer.key()}>
                              <span class="text-11-regular text-text-base bg-surface-base px-1.5 py-0.5 rounded-md">
                                {language.t("common.default")}
                              </span>
                            </Show>
                          }
                        >
                          <div class="flex-1" />
                          <Show when={server.current && key === ServerConnection.key(server.current)}>
                            <Icon name="check" size="small" class="text-icon-weak shrink-0" />
                          </Show>
                        </ServerRow>
                      </button>
                    )
                  }}
                </For>

                <Button
                  variant="secondary"
                  class="mt-3 self-start h-8 px-3 py-1.5"
                  onClick={() => {
                    const run = ++dialogRun
                    void import("./dialog-select-server").then((x) => {
                      if (dialogDead || dialogRun !== run) return
                      dialog.show(() => <x.DialogSelectServer />, defaultServer.refresh)
                    })
                  }}
                >
                  {language.t("status.popover.action.manageServers")}
                </Button>
              </div>
            </div>
          </Tabs.Content>
        )}

        <Tabs.Content value="mcp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={mcpNames().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.mcp.empty")}</div>
                }
              >
                <For each={mcpNames()}>
                  {(name) => {
                    const status = () => mcpStatus(name)
                    const enabled = () => status() === "connected"
                    return (
                      <button
                        type="button"
                        class="flex items-center gap-2 w-full min-h-8 pl-3 pr-2 py-1 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                        onClick={() => {
                          if (toggleMcp.isPending) return
                          toggleMcp.mutate(name)
                        }}
                        disabled={toggleMcp.isPending && toggleMcp.variables === name}
                      >
                        <div
                          classList={{
                            "size-1.5 rounded-full shrink-0": true,
                            "bg-icon-success-base": status() === "connected",
                            "bg-icon-critical-base": status() === "failed",
                            "bg-border-weak-base": status() === "disabled",
                            "bg-icon-warning-base":
                              status() === "needs_auth" || status() === "needs_client_registration",
                          }}
                        />
                        <span class="flex flex-col min-w-0 flex-1">
                          <span class="flex items-center gap-2 min-w-0">
                            <span class="text-14-regular text-text-base truncate">{name}</span>
                          </span>
                          <Show when={status() === "needs_auth"}>
                            <span class="text-11-regular text-text-weaker truncate">
                              {language.t("mcp.auth.clickToAuthenticate")}
                            </span>
                          </Show>
                        </span>
                        <div onClick={(event) => event.stopPropagation()}>
                          <Switch
                            checked={enabled()}
                            disabled={toggleMcp.isPending && toggleMcp.variables === name}
                            onChange={() => {
                              if (toggleMcp.isPending) return
                              toggleMcp.mutate(name)
                            }}
                          />
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Tabs.Content value="lsp">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <Show
                when={lspItems().length > 0}
                fallback={
                  <div class="text-14-regular text-text-base text-center my-auto">{language.t("dialog.lsp.empty")}</div>
                }
              >
                <For each={lspItems()}>
                  {(item) => (
                    <div class="flex items-center gap-2 w-full px-2 py-1">
                      <div
                        classList={{
                          "size-1.5 rounded-full shrink-0": true,
                          "bg-icon-success-base": item.status === "connected",
                          "bg-icon-critical-base": item.status === "error",
                        }}
                      />
                      <span class="text-14-regular text-text-base truncate">{item.name || item.id}</span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </Tabs.Content>

        <Show when={protocol() === "v1"}>
          <Tabs.Content value="plugins">
            <div class="flex flex-col px-2 pb-2">
              <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
                <Show
                  when={plugins().length > 0}
                  fallback={<div class="text-14-regular text-text-base text-center my-auto">{pluginEmpty()}</div>}
                >
                  <For each={plugins()}>
                    {(plugin) => (
                      <div class="flex items-center gap-2 w-full px-2 py-1">
                        <div class="size-1.5 rounded-full shrink-0 bg-icon-success-base" />
                        <span class="text-14-regular text-text-base truncate">{plugin}</span>
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </div>
          </Tabs.Content>
        </Show>

        <AmicodeStatusTabContents state={amicodeTabs} />
      </Tabs>
    </div>
  )
}

// amicode (#174): Vaults + Connections wiring, extracted so the session-header
// popover and the home-chrome global popover are ONE wiring with two mounts.
// Deliberately depends only on app-root contexts (useServer/useLanguage) — the
// home route mounts neither the directory-scoped sync context nor the
// composer's PromptProvider, so the manage-vaults action is injected.
type AmicodeStatusTabsState = ReturnType<typeof createAmicodeStatusTabs>

function createAmicodeStatusTabs(opts: { shown: Accessor<boolean>; onManageVaults: () => void }) {
  const server = useServer()
  const language = useLanguage()

  // amicode: Vaults tab — fetched per-active-server when the popover opens
  // (source flips truthy on open / server switch → refetch; closed keeps the
  // last value, stale-while-revalidate).
  const [vaultsRaw, { refetch: refetchVaults }] = createResource(
    () => (opts.shown() && server.current ? ServerConnection.key(server.current) : undefined),
    async () => {
      const conn = server.current
      if (!conn) return undefined
      const res = await fetch(new URL("/amicode/vaults", conn.http.url), { headers: amicodeHeaders(conn) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as unknown
    },
  )
  const vaultsView = createMemo<VaultsView | undefined>(() => {
    if (vaultsRaw.error) return { ok: false, mounts: [], error: language.t("dialog.vaults.fetchFailed") }
    const raw = vaultsRaw()
    if (raw === undefined) return undefined
    return parseVaultsResponse(raw)
  })
  const vaultsCount = () => {
    const view = vaultsView()
    return view?.ok ? view.mounts.length : 0
  }

  const connections = createAmicodeConnectionsState(opts.shown)

  return {
    vaultsView,
    vaultsCount,
    refetchVaults,
    onManageVaults: opts.onManageVaults,
    ...connections,
  }
}

// amicode#200: the Connections state, extracted verbatim from the tabs factory
// so the defaults capsule (the solver toggle owns Company Compute now) can host
// its own always-warm instance. Same fetch idiom, same one-round-trip mutation
// contract (#165/#166); depends only on app-root contexts.
export function createAmicodeConnectionsState(shown: Accessor<boolean>) {
  const server = useServer()
  const language = useLanguage()

  // Mutations are ONE round trip (#165 contract): the overlay renders
  // "validating" while the POST runs, then the terminal connection from the
  // SAME response replaces it. No polling loop.
  const [connectionsRaw, { refetch: refetchConnections }] = createResource(
    () => (shown() && server.current ? ServerConnection.key(server.current) : undefined),
    async () => {
      const conn = server.current
      if (!conn) return undefined
      const res = await fetch(new URL("/amicode/connections", conn.http.url), { headers: amicodeHeaders(conn) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as unknown
    },
  )
  const [connectionsOverlay, setConnectionsOverlay] = createSignal<ConnectionOverlay>({})
  const [connectionsActionError, setConnectionsActionError] = createSignal<string | undefined>()
  createEffect(() => {
    connectionsRaw.state // a fresh GET supersedes any leftover action overlay
    setConnectionsOverlay({})
    setConnectionsActionError(undefined)
  })
  const connectionsView = createMemo<ConnectionsView | undefined>(() => {
    const base = (() => {
      if (connectionsRaw.error)
        return { ok: false, connections: [], error: language.t("dialog.connections.fetchFailed") } as ConnectionsView
      const raw = connectionsRaw()
      if (raw === undefined) return undefined
      return parseConnectionsResponse(raw)
    })()
    return applyConnectionOverlay(base, connectionsOverlay())
  })
  const connectionsCount = () => {
    const view = connectionsView()
    return view?.ok ? view.connections.filter((conn) => conn.state === "connected").length : 0
  }
  const runConnectionAction = async (id: string, path: string, body: unknown): Promise<ConnectionActionView> => {
    setConnectionsActionError(undefined)
    setConnectionsOverlay({ validating: id })
    const result = await (async (): Promise<ConnectionActionView> => {
      const conn = server.current
      if (!conn) return { ok: false, error: language.t("dialog.connections.fetchFailed") }
      try {
        const res = await fetch(new URL(path, conn.http.url), {
          method: "POST",
          headers: { ...amicodeHeaders(conn), "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return parseConnectionActionResponse((await res.json()) as unknown)
      } catch {
        return { ok: false, error: language.t("dialog.connections.fetchFailed") }
      }
    })()
    if (result.ok && result.connection) {
      setConnectionsOverlay({ terminal: result.connection })
    } else {
      setConnectionsOverlay({})
      setConnectionsActionError(result.error ?? language.t("dialog.connections.fetchFailed"))
    }
    return result
  }
  const onSubmitCredential = (payload: CredentialSubmitPayload) =>
    runConnectionAction(payload.id, "/amicode/connections/credential", payload)
  const onDisconnectConnection = (id: string) => void runConnectionAction(id, "/amicode/connections/disconnect", { id })
  const onRevalidateConnection = (id: string) => void runConnectionAction(id, "/amicode/connections/revalidate", { id })
  // #194 two-step picker: finalize the chosen project, or cancel back to a
  // clean disconnect (the server drops the pending selection either way).
  const onChooseProject = (payload: ChooseProjectPayload) =>
    void runConnectionAction(payload.id, "/amicode/connections/choose-project", payload)
  const onCancelAuth = (id: string) => void runConnectionAction(id, "/amicode/connections/disconnect", { id })
  // opencode#78: releasing the HP tier. Deliberately NOT runConnectionAction —
  // that helper keys its overlay on a connection id and reads a `connection`
  // out of the response; this route answers {ok, mode, error} about the solver,
  // not about a connection, so routing it through there would render the
  // release as a failed credential mutation. Fire-and-forget with a refetch:
  // the server restart the switch triggers makes any awaited status stale
  // anyway.
  const onSelectPiccolo = () => {
    const conn = server.current
    if (!conn) return
    beginSolverSwitch("piccolo") // narrate the restart this is about to trigger
    void (async () => {
      try {
        await fetch(new URL("/amicode/solver-mode", conn.http.url), {
          method: "POST",
          headers: { ...amicodeHeaders(conn), "content-type": "application/json" },
          body: JSON.stringify({ mode: "piccolo" }),
        })
      } catch {
        /* the extension watcher is the durable half; a lost request is retried
           by the next pick rather than surfaced as a connection error */
      }
      refetchConnections()
    })()
  }
  // Google browser OAuth: POST to the server's auth start route; the server opens the
  // system browser via McpBrowser (which now respects BROWSER in VS Code remote).
  // Fallback to window.open when the server does not return a URL (e.g. token-based
  // google probe that already has a cached URL). The overlay tracks validating state
  // while the round-trip is in flight so the card shows the waiting-browser copy.
  const onStartAuth = (payload: import("@opencode-ai/ui/amicode-connections-tab").StartAuthPayload) => {
    void runConnectionAction(payload.id, "/amicode/connections/auth", payload).then((result) => {
      // The server's BrowserOpenFailed event carries the URL when the helper fails;
      // as a belt-and-suspenders, if the action response itself carries a URL,
      // open it here via the browser. The status-popover runs in the main app
      // (not the chat iframe), so window.open is not blocked.
      const maybeUrl = (result as unknown as { url?: string })?.url
      if (maybeUrl && typeof maybeUrl === "string" && /^https:\/\//i.test(maybeUrl)) {
        try { window.open(maybeUrl, "_blank", "noopener") } catch {}
      }
    })
  }
  const connectionsLabels = createMemo(() => ({
    empty: language.t("dialog.connections.empty"),
    retry: language.t("dialog.connections.retry"),
    states: {
      connected: language.t("dialog.connections.state.connected"),
      "needs-key": language.t("dialog.connections.state.needsKey"),
      invalid: language.t("dialog.connections.state.invalid"),
      expired: language.t("dialog.connections.state.expired"),
      unreachable: language.t("dialog.connections.state.unreachable"),
      unentitled: language.t("dialog.connections.state.unentitled"),
      validating: language.t("dialog.connections.state.validating"),
      "waiting-browser": language.t("dialog.connections.state.waitingBrowser"),
      "waiting-code": language.t("dialog.connections.state.waitingCode"),
      "choose-project": language.t("dialog.connections.state.chooseProject"),
      unknown: language.t("dialog.connections.state.unknown"),
    },
    baseUrlPlaceholder: language.t("dialog.connections.baseUrlPlaceholder"),
    tokenPlaceholder: language.t("dialog.connections.tokenPlaceholder"),
    usernamePlaceholder: language.t("dialog.connections.usernamePlaceholder"),
    passwordPlaceholder: language.t("dialog.connections.passwordPlaceholder"),
    projectIdPlaceholder: language.t("dialog.connections.projectIdPlaceholder"),
    submit: language.t("dialog.connections.submit"),
    disconnect: language.t("dialog.connections.disconnect"),
    revalidate: language.t("dialog.connections.revalidate"),
    staleHint: language.t("dialog.connections.stale"),
    sessionOnlyHint: language.t("dialog.connections.sessionOnly"),
    // raw {{slot}} templates — the ui card fills them with render-time values
    offlineHint: language.t("dialog.connections.offline"),
    driftHint: language.t("dialog.connections.drift"),
    // auth-path scaffold (#194): reachable only when the wire advertises
    // methods / mid-flow states — today's producer never does
    methods: {
      credentials: language.t("dialog.connections.method.credentials"),
      browser: language.t("dialog.connections.method.browser"),
      "device-code": language.t("dialog.connections.method.deviceCode"),
      token: language.t("dialog.connections.method.token"),
    },
    startBrowser: language.t("dialog.connections.startBrowser"),
    startDeviceCode: language.t("dialog.connections.startDeviceCode"),
    cancel: language.t("dialog.connections.cancel"),
    userCodeHint: language.t("dialog.connections.userCode"),
    codeExpiresHint: language.t("dialog.connections.codeExpires"),
    useProject: language.t("dialog.connections.useProject"),
  }))

  return {
    connectionsView,
    connectionsCount,
    connectionsLabels,
    connectionsActionError,
    refetchConnections,
    onSubmitCredential,
    onDisconnectConnection,
    onRevalidateConnection,
    onSelectPiccolo,
    onChooseProject,
    onCancelAuth,
    onStartAuth,
  }
}

const amicodeHeaders = (conn: ServerConnection.Any) => {
  const headers: Record<string, string> = {}
  if (conn.http.password)
    headers.Authorization = `Basic ${authTokenFromCredentials({
      username: conn.http.username,
      password: conn.http.password,
    })}`
  return headers
}

// The two shared tab triggers/contents — rendered inside each mount's own
// <Tabs> so Kobalte's tabs context resolves normally.
function AmicodeStatusTabTriggers(props: { state: AmicodeStatusTabsState; includeVaults?: boolean }) {
  const language = useLanguage()
  return (
    <>
      {/* amicode#202: vaults moved to the native Armonia sidebar; the global
          home-chrome mount passes includeVaults={false}. The session-view mount
          keeps its vaults tab (default true). */}
      <Show when={props.includeVaults ?? true}>
        <Tabs.Trigger value="vaults" data-slot="tab" class="text-12-regular">
          {props.state.vaultsCount() > 0 ? `${props.state.vaultsCount()} ` : ""}
          {language.t("status.popover.tab.vaults")}
        </Tabs.Trigger>
      </Show>
      <Tabs.Trigger value="connections" data-slot="tab" class="text-12-regular">
        {props.state.connectionsCount() > 0 ? `${props.state.connectionsCount()} ` : ""}
        {language.t("status.popover.tab.connections")}
      </Tabs.Trigger>
    </>
  )
}

function AmicodeStatusTabContents(props: { state: AmicodeStatusTabsState; includeVaults?: boolean }) {
  const language = useLanguage()
  return (
    <>
      <Show when={props.includeVaults ?? true}>
        <Tabs.Content value="vaults">
          <div class="flex flex-col px-2 pb-2">
            <div class="flex flex-col p-3 bg-background-base rounded-sm min-h-14">
              <AmicodeVaultsTab
                view={props.state.vaultsView()}
                emptyLabel={language.t("dialog.vaults.empty")}
                retryLabel={language.t("dialog.vaults.retry")}
                onRetry={props.state.refetchVaults}
              />
              <Button variant="secondary" class="mt-3 self-start h-8 px-3 py-1.5" onClick={props.state.onManageVaults}>
                {language.t("status.popover.action.manageVaults")}
              </Button>
            </div>
          </div>
        </Tabs.Content>
      </Show>

      <Tabs.Content value="connections">
        {/* amicode#203 (Kate): the header-less global mount uses a single flat
            14px padding (matching the other chrome dropdowns) instead of the
            tabbed mount's inset card (px-2 pb-2 + p-3 raised box). */}
        <div class="flex flex-col p-3">
          <div class="flex flex-col min-h-14">
            <AmicodeConnectionsTab
              view={props.state.connectionsView()}
              labels={props.state.connectionsLabels()}
              actionError={props.state.connectionsActionError()}
              onSubmit={props.state.onSubmitCredential}
              onDisconnect={props.state.onDisconnectConnection}
              onRevalidate={props.state.onRevalidateConnection}
              onRetry={props.state.refetchConnections}
              onStartAuth={(props.state as unknown as { onStartAuth?: (p: import("@opencode-ai/ui/amicode-connections-tab").StartAuthPayload) => void }).onStartAuth}
              onChooseProject={props.state.onChooseProject}
              onCancelAuth={props.state.onCancelAuth}
            />
          </div>
        </div>
      </Tabs.Content>
    </>
  )
}

// amicode (#174): the GLOBAL status surface — mounted from the home chrome's
// Connections entry, where no session (and no directory-scoped sync context)
// exists. Hosts only the global tabs (vaults + connections; mcp/lsp/plugins
// are per-directory) and pre-selects Connections, since that is the entry's
// label. Manage-vaults is injected: home starts a fresh draft session with
// the manage prompt instead of writing into an open composer.
export function StatusPopoverGlobalBody(props: {
  shown: Accessor<boolean>
  onClose?: () => void
  onManageVaults: () => void
}) {
  const language = useLanguage()
  const amicodeTabs = createAmicodeStatusTabs({
    shown: props.shown,
    onManageVaults: () => {
      props.onClose?.()
      props.onManageVaults()
    },
  })

  return (
    <div class="flex items-center gap-1 w-[360px] rounded-lg shadow-[var(--shadow-lg-border-base)]">
      <Tabs
        aria-label={language.t("status.popover.ariaLabel")}
        class="tabs bg-[var(--v2-background-bg-base)] rounded-lg overflow-hidden"
        data-component="tabs"
        data-active={GLOBAL_STATUS_DEFAULT_TAB}
        defaultValue={GLOBAL_STATUS_DEFAULT_TAB}
        variant="alt"
      >
        {/* amicode#203 (Kate): no tab-header — Connections is the only surface
            here now (vaults moved to the sidebar), so the label is redundant. */}
        <AmicodeStatusTabContents state={amicodeTabs} includeVaults={false} />
      </Tabs>
    </div>
  )
}
