// Candidate 2a: @opencode/server createRoutes() as a Layer, our own route added IN the HttpRouter.
import { sandbox } from "../env"
import { makeProbeDriver, serverOptions, type Target } from "../options"

export async function build(): Promise<Target> {
  const { createRoutes } = await import("@opencode/server/routes")
  const { authorizedRequest, unauthorizedResponse } = await import("@opencode/server/middleware/authorization")
  const { ServerAuth } = await import("@opencode/server/auth")
  const { SessionRestart } = await import("@opencode/core/session/execution/restart")
  const { SdkPlugins } = await import("@opencode/core/plugin/sdk")
  const { WorkspaceDriver } = await import("@opencode/core/workspace/driver")
  const { Workspace } = await import("@opencode/core/workspace")
  const { Context, Effect, Exit, Layer, Option, Scope } = await import("effect")
  const { HttpEffect, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } = await import("effect/http")
  const { probePlugin } = await import("../probe-plugin")

  const calls: string[] = []
  const driver = await makeProbeDriver(calls)()
  const auth = ServerAuth.Config.of({ password: Option.some(sandbox.password), username: "opencode" })

  // Custom route added in-router. In-router routes are NOT covered by the HttpApi Authorization middleware,
  // so the route must authorize itself (reusing the exported helper).
  const ping = HttpRouter.add(
    "GET",
    "/amicode/ping",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
      return HttpServerResponse.jsonUnsafe({ ok: true, route: "/amicode/ping", at: Date.now() })
    }),
  )
  const layer = ping.pipe(
    Layer.provideMerge(
      createRoutes(serverOptions(sandbox.password), () => [], [
        WorkspaceDriver.node.replace(WorkspaceDriver.registryNode({ h0c: driver })),
      ]).pipe(Layer.provide(HttpServer.layerServices)),
    ),
  )
  const scope = await Effect.runPromise(Scope.make())
  const started = performance.now()
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const resumed = Effect.runFork(Context.get(context, SessionRestart.Service).resumeSuspendedSessions)
  const handler = HttpEffect.toWebHandlerWith(context)(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())
  const facts: Record<string, unknown> = {
    "startup ms": Math.round(performance.now() - started),
    "resumeSuspendedSessions forked": true,
    "context has SdkPlugins/Workspace": true,
  }
  void resumed

  return {
    handler: (request) => handler(request),
    nativeAuth: true,
    customRouteInBare: true,
    registerPlugin: () => Effect.runPromise(Context.get(context, SdkPlugins.Service).register(probePlugin)),
    workspaceProbe: async () => {
      const workspace = Context.get(context, Workspace.Service)
      const id = await Effect.runPromise(workspace.create({ provider: "h0c" }))
      const info = await Effect.runPromise(workspace.provision(id))
      await Effect.runPromise(workspace.destroy(id))
      return `provider=${info.provider} calls=${calls.join(",")}`
    },
    facts,
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
