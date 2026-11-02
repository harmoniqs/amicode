// Safety envelope. Imported FIRST by every entrypoint: the process refuses to run unless it is fully
// sandboxed (temp XDG dirs, fresh DB file, loopback ports 51000-51999, no inspector). Upstream computes
// its global paths at import time, so these checks must run before any @opencode/* import.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"

const root = process.env.H0C_ROOT
if (!root || !root.startsWith("/tmp/opencode/h0c/"))
  throw new Error("H0C_ROOT must be set under /tmp/opencode/h0c/ (use run.sh)")
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "OPENCODE_TEST_HOME"]) {
  const value = process.env[key]
  if (!value || !value.startsWith(root)) throw new Error(`${key} must live under ${root}, got ${value}`)
}
if (!process.env.OPENCODE_DB?.startsWith(root)) throw new Error("OPENCODE_DB must be a fresh file under H0C_ROOT")
if (process.env.BUN_INSPECT || process.env.AMICODE_ENGINE_INSPECT) throw new Error("inspector env must be unset")

export const sandbox = {
  root,
  state: process.env.XDG_STATE_HOME!,
  dbPath: process.env.OPENCODE_DB!,
  configDir: path.join(root, "config-dir"),
  workDir: path.join(root, "work"),
  password: "h0c-throwaway-password",
  upstream: process.env.H0C_UPSTREAM ?? "/tmp/opencode/h0c/upstream",
  subsLog: path.join(root, "subs.log"),
}
fs.mkdirSync(sandbox.configDir, { recursive: true })
fs.mkdirSync(sandbox.workDir, { recursive: true })
fs.writeFileSync(sandbox.subsLog, "")
process.env.H0C_SUBS_LOG = sandbox.subsLog

const FORBIDDEN = (port: number) => port === 49374 || port === 49375 || (port >= 4094 && port <= 4296) || port === 9230

/** Pick a free loopback port in 51000-51999 (never one that anything else already holds). */
export async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 51000 + Math.floor(Math.random() * 1000)
    if (FORBIDDEN(port) || port === 51223) continue
    const ok = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (ok) return port
  }
  throw new Error("no free port in 51000-51999")
}
