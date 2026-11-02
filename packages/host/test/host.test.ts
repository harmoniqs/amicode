// End-to-end contract tests: real host processes (real @opencode/server behind the real front), real sockets,
// real lock/registration files. Each process is sandboxed by helpers.ts (temp XDG, fresh db, ports 52000-52999).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { lockPathFor } from "../src/lock.ts"
import {
  REAL_HOME,
  PORT_MAX,
  PORT_MIN,
  basic,
  cleanup,
  deadPid,
  freePort,
  makeSandbox,
  pidAlive,
  ready,
  spawnHost,
  stop,
  waitFor,
  walkFiles,
  type Sandbox,
  type SpawnedHost,
} from "./helpers.ts"

afterAll(cleanup)

const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    void Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {}, open: (s) => (s.end(), resolve(true)), error: () => resolve(false), connectError: () => resolve(false) } }).catch(() => resolve(false))
  })

const json = async (res: Response) => (await res.json()) as any

async function startHost(sb: Sandbox, env: Record<string, string | undefined> = {}) {
  const host = spawnHost(sb, { port: await freePort(), env })
  await ready(host)
  return host
}

const dirHeader = (sb: Sandbox) => ({ "x-opencode-directory": sb.work })

describe("a running host", () => {
  const sb = makeSandbox("main")
  let host: SpawnedHost
  const get = (p: string, headers: Record<string, string> = host.auth, init: RequestInit = {}) =>
    fetch(host.url + p, { ...init, headers: { ...dirHeader(sb), ...headers, ...(init.headers as object) } })

  beforeAll(async () => {
    host = await startHost(sb)
  }, 60_000)
  afterAll(async () => {
    await stop(host)
  })

  test("custom route /amicode/ping answers behind the front", async () => {
    const res = await get("/amicode/ping")
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({ ok: true, host: "amicode-host" })
  })

  test("/amicode/health: db basename only, uptime, lock holder pid, open streams", async () => {
    const text = await (await get("/amicode/health")).text()
    expect(text).not.toContain(sb.root)
    expect(text).not.toContain(sb.password)
    expect(JSON.parse(text)).toMatchObject({ ok: true, db: "amicode-host.db", lockHolderPid: host.proc.pid, openStreams: 0 })
  })

  test("standard routes work behind the front: info, create a session, list it", async () => {
    const info = await get("/api/info")
    expect(info.status).toBe(200)
    const created = await get("/api/session", host.auth, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "h1a-probe", location: { directory: sb.work } }),
    })
    expect(created.status).toBe(200)
    const id = (await json(created)).data?.id
    expect(id).toBeTruthy()
    const listed = await json(await get("/api/session"))
    expect(listed.data.some((s: { id: string }) => s.id === id)).toBe(true)
  })

  const MATRIX = [
    "/api/info",
    "/api/session",
    "/api/event",
    "/api/plugin",
    "/api/rpc/h1a/ping",
    "/global/health",
    "/amicode/ping",
    "/amicode/health",
    "/amicode/nope",
    "/nope",
    "/",
    "/assets/index.js",
    "/%2e%2e/etc/passwd",
  ]
  test.each(MATRIX)("401 without credentials: %s", async (p) => {
    for (const method of ["GET", "POST"]) {
      const res = await fetch(host.url + p, { method, headers: dirHeader(sb), signal: AbortSignal.timeout(5000) })
      void res.body?.cancel()
      expect(res.status).toBe(401)
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic/)
    }
  })
  test("401 with a wrong password on a standard path and on the custom path", async () => {
    for (const p of ["/api/info", "/amicode/ping"]) {
      const res = await fetch(host.url + p, { headers: { authorization: basic("wrong") } })
      expect(res.status).toBe(401)
    }
  })

  test("writes its own registration file (not the stock one) with no password, mode 0600", async () => {
    expect(fs.existsSync(sb.registration)).toBe(true)
    expect((fs.statSync(sb.registration).mode & 0o777).toString(8)).toBe("600")
    const raw = fs.readFileSync(sb.registration, "utf8")
    expect(raw).not.toContain(sb.password)
    expect(JSON.parse(raw)).toMatchObject({ url: host.url, pid: host.proc.pid })
    expect(typeof JSON.parse(raw).id).toBe("string")
    expect(walkFiles(sb.root).filter((file) => /service[^/]*\.json$/.test(file))).toEqual([])
    expect(fs.existsSync(sb.stockRegistration)).toBe(false)
    expect(fs.existsSync(lockPathFor(sb.db))).toBe(true)
  })

  test("isolation: only ports 52000-52999, loopback only, no descriptor into the real hub paths, own db open", () => {
    const pid = host.proc.pid
    const ss = Bun.spawnSync(["ss", "-ltnpH"]).stdout.toString().split("\n").filter((l) => l.includes(`pid=${pid},`))
    expect(ss.length).toBeGreaterThan(0)
    for (const line of ss) {
      const local = line.trim().split(/\s+/)[3]!
      expect(local.startsWith("127.0.0.1:")).toBe(true)
      const port = Number(local.split(":").at(-1))
      expect(port).toBeGreaterThanOrEqual(PORT_MIN)
      expect(port).toBeLessThanOrEqual(PORT_MAX)
    }
    const fds = fs.readdirSync(`/proc/${pid}/fd`).map((fd) => {
      try {
        return fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
      } catch {
        return ""
      }
    })
    expect(fds.filter((l) => l.startsWith(path.join(REAL_HOME, ".local/share/opencode")) || l.startsWith(path.join(REAL_HOME, ".amico")))).toEqual([])
    expect(fds.some((l) => l.startsWith(sb.db))).toBe(true)
  })

  test(
    "event stream passes through: server.connected, a second heartbeat after the 15 s cadence, abort releases the subscription",
    async () => {
      const controller = new AbortController()
      const t0 = performance.now()
      const res = await fetch(host.url + "/api/event", { headers: { ...dirHeader(sb), ...host.auth, accept: "text/event-stream" }, signal: controller.signal })
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const heartbeats: number[] = []
      let connected = false
      let openedDuring = -1
      const deadline = t0 + 40_000
      while (performance.now() < deadline && heartbeats.length < 2) {
        const next = await Promise.race([reader.read(), Bun.sleep(deadline - performance.now()).then(() => undefined)])
        if (!next || next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        connected ||= buffer.includes("server.connected")
        const seen = buffer.split(": heartbeat").length - 1
        while (heartbeats.length < seen) heartbeats.push(performance.now() - t0)
        if (openedDuring < 0 && connected) openedDuring = (await json(await get("/amicode/health"))).openStreams
      }
      expect(connected).toBe(true)
      expect(openedDuring).toBe(1)
      expect(heartbeats.length).toBe(2)
      expect(heartbeats[1]! - heartbeats[0]!).toBeGreaterThanOrEqual(10_000)

      controller.abort()
      await waitFor(async () => (await json(await get("/amicode/health"))).openStreams === 0, {
        timeoutMs: 5000,
        what: "server-side stream scope to close after client abort",
      })
    },
    60_000,
  )
})

describe("startup refusals", () => {
  test("no database path: exits 64, names AMICODE_HOST_DB, never listens", async () => {
    const sb = makeSandbox("refuse")
    const port = await freePort()
    const host = spawnHost(sb, { port, env: { AMICODE_HOST_DB: undefined } })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).toContain("AMICODE_HOST_DB")
    expect(await listening(port)).toBe(false)
    expect(fs.existsSync(sb.registration)).toBe(false)
  })
  test.each([":memory:", "", "file::memory:"])("in-memory/empty database %p: exits 64 and creates nothing", async (value) => {
    const sb = makeSandbox("refuse")
    const port = await freePort()
    const host = spawnHost(sb, { port, env: { AMICODE_HOST_DB: value } })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).toMatch(/AMICODE_HOST_DB|in-memory/i)
    expect(await listening(port)).toBe(false)
    expect(fs.existsSync(sb.registration)).toBe(false)
    expect(walkFiles(sb.root).filter((f) => f.endsWith(".lock"))).toEqual([])
  })
  test("no password: exits 64 (never serves an open server)", async () => {
    const sb = makeSandbox("refuse")
    const host = spawnHost(sb, { port: await freePort(), env: { AMICODE_HOST_PASSWORD: undefined } })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).toContain("AMICODE_HOST_PASSWORD")
  })
  test("a group-readable password file: exits 64 and the secret is not echoed", async () => {
    const sb = makeSandbox("refuse")
    const file = path.join(sb.root, "pw")
    fs.writeFileSync(file, sb.password)
    fs.chmodSync(file, 0o644)
    const host = spawnHost(sb, { port: await freePort(), env: { AMICODE_HOST_PASSWORD: undefined, AMICODE_HOST_PASSWORD_FILE: file } })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).not.toContain(sb.password)
  })
  test("refuses to run under Node with a clear message (the V1 importer is a silent no-op there)", async () => {
    const sb = makeSandbox("refuse")
    const port = await freePort()
    const host = spawnHost(sb, { port, runtime: "node" })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).toMatch(/requires Bun/)
    expect(host.output.stderr).toMatch(/Node/)
    expect(await listening(port)).toBe(false)
    expect(fs.existsSync(sb.db)).toBe(false)
  })
})

describe("lifecycle", () => {
  test("SIGTERM: exits 0, closes the port, removes the lock and the registration", async () => {
    const sb = makeSandbox("life")
    const host = await startHost(sb)
    expect(fs.existsSync(sb.registration)).toBe(true)
    expect(fs.existsSync(lockPathFor(sb.db))).toBe(true)
    expect(await stop(host, "SIGTERM")).toBe(0)
    expect(fs.existsSync(sb.registration)).toBe(false)
    expect(fs.existsSync(lockPathFor(sb.db))).toBe(false)
    expect(await listening(host.port)).toBe(false)
  }, 60_000)

  test("SIGINT behaves the same", async () => {
    const sb = makeSandbox("life")
    const host = await startHost(sb)
    expect(await stop(host, "SIGINT")).toBe(0)
    expect(fs.existsSync(sb.registration)).toBe(false)
    expect(fs.existsSync(lockPathFor(sb.db))).toBe(false)
  }, 60_000)

  test("shutdown with an open event stream still exits promptly", async () => {
    const sb = makeSandbox("life")
    const host = await startHost(sb)
    const res = await fetch(host.url + "/api/event", { headers: { ...dirHeader(sb), ...host.auth } })
    expect(res.status).toBe(200)
    const started = Date.now()
    expect(await stop(host)).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    void res.body?.cancel().catch(() => {})
  }, 60_000)

  test("second start on the same database while the first is alive: fails with a clear message naming the pid, never a second server", async () => {
    const sb = makeSandbox("lock2")
    const first = await startHost(sb)
    const before = fs.readFileSync(sb.registration, "utf8")
    const portB = await freePort()
    const second = spawnHost(sb, { port: portB, env: { AMICODE_HOST_LOCK_WAIT_MS: "1200" } })
    expect(await second.exited).toBe(69)
    expect(second.output.stderr).toContain(String(first.proc.pid))
    expect(second.output.stderr).toMatch(/database/i)
    expect(await listening(portB)).toBe(false)
    // the incumbent is untouched: still serving, same registration
    expect(fs.readFileSync(sb.registration, "utf8")).toBe(before)
    expect((await fetch(first.url + "/amicode/ping", { headers: first.auth })).status).toBe(200)
    await stop(first)
  }, 60_000)

  test("second start waits for the first to exit, then serves; the first is gone by then", async () => {
    const sb = makeSandbox("lock3")
    const first = await startHost(sb)
    const portB = await freePort()
    const second = spawnHost(sb, { port: portB, env: { AMICODE_HOST_LOCK_WAIT_MS: "30000" } })
    await Bun.sleep(1500)
    expect(await listening(portB)).toBe(false) // still waiting, not serving
    expect(first.proc.exitCode).toBeNull()
    first.proc.kill("SIGTERM")
    expect(await first.exited).toBe(0)
    await ready(second)
    expect(await listening(first.port)).toBe(false)
    expect(JSON.parse(fs.readFileSync(sb.registration, "utf8")).pid).toBe(second.proc.pid)
    expect(JSON.parse(fs.readFileSync(lockPathFor(sb.db), "utf8")).pid).toBe(second.proc.pid)
    await stop(second)
  }, 90_000)

  test("a crashed host (SIGKILL) leaves a stale lock and registration; the next start takes over", async () => {
    const sb = makeSandbox("crash")
    const first = await startHost(sb)
    first.proc.kill("SIGKILL")
    await first.exited
    expect(fs.existsSync(lockPathFor(sb.db))).toBe(true)
    const second = await startHost(sb)
    expect(second.output.stderr).toMatch(/took over a stale lock/)
    expect(second.output.stderr).toContain(String(first.proc.pid))
    expect(JSON.parse(fs.readFileSync(sb.registration, "utf8")).pid).toBe(second.proc.pid)
    await stop(second)
  }, 60_000)

  test("a lock left by a dead pid is taken over", async () => {
    const sb = makeSandbox("stale")
    const pid = await deadPid()
    fs.writeFileSync(lockPathFor(sb.db), JSON.stringify({ pid, token: "stale", startedAt: 1, procStart: "1" }))
    const host = await startHost(sb)
    expect(host.output.stderr).toContain(String(pid))
    expect(JSON.parse(fs.readFileSync(lockPathFor(sb.db), "utf8")).pid).toBe(host.proc.pid)
    await stop(host)
  }, 60_000)
})

describe("a stock opencode client and the host do not see or touch each other", () => {
  // The stock client finds, replaces or kills a service through <XDG_STATE_HOME>/opencode/service.json
  // (packages/cli/src/services/service-registration.ts). Discovery here is exactly that default path.
  const stockDiscovery = (sb: Sandbox) =>
    fs.existsSync(sb.stockRegistration) ? (JSON.parse(fs.readFileSync(sb.stockRegistration, "utf8")) as { pid: number; url: string }) : undefined

  test("a decoy stock registration for another pid is never read as ours, replaced, removed or signalled", async () => {
    const sb = makeSandbox("stock")
    const decoy = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" })
    try {
      fs.mkdirSync(path.dirname(sb.stockRegistration), { recursive: true })
      const body = JSON.stringify({ id: "decoy", version: "0.0.0", url: "http://127.0.0.1:52999", pid: decoy.pid, password: "decoy-" + crypto.randomUUID() })
      fs.writeFileSync(sb.stockRegistration, body, { mode: 0o600 })
      const mtime = fs.statSync(sb.stockRegistration).mtimeMs
      const host = await startHost(sb)
      await Bun.sleep(1500)
      // stock-style discovery finds the decoy, never the host
      expect(stockDiscovery(sb)?.pid).toBe(decoy.pid)
      expect(stockDiscovery(sb)?.pid).not.toBe(host.proc.pid)
      expect(stockDiscovery(sb)?.url).not.toBe(host.url)
      expect(JSON.parse(fs.readFileSync(sb.registration, "utf8")).pid).toBe(host.proc.pid)
      expect(await stop(host)).toBe(0)
      expect(fs.readFileSync(sb.stockRegistration, "utf8")).toBe(body)
      expect(fs.statSync(sb.stockRegistration).mtimeMs).toBe(mtime)
      expect(pidAlive(decoy.pid)).toBe(true)
    } finally {
      decoy.kill("SIGKILL")
    }
  }, 60_000)

  test("with no stock registration at all, a running host does not create one (stock discovery finds nothing to kill)", async () => {
    const sb = makeSandbox("stock")
    const host = await startHost(sb)
    expect(stockDiscovery(sb)).toBeUndefined()
    expect(fs.existsSync(path.dirname(sb.stockRegistration))).toBe(false)
    await stop(host)
    expect(stockDiscovery(sb)).toBeUndefined()
  }, 60_000)

  test("the host never opens the stock path: a FIFO sitting there would hang any open(); the host starts and leaves it intact", async () => {
    const sb = makeSandbox("stock")
    fs.mkdirSync(path.dirname(sb.stockRegistration), { recursive: true })
    expect(Bun.spawnSync(["mkfifo", sb.stockRegistration]).exitCode).toBe(0)
    const inode = fs.statSync(sb.stockRegistration).ino
    const host = await startHost(sb)
    expect(fs.statSync(sb.stockRegistration).isFIFO()).toBe(true)
    expect(fs.statSync(sb.stockRegistration).ino).toBe(inode)
    expect(await stop(host)).toBe(0)
    expect(fs.statSync(sb.stockRegistration).ino).toBe(inode)
  }, 60_000)

  test("pointing the host's registration at the stock path is refused at startup", async () => {
    const sb = makeSandbox("stock")
    const host = spawnHost(sb, { port: await freePort(), env: { AMICODE_HOST_REGISTRATION_FILE: sb.stockRegistration } })
    expect(await host.exited).toBe(64)
    expect(host.output.stderr).toMatch(/stock opencode/i)
    expect(fs.existsSync(sb.stockRegistration)).toBe(false)
  })
})

describe("resume of suspended sessions", () => {
  // Seed: start a host, create a session, stop it; then mark the session as holding an execution claim
  // (`time_suspended`), the durable signature of a turn that was in flight when the process died.
  async function seed() {
    const sb = makeSandbox("resume")
    const host = await startHost(sb)
    const created = await fetch(host.url + "/api/session", {
      method: "POST",
      headers: { ...host.auth, ...dirHeader(sb), "content-type": "application/json" },
      body: JSON.stringify({ title: "suspended-probe", location: { directory: sb.work } }),
    })
    const id: string = (await json(created)).data.id
    expect(await stop(host)).toBe(0)
    const db = new Database(sb.db)
    db.run("UPDATE session SET time_suspended = ? WHERE id = ?", [Date.now(), id])
    db.close()
    return { sb, id }
  }
  const row = (sb: Sandbox, id: string) => {
    const db = new Database(sb.db, { readonly: true })
    try {
      return db.query("SELECT time_suspended, resume_attempts FROM session WHERE id = ?").get(id) as { time_suspended: number | null; resume_attempts: number } | null
    } finally {
      db.close()
    }
  }
  const restartNotices = async (host: SpawnedHost, sb: Sandbox, id: string) => {
    const res = await fetch(`${host.url}/api/session/${id}/message`, { headers: { ...host.auth, ...dirHeader(sb) } })
    return (await res.text()).includes("Continuing after restart")
  }

  test("AMICODE_HOST_RESUME=1 (default): the suspended session is resumed on start", async () => {
    const { sb, id } = await seed()
    const host = await startHost(sb)
    await waitFor(async () => (await restartNotices(host, sb, id)) || (row(sb, id)?.resume_attempts ?? 0) > 0, { timeoutMs: 15_000, what: "resume of the suspended session" })
    expect((await json(await fetch(host.url + "/amicode/health", { headers: host.auth }))).resume).toBe(true)
    await stop(host)
  }, 90_000)

  test("AMICODE_HOST_RESUME=0: the claim is left untouched and nothing is replayed", async () => {
    const { sb, id } = await seed()
    const before = row(sb, id)
    expect(before?.time_suspended).not.toBeNull()
    const host = await startHost(sb, { AMICODE_HOST_RESUME: "0" })
    await Bun.sleep(4000)
    expect(await restartNotices(host, sb, id)).toBe(false)
    await stop(host)
    expect(row(sb, id)).toEqual(before)
    expect(row(sb, id)?.resume_attempts).toBe(0)
  }, 90_000)
})
