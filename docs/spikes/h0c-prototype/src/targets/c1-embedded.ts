// Candidate 1: deep import of the SDK's unexported EmbeddedHost.
import path from "node:path"
import { sandbox } from "../env"
import { makeProbeDriver, serverOptions, type Target } from "../options"

export async function build(): Promise<Target> {
  const facts: Record<string, unknown> = {}

  // Evidence for "internal/ is not exported": resolve through the package name, the way a consumer would.
  const consumer = path.join(sandbox.root, "consumer")
  const { mkdirSync, symlinkSync, existsSync } = await import("node:fs")
  mkdirSync(path.join(consumer, "node_modules/@opencode"), { recursive: true })
  const link = path.join(consumer, "node_modules/@opencode/sdk")
  if (!existsSync(link)) symlinkSync(path.join(sandbox.upstream, "packages/sdk"), link)
  const attempt = async (specifier: string) => {
    try {
      return `resolved ${Bun.resolveSync(specifier, consumer)}`
    } catch (error) {
      return `FAILS: ${(error as Error).message.split("\n")[0]}`
    }
  }
  facts["resolve @opencode/sdk (package root)"] = await attempt("@opencode/sdk")
  facts["resolve @opencode/sdk/internal/host (deep)"] = await attempt("@opencode/sdk/internal/host")

  // So the prototype has to reach into the checkout by file path (the brittle part).
  const { EmbeddedHost } = await import(path.join(sandbox.upstream, "packages/sdk/src/internal/host.ts"))
  const { Effect } = await import("effect")
  const { probePlugin } = await import("../probe-plugin")
  const calls: string[] = []
  const driver = await makeProbeDriver(calls)()
  const started = performance.now()
  const host = await Effect.runPromise(
    EmbeddedHost.create({
      ...serverOptions(),
      plugins: [probePlugin],
      workspaceProviders: { h0c: driver },
    }),
  )
  facts["startup ms"] = Math.round(performance.now() - started)
  facts["host keys"] = Object.keys(host)

  return {
    handler: (request) => host.fetch(request),
    nativeAuth: false, // createEmbeddedRoutes sets password: none
    customRouteInBare: false,
    registerPlugin: async () => {}, // seeded through CreateOptions.plugins above; also exposes host.plugins.register
    workspaceProbe: async () => {
      const id = await Effect.runPromise(host.workspace.create({ provider: "h0c" }))
      const info = await Effect.runPromise(host.workspace.provision(id))
      await Effect.runPromise(host.workspace.destroy(id))
      return `provider=${info.provider} calls=${calls.join(",")}`
    },
    facts,
    stop: () => host.close(),
  }
}
