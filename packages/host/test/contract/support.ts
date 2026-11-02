// Shared harness for the contract suite. Everything it starts runs in a sandbox: temp XDG dirs and HOME, a
// fresh database file, a random password, OPENCODE_DISABLE_FREE_MODELS=1, loopback ports 52200-52299 only
// (never 49374/49375, 4094-4296, 9229-9231, or another slice's range). Nothing here touches ~/.amico,
// ~/.config/systemd or the machine's opencode service.
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { hostEnv, makeSandbox, ready, waitFor, type Sandbox } from "../helpers.ts"

export const packageRoot = path.resolve(import.meta.dir, "../..")
export const CONTRACT_PORT_MIN = 52200
export const CONTRACT_PORT_MAX = 52299
export { makeSandbox, ready, waitFor, type Sandbox }

const sandboxes: Sandbox[] = []
const children: Bun.Subprocess[] = []

/** Environment for a bun child that must not inherit the machine's inspector or any credential. */
export const bunEnv = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", ...extra })

export function contractSandbox(name: string) {
  const sb = makeSandbox(`contract-${name}`)
  sandboxes.push(sb)
  return sb
}

export async function contractPort() {
  for (let i = 0; i < 200; i++) {
    const port = CONTRACT_PORT_MIN + Math.floor(Math.random() * (CONTRACT_PORT_MAX - CONTRACT_PORT_MIN + 1))
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`no free port in ${CONTRACT_PORT_MIN}-${CONTRACT_PORT_MAX}`)
}

/** Start the real host process (bin/amicode-host.mjs) in a sandbox on a contract port. */
export async function startContractHost(sb: Sandbox, env: Record<string, string | undefined> = {}) {
  const port = await contractPort()
  if (port < CONTRACT_PORT_MIN || port > CONTRACT_PORT_MAX) throw new Error("port outside the contract range")
  const proc = Bun.spawn([process.execPath, path.join(packageRoot, "bin/amicode-host.mjs")], {
    cwd: sb.work,
    env: hostEnv(sb, { AMICODE_HOST_PORT: String(port), ...env }),
    stdout: "pipe",
    stderr: "pipe",
  })
  children.push(proc)
  const output = { stdout: "", stderr: "" }
  const pump = async (stream: ReadableStream<Uint8Array>, key: keyof typeof output) => {
    const decoder = new TextDecoder()
    for await (const chunk of stream) output[key] += decoder.decode(chunk, { stream: true })
  }
  void pump(proc.stdout, "stdout")
  void pump(proc.stderr, "stderr")
  const host = {
    proc,
    port,
    url: `http://127.0.0.1:${port}`,
    output,
    exited: proc.exited,
    auth: { authorization: "Basic " + Buffer.from(`opencode:${sb.password}`).toString("base64") },
    headers: { authorization: "Basic " + Buffer.from(`opencode:${sb.password}`).toString("base64"), "x-opencode-directory": sb.work },
  }
  await ready(host, 45_000)
  return host
}
export type ContractHost = Awaited<ReturnType<typeof startContractHost>>

export async function stopContractHost(host: ContractHost) {
  if (host.proc.exitCode === null) host.proc.kill("SIGTERM")
  await Promise.race([host.exited, Bun.sleep(15_000)])
}

/** Run test/contract/probe.ts in a sandboxed child: the engine computes (and may create) its global dirs at import time. */
export function runProbe() {
  const sb = contractSandbox("probe")
  const run = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "probe.ts")], {
    cwd: packageRoot,
    env: hostEnv(sb),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

export function cleanupContract() {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL")
  for (const sb of sandboxes) fs.rmSync(sb.root, { recursive: true, force: true })
}
