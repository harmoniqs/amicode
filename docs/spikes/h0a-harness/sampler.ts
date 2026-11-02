// The sampler: RSS (VmRSS), CPU seconds (utime+stime) of the host pid every 10 s from /proc, plus the machine's load average.
// It also samples the harness's own processes (`--also name=pid,...`) so a hungry model/driver is visible in the record.
// Row: { t, rss, cpu_s, load1, load5, procs: { name: { rss, cpu_s } } }. No row is written while the host pid is gone.
import fs from "node:fs"
import { args, ndjson } from "./common.ts"

export const CLK_TCK = (() => {
  const r = Bun.spawnSync(["getconf", "CLK_TCK"])
  const n = Number(new TextDecoder().decode(r.stdout).trim())
  return Number.isFinite(n) && n > 0 ? n : 100
})()

/** VmRSS in bytes from the text of /proc/<pid>/status. */
export function parseRss(status: string) {
  const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
  return match ? Number(match[1]) * 1024 : undefined
}

/** utime + stime in seconds from the text of /proc/<pid>/stat (the comm field may contain spaces and parentheses). */
export function parseCpuSeconds(stat: string, clkTck = CLK_TCK) {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ") // field 3 (state) is rest[0]
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  return Number.isFinite(utime) && Number.isFinite(stime) ? (utime + stime) / clkTck : undefined
}

export function readProc(pid: number) {
  try {
    const rss = parseRss(fs.readFileSync(`/proc/${pid}/status`, "utf8"))
    const cpu = parseCpuSeconds(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))
    return rss === undefined || cpu === undefined ? undefined : { rss, cpu_s: Math.round(cpu * 100) / 100 }
  } catch {
    return undefined
  }
}

export function sampleOnce(hostPid: number, also: Record<string, number> = {}) {
  const host = readProc(hostPid)
  if (!host) return undefined
  const load = fs.readFileSync("/proc/loadavg", "utf8").split(" ")
  return {
    t: Date.now(),
    rss: host.rss,
    cpu_s: host.cpu_s,
    load1: Number(load[0]),
    load5: Number(load[1]),
    procs: Object.fromEntries(Object.entries(also).map(([name, pid]) => [name, readProc(pid) ?? null])),
  }
}

if (import.meta.main) {
  const a = args(process.argv.slice(2))
  const hostPid = Number(a["host-pid"])
  const also = Object.fromEntries((a.also ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]).map(([name, pid]) => [name, Number(pid)]))
  const out = ndjson(a.out!)
  const every = Number(a["interval-s"] ?? 10) * 1000
  const take = () => {
    const row = sampleOnce(hostPid, also)
    if (row) out.write(row)
  }
  take()
  const timer = setInterval(take, every)
  console.log(JSON.stringify({ event: "sampling", pid: process.pid }))
  const bye = () => {
    clearInterval(timer)
    take()
    out.close()
    process.exit(0)
  }
  process.on("SIGTERM", bye)
  process.on("SIGINT", bye)
}
