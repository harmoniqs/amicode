// Criteria C1-C9 from the pre-registered note. Each check returns PASS | FAIL | NA with the evidence string.
import fs from "node:fs"
import path from "node:path"
import { sandbox } from "./env"
import type { Target } from "./options"

export type Row = { target: string; id: string; verdict: "PASS" | "FAIL" | "NA"; detail: string }

export interface Subject {
  label: string
  baseUrl: string
  /** Basic credential that should work against baseUrl, or undefined if the target has no auth at all. */
  password?: string
  target: Target
  /** Does a custom route exist at baseUrl? */
  hasCustom: boolean
}

const basic = (password: string) => "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
const dirHeader = { "x-opencode-directory": sandbox.workDir }

export async function runCriteria(subject: Subject, heartbeatBudgetMs = 40_000): Promise<Row[]> {
  const rows: Row[] = []
  const add = (id: string, verdict: Row["verdict"], detail: string) => {
    rows.push({ target: subject.label, id, verdict, detail })
    console.log(`${verdict.padEnd(4)} ${subject.label.padEnd(24)} ${id.padEnd(4)} ${detail}`)
  }
  const auth = subject.password ? { authorization: basic(subject.password) } : {}
  const get = (p: string, headers: Record<string, string> = auth, init: RequestInit = {}) =>
    fetch(subject.baseUrl + p, { ...init, headers: { ...dirHeader, ...headers, ...(init.headers as object) } })

  // C1: standard routes end to end
  try {
    const info = await get("/api/info")
    const infoBody = (await info.json()) as { version?: string }
    const created = await get("/api/session", auth, {
      method: "POST",
      headers: { ...auth, ...dirHeader, "content-type": "application/json" },
      body: JSON.stringify({ title: "h0c-probe", location: { directory: sandbox.workDir } }),
    })
    const createdBody = (await created.json()) as { data?: { id?: string } }
    const id = createdBody.data?.id
    const listed = (await (await get("/api/session")).json()) as { data?: { id: string }[] }
    const found = !!id && !!listed.data?.some((s) => s.id === id)
    add(
      "C1",
      info.status === 200 && created.status === 200 && found ? "PASS" : "FAIL",
      `info=${info.status} v=${infoBody.version} create=${created.status} id=${id} listed=${found} (n=${listed.data?.length})`,
    )
  } catch (error) {
    add("C1", "FAIL", String(error))
  }

  // C2: custom route
  if (!subject.hasCustom) add("C2", "NA", "no custom-route seam without a host front at this layer")
  else {
    const r = await get("/amicode/ping")
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean }
    add("C2", r.status === 200 && body.ok === true ? "PASS" : "FAIL", `status=${r.status} body.ok=${body.ok}`)
  }

  // C3: deny-by-default
  const probes = ["/api/info", "/api/session", "/amicode/ping", "/nope", "/api/event"]
  const noCreds = await Promise.all(
    probes.map(async (p) => {
      const r = await fetch(subject.baseUrl + p, { headers: dirHeader, signal: AbortSignal.timeout(5000) })
      void r.body?.cancel()
      return `${p}=${r.status}`
    }),
  )
  const wrong = await fetch(subject.baseUrl + "/api/info", { headers: { ...dirHeader, authorization: basic("wrong") } })
  const all401 = noCreds.every((s) => s.endsWith("=401")) && wrong.status === 401
  add("C3", all401 ? "PASS" : "FAIL", `no-credentials: ${noCreds.join(" ")}; wrong-password /api/info=${wrong.status}`)

  // C4/C5/C6: SSE + heartbeat + abort -> server-side subscription release
  const logLines = () => fs.readFileSync(sandbox.subsLog, "utf8").split("\n").filter(Boolean)
  const before = logLines().length
  const controller = new AbortController()
  const t0 = performance.now()
  let connected = false
  let heartbeatAt: number | undefined
  const heartbeats: number[] = []
  let streamError: string | undefined
  try {
    const response = await fetch(subject.baseUrl + "/api/event", {
      headers: { ...dirHeader, ...auth, accept: "text/event-stream" },
      signal: controller.signal,
    })
    if (response.status !== 200 || !response.body) throw new Error(`status ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const deadline = t0 + heartbeatBudgetMs
    while (performance.now() < deadline && heartbeats.length < 2) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(Math.max(1, deadline - performance.now())).then(() => "timeout" as const),
      ])
      if (next === "timeout") break
      if (next.done) {
        streamError = "stream ended early"
        break
      }
      buffer += decoder.decode(next.value, { stream: true })
      if (!connected && buffer.includes("server.connected")) connected = true
      const seen = buffer.split(": heartbeat").length - 1
      while (heartbeats.length < seen) heartbeats.push(performance.now() - t0)
      heartbeatAt = heartbeats[0]
    }
  } catch (error) {
    streamError = String(error)
  }
  const subscribed = logLines().slice(before).filter((l) => l.includes(" subscribe "))
  const midSubscribers = subscribed.at(-1)?.match(/subscribers=(\d+)/)?.[1]
  add("C4", connected ? "PASS" : "FAIL", `server.connected=${connected}${streamError ? " err=" + streamError : ""}`)
  add(
    "C5",
    heartbeatAt !== undefined ? "PASS" : "FAIL",
    heartbeatAt !== undefined ? `heartbeat after ${Math.round(heartbeatAt)} ms` : `no heartbeat in ${heartbeatBudgetMs} ms${streamError ? " (" + streamError + ")" : ""}`,
  )
  // C5b (added after the first run showed the first tick is immediate, so one heartbeat proves nothing about
  // the 15 s cadence): a second heartbeat arrives >= 10 s after the first, i.e. the idle stream survived.
  const gap = heartbeats.length >= 2 ? heartbeats[1] - heartbeats[0] : undefined
  add(
    "C5b",
    gap !== undefined && gap >= 10_000 ? "PASS" : "FAIL",
    gap !== undefined ? `heartbeats at ${heartbeats.map((h) => Math.round(h)).join(", ")} ms (gap ${Math.round(gap)} ms)` : `only ${heartbeats.length} heartbeat(s) in ${heartbeatBudgetMs} ms${streamError ? " (" + streamError + ")" : ""}`,
  )
  controller.abort()
  let released: string | undefined
  for (let i = 0; i < 50 && !released; i++) {
    await Bun.sleep(100)
    released = logLines().slice(before).find((l) => l.includes(" release "))
  }
  const releasedAfter = released?.match(/subscribers=(\d+)/)?.[1]
  add(
    "C6",
    subscribed.length > 0 && released && releasedAfter === "0" ? "PASS" : "FAIL",
    `server-side feed log: subscribed(subscribers=${midSubscribers ?? "none"}) -> ${released ? `released(subscribers=${releasedAfter})` : "NO release within 5 s of client abort"}`,
  )

  // C7: in-process plugin visible through the running server
  if (!subject.target.registerPlugin) add("C7", "NA", "seam exposes no in-process plugin handle")
  else {
    try {
      await subject.target.registerPlugin()
      let listed = false
      for (let i = 0; i < 100 && !listed; i++) {
        const plugins = (await (await get("/api/plugin")).json()) as { data?: { id: string }[] }
        listed = !!plugins.data?.some((p) => p.id === "h0c-probe")
        if (!listed) await Bun.sleep(100)
      }
      const rpc = await get("/api/rpc/h0c/ping", auth, {
        method: "POST",
        headers: { ...auth, ...dirHeader, "content-type": "application/json" },
        body: JSON.stringify({ input: {} }),
      })
      const rpcBody = await rpc.text()
      add("C7", listed && rpc.status === 200 && rpcBody.includes("pong-from-in-process-plugin") ? "PASS" : "FAIL", `listed=${listed} rpc=${rpc.status} ${rpcBody.slice(0, 120)}`)
    } catch (error) {
      add("C7", "FAIL", String(error))
    }
  }

  // C7b: file-config plugin (what a stock process can do instead of in-process registration)
  if (subject.target.filePluginId) {
    let listed = false
    for (let i = 0; i < 100 && !listed; i++) {
      const plugins = (await (await get("/api/plugin")).json()) as { data?: { id: string }[] }
      listed = !!plugins.data?.some((p) => p.id === subject.target.filePluginId)
      if (!listed) await Bun.sleep(100)
    }
    const rpc = await get("/api/rpc/h0cfile/ping", auth, {
      method: "POST",
      headers: { ...auth, ...dirHeader, "content-type": "application/json" },
      body: JSON.stringify({ input: {} }),
    })
    const body = await rpc.text()
    add("C7b", listed && body.includes("pong-from-file-plugin") ? "PASS" : "FAIL", `file plugin listed=${listed} rpc=${rpc.status} ${body.slice(0, 100)}`)
  }

  // C8: workspace provider
  if (!subject.target.workspaceProbe) add("C8", "NA", "seam cannot drive a workspace provider in-process")
  else {
    try {
      add("C8", "PASS", await subject.target.workspaceProbe())
    } catch (error) {
      add("C8", "FAIL", String(error))
    }
  }
  return rows
}

/** C9: the process tree did not register/bind/open anything belonging to the machine's service. */
export async function checkIsolation(label: string, extraPids: number[] = []): Promise<Row[]> {
  const rows: Row[] = []
  const add = (id: string, verdict: Row["verdict"], detail: string) => {
    rows.push({ target: label, id, verdict, detail })
    console.log(`${verdict.padEnd(4)} ${label.padEnd(24)} ${id.padEnd(4)} ${detail}`)
  }
  const descendants = (pid: number): number[] => {
    const out = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").filter(Boolean).map(Number)
    return [pid, ...out.flatMap(descendants)]
  }
  const pids = [...new Set([process.pid, ...extraPids].flatMap(descendants))]
  const fds = pids.flatMap((pid) => {
    try {
      return fs.readdirSync(`/proc/${pid}/fd`).map((fd) => {
        try {
          return fs.readlinkSync(`/proc/${pid}/fd/${fd}`)
        } catch {
          return ""
        }
      })
    } catch {
      return []
    }
  })
  const hub = fds.filter((l) => l.startsWith("/home/aaron/.local/share/opencode") || l.includes("/.amico/server"))
  const ours = fds.filter((l) => l.startsWith(sandbox.dbPath))
  add("C9a", hub.length === 0 && ours.length > 0 ? "PASS" : "FAIL", `hub-path fds=${hub.length}; own fresh DB fds=${ours.length}`)

  const ss = Bun.spawnSync(["ss", "-ltnpH"]).stdout.toString().split("\n")
  const mine = ss.filter((line) => pids.some((p) => line.includes(`pid=${p},`)))
  const ports = mine.map((l) => Number(l.trim().split(/\s+/)[3]?.split(":").at(-1)))
  const bad = ports.filter((p) => !(p >= 51000 && p <= 51999))
  add("C9b", bad.length === 0 ? "PASS" : "FAIL", `listening ports of process tree: ${JSON.stringify(ports)}; outside 51000-51999: ${JSON.stringify(bad)}`)

  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name)
      if (/^service.*\.json$/.test(entry.name)) found.push(full)
      if (entry.isDirectory() && entry.name !== "node_modules") walk(full)
    }
  }
  walk(sandbox.root)
  add("C9c", found.length === 0 ? "PASS" : "FAIL", `service registration files under sandbox: ${JSON.stringify(found)}`)
  return rows
}
