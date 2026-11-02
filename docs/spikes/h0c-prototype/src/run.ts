import "./env" // must be first: asserts the sandbox before any upstream module is imported
import fs from "node:fs"
import { sandbox, freePort } from "./env"
import { checkIsolation, runCriteria, type Row } from "./criteria"
import { front, proxy } from "./front"
import type { Target } from "./options"

const name = process.argv[2]
const modes = (process.argv[3] ?? "bare,fronted").split(",")
const builders: Record<string, () => Promise<{ build: () => Promise<Target> }>> = {
  c1: () => import("./targets/c1-embedded"),
  c2a: () => import("./targets/c2a-createroutes"),
  c2b: () => import("./targets/c2b-serverfetch"),
  c2c: () => import("./targets/c2c-serverprocess"),
  c3: () => import("./targets/c3-stock"),
}
if (!builders[name]) throw new Error(`usage: run.ts <${Object.keys(builders).join("|")}> [bare,fronted,fronted-default-idle]`)

const target = await (await builders[name]()).build()
console.log(`# ${name} built: ${JSON.stringify(target.facts)}`)
const innerPassword = (target.facts.innerPassword as string | undefined) ?? sandbox.password
const rows: Row[] = []
const servers: { stop: (force?: boolean) => unknown }[] = []

for (const mode of modes) {
  const port = await freePort()
  if (mode === "bare") {
    const baseUrl = target.nativeUrl ?? ""
    let url = baseUrl
    if (target.handler) {
      const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: target.handler })
      servers.push(server)
      url = `http://127.0.0.1:${port}`
    }
    rows.push(
      ...(await runCriteria({
        label: `${name}/bare`,
        baseUrl: url,
        password: target.nativeAuth ? innerPassword : undefined,
        target,
        hasCustom: target.customRouteInBare,
      })),
    )
  } else {
    const downstream = target.handler ?? proxy(target.nativeUrl!, innerPassword, mode === "fronted-no-abort-forward" ? "none" : mode === "fronted-body-cancel-only" ? "body-only" : "both")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      ...(mode === "fronted-default-idle" ? {} : { idleTimeout: 0 }),
      fetch: front(sandbox.password, downstream),
    })
    servers.push(server)
    rows.push(
      ...(await runCriteria({
        label: `${name}/${mode}`,
        baseUrl: `http://127.0.0.1:${port}`,
        password: sandbox.password,
        target,
        hasCustom: true,
      })),
    )
  }
}
const childPid = target.facts.pid as number | undefined
rows.push(...(await checkIsolation(name, childPid ? [childPid] : [])))
fs.writeFileSync(`${sandbox.root}/results-${name}.json`, JSON.stringify({ name, facts: target.facts, rows }, null, 2))
for (const s of servers) s.stop(true)
await target.stop()
console.log(`# ${name} done`)
process.exit(0)
