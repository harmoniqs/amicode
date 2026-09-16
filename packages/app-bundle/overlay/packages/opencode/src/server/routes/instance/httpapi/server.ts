import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpClient, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Observability from "@opencode-ai/core/observability"
import { Account } from "@/account/account"
import { Agent } from "@/agent/agent"
import { Auth } from "@/auth"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { Workspace } from "@/control-plane/workspace"
import { Env } from "@/env"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "@/format"
import { Git } from "@/git"
import { Installation } from "@/installation"
import { LSP } from "@/lsp/lsp"
import { MCP } from "@/mcp"
import { McpAuth } from "@/mcp/auth"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { PluginPtyEnvironment } from "@/plugin/pty-environment"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Vcs } from "@/project/vcs"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { SessionCompaction } from "@/session/compaction"
import { Instruction } from "@/session/instruction"
import { LLM } from "@/session/llm"
import { SessionProcessor } from "@/session/processor"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionPause } from "@/session/pause"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Skill } from "@/skill"
import { Discovery } from "@/skill/discovery"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { Worktree } from "@/worktree"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Npm } from "@opencode-ai/core/npm"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectCopy } from "@opencode-ai/core/project/copy"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import * as SessionExecutionLocal from "@opencode-ai/core/session/execution/local"
import { lazy } from "@/util/lazy"
import { CorsConfig, isAllowedCorsOrigin, type CorsOptions } from "@opencode-ai/server/cors"
import { serveUIEffect } from "@/server/shared/ui"
import * as AmicodeVaults from "@/server/amicode/vaults"
import * as AmicodeWarrants from "@/server/amicode/warrants"
import * as AmicodeVaultBrowser from "@/server/amicode/vault-browser"
import * as AmicodeFileResolve from "@/server/amicode/file-resolve"
import * as AmicodeProblems from "@/server/amicode/problems"
import * as AmicodeWidgets from "@/server/amicode/widgets"
import * as AmicodeDashboard from "@/server/amicode/dashboard"
import * as AmicodeWidgetFrame from "@/server/amicode/widget-frame-html"
import * as AmicodeLibrary from "@/server/amicode/library"
import * as AmicodeProfile from "@/server/amicode/profile"
import * as AmicodeConnections from "@/server/amicode/connections"
import * as AmicodeProject from "@/server/amicode/project"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { Api } from "@opencode-ai/server/api"
import { PublicApi } from "./public"
import {
  authorizationLayer,
  authorizationRouterMiddleware,
  ptyConnectAuthorizationLayer,
  serverAuthorizationLayer,
} from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { PtyConnectApi } from "./groups/pty"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { controlPlaneHandlers } from "./handlers/control-plane"
import { experimentalHandlers } from "./handlers/experimental"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { mcpHandlers } from "./handlers/mcp"
import { permissionHandlers } from "./handlers/permission"
import { projectHandlers } from "./handlers/project"
import { projectCopyHandlers } from "./handlers/project-copy"
import { providerHandlers } from "./handlers/provider"
import { ptyConnectHandlers, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { syncHandlers } from "./handlers/sync"
import { tuiHandlers } from "./handlers/tui"
import { handlers } from "@opencode-ai/server/handlers"
import { buildLocationServiceMap, LocationServiceMap } from "@opencode-ai/core/location-services"
import { layer as locationLayer } from "@opencode-ai/server/location"
import { sessionLocationLayer } from "@opencode-ai/server/middleware/session-location"
import { PtyEnvironment } from "@opencode-ai/server/pty-environment"
import { schemaErrorLayer as v2SchemaErrorLayer } from "@opencode-ai/server/middleware/schema-error"
import { workspaceHandlers } from "./handlers/workspace"
import { instanceContextLayer } from "./middleware/instance-context"
import { workspaceRoutingLayer } from "./middleware/workspace-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { fenceLayer } from "./middleware/fence"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = (corsOptions?: CorsOptions) =>
  HttpRouter.middleware(
    HttpMiddleware.cors({
      allowedOrigins: (origin) => isAllowedCorsOrigin(origin, corsOptions),
      maxAge: 86_400,
    }),
    { global: true },
  )

// Route tree:
// - rootApiRoutes: typed /global/* and control routes; auth is declared by RootHttpApi.
// - eventApiRoutes: typed SSE route with instance routing context and its existing API contract.
// - ptyConnectApiRoutes: typed WebSocket upgrade route with ticket-aware auth.
// - instanceApiRoutes: remaining typed instance routes.
// - uiRoute: raw catch-all fallback; auth is router middleware so public static assets can bypass it.
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const ptyConnectHttpApiAuthLayer = ptyConnectAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const serverHttpApiAuthLayer = serverAuthorizationLayer.pipe(Layer.provide(ServerAuth.Config.layer))
const workspaceRoutingLive = workspaceRoutingLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const ptyConnectApiRoutes = HttpApiBuilder.layer(PtyConnectApi).pipe(
  Layer.provide(ptyConnectHandlers),
  Layer.provide([ptyConnectHttpApiAuthLayer, workspaceRoutingLive, instanceContextLayer]),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    experimentalHandlers,
    fileHandlers,
    instanceHandlers,
    mcpHandlers,
    projectHandlers,
    projectCopyHandlers,
    ptyHandlers,
    questionHandlers,
    permissionHandlers,
    providerHandlers,
    sessionHandlers,
    syncHandlers,
    tuiHandlers,
    workspaceHandlers,
  ]),
)

const instanceRoutes = instanceApiRoutes.pipe(
  Layer.provide([httpApiAuthLayer, workspaceRoutingLive, instanceContextLayer, schemaErrorLayer]),
)
const serverRoutes = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(handlers),
  Layer.provide(PluginPtyEnvironment.layer),
  Layer.provide([serverHttpApiAuthLayer, v2SchemaErrorLayer]),
)

// `OpenApi.fromApi` is non-trivial; defer until /doc is actually hit so
// processes that never serve it (CLI, scripts) don't pay at module load.
// `HttpServerResponse.jsonUnsafe` runs JSON.stringify eagerly, so caching
// the response also caches the serialized body — every /doc request reuses
// the same Uint8Array instead of re-stringifying the spec.
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

// amicode: Vaults panel tab data source — relays `amico-vault status --json`.
// Raw route outside the declared API surface (same idiom + auth as /doc).
// AmicodeVaults.status() never rejects — failures come back as JSON bodies.
const amicodeVaultsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/amicode/vaults", () =>
      Effect.promise(() => AmicodeVaults.status()).pipe(
        Effect.map((body) => HttpServerResponse.text(body, { contentType: "application/json" })),
      ),
    )
    // Attach an existing vault (onboarding-wizard finale). JSON body {ref};
    // clones a repo or symlinks a local vault dir into the vaults root.
    yield* router.add("POST", "/amicode/vaults", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeVaults.attachVault(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    // Vault browser (the app's Vault panel): recursive read-only listing of one
    // mount, and single-file reads with a real-path traversal guard. Builders
    // never reject — failures come back as ok:false JSON bodies.
    // Capability warrants (spec-20260727-164748 §9.5): the approval card's transport.
    // READ is a plain ledger read; WRITE shells `amico ledger approve` because
    // amico-run is the ledger's single writer (#212) and an append from here would
    // break O_APPEND atomicity quietly, only under concurrency.
    yield* router.add("GET", "/amicode/warrants", () =>
      Effect.sync(() => HttpServerResponse.text(AmicodeWarrants.warrantsBody(), { contentType: "application/json" })),
    )
    yield* router.add("POST", "/amicode/approve", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        let parsed: AmicodeWarrants.ApproveInput = {}
        try {
          parsed = JSON.parse(body) as AmicodeWarrants.ApproveInput
        } catch {
          return HttpServerResponse.text(JSON.stringify({ ok: false, error: "body must be JSON" }), {
            contentType: "application/json",
          })
        }
        return HttpServerResponse.text(AmicodeWarrants.approveBody(parsed), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/vault-files", (request) =>
      Effect.sync(() => {
        const mount = new URL(request.url, "http://localhost").searchParams.get("mount") ?? undefined
        return HttpServerResponse.text(AmicodeVaultBrowser.vaultFilesBody(mount), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/vault-file", (request) =>
      Effect.sync(() => {
        const params = new URL(request.url, "http://localhost").searchParams
        const mount = params.get("mount") ?? undefined
        const file = params.get("path") ?? undefined
        return HttpServerResponse.text(AmicodeVaultBrowser.vaultFileBody(mount, file), {
          contentType: "application/json",
        })
      }),
    )
    // Chat file-reference linkifier: resolve a path-like string from chat
    // markdown (inline-code pill, relative authored link) to an absolute
    // on-disk path so the app can render it as a file:// link — the VS Code
    // bridge opens the file from there. Same loopback gate as the vault
    // browser; RESOLVES only, never reads.
    yield* router.add("GET", "/amicode/resolve-file", (request) =>
      Effect.sync(() => {
        const p = new URL(request.url, "http://localhost").searchParams.get("path") ?? undefined
        return HttpServerResponse.text(AmicodeFileResolve.resolveFileBody(p), { contentType: "application/json" })
      }),
    )
    // amicode#203: New-project creation — mkdir + best-effort git init. JSON
    // body {name, parentDir}; never rejects (failures come back as ok:false).
    yield* router.add("POST", "/amicode/project", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = AmicodeProject.createProject(body)
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    // amicode: Projects list — enumerate ~/AmicodeProjects folders (each folder
    // is a project). Source of truth for the Projects menu, so a created folder
    // surfaces even before it's opened. Never rejects.
    yield* router.add("GET", "/amicode/projects", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeProject.listProjects(), { contentType: "application/json" }),
      ),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// amicode: Problem-UI data sources (spec B). Raw routes outside the declared
// API surface (same idiom + auth as /doc and /amicode/vaults). The response
// builders never reject — failures come back as ok:false JSON bodies.
// request.url is RELATIVE here; the base-argument URL form is the repo idiom
// (see handlers/pty.ts:190, middleware/authorization.ts).
const amicodeProblemsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/amicode/problems", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeProblems.problemsResponse(), { contentType: "application/json" }),
      ),
    )
    yield* router.add("GET", "/amicode/problem", (request) =>
      Effect.sync(() => {
        const slug = new URL(request.url, "http://localhost").searchParams.get("slug") ?? undefined
        return HttpServerResponse.text(AmicodeProblems.problemResponse(slug), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/run-status", (request) =>
      Effect.sync(() => {
        const slug = new URL(request.url, "http://localhost").searchParams.get("slug") ?? undefined
        return HttpServerResponse.text(AmicodeProblems.runStatusResponse(slug), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/run-cards", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeProblems.runCardsResponse(), { contentType: "application/json" }),
      ),
    )
    yield* router.add("GET", "/amicode/run-series", (request) =>
      Effect.sync(() => {
        const params = new URL(request.url, "http://localhost").searchParams
        const run = params.get("run") ?? undefined
        const lab = params.get("lab") ?? undefined
        return HttpServerResponse.text(AmicodeProblems.runSeriesResponse(run, lab), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/profile", () =>
      Effect.sync(() => HttpServerResponse.text(AmicodeProfile.profileResponse(), { contentType: "application/json" })),
    )
    // In-place profile save (About-You card). Same raw-route idiom as the GETs:
    // editable identity fields ride query params (small strings; keeps the
    // handler body-free like every other amicode route). Returns the fresh
    // profile JSON so the card can render the saved state without a second GET.
    yield* router.add("GET", "/amicode/library", () =>
      Effect.sync(() => HttpServerResponse.text(AmicodeLibrary.libraryBody(), { contentType: "application/json" })),
    )
    yield* router.add("POST", "/amicode/library", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(AmicodeLibrary.saveLibraryFile(body), { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/profile", (request) =>
      Effect.gen(function* () {
        const params = new URL(request.url, "http://localhost").searchParams
        // Merge: query params for simple fields, JSON body for large ones (avatar)
        let bodyFields: Record<string, string> = {}
        const ct = request.headers["content-type"] ?? ""
        if (ct.includes("application/json")) {
          try {
            const raw = yield* Effect.orDie(request.text)
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) bodyFields = parsed
          } catch { /* ignore parse failures */ }
        }
        const field = (k: string): string | undefined => {
          if (params.has(k)) return params.get(k) ?? ""
          if (k in bodyFields && typeof bodyFields[k] === "string") return bodyFields[k]
          return undefined
        }
        const body = AmicodeProfile.saveProfile({
          name: field("name"),
          affiliation: field("affiliation"),
          focus: field("focus"),
          scholar: field("scholar"),
          affiliation_logo: field("affiliation_logo"),
          role: field("role"),
          description: field("description"),
          github: field("github"),
          avatar: field("avatar"),
          custom_link_url: field("custom_link_url"),
          custom_link_label: field("custom_link_label"),
        })
        return HttpServerResponse.text(body, { contentType: "application/json" })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// amicode: widget kernel data sources (spec T2.4) — registry, code serving,
// fork, and dashboard layout state. Same raw-route idiom + auth as the
// problems routes; body-builders live in amicode/widgets.ts + dashboard.ts.
const amicodeWidgetsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/amicode/widgets", () =>
      Effect.sync(() => HttpServerResponse.text(AmicodeWidgets.widgetsResponse(), { contentType: "application/json" })),
    )
    // The frame document is served (not srcdoc) so it carries its OWN CSP
    // header — srcdoc would inherit the app's CSP, which forbids the inline
    // runtime (see widget-frame-html.ts).
    yield* router.add("GET", "/amicode/widget-frame", (request) =>
      Effect.sync(() => {
        const id = new URL(request.url, "http://localhost").searchParams.get("id") ?? undefined
        const r = AmicodeWidgetFrame.widgetFrameHtml(id)
        return HttpServerResponse.text(r.html, {
          headers: new Headers({
            "content-type": "text/html",
            "content-security-policy": AmicodeWidgetFrame.WIDGET_CSP,
          }),
        })
      }),
    )
    yield* router.add("GET", "/amicode/widget-code", (request) =>
      Effect.sync(() => {
        const id = new URL(request.url, "http://localhost").searchParams.get("id") ?? undefined
        return HttpServerResponse.text(AmicodeWidgets.widgetCodeResponse(id), { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/widget-fork", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(AmicodeWidgets.forkWidgetResponse(body), { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/dashboard", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeDashboard.dashboardResponse(AmicodeWidgets.loadRegistry().widgets), {
          contentType: "application/json",
        }),
      ),
    )
    yield* router.add("POST", "/amicode/dashboard", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(
          AmicodeDashboard.saveDashboardResponse(body, AmicodeWidgets.loadRegistry().widgets),
          { contentType: "application/json" },
        )
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

// amicode: Connections panel routes (spec #159/S3) — Company Compute connect
// path. Same raw-route idiom + auth as the problems routes; body-builders
// live in amicode/connections.ts and never reject. SECURITY: the credential
// rides the POST BODY (the library idiom) — never query params, never URLs;
// mutation routes refuse non-loopback binds inside the body-builders.
const amicodeConnectionsRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/amicode/connections", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeConnections.statusResponse(), { contentType: "application/json" }),
      ),
    )
    yield* router.add("POST", "/amicode/connections/credential", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeConnections.submitCredentialResponse(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/connections/disconnect", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(AmicodeConnections.disconnectResponse(body), {
          contentType: "application/json",
        })
      }),
    )
    yield* router.add("POST", "/amicode/connections/revalidate", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeConnections.revalidateResponse(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/connections/choose-project", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeConnections.chooseProjectResponse(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/connections/auth", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeConnections.startAuthResponse(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    yield* router.add("GET", "/amicode/connections/catalog", () =>
      Effect.sync(() =>
        HttpServerResponse.text(AmicodeConnections.catalogResponse(), { contentType: "application/json" }),
      ),
    )
    yield* router.add("POST", "/amicode/connections/add-custom", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        const out = yield* Effect.promise(() => AmicodeConnections.addCustomConnectionResponse(body))
        return HttpServerResponse.text(out, { contentType: "application/json" })
      }),
    )
    yield* router.add("POST", "/amicode/connections/remove", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(AmicodeConnections.removeCustomConnectionResponse(body), {
          contentType: "application/json",
        })
      }),
    )
    // opencode#78: RELEASING the solver tier. Selecting hp is not served here —
    // that flip rides a validated Company Compute credential (the route above),
    // and a second hp writer is the duplicate flip ADR 0001 forbids.
    yield* router.add("POST", "/amicode/solver-mode", (request) =>
      Effect.gen(function* () {
        const body = yield* Effect.orDie(request.text)
        return HttpServerResponse.text(AmicodeConnections.solverModeResponse(body), {
          contentType: "application/json",
        })
      }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

const uiRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const flags = yield* RuntimeFlags.Service
    yield* router.add("*", "/*", (request) =>
      serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
    )
  }),
).pipe(Layer.provide(authOnlyRouterLayer))

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

const app = LayerNode.group([
  Npm.node,
  FSUtil.node,
  Database.node,
  Auth.node,
  Account.node,
  Config.node,
  Env.node,
  Git.node,
  Ripgrep.node,
  Storage.node,
  Snapshot.node,
  Plugin.node,
  ModelsDev.node,
  Provider.node,
  ProviderAuth.node,
  Agent.node,
  Skill.node,
  Discovery.node,
  Question.node,
  Permission.node,
  PermissionSaved.node,
  Todo.node,
  Session.node,
  SessionProjector.node,
  SessionStatus.node,
  BackgroundJob.node,
  RuntimeFlags.node,
  EventV2Bridge.node,
  SessionRunState.node,
  SessionPause.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionRevert.node,
  SessionSummary.node,
  SessionPrompt.node,
  Instruction.node,
  LLM.node,
  LSP.node,
  MCP.node,
  McpAuth.node,
  Command.node,
  Truncate.node,
  ToolRegistry.node,
  Format.node,
  Project.node,
  Vcs.node,
  Workspace.node,
  Worktree.node,
  Installation.node,
  ShareNext.node,
  SessionShare.node,
  InstanceStore.node,
  httpClient,
  EventV2.node,
  ProjectV2.node,
  ProjectCopy.node,
  PtyTicket.node,
])

export function createRoutes(
  corsOptions?: CorsOptions,
): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const locationServiceMapV2 = buildLocationServiceMap()

  return Layer.mergeAll(
    rootApiRoutes,
    eventApiRoutes,
    ptyConnectApiRoutes,
    instanceRoutes,
    serverRoutes,
    docRoute,
    amicodeVaultsRoute,
    amicodeProblemsRoute,
    amicodeWidgetsRoute,
    amicodeConnectionsRoute,
    uiRoute,
  ).pipe(
    Layer.provide([
      errorLayer,
      compressionLayer,
      corsVaryFix,
      fenceLayer,
      cors(corsOptions),
      AppNodeBuilderV1.build(MoveSession.node, [[LocationServiceMap.node, locationServiceMapV2]]),
      HttpServer.layerServices,
    ]),
    Layer.provide(Layer.succeed(CorsConfig)(corsOptions)),
    Layer.provide(sessionLocationLayer),
    Layer.provide(locationLayer),
    Layer.provide(PtyEnvironment.layer),
    Layer.provide(
      AppNodeBuilderV1.build(SessionV2.node, [
        [LocationServiceMap.node, locationServiceMapV2],
        [SessionExecution.node, SessionExecutionLocal.node],
      ]),
    ),
    Layer.provide(locationServiceMapV2),

    Layer.provide(AppNodeBuilderV1.build(app)),
    // Must stay last: layers provided later in this pipe build beneath earlier ones,
    // so Observability must come after every service graph. Otherwise eagerly forked
    // fibers (e.g. the ModelsDev background refresh) capture Effect's default stdout
    // logger and corrupt the TUI (#34730).
    Layer.provideMerge(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
