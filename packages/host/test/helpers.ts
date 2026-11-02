// Test harness. Every process the tests start runs inside a throwaway sandbox: temp XDG dirs, a fresh
// database file, loopback ports 52000-52999 only, a from-scratch environment (no inherited inspector,
// no HOME), random per-run passwords. Nothing here touches ~/.amico, ~/.config/systemd or the machine's
// opencode service.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export const PORT_MIN = 52000
export const PORT_MAX = 52999
export const HOST_MAIN = path.resolve(import.meta.dir, "../bin/amicode-host.mjs")
export const REAL_HOME = os.userInfo().homedir

const sandboxes: string[] = []
const children: Bun.Subprocess[] = []

export async function freePort() {
  for (let i = 0; i < 300; i++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1))
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`)
}

export function makeSandbox(name = "host") {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", `h1a-${name}-`))
  sandboxes.push(root)
  const dirs = {
    state: path.join(root, "state"),
    data: path.join(root, "data"),
    config: path.join(root, "config"),
    cache: path.join(root, "cache"),
    home: path.join(root, "home"),
    work: path.join(root, "work"),
    serverConfig: path.join(root, "server-config"),
  }
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
  return {
    root,
    ...dirs,
    db: path.join(dirs.data, "amicode-host.db"),
    password: crypto.randomUUID(),
    registration: path.join(dirs.state, "amicode", "host.json"),
    stockRegistration: path.join(dirs.state, "opencode", "service.json"),
  }
}
export type Sandbox = ReturnType<typeof makeSandbox>

export function hostEnv(sb: Sandbox, extra: Record<string, string | undefined> = {}) {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: sb.home,
    OPENCODE_TEST_HOME: sb.home,
    XDG_STATE_HOME: sb.state,
    XDG_DATA_HOME: sb.data,
    XDG_CONFIG_HOME: sb.config,
    XDG_CACHE_HOME: sb.cache,
    OPENCODE_DB: sb.db,
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    AMICODE_HOST_DB: sb.db,
    AMICODE_HOST_PASSWORD: sb.password,
    AMICODE_HOST_SERVER_OPTIONS: JSON.stringify({
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
      config: { directory: sb.serverConfig, project: false, claude: false, content: "{}" },
    }),
  }
  const merged = { ...base, ...extra }
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

export function spawnHost(
  sb: Sandbox,
  options: { port?: number; env?: Record<string, string | undefined>; entry?: string; runtime?: string } = {},
) {
  const port = options.port ?? 0
  const proc = Bun.spawn([options.runtime ?? process.execPath, options.entry ?? HOST_MAIN], {
    cwd: sb.work,
    env: hostEnv(sb, { AMICODE_HOST_PORT: String(port), ...options.env }),
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(proc)
  const out = { stdout: "", stderr: "" }
  const pump = async (stream: ReadableStream<Uint8Array>, key: keyof typeof out) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) out[key] += decoder.decode(chunk, { stream: true })
  }
  void pump(proc.stdout, "stdout")
  void pump(proc.stderr, "stderr")
  return {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    output: out,
    exited: proc.exited,
    auth: { authorization: basic(sb.password) },
  }
}
export type SpawnedHost = ReturnType<typeof spawnHost>

export const basic = (password: string, user = "opencode") =>
  "Basic " + Buffer.from(`${user}:${password}`).toString("base64")

export async function waitFor<T>(
  probe: () => T | undefined | false | Promise<T | undefined | false>,
  options: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000)
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${options.what ?? "condition"}`)
    await Bun.sleep(options.intervalMs ?? 50)
  }
}

/** Resolves once the host answers /amicode/ping with credentials. */
export async function ready(host: SpawnedHost, timeoutMs = 30_000) {
  await waitFor(
    async () => {
      if (host.proc.exitCode !== null) throw new Error(`host exited early (${host.proc.exitCode}): ${host.output.stderr}`)
      return fetch(`${host.url}/amicode/ping`, { headers: host.auth })
        .then((r) => r.status === 200)
        .catch(() => false)
    },
    { timeoutMs, what: `host on ${host.url} to answer (stderr: ${host.output.stderr.slice(-500)})` },
  )
}

export async function stop(host: SpawnedHost, signal: NodeJS.Signals = "SIGTERM") {
  if (host.proc.exitCode === null) host.proc.kill(signal)
  return Promise.race([host.exited, Bun.sleep(15_000).then(() => "timeout" as const)])
}

export function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A pid that is guaranteed dead: spawn a short child and wait for it. */
export async function deadPid() {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" })
  await proc.exited
  return proc.pid
}

export function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name)
    return entry.isDirectory() ? walkFiles(full) : [full]
  })
}

export function cleanup() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true })
}
