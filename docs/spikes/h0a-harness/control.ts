// The control: a trivial server in its own process that does nothing but answer. Probed at the same cadence, from the same
// probe process, at the same nice level as the host. Whatever latency it shows is the machine's (and the probe's), not the host's.
import { args, assertPort } from "./common.ts"

export function startControl(port: number) {
  assertPort(port)
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: () => Response.json({ ok: true }),
  })
  return { port: server.port as number, stop: () => server.stop(true) }
}

if (import.meta.main) {
  const control = startControl(Number(args(process.argv.slice(2)).port))
  console.log(JSON.stringify({ event: "listening", port: control.port, pid: process.pid }))
  const bye = () => {
    control.stop()
    process.exit(0)
  }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
}
