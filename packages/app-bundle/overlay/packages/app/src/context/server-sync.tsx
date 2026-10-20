import type {
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { getFilename } from "@opencode-ai/core/util/path"
import { type Accessor, batch, createEffect, createMemo, getOwner, onCleanup, onMount, untrack } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useLanguage } from "@/context/language"
import type { InitError } from "../pages/error"
import { ServerSDK } from "./server-sdk"
import {
  bootstrapDirectory,
  bootstrapGlobal,
  clearProviderRev,
  loadAgentsQuery,
  loadCommands,
  loadGlobalConfigQuery,
  loadPathQuery,
  loadProjectsQuery,
  loadProvidersQuery,
  loadReferencesQuery,
} from "./global-sync/bootstrap"
import { createChildStoreManager } from "./global-sync/child-store"
import { applyDirectoryEvent, applyGlobalEvent } from "./global-sync/event-reducer"
import { estimateRootSessionTotal, loadRootSessions, loadRootSessionsV1 } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SolidQueryOptions } from "@tanstack/solid-query"
import { createRefreshQueue } from "./global-sync/queue"
import { directoryKey } from "./global-sync/utils"
import { PathKey } from "@/utils/path-key"
import { createDirSyncContext } from "./directory-sync"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { retry } from "@opencode-ai/core/util/retry"
import type { ServerScope } from "@/utils/server-scope"
import { createHomeSessionIndexCache } from "./global-sync/home-session-index"
import { persisted } from "@/utils/persist"
import type { ServerApi } from "@/utils/server"
import type {
  McpListInput,
  McpListOutput,
  McpResource,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  McpServer,
  SessionActiveOutput,
} from "@opencode-ai/client/promise"
import { toggleMcp } from "./global-sync/mcp"
import { createServerSession, type ServerSession } from "./server-session"
import { amicodeGetResponse } from "@/utils/amicode-fetch"
import {
  createFleetDiagnostics,
  fleetSessionStatusRoute,
  runFleetReseed,
  type FleetReseedDeps,
} from "./fleet-session-status"
import { createFleetReseedScheduler, viewedSessionIdFromLocation } from "./fleet-reseed-scheduler"

type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  provider: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

type McpListApi = {
  readonly list: (input?: McpListInput) => Promise<McpListOutput>
}

type McpResourceApi = {
  readonly resource: {
    readonly catalog: (input?: McpResourceCatalogInput) => Promise<McpResourceCatalogOutput>
  }
}

type ApiQueryOptions<T, K extends readonly unknown[]> = SolidQueryOptions<T, Error, T, K> & {
  initialData?: undefined
  queryKey: K
}

type SessionActiveApi = {
  readonly active: () => Promise<SessionActiveOutput>
}

export const loadMcpQuery = (
  scope: ServerScope,
  directory: string,
  api: McpListApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpServer["status"]>, readonly [ServerScope, string, "mcp"]> =>
  queryOptions<
    Record<string, McpServer["status"]>,
    Error,
    Record<string, McpServer["status"]>,
    readonly [ServerScope, string, "mcp"]
  >({
    queryKey: [scope, directory, "mcp"] as const,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy) return (await legacy.mcp.status()).data ?? {}
      return api
        .list({ location: { directory } })
        .then((result) => Object.fromEntries(result.data.map((server) => [server.name, server.status])))
    },
  })

export const loadMcpResourcesQuery = (
  scope: ServerScope,
  directory: string,
  api: McpResourceApi,
  legacy?: OpencodeClient,
  protocol?: Promise<"v1" | "v2">,
): ApiQueryOptions<Record<string, McpResource>, readonly [ServerScope, string, "mcpResources"]> =>
  queryOptions<
    Record<string, McpResource>,
    Error,
    Record<string, McpResource>,
    readonly [ServerScope, string, "mcpResources"]
  >({
    queryKey: [scope, directory, "mcpResources"] as const,
    queryFn: async () => {
      if ((await protocol) === "v1" && legacy) {
        return Object.fromEntries(
          Object.entries((await legacy.experimental.resource.list()).data ?? {}).map(([key, resource]) => [
            key,
            { ...resource, server: resource.client },
          ]),
        )
      }
      return api.resource
        .catalog({ location: { directory } })
        .then((result) =>
          Object.fromEntries(result.data.resources.map((resource) => [`${resource.server}:${resource.uri}`, resource])),
        )
    },
    placeholderData: {},
  })

export const loadLspQuery = (scope: ServerScope, directory: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [scope, directory, "lsp"] as const,
    queryFn: () => sdk.lsp.status().then((r) => r.data ?? []),
  })

export const loadActiveSessionsQuery = (
  scope: ServerScope,
  api: SessionActiveApi,
): ApiQueryOptions<SessionActiveOutput, readonly [ServerScope, "activeSessions"]> =>
  queryOptions<SessionActiveOutput, Error, SessionActiveOutput, readonly [ServerScope, "activeSessions"]>({
    queryKey: [scope, "activeSessions"] as const,
    queryFn: () => api.active(),
    enabled: true,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  })

export function seedActiveSessionStatuses(
  session: Pick<ServerSession, "data" | "set">,
  active: SessionActiveOutput | Record<string, SessionStatus>,
) {
  for (const sessionID of Object.keys(active)) {
    if (session.data.session_status[sessionID] !== undefined) continue
    const status = active[sessionID]
    session.set("session_status", sessionID, status?.type === "running" ? { type: "busy" } : status)
  }
}

function makeQueryOptionsApi(
  scope: ServerScope,
  serverSDK: () => OpencodeClient,
  serverAPI: ServerApi,
  sdkFor: (dir: PathKey) => OpencodeClient,
  protocol: Promise<"v1" | "v2">,
) {
  return {
    globalConfig: () => loadGlobalConfigQuery(scope, serverSDK(), protocol),
    projects: () => loadProjectsQuery(scope, serverAPI.project),
    providers: (directory: PathKey | null) =>
      loadProvidersQuery(scope, directory, serverAPI, directory ? sdkFor(directory) : serverSDK(), protocol),
    path: (directory: PathKey | null) =>
      loadPathQuery(scope, directory, directory ? sdkFor(directory) : serverSDK(), protocol),
    agents: (directory: PathKey) => loadAgentsQuery(scope, directory, serverAPI.agent, sdkFor(directory), protocol),
    references: (directory: PathKey) =>
      loadReferencesQuery(scope, directory, serverAPI.reference, sdkFor(directory), protocol),
    mcp: (directory: PathKey) => loadMcpQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol),
    mcpResources: (directory: PathKey) =>
      loadMcpResourcesQuery(scope, directory, serverAPI.mcp, sdkFor(directory), protocol),
    lsp: (directory: PathKey) => loadLspQuery(scope, directory, sdkFor(directory)),
    sessions: (directory: PathKey) => ({ queryKey: [scope, directory, "loadSessions"] as const }),
  }
}
export type QueryOptionsApi = ReturnType<typeof makeQueryOptionsApi>

export function createServerSyncContextInner(serverSDK: ServerSDK) {
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("ServerSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()

  const sdkFor = (directory: string) => {
    const key = directoryKey(directory)
    const cached = sdkCache.get(key)
    if (cached) return cached
    const sdk = serverSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(key, sdk)
    return sdk
  }

  const session = createServerSession(serverSDK.client, serverSDK.api.session, serverSDK.api.message, {
    protocol: serverSDK.protocol,
    // #1291 durable mirror: the scope string keys the IndexedDB mirror
    // (per server; session IDs are unique on their own).
    mirrorScope: serverSDK.scope,
  })
  const queryOptionsApi = makeQueryOptionsApi(
    serverSDK.scope,
    () => serverSDK.client,
    serverSDK.api,
    sdkFor,
    serverSDK.protocol,
  )

  const [configQuery, providerQuery, pathQuery] = useQueries(() => ({
    queries: [queryOptionsApi.globalConfig(), queryOptionsApi.providers(null), queryOptionsApi.path(null)],
  }))
  const activeSessionsQuery = useQuery(() =>
    loadActiveSessionsQuery(serverSDK.scope, {
      active: async () => {
        if ((await serverSDK.protocol) === "v1") {
          const statuses = (await serverSDK.client.session.status()).data ?? {}
          seedActiveSessionStatuses(session, statuses)
          for (const sessionID of Object.keys(statuses)) {
            void session.resolve(sessionID).catch(() => undefined)
          }
          return Object.fromEntries(
            Object.entries(statuses).flatMap(([sessionID, status]) =>
              status.type === "idle" ? [] : [[sessionID, { type: "running" as const }]],
            ),
          )
        }
        const active = await serverSDK.api.session.active()
        seedActiveSessionStatuses(session, active)
        for (const sessionID of Object.keys(active)) {
          void session.resolve(sessionID).catch(() => undefined)
        }
        return active
      },
    }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    get ready() {
      return !bootstrap.isPending
    },
    project: [],
    provider_auth: {},
    get path() {
      const EMPTY = { state: "", config: "", worktree: "", directory: "", home: "" }
      if (pathQuery.isLoading) return EMPTY
      return pathQuery.data ?? EMPTY
    },
    get provider() {
      const EMPTY = { all: new Map(), connected: [], default: {} }
      if (providerQuery.isLoading) return EMPTY
      return providerQuery.data ?? EMPTY
    },
    get config() {
      if (configQuery.isLoading) return {}
      return configQuery.data ?? {}
    },
    get reload() {
      return updateConfigMutation.isPending ? "pending" : undefined
    },
  })

  const queryClient = useQueryClient()
  const homeSessions = createHomeSessionIndexCache(queryClient, ServerConnection.key(serverSDK.server))
  const refreshProviders = () =>
    queryClient.refetchQueries({
      predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
    })

  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  // #1637 — reconcile session_status from /session/status (the FULL tri-state
  // map — NOT /session/active, which is running-only and cannot carry the idle
  // needed to downgrade a stale busy) on every reconnect edge / gap frame. The
  // fetch is timestamped BEFORE the request so the store's recency guard can
  // refuse a downgrade of a busy that was mutated locally after the snapshot.
  // #1766: this is now the FALLBACK — today's local re-seed, unchanged.
  const localReseed = async () => {
    const fetchedAt = Date.now()
    try {
      const statuses = (await serverSDK.client.session.status()).data ?? {}
      session.reconcileStatuses(statuses, { fetchedAt })
    } catch {
      // A failed reconcile is non-fatal — the next edge retries.
    }
  }
  // #1766 — the FLEET re-seed: name the pinned sessions (every open tab's, the
  // viewed one first) to the service's fleet session-status read, which asks
  // each session's OWNER for status in that session's exact DIRECTORY, and
  // apply its tri-state map through the same recency-guarded reconcile. A peer
  // session's busy re-learned here re-raises the rail's working floor after a
  // reopen (the fan-in does not replay). Unavailable → localReseed().
  const fleetDiagnostics = createFleetDiagnostics()
  const fleetReseedDeps: FleetReseedDeps = {
    fetchFleet: (ids, signal) => amicodeGetResponse(serverSDK.server, fleetSessionStatusRoute(ids), { signal }),
    // The read passes the engine's own SessionStatus entries through validated.
    reconcile: (statuses, opts) => session.reconcileStatuses(statuses as Record<string, SessionStatus>, opts),
    localReseed,
    diagnostics: fleetDiagnostics,
  }
  // #1766 — the re-seed TRIGGERS + 10 s SELF-HEAL: the connected edge and the
  // sync-gap frame (below), a newly pinned session (debounced), `unknown`
  // retries for a cold owner map, and a visibility-gated periodic tick — all
  // single-flight, each read bounded by the client timeout. Nothing pinned →
  // the edges keep today's local re-seed.
  const fleetReseed = createFleetReseedScheduler({
    pinnedIds: () => session.pinnedIds(),
    viewedId: () =>
      typeof window === "undefined"
        ? undefined
        : viewedSessionIdFromLocation(`${window.location.pathname}${window.location.hash}`),
    reseed: (ids, signal) => runFleetReseed(ids, { ...fleetReseedDeps, signal }),
    localReseed,
    isConnected: () => serverSDK.event.status() === "connected",
    isVisible: () => typeof document === "undefined" || document.visibilityState !== "hidden",
    diagnostics: fleetDiagnostics,
  })
  const offPinned = session.onPinned((sessionID) => fleetReseed.notePinned(sessionID))
  fleetReseed.start()
  onCleanup(() => {
    offPinned()
    fleetReseed.stop()
  })
  // #1264/#1289 (reconnect-storm debounce): the SSE preamble replays
  // `server.connected` to EVERY reconnecting member — over a flaky link a
  // reconnect flurry would re-bootstrap all active directories once per
  // blip. A real server restart still queues (after the debounce window),
  // and the session-list refetch above still covers new/disposed sessions
  // immediately.
  let lastConnectedQueueAt = 0
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const setProjects = (next: Project[] | ((draft: Project[]) => Project[])) => {
    setGlobalStore("project", next)
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const bootstrap = useQuery(() => ({
    queryKey: [serverSDK.scope, "bootstrap"],
    queryFn: async () => {
      await bootstrapGlobal({
        serverSDK: serverSDK.client,
        serverAPI: serverSDK.api,
        protocol: serverSDK.protocol,
        scope: serverSDK.scope,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
      return bootedAt
    },
  }))

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => Project[]))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    key: directoryKey,
    bootstrap: () => queryClient.fetchQuery({ queryKey: [serverSDK.scope, "bootstrap"] }),
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    scope: serverSDK.scope,
    persist: persisted,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onMcp: (directory, setStore) => {
      void loadCommands(directory, serverSDK.api.command, sdkFor(directory), serverSDK.protocol)
        .then((commands) => setStore("command", commands))
        .catch((err) => {
          showToast({
            variant: "error",
            title: language.t("toast.project.reloadFailed.title", { project: getFilename(directory) }),
            description: formatServerError(err, language.t),
          })
        })
    },
    onDispose: (directory) => {
      const key = directoryKey(directory)
      queue.clear(key)
      sessionMeta.delete(key)
      sdkCache.delete(key)
      clearProviderRev(serverSDK.scope, key)
    },
    translate: language.t,
    queryOptions: queryOptionsApi,
    global: {
      provider: globalStore.provider,
    },
  })

  async function loadSessions(directory: string, options?: { limit?: number }) {
    const key = directoryKey(directory)
    const pending = sessionLoads.get(key)
    if (pending) {
      await pending
      return loadSessions(directory, options)
    }

    children.pin(key)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(key)
    const retainedLimit = Math.max(store.limit, options?.limit ?? 0, meta?.limit ?? 0)
    if (meta && meta.limit >= retainedLimit) {
      const next = trimSessions(store.session, {
        limit: retainedLimit,
        permission: session.data.permission,
      })
      if (next.length !== store.session.length) {
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(key)
      return
    }

    const limit = Math.max(retainedLimit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...queryOptionsApi.sessions(key),
        queryFn: () =>
          serverSDK.protocol
            .then((protocol) =>
              protocol === "v1"
                ? loadRootSessionsV1({ client: sdkFor(directory), directory, limit })
                : loadRootSessions({ api: serverSDK.api.session, directory, limit }),
            )
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              // amicode#288: the fetch limit must be the floor here. Re-deriving
              // it from a fresh store (limit 0) trimmed everything older than
              // SESSION_RECENT_WINDOW out of the store — the dropdown and home
              // list then showed only the last few hours of history.
              const retained = Math.max(limit, store.limit, options?.limit ?? 0, sessionMeta.get(key)?.limit ?? 0)
              const childSessions = store.session.filter((s) => !!s.parentID)
              const next = trimSessions([...nonArchived, ...childSessions], {
                limit: retained,
                permission: session.data.permission,
              })
              batch(() => {
                next.forEach(session.remember)
                setStore(
                  "sessionTotal",
                  estimateRootSessionTotal({
                    count: nonArchived.length,
                    limit: x.limit,
                    limited: x.limited,
                  }),
                )
                setStore("session", reconcile(next, { key: "id" }))
              })
              sessionMeta.set(key, { limit: retained })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(key, promise)
    void promise.finally(() => {
      sessionLoads.delete(key)
      children.unpin(key)
    })
    return promise
  }

  async function bootstrapInstance(directory: string) {
    const key = directoryKey(directory)
    if (!key) return
    const pending = booting.get(key)
    if (pending) return pending

    children.pin(key)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(key)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        scope: serverSDK.scope,
        mcp: children.mcp(key),
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        api: serverSDK.api,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        session,
        protocol: serverSDK.protocol,
      })
    })

    booting.set(key, promise)
    void promise.finally(() => {
      booting.delete(key)
      children.unpin(key)
    })
    return promise
  }

  const indexSession = (info: Parameters<typeof session.remember>[0]) => {
    const key = directoryKey(info.directory)
    const existing = children.children[key]
    if (!existing) return
    applyDirectoryEvent({
      event: { type: "session.created", properties: { info } },
      directory: key,
      store: existing[0],
      setStore: existing[1],
      push: queue.push,
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      loadLsp() {},
    })
  }

  const unsub = serverSDK.event.listen((e) => {
    const directory = e.name
    const key = directoryKey(directory)
    const event = e.details
    const eventType: string = event.type
    const recent = bootingRoot || Date.now() - bootedAt < 1500
    // #1539: remote-origin events must NOT mutate the local directory store.
    // The origin field is set by the SSE loop when the event came from a remote
    // peer's namespace in the fan-in composite cursor. `undefined` = local.
    const isRemote = typeof event.origin === "string"

    if (event.current) session.applyV2(event.current)
    session.apply(event)
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      // #1539: homeSessions feeds into the session list that mergePeerSessions
      // deduplicates against; remote events contaminate it the same way.
      if (!isRemote) homeSessions.apply(event)
    }
    homeSessions.refresh(event.type)
    if (eventType === "integration.connection.updated") void refreshProviders()

    if (directory === "global") {
      if (eventType === "server.connected" && activeSessionsQuery.data === undefined && !activeSessionsQuery.isFetching)
        void activeSessionsQuery.refetch()
      // #1637 — reconcile the tri-state status on every reconnect edge / gap
      // frame so a status left stale during an outage self-corrects without a
      // reload (a stale busy AND a stale idle), recency-guarded in the store.
      // #1766: through the FLEET read (peer sessions included), local fallback.
      if (eventType === "server.connected") fleetReseed.trigger("connected")
      if (eventType === "amicode.sync.gap") fleetReseed.trigger("gap")
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          bootstrap.refetch()
        },
        setGlobalProject: setProjects,
      })
      if (
        eventType === "config.updated" ||
        eventType === "catalog.updated" ||
        eventType === "agent.updated" ||
        eventType === "project.directories.updated" ||
        // #1617 (ADR 0033 Amendment 1): the fan-in aggregator dropped frames on
        // buffer overflow while the downstream was backpressured and emitted a
        // gap signal; the SDK loop re-emitted it as this synthetic global event.
        // A gap is a real loss, so force a bootstrap refetch UNCONDITIONALLY —
        // this branch runs before the #1289 `server.connected` debounce below and
        // keys on a distinct type, so the forced refetch bypasses that debounce.
        eventType === "amicode.sync.gap"
      )
        bootstrap.refetch()
      if (eventType === "server.connected" || eventType === "global.disposed") {
        if (recent) return
        // #1264/#1289: debounce — skip if a connected-triggered queue ran
        // within the window (reconnect flurry), queue otherwise.
        if (eventType === "server.connected" && Date.now() - lastConnectedQueueAt < 30_000) return
        lastConnectedQueueAt = Date.now()
        for (const directory of Object.keys(children.children)) {
          if (!children.active(directory)) continue
          // #1539: a remote server.connected/global.disposed must not trigger
          // local directory re-bootstraps.
          if (!isRemote) queue.push(directory)
        }
      }
      return
    }

    // #1539: indexSession inserts synthetic session.created events into the
    // directory store — skip for remote events.
    if (!isRemote) {
      if (event.current?.type === "session.moved") {
        const info = session.get(event.current.data.sessionID)
        if (info) indexSession(info)
      }
      if (event.current?.type === "session.forked")
        void session
          .resolve(event.current.data.sessionID, { force: true })
          .then(indexSession)
          .catch(() => {})
    }

    const existing = children.children[key]
    if (!existing) return
    children.mark(key)
    if (
      event.current?.type === "session.moved" ||
      // event.current?.type === "session.archived" ||
      event.current?.type === "session.forked" ||
      eventType === "command.updated" ||
      eventType === "config.updated" ||
      eventType === "agent.updated"
    ) {
      // #1539: queue.push triggers directory re-fetches that would pull remote
      // sessions into the local store.
      if (!isRemote) queue.push(key)
    }
    if (eventType === "mcp.status.changed") void queryClient.invalidateQueries(queryOptionsApi.mcp(key))
    if (eventType === "mcp.resources.changed") void queryClient.invalidateQueries(queryOptionsApi.mcpResources(key))
    // #1539: applyDirectoryEvent is the primary contamination point — remote
    // events must not insert into or update the directory-scoped store.session.
    if (isRemote) return
    const [store, setStore] = existing
    applyDirectoryEvent({
      event,
      directory,
      store,
      setStore,
      push: (directory) => {
        if (children.active(directory)) queue.push(directory)
      },
      retainedLimit: sessionMeta.get(key)?.limit,
      sessionContent: false,
      permission: session.data.permission,
      vcsCache: children.vcsCache.get(key),
      loadLsp: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.lsp(key))
      },
      loadReferences: () => {
        if (!children.active(key)) return
        void queryClient.fetchQuery(queryOptionsApi.references(key))
      },
    })
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directoryKey(directory))
    }
  })

  // #1760/#1785 attach protocol — SYNC-LAYER placement (2026-10-20). On every
  // stream (re)connect, pull the hub's one-wire snapshot (/attach?directory= —
  // merged busy map + session list) per known directory and reconcile busy
  // state from STATE, not transitions. A fresh/reconnecting client never
  // witnessed the busy transitions of sessions that started while it was
  // away, and the boot seed (activeSessionsQuery) runs once with
  // staleTime:Infinity — the "output streams but the busy chip never lights"
  // class. Locally-busy sessions ABSENT from the snapshot downgrade to idle
  // (an idle transition swallowed by a gap heals); reconcileStatuses applies
  // everything recency-guarded so live transitions win.
  // WHY HERE and not a component: the view-level resync effects
  // (session.tsx, layout) are DISPOSED with a transient first-mount owner
  // right after their initial run (diagnosed 2026-10-20 via onCleanup
  // telemetry: "EFFECT DISPOSED (count was 0)" — the resync signal bumps
  // 1,2,3 across reconnects but no component effect ever observes it). The
  // sync context outlives view churn — its onMount starts the very stream
  // that bumps the signal — so the attach consumer lives here.
  const attachInflight = new Set<string>()
  const attachDirectory = async (directory: string) => {
    const conn = serverSDK.server
    if (!conn) return
    if (attachInflight.has(directory)) return
    attachInflight.add(directory)
    const fetchedAt = Date.now()
    try {
      const { status, body } = await amicodeGetResponse(
        conn,
        `/attach?directory=${encodeURIComponent(directory)}`,
      )
      if (status !== 200 || !body || typeof body !== "object") return
      const snap = body as { busy?: Record<string, unknown> }
      if (!snap.busy || typeof snap.busy !== "object") return
      // The engines' status maps carry BUSY sessions only — absent = idle.
      // Compose the full map: snapshot busy + idle downgrades for locally-busy
      // sessions the snapshot no longer knows (recency-guarded inside
      // reconcileStatuses — a busy transition newer than this fetch refuses
      // the downgrade).
      const localBusy = untrack(() => {
        const all = session.data.session_status
        return Object.entries(all).filter(([, st]) => st && st.type !== "idle")
      })
      const statuses: Record<string, { type: string }> = {}
      for (const [sid, st] of Object.entries(snap.busy)) {
        if (st && typeof st === "object" && "type" in st) statuses[sid] = st as { type: string }
      }
      // SCOPE (2026-10-20 flaky-animation fix): each attach carries only ITS
      // directory's sessions — absent-from-snapshot means idle ONLY within
      // that directory. A panel attaches EVERY project concurrently (the
      // boot fans out one attach per project worktree); an unscoped
      // downgrade let the emptiest directory's attach (a worktree, "/")
      // mark the whole fleet's busy sessions idle, and whichever attach
      // landed LAST won. Animation then lit only when the right
      // directory's attach happened to be final — random per reload. Only
      // sessions whose cached info places them in THIS directory may be
      // downgraded; unknown-directory sessions are left alone (safe: the
      // recency guard inside reconcileStatuses still refuses downgrades
      // newer than the fetch).
      for (const [sid] of localBusy) {
        const sessionDirectory = untrack(() => session.data.info[sid]?.directory)
        if (sessionDirectory !== directory) continue
        if (!statuses[sid]) statuses[sid] = { type: "idle" }
      }
      session.reconcileStatuses(statuses as Record<string, SessionStatus>, { fetchedAt })
      // Sessions spawned during the gap appear immediately.
      void loadSessions(directory).catch(() => {})
    } catch {
      // A failed attach is non-fatal: the next resync edge retries.
    } finally {
      attachInflight.delete(directory)
    }
  }
  // 2026-10-20 (boot-race fix): the directory source is the PROJECT LIST,
  // not loadSessions registration. The VS Code panel iframe boots at the
  // bare origin — no directory route — so loadSessions never runs at boot
  // (verified in the frontdoor log: no /session?directory=...&roots=true for
  // webview boots) and a registry fed by it stays empty forever: bump-time
  // attach had no dirs, register-time never came. The projects query
  // (/project) runs on EVERY boot regardless of route, so the effect below
  // fires when EITHER edge arrives last — the first stream connect, or the
  // project list resolving — and attaches every project's worktree (plus
  // sandboxes). Tracked reads: the effect re-runs on count bumps AND on
  // project-list changes; the attach body itself is untracked.
  // The directory source: project worktrees UNION the directories of every
  // session the store has cached info for. The projects query is the ideal
  // source but has proven non-deterministic across webview boots (observed
  // 2026-10-20: a webview boot that never issued /project); session info
  // accumulates from any session list/view load, so the union converges on
  // every panel regardless of which query raced which.
  const knownAttachDirs = (): string[] => {
    const dirs = new Set<string>()
    for (const project of globalStore.project ?? []) {
      if (project?.worktree) dirs.add(project.worktree)
      for (const sandbox of project.sandboxes ?? []) if (sandbox) dirs.add(sandbox)
    }
    for (const info of Object.values(session.data.info)) {
      if (info?.directory) dirs.add(info.directory)
    }
    return [...dirs]
  }
  createEffect(() => {
    const count = serverSDK.event.resyncCount()
    const projects = globalStore.project ?? []
    if (count === 0) return
    const dirs = untrack(() => knownAttachDirs())
    untrack(() => {
      for (const directory of dirs) void attachDirectory(directory)
    })
  })
  // 2026-10-20 (deterministic convergence): the reactive edges (stream bump,
  // project list, session info arriving) have each been observed to lose
  // races across real webview boots. A 15s poll makes busy-state truth
  // converge REGARDLESS of which reactive path fired: whatever the boot
  // ordering, within one poll tick of the store knowing a directory, its
  // merged snapshot is reconciled. Cheap (one request per directory per
  // tick, inflight-deduped), and the scoped downgrade keeps cross-directory
  // attaches from fighting each other.
  const attachPoll = setInterval(() => {
    if (serverSDK.event.status() !== "connected") return
    const dirs = untrack(() => knownAttachDirs())
    for (const directory of dirs) void attachDirectory(directory)
  }, 15000)
  onCleanup(() => clearInterval(attachPoll))

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void serverSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void serverSDK.event.start()
      }, 0)
    }
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const updateConfigMutation = useMutation(() => ({
    mutationFn: (config: Config) => serverSDK.client.global.config.update({ config }),
    onSuccess: () => {
      bootstrap.refetch()
      // Invalidate all provider queries so newly configured custom providers
      // appear immediately in the available provider list across all directories.
      queryClient.invalidateQueries({ queryKey: [serverSDK.scope, null, "providers"] })
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] === serverSDK.scope && query.queryKey[2] === "providers",
      })
    },
  }))

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    disableMcp: children.disableMcp,
    queryOptions: queryOptionsApi,
    refreshProviders,
    // bootstrap,
    updateConfig: updateConfigMutation.mutateAsync,
    project: projectApi,
    session,
    homeSessions,
    mcp: {
      toggle: async (directory: string, name: string) => {
        const key = directoryKey(directory)
        const sdk = sdkFor(key)
        const status = children.child(key, { bootstrap: false })[0].mcp[name]?.status
        if (!status) return
        await toggleMcp({
          status,
          connect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.connect({ name })
              return
            }
            await serverSDK.api.mcp.connect({ server: name, location: { directory: key } })
          },
          disconnect: async () => {
            if ((await serverSDK.protocol) === "v1") {
              await sdk.mcp.disconnect({ name })
              return
            }
            await serverSDK.api.mcp.disconnect({ server: name, location: { directory: key } })
          },
          authenticate: async () => {
            await sdk.mcp.auth.authenticate({ name })
          },
          refresh: async () => {
            await queryClient.refetchQueries(queryOptionsApi.mcp(key))
            await queryClient.refetchQueries(queryOptionsApi.mcpResources(key))
          },
        })
      },
    },
  }
}

export function createServerSyncContext(serverSDK: ServerSDK) {
  const inner = createServerSyncContextInner(serverSDK)
  return Object.assign(inner, {
    ensureDirSyncContext: createRefCountMap(
      (dir) => createDirSyncContext(dir, inner, serverSDK),
      (dir) => inner.disableMcp(dir),
      directoryKey,
    ),
  })
}

export type ServerSync = ReturnType<typeof createServerSyncContext>

export const { use: useServerSync, provider: ServerSyncProvider } = createSimpleContext({
  name: "ServerSync",
  // Returns an accessor so the resolved server can change reactively without
  // re-instantiating the subtree (mirrors useServerSDK).
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSync>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sync
    })
  },
})

export function useQueryOptions() {
  const sync = useServerSync()
  return createMemo(() => sync().queryOptions)
}
