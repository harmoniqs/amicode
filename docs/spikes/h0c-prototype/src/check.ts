// Criteria check for the prototype: starts the host, runs C1-C8 against it through the front, prints PASS/FAIL.
import "./env"
import { sandbox } from "./env"
import { checkIsolation, runCriteria } from "./criteria"
import { startHost } from "./host"
import type { Target } from "./options"

const started = await startHost({ password: sandbox.password })
const { Effect } = await import("effect")
const { makeProbeDriver } = await import("./options")
void makeProbeDriver
const target = {
  // The plugin was seeded through EmbeddedHost.create; host.plugins.register(plugin) is also available at runtime.
  registerPlugin: async () => {},
  workspaceProbe: async () => {
    const id = await Effect.runPromise(started.host.workspace.create({ provider: "h0c" }))
    const info = await Effect.runPromise(started.host.workspace.provision(id))
    await Effect.runPromise(started.host.workspace.destroy(id))
    return `provider=${info.provider} calls=${started.calls.join(",")}`
  },
  nativeAuth: false,
  customRouteInBare: false,
  facts: {},
  stop: async () => {},
} satisfies Partial<Target> as unknown as Target
const rows = [
  ...(await runCriteria({ label: "prototype", baseUrl: started.url, password: sandbox.password, target, hasCustom: true })),
  ...(await checkIsolation("prototype")),
]
await started.stop()
const failed = rows.filter((r) => r.verdict === "FAIL")
console.log(`\n${rows.length - failed.length}/${rows.length} rows pass (NA counted as pass)${failed.length ? "; FAILED: " + failed.map((r) => r.id).join(",") : ""}`)
process.exit(failed.length ? 1 : 0)
