// THE SEAM — the only module that imports the opencode server. Everything else in the host sees the
// `HostServer` shape below. Today it is built on the PUBLISHED route builder `@opencode/server/routes`
// (`createRoutes`, which honours a password): the SDK's embedded host (`@opencode/sdk/internal/host`) is
// hidden by the SDK's `exports` map and cannot be imported from outside the upstream workspace.
//
// Swap plan for harmoniqs/amicode#2054 (upstream export of the embedded host): replace the body of
// `createServer` with `EmbeddedHost.create(...)` from the new export and map `.fetch`/`.close` onto
// `HostServer`. Nothing outside this file changes. (Dynamic imports below keep the host's startup path
// free of the engine until it is needed, and let non-engine modules load under any runtime.)

import type { Effect } from "effect"
import type { HttpServerResponse } from "effect/http"

export interface HostServer {
  /** Web-standard handler for the whole opencode v2 API. Trusted-caller: the front authenticates BEFORE this. */
  readonly fetch: (request: Request) => Promise<Response>
  /** Requests whose server-side scope is still open — an event stream holds one until it is released. */
  readonly openStreams: () => number
  readonly close: () => Promise<void>
}

export interface CreateServerOptions {
  readonly version: string
  readonly dbPath: string
  readonly password: string
  /** Fork `SessionRestart.resumeSuspendedSessions` after the routes are built. */
  readonly resume: boolean
  /** Extra ServerOptions (config dir, models, fs ...). Host-owned keys are already rejected by config. */
  readonly serverOptions: Record<string, unknown>
}

export async function createServer(options: CreateServerOptions): Promise<HostServer> {
  const { createRoutes } = await import("@opencode/server/routes")
  const { SessionRestart } = await import("@opencode/core/session/execution/restart")
  const { Context, Effect, Exit, Layer, Scope } = await import("effect")
  const { HttpEffect, HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } = await import("effect/http")

  const serverOptions = {
    ...options.serverOptions,
    // Inner auth too (defence in depth): the front has already checked the very same Basic credentials.
    password: options.password,
    app: { name: "amicode-host", version: options.version },
    database: { path: options.dbPath },
  }
  const scope = await Effect.runPromise(Scope.make())
  const context = await Effect.runPromise(
    Layer.buildWithScope(createRoutes(serverOptions, () => []).pipe(Layer.provide(HttpServer.layerServices)), scope),
  )

  // `createRoutes` does NOT resume suspended sessions (ServerFetch.make and the node server process fork it
  // themselves), so resume is entirely the host's call.
  if (options.resume) Effect.runFork(Context.get(context, SessionRestart.Service).resumeSuspendedSessions)

  // Observation for the abort contract: every request runs in its own Scope, and a streaming response holds
  // it open until the client disconnects (the event feed's subscription is released by finalizers of that
  // same scope). Our finalizer is registered first, so it runs last: the count drops only after the
  // subscription's release has run.
  let open = 0
  const track = HttpMiddleware.make((app) =>
    Effect.gen(function* () {
      const requestScope = yield* Effect.scope
      open++
      yield* Scope.addFinalizer(requestScope, Effect.sync(() => void open--))
      return yield* app
    }),
  )
  // The router's effect needs HttpServerRequest and Scope; the web handler provides both per request, but
  // toWebHandlerWith's outer call defaults its requirement parameter to `never`, so the cast is the honest spelling.
  const app = Context.get(context, HttpRouter.HttpRouter).asHttpEffect() as Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>
  const handler = HttpEffect.toWebHandlerWith(context)(app, track)

  return {
    fetch: (request) => handler(request),
    openStreams: () => open,
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
