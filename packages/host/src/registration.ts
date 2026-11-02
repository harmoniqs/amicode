// The host's OWN registration file. It is deliberately never the stock opencode one:
// `<state>/opencode/service*.json` is what a stock opencode client reads to find, replace, or KILL a
// managed service (see the stock registrar, which also self-terminates when its file is replaced).
// This file carries no password and is only an advertisement for host-aware tooling.
import fs from "node:fs"
import path from "node:path"

export interface RegistrationInfo {
  readonly id: string
  readonly version: string
  readonly url: string
  readonly pid: number
}

export function writeRegistration(file: string, info: RegistrationInfo) {
  assertNotStockRegistration(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${info.id}.tmp`
  fs.writeFileSync(temp, JSON.stringify({ ...info, startedAt: Date.now() }) + "\n", { mode: 0o600 })
  fs.renameSync(temp, file)
  return {
    /** Removes the file only while it still names this registration; a successor's file is left alone. */
    remove() {
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).id === info.id) fs.rmSync(file, { force: true })
      } catch {
        // already gone or replaced by something unparsable that is not ours to delete
      }
    },
  }
}

/** True for any path the stock opencode client would treat as a managed-service registration. */
export function isStockRegistrationPath(file: string) {
  return /^service.*\.json$/.test(path.basename(file)) || path.basename(path.dirname(file)) === "opencode"
}

export function assertNotStockRegistration(file: string) {
  if (isStockRegistrationPath(file))
    throw new Error(`registration file ${file} is a path the stock opencode client uses to find, replace or kill its service`)
}
