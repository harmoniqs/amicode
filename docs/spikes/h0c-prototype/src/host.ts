// The prototype of the leading candidate (route 1): the v2 handler obtained from the SDK's embedded host,
// served behind OUR deny-by-default front, with one custom /amicode/ping route and an in-process plugin.
//
// Today the host lives in an unexported internal module, so it is imported by file path. After the proposed
// upstream change (see the note's Decision section) this becomes `import { EmbeddedHost } from "@opencode/sdk/host"`.
import path from "node:path"
import { sandbox, freePort } from "./env"
import { front } from "./front"
import { probePlugin } from "./probe-plugin"
import { makeProbeDriver, serverOptions } from "./options"

export const HOST_MODULE = path.join(sandbox.upstream, "packages/sdk/src/internal/host.ts")

export async function startHost(options: { password: string; port?: number }) {
  const { EmbeddedHost } = await import(HOST_MODULE)
  const { Effect } = await import("effect")
  const calls: string[] = []
  const driver = await makeProbeDriver(calls)()
  const host = await Effect.runPromise(
    EmbeddedHost.create({
      ...serverOptions(), // fresh DB path: the embedded default is :memory:
      plugins: [probePlugin], // in-process, registered before the first request
      workspaceProviders: { h0c: driver }, // Effect-entry-only option; a trivial provider that touches nothing
    }),
  )
  const port = options.port ?? (await freePort())
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0, // Bun's 10 s default would kill an idle SSE stream before the 15 s heartbeat
    fetch: front(options.password, (request) => host.fetch(request)),
  })
  return {
    url: `http://127.0.0.1:${port}`,
    host,
    calls,
    stop: async () => {
      server.stop(true)
      await host.close()
    },
  }
}
