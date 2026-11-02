// Environment/flags -> validated host configuration. Every refusal throws ConfigError (exit 64 in main).
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isStockRegistrationPath } from "./registration.ts"

/** Port 0 asks the OS for a free port (tests always pass an explicit port). The real default is chosen at install. */
export const DEFAULT_PORT = 0
export const DEFAULT_LOCK_WAIT_MS = 30_000

// Ports the machine-managed opencode service uses (0xC0DE and its neighbour); the host must never sit on them.
const STOCK_SERVICE_PORTS = new Set([49374, 49375])
const HOST_OWNED_SERVER_OPTIONS = ["password", "port", "hostname", "database"]

export class ConfigError extends Error {}

export interface Config {
  readonly port: number
  readonly dbPath: string
  readonly password: string
  readonly registrationFile: string
  readonly lockWaitMs: number
  readonly resume: boolean
  /** Extra `@opencode/server` ServerOptions (config dir, models, fs, ...). Host-owned keys are rejected. */
  readonly serverOptions: Record<string, unknown>
}

type Env = Record<string, string | undefined>

export function loadConfig(env: Env, argv: readonly string[] = []): Config {
  const read = (name: string) => flag(argv, name.replace(/^AMICODE_HOST_/, "").toLowerCase().replaceAll("_", "-")) ?? env[name]
  return {
    dbPath: readDbPath(read("AMICODE_HOST_DB")),
    password: readPassword(read("AMICODE_HOST_PASSWORD"), read("AMICODE_HOST_PASSWORD_FILE")),
    port: readInt("AMICODE_HOST_PORT", read("AMICODE_HOST_PORT"), DEFAULT_PORT, 65_535, STOCK_SERVICE_PORTS),
    lockWaitMs: readInt("AMICODE_HOST_LOCK_WAIT_MS", read("AMICODE_HOST_LOCK_WAIT_MS"), DEFAULT_LOCK_WAIT_MS, 86_400_000),
    resume: readResume(read("AMICODE_HOST_RESUME")),
    registrationFile: readRegistrationFile(read("AMICODE_HOST_REGISTRATION_FILE"), env),
    serverOptions: readServerOptions(read("AMICODE_HOST_SERVER_OPTIONS")),
  }
}

function flag(argv: readonly string[], name: string) {
  const index = argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
  if (index < 0) return undefined
  const arg = argv[index]!
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[index + 1]
}

function readDbPath(raw: string | undefined) {
  const value = raw?.trim()
  if (!value) throw new ConfigError("AMICODE_HOST_DB is required: an explicit database file path (the host never defaults to an in-memory database)")
  const uri = value.replace(/^file:/i, "")
  if (uri.toLowerCase().startsWith(":memory:") || /[?&]mode=memory\b/i.test(uri))
    throw new ConfigError(`AMICODE_HOST_DB=${value} is an in-memory database: sessions would vanish on exit. Give a file path`)
  return path.resolve(value)
}

function readPassword(inline: string | undefined, file: string | undefined) {
  if (inline !== undefined && file !== undefined)
    throw new ConfigError("set only one of AMICODE_HOST_PASSWORD and AMICODE_HOST_PASSWORD_FILE")
  if (file !== undefined) return readPasswordFile(file)
  if (inline === undefined) throw new ConfigError("AMICODE_HOST_PASSWORD (or AMICODE_HOST_PASSWORD_FILE) is required: the host never serves unauthenticated")
  if (!inline) throw new ConfigError("AMICODE_HOST_PASSWORD must not be empty")
  return inline
}

function readPasswordFile(file: string) {
  const stat = fs.statSync(file, { throwIfNoEntry: false })
  if (!stat?.isFile()) throw new ConfigError(`AMICODE_HOST_PASSWORD_FILE ${file} does not exist or is not a regular file`)
  if (stat.mode & 0o077)
    throw new ConfigError(`AMICODE_HOST_PASSWORD_FILE ${file} is readable by group or others (mode ${(stat.mode & 0o777).toString(8)}); chmod 600 it`)
  const password = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "")
  if (!password) throw new ConfigError(`AMICODE_HOST_PASSWORD_FILE ${file} is empty`)
  return password
}

function readInt(name: string, raw: string | undefined, fallback: number, max: number, forbidden?: ReadonlySet<number>) {
  if (raw === undefined || raw === "") return fallback
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(value) || value > max) throw new ConfigError(`${name}=${raw} is not an integer in 0..${max}`)
  if (forbidden?.has(value)) throw new ConfigError(`${name}=${value} is a port of the machine's opencode service; the host must not use it`)
  return value
}

function readResume(raw: string | undefined) {
  if (raw === undefined || raw === "") return true
  if (raw === "0" || raw === "1") return raw === "1"
  throw new ConfigError(`AMICODE_HOST_RESUME=${raw} must be 0 or 1`)
}

function readRegistrationFile(raw: string | undefined, env: Env) {
  const stateHome = env.XDG_STATE_HOME || path.join(env.HOME || os.homedir(), ".local", "state")
  const file = path.resolve(raw || path.join(stateHome, "amicode", "host.json"))
  if (isStockRegistrationPath(file))
    throw new ConfigError(`registration file ${file} is a path the stock opencode client uses to find, replace or kill its service; choose another`)
  return file
}

function readServerOptions(raw: string | undefined) {
  if (!raw) return {}
  const parsed = parseJson(raw)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError("AMICODE_HOST_SERVER_OPTIONS must be a JSON object")
  const owned = HOST_OWNED_SERVER_OPTIONS.filter((key) => key in parsed)
  if (owned.length) throw new ConfigError(`AMICODE_HOST_SERVER_OPTIONS may not set host-owned keys: ${owned.join(", ")}`)
  return parsed as Record<string, unknown>
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new ConfigError("AMICODE_HOST_SERVER_OPTIONS is not valid JSON")
  }
}
