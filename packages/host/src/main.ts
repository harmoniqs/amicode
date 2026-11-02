// Wiring + lifecycle: config -> start lock -> server -> front -> listener -> registration; and the reverse on exit.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import pkg from "../package.json" with { type: "json" }
import { ConfigError, loadConfig } from "./config.ts"
import { front } from "./front.ts"
import { listen } from "./listener.ts"
import { acquireLock, LockHeldError } from "./lock.ts"
import { loadPlugins, PluginConfigError } from "./plugins/index.ts"
import { writeRegistration } from "./registration.ts"
import { hostRoutes } from "./routes.ts"
import { runtimeProblem } from "./runtime.ts"
import { createServer } from "./server-seam.ts"

export const EXIT_USAGE = 64 // refused to start: bad configuration or wrong runtime
export const EXIT_LOCK = 69 // another host holds this database

const log = (message: string) => process.stderr.write(`amicode-host: ${message}\n`)

/** Runs the host until SIGTERM/SIGINT; resolves with the process exit code. */
export async function main(env: Record<string, string | undefined> = process.env, argv: readonly string[] = process.argv.slice(2)) {
  const problem = runtimeProblem()
  if (problem) return refuse(problem, EXIT_USAGE)

  const config = (() => {
    try {
      return loadConfig(env, argv)
    } catch (error) {
      if (error instanceof ConfigError) return error
      throw error
    }
  })()
  if (config instanceof ConfigError) return refuse(config.message, EXIT_USAGE)
  const plugins = await loadPlugins(env).catch((error) => (error instanceof PluginConfigError ? error : Promise.reject(error)))
  if (plugins instanceof PluginConfigError) return refuse(plugins.message, EXIT_USAGE)

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true })
  const lock = await acquireLock(config.dbPath, { waitMs: config.lockWaitMs }).catch((error) => {
    if (error instanceof LockHeldError) return error
    throw error
  })
  if (lock instanceof LockHeldError) return refuse(lock.message, EXIT_LOCK)
  if (lock.takeover) log(`took over a stale lock left by pid ${lock.takeover.pid ?? "unknown"} (${lock.path})`)

  let registration: ReturnType<typeof writeRegistration> | undefined
  // Safety net for abnormal exits: the lock and registration never outlive the process.
  process.on("exit", () => {
    registration?.remove()
    lock.release()
  })

  try {
    const server = await createServer({
      version: pkg.version,
      dbPath: config.dbPath,
      password: config.password,
      resume: config.resume,
      serverOptions: config.serverOptions,
      plugins,
    })
    const startedAt = Date.now()
    const listener = listen({
      port: config.port,
      fetch: front({
        password: config.password,
        own: hostRoutes({ version: pkg.version, dbPath: config.dbPath, lockPid: process.pid, startedAt, openStreams: server.openStreams, resume: config.resume }),
        downstream: server.fetch,
      }),
    })
    const url = `http://127.0.0.1:${listener.port}`
    registration = writeRegistration(config.registrationFile, { id: crypto.randomUUID(), version: pkg.version, url, pid: process.pid })
    process.stdout.write(`${JSON.stringify({ event: "listening", url, pid: process.pid, db: path.basename(config.dbPath) })}\n`)

    await new Promise<void>((resolve) => {
      for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolve())
    })
    // Stop being discoverable, stop accepting, close the engine (flushes the database), and only then
    // release the lock so a waiting successor never overlaps this process's use of the database.
    registration.remove()
    await listener.stop(true)
    await server.close()
    return 0
  } catch (error) {
    log(`failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    return 1
  } finally {
    lock.release()
  }
}

function refuse(message: string, code: number) {
  log(message)
  return code
}
