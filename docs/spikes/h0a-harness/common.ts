// Shared by the H0a harness processes. Nothing here starts a process or touches a path outside the caller's run directory.
import fs from "node:fs"
import net from "node:net"

export const PORT_MIN = 53000
export const PORT_MAX = 53999

/** mulberry32: a tiny seeded PRNG so a run (pacing, think-time, reconnect schedule) is reproducible from `--seed`. */
export function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A seeded PRNG for one named stream, independent of call order elsewhere (so concurrency cannot change a draw). */
export function rngFor(seed: number, ...keys: number[]) {
  return rng(keys.reduce((acc, key) => (Math.imul(acc ^ (key + 0x9e3779b9), 0x85ebca6b) >>> 0) ^ (acc >>> 13), seed >>> 0))
}

export const uniform = (random: () => number, low: number, high: number) => low + random() * (high - low)

export function assertPort(port: number) {
  if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX)
    throw new Error(`port ${port} is outside the H0a range ${PORT_MIN}-${PORT_MAX}`)
  return port
}

/** A free loopback port inside the H0a range, never one in `taken`. */
export async function freePort(taken: readonly number[] = []) {
  for (let i = 0; i < 400; i++) {
    const port = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN + 1))
    if (taken.includes(port)) continue
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer()
      probe.once("error", () => resolve(false))
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`)
}

export const basic = (password: string, user = "opencode") => "Basic " + Buffer.from(`${user}:${password}`).toString("base64")

/** Append-only NDJSON writer; sync appends so a crash loses at most the line in flight. */
export function ndjson(file: string) {
  const fd = fs.openSync(file, "a", 0o600)
  return {
    write: (row: unknown) => fs.writeSync(fd, JSON.stringify(row) + "\n"),
    close: () => fs.closeSync(fd),
  }
}

export function readNdjson<T = Record<string, unknown>>(file: string): T[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T)
}

/** Parsed `--key value` / `--flag` command-line arguments. */
export function args(argv: readonly string[]) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) out[arg.slice(2)] = "true"
    else {
      out[arg.slice(2)] = next
      i++
    }
  }
  return out
}
