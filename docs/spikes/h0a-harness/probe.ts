// The probe: a SEPARATE process that every 250 ms asks the host (Basic auth) and the control for `GET /amicode/ping` and
// records (t, host_ms, control_ms, host_status, control_status). A request not answered within the timeout (2 s) is a
// miss (`h: null`, `hs: 0`); two consecutive host misses are a wedge (see stats.ts). External round-trip latency is an
// upper bound on the host's event-loop lag; the control's latency over the same path is the part that is not the host's.
//
// Row: { t: scheduled epoch ms, h, c: ms|null, hs, cs: HTTP status|0, pl: how late the probe itself fired, in ms }
import fs from "node:fs"
import { args, basic, ndjson } from "./common.ts"

export type ProbeOptions = { hostUrl: string; controlUrl: string; auth: string; out: string; intervalMs: number; timeoutMs: number }

async function ask(url: string, headers: Record<string, string>, timeoutMs: number) {
  const started = performance.now()
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    await res.arrayBuffer()
    return { ms: Math.round((performance.now() - started) * 100) / 100, status: res.status }
  } catch {
    return { ms: null, status: 0 }
  }
}

export function startProbe(options: ProbeOptions) {
  const out = ndjson(options.out)
  const startedAt = performance.now()
  const epoch = Date.now()
  let k = 0
  let inflight = 0
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = () => {
    if (stopped) return
    const scheduled = startedAt + k * options.intervalMs
    const row = { t: Math.round(epoch + k * options.intervalMs), pl: Math.round((performance.now() - scheduled) * 10) / 10 }
    k++
    inflight++
    // Both requests go out in the same tick, so host and control see the same machine state.
    void Promise.all([ask(`${options.hostUrl}/amicode/ping`, { authorization: options.auth }, options.timeoutMs), ask(`${options.controlUrl}/`, {}, options.timeoutMs)]).then(([h, c]) => {
      out.write({ ...row, h: h.ms, c: c.ms, hs: h.status, cs: c.status })
      inflight--
    })
    timer = setTimeout(tick, Math.max(0, startedAt + k * options.intervalMs - performance.now()))
  }
  tick()
  return {
    /** Stop issuing ticks, let in-flight ones finish (at most the timeout), flush and close. */
    stop: async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      const deadline = Date.now() + options.timeoutMs + 500
      while (inflight > 0 && Date.now() < deadline) await Bun.sleep(25)
      out.close()
    },
    ticks: () => k,
  }
}

if (import.meta.main) {
  const a = args(process.argv.slice(2))
  const probe = startProbe({
    hostUrl: a["host-url"]!,
    controlUrl: a["control-url"]!,
    auth: basic(fs.readFileSync(a["password-file"]!, "utf8").trim()),
    out: a.out!,
    intervalMs: Number(a["interval-ms"] ?? 250),
    timeoutMs: Number(a["timeout-ms"] ?? 2000),
  })
  console.log(JSON.stringify({ event: "probing", pid: process.pid }))
  const bye = async () => {
    await probe.stop()
    process.exit(0)
  }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
}
