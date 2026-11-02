// Candidate 2b: @opencode/server ServerFetch.make() -> web fetch handler with the HttpApi password enforced.
import { sandbox } from "../env"
import { serverOptions, type Target } from "../options"

export async function build(): Promise<Target> {
  const { ServerFetch } = await import("@opencode/server/fetch")
  const { WorkspaceDriver } = await import("@opencode/core/workspace/driver")
  const { Effect, Exit, Scope } = await import("effect")
  const { makeProbeDriver } = await import("../options")
  const calls: string[] = []
  const driver = await makeProbeDriver(calls)()
  const scope = await Effect.runPromise(Scope.make())
  const started = performance.now()
  const handler = await Effect.runPromise(
    ServerFetch.make(serverOptions(sandbox.password), {
      overrides: [WorkspaceDriver.node.replace(WorkspaceDriver.registryNode({ h0c: driver }))],
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  )
  return {
    handler: (request) => handler(request),
    nativeAuth: true,
    customRouteInBare: false,
    registerPlugin: undefined, // the SdkPlugins service lives in a context ServerFetch.make does not return
    workspaceProbe: undefined, // overrides accepted, but the Workspace service is not reachable and PublicRef omits workspaceID
    facts: { "startup ms": Math.round(performance.now() - started), "overrides accepted (workspace registry)": true },
    stop: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}
