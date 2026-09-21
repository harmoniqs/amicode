import "@/index.css"
import * as Sentry from "@sentry/solid"
import { requestComputeConnect } from "@/components/amicode-defaults-capsule"
import { adoptWorkspaceProjects, workspaceProjects, requestAddWorkspaceProject } from "@/utils/amicode-workspace-projects"
import { I18nProvider } from "@opencode-ai/ui/context"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { File } from "@opencode-ai/session-ui/file"
import { Font } from "@opencode-ai/ui/font"
import { Splash } from "@opencode-ai/ui/logo"
import { ThemeProvider, useTheme } from "@opencode-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import {
  type BaseRouterProps,
  Navigate,
  Route,
  Router,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import { base64Encode } from "@opencode-ai/core/util/encode"
import {
  type Component,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  Suspense,
  onCleanup,
  type ParentProps,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { Spinner } from "@opencode-ai/ui/spinner"
import { makeEventListener } from "@solid-primitives/event-listener"
import { CommandProvider, useCommand, type CommandOption } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider, useServerSync } from "@/context/server-sync"
import { GlobalProvider, useGlobal } from "@/context/global"
import { HighlightsProvider } from "@/context/highlights"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { SplitProvider } from "@/context/split"
import { WorkbenchProvider } from "@/context/workbench"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { usePlatform } from "@/context/platform"
import { setPendingAutoSend } from "@/pages/new-session/new-session-draft-controller"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider, useSettings } from "@/context/settings"
import { TabsProvider, tabHref, useTabs, type DraftTab } from "@/context/tabs"
import { SDKProvider, useSDK } from "@/context/sdk"
import { resolveLandingDirectory } from "@/pages/new-session-landing"
import { authTokenFromCredentials } from "@/utils/server"
import { normalizeSessionInfo } from "@/utils/session"
import type { SessionV2Info } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo } from "@opencode-ai/client/promise"
import { WslServersProvider } from "@/wsl/context"
import DirectoryLayout, { DirectoryDataProvider } from "@/pages/directory-layout"
import LegacyLayout from "@/pages/layout"
import NewLayout from "@/pages/layout-new"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"
import { AmicodeSplash } from "@opencode-ai/ui/amicode-splash"
import { legacySessionHref, legacySessionServer, requireServerKey, sessionHref } from "./utils/session-route"
import { createSessionLineage } from "@/pages/session/session-lineage"
import { bugDockController } from "@/pages/session/composer/bug-dock-controller"
import { postBugReportPoke } from "@/utils/amicode-bug-report"

import { SessionPage, SessionRouteErrorBoundary, TargetSessionRouteContent, registerHeldPanelView, heldPanelViewState, SessionPanelHold } from "@/pages/session"
import { LegacyHome } from "@/pages/home/legacy-home"
import { AmicodeFileRefBridge } from "@/components/amicode-file-ref-bridge"
import { DevToolsReopenBridge } from "@/components/settings-dialog"

const NewSession = lazy(() => import("@/pages/new-session"))

// #1290: the notorious ResizeObserver-loop exception is thrown at the end of
// any frame whose resize callbacks changed layout. Benign in most apps — but
// over remote links it lands inside Solid's keyed-Show transition frames
// (route/provider tree swaps on switch/send/question/response), aborting the
// new children mid-creation: the outlet renders NOTHING (main:0 / now:none /
// p0, no reload, correct URL) until the next update re-renders. The
// capture-phase suppression is the standard mitigation.
if (typeof window !== "undefined") {
  window.addEventListener(
    "error",
    (e) => {
      if (typeof e.message === "string" && e.message.includes("ResizeObserver loop")) {
        e.stopImmediatePropagation()
        e.preventDefault()
      }
    },
    true,
  )
}

const SessionRoute = () => {
  const settings = useSettings()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string; prompt?: string }>()
  const sdk = useSDK()
  const server = useServer()
  const tabs = useTabs()

  if (params.id && settings.general.newLayoutDesigns()) {
    const sessionID = params.id
    return (
      <Show when={tabs.ready()}>
        {(_) => {
          const persisted = tabs.store.filter((item) => item.type === "session")
          return <Navigate href={sessionHref(legacySessionServer(persisted, sessionID, server.key), sessionID)} />
        }}
      </Show>
    )
  }

  // When the new layout is enabled, the legacy new-session route (/:dir/session with no id)
  // is replaced by a draft at /new-session?draftId=…
  createEffect(() => {
    if (!settings.general.newLayoutDesigns()) return
    if (params.id || search.draftId) return
    if (!tabs.ready() || !sdk().directory) return
    tabs.newDraft({ server: server.key, directory: sdk().directory }, search.prompt)
  })

  return (
    <SessionRouteErrorBoundary sessionID={params.id}>
      <SessionPage />
    </SessionRouteErrorBoundary>
  )
}

function TargetServerRoute(props: ParentProps) {
  const params = useParams<{ serverKey: string; id: string }>()
  const global = useGlobal()
  // #1290: requireServerKey THROWS on a transiently-invalid param — a throw
  // inside the keyed Show's `when` during a route re-match tears the whole
  // server-scoped tree to an EMPTY outlet (now:none / p0 — the blank on
  // question, response, and session-switch). Catch the transient: the key
  // memo reads undefined, the Show renders the frozen hold, and the real
  // tree returns the moment the params settle.
  const serverKey = createMemo(() => {
    try {
      return requireServerKey(params.serverKey)
    } catch {
      return undefined
    }
  })
  const conn = createMemo(() => {
    const key = serverKey()
    if (!key) return undefined
    return global.servers.list().find((item) => ServerConnection.key(item) === key)
  })

  return (
    // Owns the server-identity remount. Session changes must NOT remount this
    // subtree (SessionRouteErrorBoundary resets and createSessionLineage
    // re-resolves reactively instead); both rely on this key for server changes.
    <Show when={serverKey()} keyed fallback={<SessionPanelHold />}>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>{props.children}</ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

const TargetSessionRoute = () => (
  <TargetServerRoute>
    <TargetSessionRouteContent />
  </TargetServerRoute>
)

function LegacyTargetSessionRoute() {
  const params = useParams<{ serverKey: string; id: string }>()
  return (
    <TargetServerRoute>
      <SessionRouteErrorBoundary sessionID={params.id} serverKey={requireServerKey(params.serverKey)}>
        <LegacyTargetSessionRedirect />
      </SessionRouteErrorBoundary>
    </TargetServerRoute>
  )
}

function LegacyTargetSessionRedirect() {
  const params = useParams<{ id: string }>()
  const navigate = useNavigate()
  const sync = useServerSync()
  const current = createSessionLineage(
    () => params.id,
    () => sync().session.lineage,
  )

  createEffect(() => {
    const directory = current()?.session.directory
    if (!directory) return
    navigate(legacySessionHref(directory, params.id), { replace: true })
  })

  // #1290: this route used to render NULL while the lineage resolved over
  // the wire — an empty router outlet ("the pane disappears on send", p0 /
  // now:none, no tree at all). Hold the frozen last view instead; the
  // effect navigates to the canonical route the moment it resolves.
  return <SessionPanelHold />
}

// Wraps the non-draft routes. They are gated on (and keyed to) the globally selected
// server via ServerKey, then provide the server-scoped shell for that server.
function SelectedServerProviders(props: ParentProps) {
  return (
    <ServerKey>
      <ServerSDKProvider>
        <ServerSyncProvider>
          <AmicodeFileRefBridge />
          {props.children}
        </ServerSyncProvider>
      </ServerSDKProvider>
    </ServerKey>
  )
}

function LegacyServerLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <LegacyServerScopedShell serverScoped={props.serverScoped}>{props.children}</LegacyServerScopedShell>
    </SelectedServerProviders>
  )
}

function DraftRoute() {
  const [search] = useSearchParams<{ draftId?: string }>()
  const settings = useSettings()
  const tabs = useTabs()
  return (
    <Show when={tabs.ready()}>
      <Show
        when={tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === search.draftId)}
        keyed
        fallback={<Navigate href="/" />}
      >
        {(draft) => (
          <Show
            when={settings.general.newLayoutDesigns()}
            fallback={<Navigate href={`/${base64Encode(draft.directory)}/session`} />}
          >
            <ResolvedDraftRoute draft={draft} />
          </Show>
        )}
      </Show>
    </Show>
  )
}

function ResolvedDraftRoute(props: { draft: DraftTab }) {
  const global = useGlobal()
  const conn = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === props.draft.server))
  const directory = () => props.draft.directory
  const serverKey = () => props.draft.server

  return (
    <Show when={`${props.draft.server}\0${props.draft.directory}`} keyed>
      <ServerSDKProvider server={conn}>
        <ServerSyncProvider server={conn}>
          <ModelsProvider directory={directory}>
            <SDKProvider directory={directory}>
              <DirectoryDataProvider directory={directory} server={serverKey}>
                <DraftProviders>
                  <Suspense
                    fallback={
                      // #1286: a lazy import that stalls (fleet tunnel windows)
                      // rendered NOTHING while suspended — a blank with the
                      // chrome intact. Show the loading state instead, on the
                      // panel card's own ground (a transparent slot reads as
                      // a blank panel in the wrong shade).
                      <div class="flex h-full w-full items-center justify-center bg-v2-background-bg-base">
                        <Spinner class="size-5 text-v2-icon-icon-muted" />
                      </div>
                    }
                  >
                    {/* #1288 (never unmount first): register the draft view
                        so a send (draft→session route swap) holds the frozen
                        composer + the sent message until the session view's
                        gates resolve — instead of a blank route outlet for
                        the wire round-trips. display:contents keeps the
                        wrapper layout-neutral. */}
                    <div
                      class="contents"
                      ref={(el) => registerHeldPanelView(el)}
                    >
                      <NewSession />
                    </div>
                  </Suspense>
                </DraftProviders>
              </DirectoryDataProvider>
            </SDKProvider>
          </ModelsProvider>
        </ServerSyncProvider>
      </ServerSDKProvider>
    </Show>
  )
}

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

function LayoutCompatibility(props: ParentProps) {
  const global = useGlobal()
  const navigate = useNavigate()
  const server = useServer()
  const settings = useSettings()

  createEffect(() => {
    if (settings.general.newLayoutDesigns()) return
    const current = server.current
    if (!current) return
    const protocol = global.ensureServerCtx(current).sdk.protocolKind()
    if (protocol !== "v2") return
    const next = global.servers.list().find((s) => {
      if (ServerConnection.key(s) === ServerConnection.key(current)) return false
      return global.ensureServerCtx(s).sdk.protocolKind() !== "v2"
    })
    if (!next) return
    navigate("/")
    queueMicrotask(() => server.setActive(ServerConnection.key(next)))
  })

  return <>{props.children}</>
}

declare global {
  interface Window {
    __OPENCODE__?: {
      deepLinks?: string[]
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark"; scheme?: "system" | "light" | "dark" }) => Promise<void>
      exportDebugLogs?: () => Promise<string>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnReconnect: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function BodyDesignClass() {
  const settings = useSettings()

  createRenderEffect(() => {
    if (typeof document === "undefined") return

    const enabled = settings.general.newLayoutDesigns()
    document.body.toggleAttribute("data-new-layout", enabled)
    document.body.classList.toggle("text-12-regular", !enabled)
    document.body.classList.toggle("font-(family-name:--font-family-text)", enabled)
    document.body.classList.toggle("text-[13px]", enabled)
    document.body.classList.toggle("font-[440]", enabled)
  })

  return null
}

// Server-agnostic providers shared across every route. These live in the shared
// shell (router root) so they stay mounted regardless of the active server/route.
function SharedProviders(props: ParentProps) {
  return (
    <>
      <BodyDesignClass />
      <CommandProvider>
        <DesktopCommands />
        <HighlightsProvider>
          {/* amicode(split): the in-app pane state wraps the shell — the
              titlebar (drag sources) and the layout (drop zones) both
              consume it. amicode(workbench S2): the parent's tab mirror
              sits above it — drops resolve against the mirror. */}
          <WorkbenchProvider>
            <SplitProvider>{props.children}</SplitProvider>
          </WorkbenchProvider>
        </HighlightsProvider>
      </CommandProvider>
    </>
  )
}

function DesktopCommands() {
  const command = useCommand()
  const language = useLanguage()
  const platform = usePlatform()

  command.register("desktop", () => {
    const commands: CommandOption[] = []
    if (platform.platform === "desktop" && platform.exportDebugLogs) {
      commands.push({
        id: "logs.export",
        title: "Export logs",
        category: language.t("command.category.settings"),
        onSelect: () => {
          void platform.exportDebugLogs?.()
        },
      })
    }
    return commands
  })

  // amicode#878: VS Code intercepts Tab keys before they reach the webview,
  // so the extension catches Shift+Tab and bridges it here as an agent-cycle
  // message. Trigger the same command the in-app keybind would.
  if (window.parent !== window) {
    const onAgentCycle = (e: MessageEvent) => {
      const d = e.data as { source?: string; kind?: string } | undefined
      if (d?.source === "amicode" && d.kind === "agent-cycle") {
        command.trigger("agent.cycle", "keybind")
      }
    }
    window.addEventListener("message", onAgentCycle)
    onCleanup(() => window.removeEventListener("message", onAgentCycle))
  }

  return null
}

// Server-scoped providers shared by the legacy shell and the top-level new shell.
type ServerScopedShellProps = ParentProps<{
  directory?: () => string | undefined
  serverScoped?: JSX.Element
}>

function ServerScopedProviders(props: ServerScopedShellProps) {
  return (
    <LayoutProvider>
      {props.serverScoped}
      <ModelsProvider directory={props.directory}>{props.children}</ModelsProvider>
    </LayoutProvider>
  )
}

function LegacyServerScopedShell(props: ServerScopedShellProps) {
  return (
    <ServerScopedProviders directory={props.directory} serverScoped={props.serverScoped}>
      <LegacyLayout>{props.children}</LegacyLayout>
    </ServerScopedProviders>
  )
}

function NewAppLayout(props: ParentProps<{ serverScoped?: JSX.Element }>) {
  return (
    <SelectedServerProviders>
      <ServerScopedProviders serverScoped={props.serverScoped}>
        <NewLayout>{props.children}</NewLayout>
      </ServerScopedProviders>
    </SelectedServerProviders>
  )
}

// The draft page only renders the prompt composer, so it drops TerminalProvider.
// FileProvider and CommentsProvider stay because PromptInput uses file search and comment context.
function DraftProviders(props: ParentProps) {
  return (
    <FileProvider>
      <PromptProvider>
        <CommentsProvider>{props.children}</CommentsProvider>
      </PromptProvider>
    </FileProvider>
  )
}

/** amicode: live theme bridge for the VS Code webview host. The extension
 *  forwards editor theme changes as window messages (outer relay → iframe);
 *  route them through the existing setColorScheme so everything re-themes. */
function AmicodeThemeBridge() {
  const theme = useTheme()
  const onMsg = (e: MessageEvent) => {
    const d = e.data as { source?: string; kind?: string; colorScheme?: string } | undefined
    if (d?.source !== "amicode") return
    // amicode#200 AC6: the Connect Cloud palette command deep-links into the
    // defaults capsule's compute-connect flow (consumed when home is showing).
    if (d.kind === "open-compute-connect") {
      requestComputeConnect()
      return
    }
    // amicode/opencode#117: bug-report dock open/close down-messages. Handled
    // at app level (not in the dock) so an open can't be missed between
    // pages; the controller self-gates on the boot param + kind.
    if (d.kind === "open-bug-report" || d.kind === "close-bug-report") {
      bugDockController.handleBridgeMessage(d)
      return
    }
    // amicode#663: workspace-projects push from the extension host.
    if (d.kind === "workspace-projects") {
      adoptWorkspaceProjects((d as { projects?: unknown[] }).projects as Parameters<typeof adoptWorkspaceProjects>[0])
      return
    }
    if (d.kind !== "theme") return
    if (d.colorScheme === "light" || d.colorScheme === "dark") theme.setColorScheme(d.colorScheme)
  }
  window.addEventListener("message", onMsg)
  onCleanup(() => window.removeEventListener("message", onMsg))
  // ⌘⇧P / Ctrl+Shift+P: when embedded in the amicode webview (we have a
  // parent), the EDITOR's Command Palette wins over the app's own palette —
  // capture-phase so the in-app binding never sees it; forwarded over the
  // existing allowlisted command bridge.
  const onKey = (e: KeyboardEvent) => {
    if (window.parent === window) return
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault()
      e.stopPropagation()
      window.parent.postMessage({ source: "amicode", kind: "command", command: "workbench.action.showCommands" }, "*")
    }
  }
  window.addEventListener("keydown", onKey, { capture: true })
  onCleanup(() => window.removeEventListener("keydown", onKey, { capture: true }))
  // The boot poke — the dock contract's pull half (QA follow-up, amicode#249
  // preview): posted once per app-frame boot when the flag is on; the
  // extension re-posts open-bug-report if a bug session is live, so a lost
  // one-shot open (cold-boot race, webview reload) self-heals.
  postBugReportPoke()
  return null
}

/** amicode#363: bridge for the extension to open a new draft session with a
 *  pre-filled prompt. Must live inside TabsProvider + ServerProvider so it has
 *  access to useTabs().newDraft. */
// 2026-09-19 fleet flash fix: cold session lineages blank the session view
// for a full wire round-trip (send -> new session; switch -> not-yet-synced
// session). Warm every OPEN session tab's lineage in the background so tab
// switches resolve synchronously from the sync cache. resolve() dedupes
// in-flight requests and short-circuits already-cached sessions, so this is
// a no-op on warm state.

/** Safe localStorage read for the debug badge gate. When browser storage is
 *  restricted (incognito, iframe sandbox, storage policy), the getter or
 *  getItem can throw — optional chaining alone doesn't catch that. Return
 *  false on any failure so the app stays renderable. */
function isDebugBadgeEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem("amicode_debug_badge") === "1"
  } catch {
    return false
  }
}

/** #1290 debug badge (temporary — the send-blank chase): bottom-right, tiny,
 *  inert. Shows the running build + whether the frozen-hold registry has a
 *  snapshot. When the pane disappears, read this: `hold:n` = the registry
 *  never populated (a registration wiring gap); `hold:Y` + a beat anyway =
 *  the fallback render path is failing. */
function HoldDebugBadge() {
  const [state, setState] = createSignal("")
  const [history, setHistory] = createSignal<string[]>([])
  const [lastErr, setLastErr] = createSignal("")
  const server = useServer()
  const dataUrl = () => {
    const current = (server as unknown as { current?: { http?: { url?: string } } }).current
    return current?.http?.url ?? location.origin
  }
  // #1294: the local service in fleet mode authenticates every request
  // (per-boot Basic) — the frontdoor never did, which is why the shipper
  // silently 401'd on the real panel while working against the mock/rig.
  const dataAuth = () => {
    const current = (server as unknown as { current?: { username?: string; password?: string } }).current
    if (!current?.password) return undefined
    try {
      return authTokenFromCredentials({ username: current.username, password: current.password })
    } catch {
      return undefined
    }
  }
  {
    // #1290: Solid routes unhandled reactive errors through console.error,
    // NOT window.onerror — the teardown error behind the blank was never
    // visible to the window capture. Intercept console.error too, and ship
    // every capture to the hub's client-error log so nobody has to read
    // them off the screen: POST /__amicode_client_log (the frontdoor
    // appends to ~/.amico/server/client-errors.log on the hub).
    const shipped = new Set<string>()
    const ship = (kind: string, text: string) => {
      if (shipped.has(text)) return
      shipped.add(text)
      try {
        // The same-origin service 404s unknown routes (no proxy passthrough
        // for POSTs). Post DIRECTLY to the data server's own origin (the
        // fleet tunnel / the engine itself) — a simple text/plain POST so
        // no CORS preflight is required; the frontdoor logs it regardless.
        const target = new URL("/__amicode_client_log", dataUrl())
        const auth = dataAuth()
        void fetch(target, {
          headers: auth ? { Authorization: `Basic ${auth}` } : {},
          method: "POST",
          body: `${kind} ${build}\n${text.slice(0, 600)}`,
        }).catch(() => {})
      } catch {}
    }
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      const first = args.find((a) => a instanceof Error) ?? args[0]
      const text = String(first instanceof Error ? first.message : (first as unknown))
      const stack = args.find((a) => a instanceof Error) instanceof Error
        ? String((args.find((a) => a instanceof Error) as Error).stack ?? "").slice(0, 400)
        : ""
      if (!text.includes("ResizeObserver loop")) {
        setLastErr(`C:${text.slice(0, 80)}`)
        ship("C", `${text}\n${stack}`)
      }
      originalError(...(args as Parameters<typeof console.error>))
    }
    const onWindowError = (e: ErrorEvent) => {
      setLastErr(`E:${(e.message || "unknown").slice(0, 70)}`)
      ship("E", `${e.message ?? "unknown"}\n${(e.error as Error | undefined)?.stack ?? ""}`)
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      setLastErr(`R:${String(e.reason).slice(0, 70)}`)
      ship("R", `${String(e.reason)}\n${e.reason instanceof Error ? e.reason.stack ?? "" : ""}`)
    }
    window.addEventListener("error", onWindowError)
    window.addEventListener("unhandledrejection", onRejection)
    const entry = performance
      .getEntriesByType("resource")
      .map((r) => r.name)
      .find((n) => n.includes("index-") && n.endsWith(".js"))
    const build = entry ? entry.split("/").pop()!.replace("index-", "").replace(".js", "") : "?"

    // #1294 diagnosis-at-distance: the harness rig cannot reproduce the
    // live-SSE conditions of the real panel, and asking the user to read
    // console rings mid-lag is the wrong ergonomics. Ship the diagnostic
    // rings to the hub's client log on an interval — the panel self-
    // reports what its loads/gates/mirror did, and the log is read
    // remotely. Strips together with the badge once trusted.
    const diagStart = Date.now()
    const postRaw = (kind: string, text: string) => {
      try {
        const target = new URL("/__amicode_client_log", dataUrl())
        const auth = dataAuth()
        void fetch(target, { method: "POST", headers: auth ? { Authorization: `Basic ${auth}` } : {}, body: `${kind} ${build}
${text.slice(0, 12000)}` }).catch(() => {})  // #1294: 2400 truncated snapshots mid-JSON
      } catch {}
    }
    const briefMap = (m?: Map<string, unknown[]>) =>
      m
        ? Object.fromEntries(
            [...m.entries()].slice(-4).map(([k, v]) => [k.slice(-14), (v as unknown[]).slice(-6)]),
          )
        : null
    const shipRings = () => {
      try {
        const w = globalThis as {
          __loadDebug?: Map<string, unknown[]>
          __gateDebug?: Map<string, unknown[]>
          __mirrorDebug?: unknown[]
          __mirrorHydrated?: string[]
        }
        postRaw(
          "D",
          JSON.stringify({
            url: location.pathname.slice(-46),
            up: Math.round((Date.now() - diagStart) / 1000),
            load: briefMap(w.__loadDebug),
            gate: briefMap(w.__gateDebug),
            mirror: w.__mirrorDebug?.slice(-4) ?? null,
            hydrated: w.__mirrorHydrated?.slice(-6) ?? null,
          }),
        )
      } catch {}
    }
    const shipTimeout = setTimeout(shipRings, 8_000)
    const shipInterval = setInterval(shipRings, 30_000)
    let lastHtml = -1
    let lastKids = -1
    const ring: string[] = []
    let rafId = 0
    const tickFast = () => {
      const frame = document.querySelector("[data-amicode-panel]")
      const html = frame ? frame.innerHTML.length : -1
      const kids = frame ? frame.childElementCount : -1
      // Only SIGNIFICANT transitions enter the ring: a kids change or a
      // content-size swing > 1200 bytes. Streaming deltas are a few bytes
      // and would flood the history out of the beat's evidence.
      if (kids !== lastKids || (html !== -1 && lastHtml !== -1 && Math.abs(html - lastHtml) > 1200)) {
        if (lastHtml !== -1) {
          const pill = document.querySelectorAll('[style*="backdrop-filter"]').length
          ring.push(`${lastKids}k/${lastHtml}h/p${pill}`)
          if (ring.length > 6) ring.shift()
          setHistory([...ring])
        }
        lastHtml = html
        lastKids = kids
      } else if (html !== lastHtml) {
        lastHtml = html
      }
      rafId = requestAnimationFrame(tickFast)
    }
    rafId = requestAnimationFrame(tickFast)
    const timer = setInterval(() => {
      const frame = document.querySelector("[data-amicode-panel]")
      const pill = document.querySelectorAll('[style*="backdrop-filter"]').length
      const main = document.querySelector("main")
      const mainKids = main ? main.childElementCount : -1
      const prewarm = (globalThis as { __amicodePrewarm?: { n: number; at: number }; __amicodePrewarmErr?: string }).__amicodePrewarm
      const prewarmErr = (globalThis as { __amicodePrewarmErr?: string }).__amicodePrewarmErr
      const warmState = prewarm
        ? `warm:${prewarm.n}@${Math.round((Date.now() - prewarm.at) / 1000)}s`
        : `warm:none${prewarmErr ? "!" + prewarmErr.slice(0, 40) : ""}`
      setState(`${build} | up:${Math.round(performance.now() / 1000)}s | ${warmState} | hold:${heldPanelViewState() ? "Y" : "n"} | now:${frame ? frame.childElementCount + "k/" + frame.innerHTML.length + "h" : "none"} | main:${mainKids} | p${pill} | ${location.pathname.slice(-34)}${lastErr() ? "\n" + lastErr() : ""}`)
    }, 500)
    // #1287: clean up EVERY effect this badge installs, not just the 500ms
    // interval — restore console.error, drop both window listeners, and clear
    // the diagnostic timeout/interval and the animation-frame loop.
    onCleanup(() => {
      console.error = originalError
      window.removeEventListener("error", onWindowError)
      window.removeEventListener("unhandledrejection", onRejection)
      clearTimeout(shipTimeout)
      clearInterval(shipInterval)
      cancelAnimationFrame(rafId)
      clearInterval(timer)
    })
  }
  return (
    <div
      style={{
        position: "fixed",
        right: "6px",
        bottom: "6px",
        "z-index": "99999",
        "font-size": "10px",
        "font-family": "ui-monospace, monospace",
        background: "rgba(0, 0, 0, 0.7)",
        color: "#fff",
        padding: "3px 7px",
        "border-radius": "4px",
        "pointer-events": "none",
        opacity: "0.85",
        "white-space": "pre-line",
      }}
    >
      {state()}
      {"\n"}
      {history().join("  ")}
    </div>
  )
}

function SessionLineagePrewarmer() {
  const global = useGlobal()
  const tabs = useTabs()
  // #1294: pin OPEN TABS for their lifetime — the route-level pin unpins
  // the session the moment you switch away, and without a pin the cache
  // evictor can drop an idle tab's message data between warm passes
  // (making every back-and-forth switch a cold wire reload). Track our
  // pins locally so each tab session is pinned exactly once and unpinned
  // when its tab closes.
  const pinnedTabs = new Map<string, (sessionID: string) => void>()
  const resolveTabSession = (tab: { server?: string; sessionId: string }) => {
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
    return conn ? global.ensureServerCtx(conn).sync?.session : undefined
  }
  createEffect(() => {
    const open = new Set<string>()
    for (const tab of tabs.store) {
      if (tab.type !== "session") continue
      open.add(tab.sessionId)
      const session = resolveTabSession(tab)
      if (session && !pinnedTabs.has(tab.sessionId)) {
        pinnedTabs.set(tab.sessionId, (id) => session.unpin(id))
        session.pin(tab.sessionId)
      }
    }
    for (const [sessionID, unpin] of pinnedTabs) {
      if (!open.has(sessionID)) {
        pinnedTabs.delete(sessionID)
        unpin(sessionID)
      }
    }
  })
  createEffect(() => {
    for (const tab of tabs.store) {
      if (tab.type !== "session") continue
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === tab.server)
      // #1290: the sync context lives on the SERVER CTX, not the raw
      // connection entry (conn.sync is undefined — this loop silently
      // skipped every tab since it was written). Resolve through the ctx.
      const session = conn ? global.ensureServerCtx(conn).sync?.session : undefined
      if (!session) continue
      if (session.lineage && !session.lineage.peek(tab.sessionId)) {
        void session.lineage.resolve(tab.sessionId).catch(() => {})
      }
      // #1294c: also seed data.info for open tabs — tabs can reference
      // sessions outside the 30-recent warm window; resolve() is
      // promise-deduped so this is one background fetch per tab per boot.
      if (session.resolve) {
        void session.resolve(tab.sessionId).catch(() => {})
      }
      // Messages too: the timeline gates on the sync store holding the
      // session's messages — a cold message load is the same wire gap.
      if (session.prefetch) {
        // #1292 deeper warm for open tabs — the actively-used sessions get
        // the first ~3 pages so history scrolls locally; the 15s freshness
        // guard in prefetch() keeps repeat passes free.
        void session.prefetch(tab.sessionId, 60).catch(() => {})
      }
    }
  })
  // #1289 P2 (bulk mirror): warm the N most-recent sessions across the
  // server — lineage + the first message page each — not just OPEN TABS.
  // Over a fleet link, a tab click to any recently-touched session then
  // renders from the local mirror with zero wire round-trips. One
  // recency-ordered list page per pass (the server sorts); the
  // lineage-peek + shouldPrefetch guards make repeat passes free.
  const BULK_WARM_SESSIONS = 30
  const BULK_WARM_MESSAGES = 20
  const bulkWarm = async () => {
    for (const conn of global.servers.list()) {
      // #1290: same ctx fix — conn.sync is undefined on raw list entries.
      const sync = global.ensureServerCtx(conn).sync
      if (!sync?.session) {
        ;(globalThis as { __amicodePrewarmErr?: string }).__amicodePrewarmErr = "no-sync-ctx"
        continue
      }
      let recent: Array<SessionV2Info> = []
      try {
        const ctx = global.ensureServerCtx(conn)
        const page = await ctx.sdk.client.v2.session.list({ limit: BULK_WARM_SESSIONS, order: "desc" })
        // #1294c: keep the FULL session objects — the warm's list response
        // already carries them, and seeding data.info here is what lets
        // sync()'s cache check early-return on a switch. Without it, a
        // warmed+cached session still fetched its info on every switch
        // (wire RTT), and the outlet Suspense held the panel for it.
        recent = (page.data?.data ?? []).filter((info): info is typeof info & { id: string } => typeof info?.id === "string")
        ;(globalThis as { __amicodePrewarm?: { n: number; at: number } }).__amicodePrewarm = {
          n: recent.length,
          at: Date.now(),
        }
      } catch (e) {
        console.warn("[prewarmer] bulk list failed:", e)
        ;(globalThis as { __amicodePrewarmErr?: string }).__amicodePrewarmErr = String(e).slice(0, 90)
        continue
      }
      for (const info of recent) {
        // #1294c: seed data.info from the list payload — zero wire cost.
        // The v2 list objects carry location:{directory} with NO
        // top-level directory/slug/path — normalizeSessionInfo maps them
        // (every other consumer normalizes at the boundary; the raw
        // object crashed the tab strip's render on the real hub).
        try {
          sync.session.remember(normalizeSessionInfo(info as SessionInfo))
        } catch {
          /* best-effort */
        }
        if (sync.session.lineage && !sync.session.lineage.peek(info.id)) {
          void sync.session.lineage.resolve(info.id).catch(() => {})
        }
        if (sync.session.prefetch && sync.session.shouldPrefetch(info.id, BULK_WARM_MESSAGES)) {
          void sync.session.prefetch(info.id, BULK_WARM_MESSAGES).catch(() => {})
        }
      }
    }
  }
  void bulkWarm()
  const warmTimer = setInterval(() => void bulkWarm(), 20_000)
  onCleanup(() => clearInterval(warmTimer))
  return null
}

function AmicodeNavigateBridge() {
  const tabs = useTabs()
  const server = useServer()
  let pending = false

  // Signal to the extension host that the app is mounted and ready to
  // receive navigate messages. The extension uses this to dismiss the
  // onboarding splash and post the greeting (instead of blind timeouts).
  window.parent.postMessage({ source: "amicode", kind: "app-ready" }, "*")

  const onMsg = async (e: MessageEvent) => {
    const d = e.data as { source?: string; kind?: string; path?: string } | undefined
    if (d?.source !== "amicode" || d.kind !== "navigate" || !d.path) return
    if (pending) return
    pending = true
    try {
      const url = new URL(d.path, window.location.origin)
      if (url.pathname === "/new-session") {
        const prompt = url.searchParams.get("prompt") || undefined
        const autoSend = url.searchParams.get("autoSend") === "1"
        // amicode#872: prefer workspace-projects (real VS Code folders) over
        // the engine's project list (which returns the scaffold dir).
        const wsProjects = workspaceProjects()
        const directory = wsProjects.length > 0
          ? wsProjects[0].worktree
          : server.projects.list()[0]?.worktree ?? ""
        await tabs.newDraft({ server: server.key, directory }, prompt)
        if (autoSend) setPendingAutoSend(true)
      } else {
        // Navigate to an existing session by path (e.g. /session/:id)
        const sessionMatch = url.pathname.match(/^\/session\/([^/?]+)/)
        if (sessionMatch) {
          const sessionId = sessionMatch[1]
          tabs.openPath(`/${server.key}/session/${sessionId}`, { activate: true })
        }
      }
    } catch { /* malformed path — ignore */ }
    finally { setTimeout(() => { pending = false }, 2000) }
  }
  window.addEventListener("message", onMsg)
  onCleanup(() => window.removeEventListener("message", onMsg))
  return null
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        lockThemeId="harmoniqs"
        onThemeApplied={(_, mode, scheme) => {
          void window.api?.setTitlebar?.({ mode, scheme })
        }}
      >
        <AmicodeThemeBridge />
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                Sentry.captureException(error)
                return <ErrorPage error={error} />
              }}
            >
              <QueryProvider>
                <WslServersProvider>
                  <DialogProvider>
                    <DevToolsReopenBridge />
                    <MarkedProvider>
                      <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                    </MarkedProvider>
                  </DialogProvider>
                </WslServersProvider>
              </QueryProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean; startup?: Promise<void> }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(() =>
    props.disableHealthCheck
      ? true
      : Effect.gen(function* () {
          if (!server.current) return true
          const { http, type } = server.current

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )
  const checking = createMemo(
    () => checkMode() === "blocking" && ["unresolved", "pending"].includes(startupHealthCheck.state),
  )
  const [startup] = createResource(async () => {
    if (!props.startup) return true
    await props.startup.catch((error) => {
      console.error("[startup] startup gate failed", error)
    })
    return true
  })
  const startupChecking = createMemo(
    () => startupHealthCheck.latest === true && ["unresolved", "pending"].includes(startup.state),
  )
  const loading = createMemo(() => checking() || startupChecking())

  return (
    <>
      <Show when={!checking()}>
        <Show
          when={startupHealthCheck.latest}
          fallback={
            <ConnectionError
              onRetry={() => {
                if (checkMode() === "background") void healthCheckActions.refetch()
              }}
              onServerSelected={(key) => {
                setCheckMode("blocking")
                server.setActive(key)
                void healthCheckActions.refetch()
              }}
            />
          }
        >
          {props.children}
        </Show>
      </Show>
      <Show when={loading()}>
        {/* amicode: brand splash at the loading surface */}
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base">
          <AmicodeSplash />
        </div>
      </Show>
    </>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash class="w-12 h-15 mb-4" />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  // #1290 (held key): while the agent is thinking/streaming, SSE bursts
  // refresh the server context and the selected-server key signal CHANGES
  // VALUE mid-stream — a keyed dispose+create of the WHOLE shell whose
  // creation can abort in the transition frame (main:0 during thinking).
  // A fallback can't cover a re-key; holding the last valid key through
  // the churn means the shell never re-keys on flicker — only on a real
  // server change (a genuinely new key).
  const heldKey = createMemo((prev: string | undefined) => server.key ?? prev, undefined)
  return (
    <Show when={heldKey()} keyed fallback={<SessionPanelHold />}>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  canonicalLocalServer?: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
  startup?: Promise<void>
  serverScoped?: JSX.Element
}) {
  // The visual new layout lives in the router root so it remains mounted across
  // route changes. Draft and session routes override only their server-bound data
  // providers beneath it.
  const ServerShell = (shellProps: ParentProps) => (
    <QueryProvider>
      <SharedProviders>
        {props.children}
        {shellProps.children}
      </SharedProviders>
    </QueryProvider>
  )

  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      canonicalLocalServer={props.canonicalLocalServer}
      servers={props.servers}
    >
      <GlobalProvider>
        <SettingsProvider>
          <ConnectionGate disableHealthCheck={props.disableHealthCheck} startup={props.startup}>
            <Show when={useSettings().general.newLayoutDesigns().toString()} keyed>
              <Dynamic
                component={props.router ?? Router}
                root={(routerProps) => (
                  <TabsProvider>
                    <AmicodeNavigateBridge />
                    <SessionLineagePrewarmer />
                    {/* #1287/#1290 debug badge — opt-in via localStorage so it
                        never shows to users by default. Enable:
                        localStorage.setItem("amicode_debug_badge","1") + reload.
                        The badge, its RAF ring, error shipper, and diagnostic
                        intervals only mount when the flag is set. */}
                    <Show when={useSettings().general.newLayoutDesigns() && isDebugBadgeEnabled()}>
                      <HoldDebugBadge />
                    </Show>
                    <PermissionProvider>
                      <NotificationProvider>
                        <ServerShell>
                          <Show when={useSettings().general.newLayoutDesigns()} fallback={routerProps.children}>
                            <NewAppLayout serverScoped={props.serverScoped}>
                              {/* #1290 (outlet net): every ErrorBoundary AND
                                  every Suspense in the app lives INSIDE the
                                  route trees. A resource read suspending
                                  above them (the sync's resources refetch on
                                  the SSE churn while the agent streams)
                                  propagated to the router and blanked the
                                  WHOLE outlet: no error, no catch, main:0
                                  until the resource resolved. This pair holds
                                  the frozen view through both classes —
                                  thrown teardowns (ErrorBoundary) and
                                  pending resources (Suspense). */}
                              <ErrorBoundary fallback={() => <SessionPanelHold />}>
                                <Suspense fallback={<SessionPanelHold />}>
                                  {routerProps.children}
                                </Suspense>
                              </ErrorBoundary>
                            </NewAppLayout>
                          </Show>
                        </ServerShell>
                      </NotificationProvider>
                    </PermissionProvider>
                  </TabsProvider>
                )}
              >
                <Routes serverScoped={props.serverScoped} />
              </Dynamic>
            </Show>
          </ConnectionGate>
        </SettingsProvider>
      </GlobalProvider>
    </ServerProvider>
  )
}

function Routes(props: { serverScoped?: JSX.Element }) {
  const settings = useSettings()

  return (
    <>
      <Route
        component={(routeProps) => (
          <LegacyServerLayout serverScoped={props.serverScoped}>{routeProps.children}</LegacyServerLayout>
        )}
      >
        <Show when={!settings.general.newLayoutDesigns()}>
          {
            <>
              <Route path="/" component={LegacyHome} />
              <Route path="/server/:serverKey/session/:id" component={LegacyTargetSessionRoute} />
            </>
          }
        </Show>
        <Route path="/:dir" component={DirectoryLayout}>
          <Route path="/" component={() => <Navigate href="session" />} />
          <Route path="/session/:id?" component={SessionRoute} />
        </Route>
      </Route>
      <Show when={settings.general.newLayoutDesigns()}>
        <Route path="/" component={NewSessionLanding} />
        <Route path="/:dir/session/:id" component={NewLayoutLegacySessionRedirect} />
        <Route path="/server/:serverKey/session/:id" component={TargetSessionRoute} />
      </Show>
      <Route path="/new-session" component={DraftRoute} />
      <Route path="*404" component={RouteNotFound} />
    </>
  )
}

/** #1290: the catch-all for stale hrefs (old route formats persisted in
 *  tabs/localStorage) — an unmatched path used to render an EMPTY router
 *  outlet (main:0 / now:none — the blank on question, response, switch).
 *  Hold the frozen view and recover home, where the app state rebuilds. */
function RouteNotFound() {
  const navigate = useNavigate()
  createEffect(() => {
    navigate("/", { replace: true })
  })
  return <SessionPanelHold />
}

/** Landing route when the Home/Dashboard page is removed: creates a new draft
 *  session tab on mount and navigates to it. If a session tab already exists,
 *  navigates to the most recent one instead of creating a duplicate. */
function NewSessionLanding() {
  const tabs = useTabs()
  const global = useGlobal()
  const navigate = useNavigate()
  const [showEmpty, setShowEmpty] = createSignal(false)

  const land = () => {
    // #1291 diagnostic hook — one build cycle to pinpoint the gate
    const w = globalThis as { __landingDebug?: unknown[] }
    w.__landingDebug = w.__landingDebug ?? []
    const dbg = (info: Record<string, unknown>) => {
      w.__landingDebug!.push({ t: Date.now(), ...info })
      if (w.__landingDebug!.length > 40) w.__landingDebug!.shift()
    }

    // If there's already a session or draft tab, navigate to it
    const existing = tabs.store.find((tab) => tab.type === "session" || tab.type === "draft")
    if (existing) {
      setShowEmpty(false)
      dbg({ gate: "existing-tab", href: tabHref(existing) })
      navigate(tabHref(existing), { replace: true })
      return
    }

    // Otherwise create a new draft — find a server + directory to use
    const connections = global.servers.list()
    const conn = connections[0]
    if (!conn) {
      dbg({ gate: "no-server" })
      return // no server connected yet — will re-render when one connects
    }

    // projects.list() is the client-side store of OPENED projects, which is empty
    // on a fresh profile and for servers running outside any registered project
    // (the amicode chat server spawns in an internal scaffold dir). Falling back
    // to a server-known worktree keeps this route from rendering nothing at all.
    //
    // Read workspaceProjects() FIRST so the createEffect in LandingEffect
    // subscribes to the reactive store that adoptWorkspaceProjects writes.
    // Without this read, adding a folder via the extension host updates the
    // store but the effect never re-runs — showEmpty stays true forever.
    const ctx = global.ensureServerCtx(conn)
    const wsProjects = workspaceProjects()
    const directory = resolveLandingDirectory(
      wsProjects.length > 0 ? wsProjects : ctx.projects.list(),
      ctx.sync.data.project[0]?.worktree,
    )
    if (!directory) {
      dbg({ gate: "no-directory", projects: ctx.projects.list().length, wsProjects: wsProjects.length, syncProjects: ctx.sync.data.project?.length ?? -1 })
      // No workspace folder open — show the v2 empty-workspace landing
      // instead of rendering nothing at all (the blank-screen gap).
      setShowEmpty(true)
      return
    }

    setShowEmpty(false)
    dbg({ gate: "newDraft", directory })
    tabs.newDraft({ server: ServerConnection.key(conn), directory }, "").catch((err) => {
      dbg({ gate: "newDraft-error", err: String(err?.message ?? err) })
    })
  }

  return (
    <Show when={tabs.ready()} fallback={null}>
      <LandingEffect land={land} />
      <Show when={showEmpty()}>
        <Suspense>
          <EmptyWorkspaceLanding />
        </Suspense>
      </Show>
    </Show>
  )
}

/** Lightweight v2 landing shown when no workspace folder is open. Renders the
 *  Amicode mark + an "Open a folder" prompt in the same visual frame as the
 *  normal new-session view, and populates the titlebar controls so the app
 *  never appears empty. The createEffect in LandingEffect keeps running: the
 *  moment a workspace folder arrives (the extension pushes it), the draft
 *  resolves and this component unmounts.
 *
 *  lazy() keeps the chunk off the critical path; the <Suspense> in the parent
 *  catches the suspension while the chunk loads. */
const EmptyWorkspaceLanding = lazy(() => import("@/pages/empty-workspace-landing"))

/** #1291: the landing's resolve used to run as a bare IIFE inside <Show> —
 *  evaluated ONCE at mount, never again. When the server connected (or the
 *  sync's project data arrived) after that moment — normal on a cold profile
 *  or a slow tunnel — land() early-returned "will re-render when one
 *  connects" and then nothing ever re-ran: the app sat at "/" rendering
 *  nothing, forever. A createEffect makes the promised re-land real. */
function LandingEffect(props: { land: () => void }) {
  createEffect(() => props.land())
  return null
}

function NewLayoutLegacySessionRedirect() {
  const server = useServer()
  const tabs = useTabs()
  const params = useParams<{ id: string }>()

  return (
    <Show when={tabs.ready()}>
      <Navigate
        href={sessionHref(
          legacySessionServer(
            tabs.store.filter((item) => item.type === "session"),
            params.id,
            server.key,
          ),
          params.id,
        )}
      />
    </Show>
  )
}
