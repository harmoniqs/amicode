import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import { basic, freePort, readNdjson } from "./common.ts"
import { startControl } from "./control.ts"
import { startProbe } from "./probe.ts"
import { parseCpuSeconds, parseRss, sampleOnce } from "./sampler.ts"
import { wedgeEvents } from "./stats.ts"

const dir = fs.mkdtempSync("/tmp/opencode/h0a-probe-")
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("probe against live servers", () => {
  test("records host and control latency per tick, a miss on a silent server, and rejects bad auth as non-200", async () => {
    const control = startControl(await freePort())
    const good = Bun.serve({ hostname: "127.0.0.1", port: await freePort([control.port]), fetch: (req) => (req.headers.get("authorization") === basic("pw") ? Response.json({ ok: true }) : new Response("no", { status: 401 })) })
    // A server that accepts the connection and never answers: the shape of a wedged host.
    const sockets: net.Socket[] = []
    const silent = net.createServer((s) => sockets.push(s))
    const silentPort = await freePort([control.port, good.port as number])
    await new Promise<void>((r) => silent.listen(silentPort, "127.0.0.1", r))
    try {
      const run = async (hostUrl: string, auth: string, file: string, ms: number) => {
        const probe = startProbe({ hostUrl, controlUrl: `http://127.0.0.1:${control.port}`, auth, out: `${dir}/${file}`, intervalMs: 100, timeoutMs: 300 })
        await Bun.sleep(ms)
        await probe.stop()
        return readNdjson<{ t: number; h: number | null; c: number | null; hs: number; cs: number }>(`${dir}/${file}`)
      }
      const ok = await run(`http://127.0.0.1:${good.port}`, basic("pw"), "ok.ndjson", 1000)
      expect(ok.length).toBeGreaterThanOrEqual(8)
      expect(ok.every((r) => r.hs === 200 && r.cs === 200 && r.h !== null && r.c !== null)).toBe(true)
      expect(ok.map((r) => r.t)).toEqual([...ok.map((r) => r.t)].sort((a, b) => a - b))

      const unauthorized = await run(`http://127.0.0.1:${good.port}`, basic("wrong"), "401.ndjson", 400)
      expect(unauthorized.every((r) => r.hs === 401 && r.cs === 200)).toBe(true)

      const wedged = await run(`http://127.0.0.1:${silentPort}`, basic("pw"), "silent.ndjson", 1500)
      expect(wedged.length).toBeGreaterThanOrEqual(10)
      expect(wedged.every((r) => r.h === null && r.hs === 0)).toBe(true) // every tick a miss
      expect(wedged.every((r) => r.cs === 200)).toBe(true) // the control still answers: it is the host that is silent
      expect(wedgeEvents(wedged.map((r) => ({ t: r.t, miss: r.h === null }))).count).toBe(1)
    } finally {
      control.stop()
      good.stop(true)
      sockets.forEach((s) => s.destroy())
      silent.close()
    }
  }, 20_000)
})

describe("sampler parsing", () => {
  test("VmRSS from /proc status text", () => {
    expect(parseRss("Name:\tbun\nVmPeak:\t 99 kB\nVmRSS:\t  2048 kB\nThreads:\t4\n")).toBe(2048 * 1024)
    expect(parseRss("Name:\tbun\n")).toBeUndefined()
  })
  test("CPU seconds from /proc stat text, including a comm with spaces and parens", () => {
    // fields after comm: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime ...
    const stat = "123 (my (weird) comm) S 1 123 123 0 -1 4194304 100 0 0 0 250 50 0 0 20 0 1 0 5000 1000 100"
    expect(parseCpuSeconds(stat, 100)).toBeCloseTo(3.0, 5)
  })
  test("samples this very process", () => {
    const row = sampleOnce(process.pid, { self: process.pid, gone: 2 ** 22 + 12345 })
    expect(row!.rss).toBeGreaterThan(1_000_000)
    expect(row!.cpu_s).toBeGreaterThan(0)
    expect(row!.load1).toBeGreaterThanOrEqual(0)
    expect(row!.procs.self!.rss).toBeGreaterThan(0)
    expect(row!.procs.gone).toBeNull()
  })
  test("a vanished host pid writes nothing", () => {
    expect(sampleOnce(2 ** 22 + 12345)).toBeUndefined()
  })
})
