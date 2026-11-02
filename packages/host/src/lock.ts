// Exclusive start lock keyed by the database path: `<db>.amicode-host.lock`, created with O_EXCL.
// Invariant: never two hosts on one database. A live holder is waited on (bounded); a dead holder's lock
// is stale and taken over. Liveness is `kill(pid, 0)` plus, on Linux, the process start time recorded at
// acquisition (guards against pid reuse after a crash).
import fs from "node:fs"
import crypto from "node:crypto"

export class LockHeldError extends Error {
  readonly pid: number | undefined
  constructor(message: string, pid: number | undefined) {
    super(message)
    this.pid = pid
  }
}

export interface Lock {
  readonly path: string
  /** Set when a stale lock left by a dead process was removed to acquire this one. */
  readonly takeover?: { readonly pid: number | undefined }
  /** Synchronous so it can run from a process `exit` handler. Never removes a lock someone else owns. */
  release(): void
}

export interface AcquireOptions {
  /** How long to wait for a live holder to exit before failing. */
  readonly waitMs: number
  /** How long an unparsable lock file (a writer caught mid-write, or junk) is respected before it counts as stale. */
  readonly garbageGraceMs?: number
  readonly pollMs?: number
}

type Holder =
  | { kind: "missing" }
  | { kind: "live"; pid: number }
  | { kind: "stale"; pid: number | undefined; raw: string }
  | { kind: "garbage"; raw: string; ageMs: number }

export const lockPathFor = (dbPath: string) => `${dbPath}.amicode-host.lock`

export async function acquireLock(dbPath: string, options: AcquireOptions): Promise<Lock> {
  const file = lockPathFor(dbPath)
  const deadline = Date.now() + options.waitMs
  const grace = options.garbageGraceMs ?? 2000
  const token = crypto.randomUUID()
  let takeover: Lock["takeover"]
  for (;;) {
    if (create(file, token)) return held(file, token, takeover)
    const holder = inspect(file)
    if (holder.kind === "missing") continue
    if (holder.kind === "stale" || (holder.kind === "garbage" && holder.ageMs > grace)) {
      if (removeStale(file, holder.raw)) takeover = { pid: holder.kind === "stale" ? holder.pid : undefined }
      continue
    }
    if (Date.now() >= deadline) throw heldError(dbPath, file, holder, options.waitMs)
    await sleep(options.pollMs ?? 50)
  }
}

function held(file: string, token: string, takeover: Lock["takeover"]): Lock {
  return {
    path: file,
    ...(takeover ? { takeover } : {}),
    release() {
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.rmSync(file, { force: true })
      } catch {
        // already gone, or replaced by something that is not ours to remove
      }
    },
  }
}

function create(file: string, token: string) {
  try {
    const fd = fs.openSync(file, "wx", 0o600)
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now(), procStart: processStart(process.pid) }) + "\n")
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

function inspect(file: string): Holder {
  let raw: string
  let mtimeMs: number
  try {
    raw = fs.readFileSync(file, "utf8")
    mtimeMs = fs.statSync(file).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" }
    throw error
  }
  const record = parse(raw)
  if (!record) return { kind: "garbage", raw, ageMs: Date.now() - mtimeMs }
  const alive = pidAlive(record.pid) && (record.procStart === undefined || processStart(record.pid) === undefined || processStart(record.pid) === record.procStart)
  return alive ? { kind: "live", pid: record.pid } : { kind: "stale", pid: record.pid, raw }
}

function parse(raw: string) {
  try {
    const value = JSON.parse(raw)
    if (typeof value?.pid === "number" && Number.isInteger(value.pid) && value.pid > 0)
      return { pid: value.pid as number, procStart: typeof value.procStart === "string" ? (value.procStart as string) : undefined }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Removes a lock judged stale. Takeovers serialise on a second O_EXCL file and re-check the content under it,
 * so two contenders cannot each delete the other's fresh lock.
 */
function removeStale(file: string, expectedRaw: string) {
  const mutex = `${file}.takeover`
  try {
    fs.closeSync(fs.openSync(mutex, "wx", 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    // a contender died inside the (microsecond) critical section: don't wedge forever
    if (Date.now() - (fs.statSync(mutex, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > 10_000) fs.rmSync(mutex, { force: true })
    return false
  }
  try {
    if (fs.readFileSync(file, "utf8") !== expectedRaw) return false
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(mutex, { force: true })
  }
}

function heldError(dbPath: string, file: string, holder: Holder, waitMs: number) {
  if (holder.kind === "live")
    return new LockHeldError(
      `database ${dbPath} is already in use by amicode-host pid ${holder.pid} (lock ${file}); waited ${waitMs} ms. Stop that process or raise AMICODE_HOST_LOCK_WAIT_MS`,
      holder.pid,
    )
  return new LockHeldError(`database ${dbPath}: lock file ${file} exists but is unreadable; waited ${waitMs} ms. Remove it if no host is running`, undefined)
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Linux: field 22 of /proc/<pid>/stat (clock ticks since boot). Other platforms: unknown. */
function processStart(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
