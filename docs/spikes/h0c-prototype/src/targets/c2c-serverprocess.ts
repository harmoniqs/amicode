// Candidate 2c: @opencode/server ServerProcess.start() (the stock Node server loop) with a `transform` hook.
import { sandbox, freePort } from "../env"
import { serverOptions, type Target } from "../options"

export async function build(): Promise<Target> {
  const { ServerProcess } = await import("@opencode/server/process")
  const { authorizedRequest, unauthorizedResponse } = await import("@opencode/server/middleware/authorization")
  const { ServerAuth } = await import("@opencode/server/auth")
  const { Effect, Exit, Option, Scope } = await import("effect")
  const { HttpServerRequest, HttpServerResponse } = await import("effect/http")
  const auth = ServerAuth.Config.of({ password: Option.some(sandbox.password), username: "opencode" })
  const port = await freePort()
  const scope = await Effect.runPromise(Scope.make())
  const started = performance.now()
  // `transform` wraps the whole dispatch (which itself 401s everything unauthenticated), so it runs BEFORE
  // the auth gate: our route has to authorize itself, everything else falls through to the gate.
  const server = await Effect.runPromise(
    ServerProcess.start(
      { ...serverOptions(sandbox.password), hostname: "127.0.0.1", port },
      // No lifecycle => no ServiceRegistration (that callback is supplied by the CLI, not this module) but ALSO no
      // restart continuity (installRestartContinuity only runs when a lifecycle is given). H0C_C2C_LIFECYCLE=1
      // passes a no-op lifecycle to show a host can opt back in without registering anything.
      process.env.H0C_C2C_LIFECYCLE ? { onListen: () => Effect.succeed(Effect.void) } : undefined,
      (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (new URL(request.url, "http://localhost").pathname !== "/amicode/ping") return yield* app
          if (!(yield* authorizedRequest(request, auth))) return unauthorizedResponse(request)
          return HttpServerResponse.jsonUnsafe({ ok: true, route: "/amicode/ping", at: Date.now() })
        }),
    ).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  return {
    nativeUrl: `http://127.0.0.1:${port}`,
    nativeAuth: true,
    customRouteInBare: true,
    registerPlugin: undefined, // start() returns {address, shutdown, updateAvailable, updated}: no context handle
    workspaceProbe: undefined, // start() has no `overrides` parameter at all
    facts: { lifecycle: !!process.env.H0C_C2C_LIFECYCLE, "startup ms": Math.round(performance.now() - started), returned: Object.keys(server), port },
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
